// ForgeCrypto — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP.
// Modern era first: server/discover (2026-07-28) with supportedVersions, and
// the legacy initialize handshake for clients that predate discover.
// Tools are the six github-mcp-server names plus get_issue, and every call
// reads and writes the same in-memory store the REST surface uses.

import { type Issue, type Repo, type Store } from './store.ts';
import { repoObject } from './rest.ts';
import { isRecord } from './util.ts';

export const MCP_SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const MCP_SERVER_NAME = 'ForgeCrypto';
export const MCP_SERVER_VERSION = '1.0.0';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools list, in the fixed order tools/list answers with. */
export function mcpToolsList(): ToolDef[] {
  return TOOLS;
}

/** The first string (or number-as-string) found under any of the given keys. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function pickBool(args: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function toolText(payload: unknown): { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function issuePayload(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function repoPayload(store: Store, repo: Repo): Record<string, unknown> {
  const rest = repoObject(store, repo);
  return {
    id: rest.id,
    name: rest.name,
    full_name: rest.full_name,
    owner: { login: repo.owner },
    private: rest.private,
    description: rest.description,
    default_branch: rest.default_branch,
    created_at: rest.created_at,
    updated_at: rest.updated_at,
  };
}

/** Run one tool call against the store. Throws an Error with a JSON-RPC code attached for bad params. */
class McpParamsError extends Error {
  code = JSON_RPC_INVALID_PARAMS;
}

function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean } {
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'user', 'login', 'account']);
  const repoName = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name']);
  switch (name) {
    case 'create_repo': {
      const repoTitle = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      const description = pickString(args, ['description', 'about', 'summary']);
      const isPrivate = pickBool(args, ['private', 'is_private']);
      if (repoTitle === '') throw new McpParamsError('create_repo needs a name');
      const repo = store.createRepo(repoTitle, description, isPrivate);
      if (repo === null) return toolError(`a repository named ${repoTitle} already exists`);
      return toolText(repoPayload(store, repo));
    }
    case 'get_repo': {
      if (owner === '' || repoName === '') throw new McpParamsError('get_repo needs owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      return toolText(repoPayload(store, repo));
    }
    case 'create_issue': {
      const title = pickString(args, ['title', 'issue_title', 'subject']);
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text']);
      if (owner === '' || repoName === '' || title === '') {
        throw new McpParamsError('create_issue needs owner, repo, and title');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, title, body, []);
      return toolText(issuePayload(issue));
    }
    case 'list_issues': {
      if (owner === '' || repoName === '') throw new McpParamsError('list_issues needs owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const state = pickString(args, ['state', 'status']);
      const issues = [...repo.issues.values()]
        .sort((a, b) => b.number - a.number)
        .filter((issue) => state === '' || state === 'all' || issue.state === state)
        .map((issue) => issuePayload(issue));
      return toolText({ issues });
    }
    case 'get_issue': {
      const number = pickNumber(args, ['issue_number', 'number', 'index']);
      if (owner === '' || repoName === '' || number === null) {
        throw new McpParamsError('get_issue needs owner, repo, and issue_number');
      }
      const repo = store.getRepo(owner, repoName);
      const issue = repo?.issues.get(number);
      if (issue === undefined) return toolError(`issue #${number} not found in ${owner}/${repoName}`);
      return toolText(issuePayload(issue));
    }
    case 'create_pull_request': {
      const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const body = pickString(args, ['body', 'description', 'content', 'text']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']);
      const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']);
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        throw new McpParamsError('create_pull_request needs owner, repo, title, head, and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = store.createPull(repo, title, body, head, base);
      if (pull === null) return toolError(`a pull request already exists for head ${head}`);
      return toolText({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        head: pull.headRef,
        base: pull.baseRef,
        state: pull.state,
        merged: pull.merged,
      });
    }
    case 'merge_pull_request': {
      const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'index']);
      if (owner === '' || repoName === '' || number === null) {
        throw new McpParamsError('merge_pull_request needs owner, repo, and pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      const pull = repo?.pulls.get(number);
      if (pull === undefined) return toolError(`pull request #${number} not found in ${owner}/${repoName}`);
      const sha = store.squashMerge(repo as Repo, pull);
      if (sha === null) return toolError(`pull request #${number} conflicts and cannot be merged`);
      return toolText({ number: pull.number, merged: true, state: 'closed', sha });
    }
    default: {
      throw new McpParamsError(`unknown tool ${name}`);
    }
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function isNotification(request: Record<string, unknown>): boolean {
  return !('id' in request) || request.id === undefined;
}

/**
 * Handle one parsed JSON-RPC request (or a batch array). Returns null for a
 * notification, which the transport answers with an empty 202.
 */
export function handleMcpRequest(
  store: Store,
  request: unknown,
): { status: number; payload: unknown } {
  if (Array.isArray(request)) {
    const answers: unknown[] = [];
    for (const entry of request) {
      const answer = handleMcpRequest(store, entry);
      if (answer.payload !== null) answers.push(answer.payload);
    }
    return { status: 200, payload: answers };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 400, payload: rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request') };
  }
  const method = request.method;
  const id = 'id' in request ? request.id : undefined;
  const params = isRecord(request.params) ? request.params : {};
  if (isNotification(request)) {
    // Notifications (notifications/initialized) need no answer.
    return { status: 202, payload: null };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        instructions: 'ForgeCrypto: a GitHub-compatible git forge. Use the tools to create repositories, issues, and pull requests.',
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2026-07-28';
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, payload: rpcResult(id, { tools: mcpToolsList() }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, payload: rpcError(id, JSON_RPC_INVALID_PARAMS, `unknown tool ${toolName}`) };
    }
    try {
      const result = callTool(store, toolName, args);
      return { status: 200, payload: rpcResult(id, result) };
    } catch (err) {
      if (err instanceof McpParamsError) {
        return { status: 200, payload: rpcError(id, JSON_RPC_INVALID_PARAMS, err.message) };
      }
      return { status: 200, payload: rpcError(id, JSON_RPC_INVALID_PARAMS, err instanceof Error ? err.message : String(err)) };
    }
  }
  return { status: 200, payload: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`) };
}

/** The -32700 parse-error answer for a body that is not JSON. */
export function mcpParseErrorResponse(rawBody: string): { status: number; payload: Record<string, unknown> } {
  const match = /"id"\s*:\s*(-?\d+|"[^"]*")/.exec(rawBody);
  let id: unknown = null;
  if (match !== null) {
    const raw = match[1] as string;
    id = raw.startsWith('"') ? raw.slice(1, -1) : Number.parseInt(raw, 10);
  }
  return { status: 400, payload: rpcError(id, JSON_RPC_PARSE_ERROR, 'Parse error') };
}
