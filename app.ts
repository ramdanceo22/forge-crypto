// ForgeCrypto — the HTTP server: routing, Bearer auth, and the git
// smart-HTTP endpoints. REST, GraphQL and MCP live in their own modules.
// GET /healthz answers without auth; everything else needs a Bearer token:
// an exact match against MAKEFUN_SHOP_TOKEN when it is set, any non-empty
// Bearer token otherwise (the local-dev case).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcpRequest, mcpParseErrorResponse } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  answerFetchV2,
  answerLsRefs,
  answerUploadV0,
  applyReceivePack,
  parseUploadV0,
  parseUploadV2,
  reportStatus,
} from './git.ts';
import {
  nextRequestId,
  pathOf,
  queryOf,
  readBody,
  readJsonBody,
  sendJson,
  sendRaw,
} from './util.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The Bearer token of a request, or '' when there is none. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length);
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function send401(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function send404(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** Handle the git smart-HTTP routes under /{owner}/{repo}.git/. */
async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
): Promise<boolean> {
  const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    send404(res);
    return true;
  }
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = version2 ? advertisementV2() : advertisementV0(repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 400, { message: 'info/refs needs a service parameter' });
    return true;
  }
  if (method === 'POST' && tail === 'git-upload-pack') {
    const body = await readBody(req);
    const protocol = req.headers['git-protocol'] ?? '';
    const text = body.subarray(0, 64).toString('ascii');
    if (protocol === 'version=2' || text.includes('command=')) {
      const parsed = parseUploadV2(body);
      if (parsed.command === 'ls-refs') {
        sendRaw(res, 200, answerLsRefs(repo, parsed), 'application/x-git-upload-pack-result');
      } else if (parsed.command === 'fetch') {
        sendRaw(res, 200, answerFetchV2(repo, parsed), 'application/x-git-upload-pack-result');
      } else {
        sendRaw(res, 200, answerLsRefs(repo, parsed), 'application/x-git-upload-pack-result');
      }
      return true;
    }
    const parsed = parseUploadV0(body);
    sendRaw(res, 200, answerUploadV0(repo, parsed), 'application/x-git-upload-pack-result');
    return true;
  }
  if (method === 'POST' && tail === 'git-receive-pack') {
    const body = await readBody(req);
    const { lines, sideband } = applyReceivePack(repo, body);
    sendRaw(res, 200, reportStatus(lines, sideband), 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}

/** One request, routed. */
async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  try {
    // The liveness probe answers without auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (!authorized(req)) {
      send401(res);
      return;
    }
    // GraphQL v4.
    if (method === 'POST' && path === '/api/graphql') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
        return;
      }
      const { status, payload } = handleGraphQL(store, body);
      sendJson(res, status, payload);
      return;
    }
    // MCP over Streamable HTTP.
    if (path === '/mcp') {
      if (method === 'DELETE') {
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        const { status, payload } = mcpParseErrorResponse(raw.toString('utf8'));
        sendJson(res, status, payload);
        return;
      }
      const { status, payload } = handleMcpRequest(store, parsed);
      if (payload === null) {
        res.writeHead(status, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, status, payload);
      return;
    }
    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      let body: unknown = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
      const ctx: RestContext = { store, req, res, query: queryOf(req), body, path };
      if (handleRest(ctx)) return;
      send404(res);
      return;
    }
    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1] as string);
      const repoName = decodeURIComponent(gitMatch[2] as string);
      const tail = gitMatch[3] as string;
      if (await handleGit(store, req, res, owner, repoName, tail)) return;
      send404(res);
      return;
    }
    send404(res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    } else {
      res.destroy();
    }
  }
}

/** Start the server on an ephemeral port (never 8080) and return it. */
export async function startServer(store: Store): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handleRequest(store, req, res);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // Bind every interface: the env dials the address the register request
    // came from, which is not 127.0.0.1 inside a trial container.
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('the server did not bind a port'));
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
