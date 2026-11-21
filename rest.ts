// ForgeCrypto — the REST v3 API under /api/v3: repositories, branches,
// commits, contents, issues, comments, labels and pull requests. Every reply
// is application/json with a non-empty X-GitHub-Request-Id; errors are JSON
// with a string message; unknown routes are 404 JSON; malformed JSON is 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  blobShaOfText,
  changedPaths,
  filesAtCommit,
  lineDiff,
  parseCommit,
  parseTree,
  putObject,
  tagTarget,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { globalId, isRecord, nextRequestId, nowIso, sendJson, stringField } from './util.ts';

// ---------------------------------------------------------------- shapes

/** The public user object for the token owner. */
function userObject(store: Store): Record<string, unknown> {
  return {
    login: store.viewerLogin,
    id: store.viewerId,
    node_id: globalId('U', store.viewerLogin),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/user',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };
}

/** The public repository object. */
export function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(store),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT', url: null, node_id: 'MDc6TGljZW5zZW1pdA==' },
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

/** The public issue object. */
export function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userObject(store),
    labels: issue.labels.map((name) => labelObject(repo, repo.labels.get(name) as Label)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

/** The public label object. */
export function labelObject(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('L', `${repo.owner}/${repo.name}:${label.name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

/** The public comment object. */
function commentObject(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.num,
    node_id: comment.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.num}`,
    html_url: '',
    body: comment.body,
    user: userObject(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

/** The public pull request object. */
export function pullObject(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergeable = store.pullMergeable(repo, pull);
  const files = store.pullFiles(repo, pull);
  let additions = 0;
  let deletions = 0;
  const head = repo.branches.get(pull.headRef);
  const base = repo.branches.get(pull.baseRef);
  if (head?.head !== null && head?.head !== undefined && base?.head !== null && base?.head !== undefined) {
    const headFiles = filesAtCommit(repo, head.head);
    const baseFiles = filesAtCommit(repo, base.head);
    for (const path of files) {
      const oldBlob = baseFiles.get(path);
      const newBlob = headFiles.get(path);
      const oldText = oldBlob === undefined ? '' : (repo.objects.get(oldBlob.sha)?.data.toString('utf8') ?? '');
      const newText = newBlob === undefined ? '' : (repo.objects.get(newBlob.sha)?.data.toString('utf8') ?? '');
      const [added, removed] = lineDiff(oldText, newText);
      additions += added;
      deletions += removed;
    }
  }
  const headRepo = repoObject(store, repo);
  const baseRepo = repoObject(store, repo);
  return {
    id: pull.id,
    node_id: pull.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: '',
    number: pull.number,
    title: pull.title,
    body: pull.body,
    user: userObject(store),
    state: pull.state,
    locked: false,
    title_prefix: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: pull.merged ? userObject(store) : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userObject(store),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userObject(store),
      repo: baseRepo,
    },
    draft: false,
    author_association: 'OWNER',
  };
}

/** The public commit object for a contents response. */
function commitObject(store: Store, repo: Repo, sha: string, message: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const parsed = obj === undefined ? null : parseCommit(obj.data);
  const now = nowIso();
  return {
    sha,
    node_id: globalId('C', `${repo.owner}/${repo.name}:${sha}`),
    commit: {
      author: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: now },
      committer: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: now },
      message,
      tree: { sha: parsed?.tree ?? '', url: '' },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: '',
    author: userObject(store),
    committer: userObject(store),
    parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------- pagination

/** Paginate a list: the page's items plus a Link header when more pages exist. */
export function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  req: IncomingMessage,
  path: string,
): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1) return { page: [...pageItems], link: null };
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  links.push(`<${base}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
  if (page > 1) links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  if (page > 1) links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  return { page: [...pageItems], link: links.join(', ') };
}

// ---------------------------------------------------------------- routing

/** One route: method, a path pattern with :params, and its handler. */
type Handler = (
  ctx: RestContext,
  params: Record<string, string>,
) => void;

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: unknown;
  path: string;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into decoded segments. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map(decode);
}

/** Find a repository or answer 404 (another owner is 404, never 403). */
function findRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function notFound(ctx: RestContext, message = 'Not Found'): void {
  sendJson(ctx.res, 404, { message, documentation_url: '' });
}

function unprocessable(ctx: RestContext, message: string): void {
  sendJson(ctx.res, 422, { message, documentation_url: '' });
}

/** The contents entry for one file. */
function fileContentObject(store: Store, repo: Repo, path: string, sha: string, size: number): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const content = obj === undefined ? '' : obj.data.toString('base64');
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name: path.split('/').pop() ?? path,
    path,
    content,
    sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}`,
    git_url: '',
    html_url: '',
    download_url: null,
    _links: { git: '', html: '', self: '' },
  };
}

/** The contents entries of one directory (or the repository root). */
function dirContentObjects(store: Store, repo: Repo, dir: string, files: Map<string, { sha: string; mode: string }>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Map<string, { sha: string; mode: string; isDir: boolean }>();
  for (const [path, entry] of files) {
    if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
    const rest = dir === '' ? path : path.slice(dir.length + 1);
    const first = rest.split('/')[0] as string;
    if (rest.includes('/')) {
      if (!seen.has(first)) seen.set(first, { sha: '', mode: '40000', isDir: true });
    } else {
      seen.set(first, { sha: entry.sha, mode: entry.mode, isDir: false });
    }
  }
  for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fullPath = dir === '' ? name : `${dir}/${name}`;
    if (entry.isDir) {
      entries.push({
        type: 'dir',
        size: 0,
        name,
        path: fullPath,
        sha: '',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(fullPath)}`,
        git_url: '',
        html_url: '',
        download_url: null,
        _links: { git: '', html: '', self: '' },
      });
    } else {
      const obj = repo.objects.get(entry.sha);
      entries.push({
        type: 'file',
        size: obj?.data.length ?? 0,
        name,
        path: fullPath,
        sha: entry.sha,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(fullPath)}`,
        git_url: '',
        html_url: '',
        download_url: null,
        _links: { git: '', html: '', self: '' },
      });
    }
  }
  return entries;
}

/** The main REST dispatcher: returns true when it handled the request. */
export function handleRest(ctx: RestContext): boolean {
  const { store, req, res, query, body } = ctx;
  const method = req.method ?? 'GET';
  const parts = segments(ctx.path);
  if (parts[0] !== 'api' || parts[1] !== 'v3') return false;
  const rest = parts.slice(2);

  // The API root and meta.
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      enterprise: false,
      hook_url: '',
      git_url: '',
      ssh_url: '',
    });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'rate_limit') {
    sendJson(res, 200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 }, search: { limit: 30, remaining: 30, reset: 0, used: 0 } },
      rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 },
    });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, userObject(store));
    return true;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos(), query, req, ctx.path);
      sendJson(res, 200, page.map((repo) => repoObject(store, repo)), link === null ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      if (!isRecord(body)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const name = stringField(body, 'name');
      if (name === '') {
        unprocessable(ctx, 'name is required');
        return true;
      }
      const repo = store.createRepo(name, stringField(body, 'description'), body.private === true);
      if (repo === null) {
        unprocessable(ctx, 'Repository creation failed.');
        return true;
      }
      sendJson(res, 201, repoObject(store, repo));
      return true;
    }
    return false;
  }

  // /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = findRepo(ctx, owner, name);
    if (repo === null) {
      notFound(ctx);
      return true;
    }
    const tail = rest.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoObject(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!isRecord(body)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const description = stringField(body, 'description', repo.description);
        repo.description = description;
        const defaultBranch = stringField(body, 'default_branch', repo.defaultBranch);
        if (repo.branches.has(defaultBranch)) repo.defaultBranch = defaultBranch;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoObject(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      return false;
    }

    // Branches.
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.branches.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((branch) => ({ name: branch.name, commit: { sha: branch.head ?? '', url: '' }, protected: false }));
        const { page, link } = paginate(list, query, req, ctx.path);
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = repo.branches.get(tail[1] as string);
        if (branch === undefined || branch.head === null) {
          notFound(ctx, 'Branch not found');
          return true;
        }
        const obj = repo.objects.get(branch.head);
        const parsed = obj === undefined ? null : parseCommit(obj.data);
        sendJson(res, 200, {
          name: branch.name,
          commit: {
            sha: branch.head,
            commit: { message: parsed?.message ?? '', author: { name: store.viewerLogin, date: nowIso() }, committer: { name: store.viewerLogin, date: nowIso() } },
            url: '',
          },
          protected: false,
          protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
        });
        return true;
      }
      return false;
    }

    // Commits.
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        // ?sha=<branch|tag|commit> walks from that ref; without it, from the
        // default branch. An unknown ref is a 404.
        const shaParam = query.get('sha') ?? '';
        let head: string | null;
        if (shaParam !== '') {
          const branch = repo.branches.get(shaParam);
          if (branch !== undefined) head = branch.head;
          else if (repo.tags.has(shaParam)) head = tagTarget(repo, repo.tags.get(shaParam) as string);
          else if (repo.objects.get(shaParam)?.type === 'commit') head = shaParam;
          else {
            notFound(ctx, `No commit found for SHA: ${shaParam}`);
            return true;
          }
        } else {
          head = repo.branches.get(repo.defaultBranch)?.head ?? null;
        }
        const list: Record<string, unknown>[] = [];
        if (head !== null) {
          const seen = new Set<string>();
          const queue: string[] = [head];
          while (queue.length > 0) {
            const sha = queue.pop() as string;
            if (seen.has(sha)) continue;
            seen.add(sha);
            const obj = repo.objects.get(sha);
            if (obj === undefined || obj.type !== 'commit') continue;
            const parsed = parseCommit(obj.data);
            list.push(commitObject(store, repo, sha, parsed.message));
            queue.push(...parsed.parents);
          }
        }
        const { page, link } = paginate(list, query, req, ctx.path);
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = tail[1] as string;
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          notFound(ctx, 'Commit not found');
          return true;
        }
        sendJson(res, 200, commitObject(store, repo, sha, parseCommit(obj.data).message));
        return true;
      }
      return false;
    }

    // Contents.
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const branchName = isRecord(body) ? stringField(body, 'branch', '') : '';
      const branch = repo.branches.get(branchName !== '' ? branchName : repo.defaultBranch);
      if (method === 'GET') {
        if (branch === undefined || branch.head === null) {
          notFound(ctx, 'This repository is empty.');
          return true;
        }
        const entry = branch.files.get(contentPath);
        if (contentPath !== '' && entry !== undefined) {
          const obj = repo.objects.get(entry.sha);
          sendJson(res, 200, fileContentObject(store, repo, contentPath, entry.sha, obj?.data.length ?? 0));
          return true;
        }
        if (contentPath === '' || entry === undefined) {
          const isDir = contentPath === '' || [...branch.files.keys()].some((path) => path.startsWith(`${contentPath}/`));
          if (!isDir) {
            notFound(ctx, 'Not Found');
            return true;
          }
          sendJson(res, 200, dirContentObjects(store, repo, contentPath, branch.files));
          return true;
        }
        notFound(ctx);
        return true;
      }
      if (method === 'PUT') {
        if (!isRecord(body)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const message = stringField(body, 'message', 'Update file');
        const contentB64 = stringField(body, 'content');
        if (contentB64 === '') {
          unprocessable(ctx, 'content is required');
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          unprocessable(ctx, 'content is not valid base64');
          return true;
        }
        const sha = stringField(body, 'sha', '');
        const targetBranch = branchName !== '' ? branchName : repo.defaultBranch;
        let target = repo.branches.get(targetBranch);
        if (target === undefined) {
          target = { name: targetBranch, head: null, files: new Map() };
          repo.branches.set(targetBranch, target);
        }
        const existing = target.files.get(contentPath);
        if (existing !== undefined && sha !== '' && sha !== existing.sha) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const blobSha = putObject(repo, 'blob', content);
        const isNew = existing === undefined;
        const changes = new Map<string, { sha: string; mode: string } | null>();
        changes.set(contentPath, { sha: blobSha, mode: '100644' });
        const commitSha = store.createCommit(repo, targetBranch, message, changes);
        sendJson(res, isNew ? 201 : 200, {
          content: fileContentObject(store, repo, contentPath, blobSha, content.length),
          commit: commitObject(store, repo, commitSha, message),
        });
        return true;
      }
      if (method === 'DELETE') {
        if (!isRecord(body)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const message = stringField(body, 'message', 'Delete file');
        const targetBranch = branchName !== '' ? branchName : repo.defaultBranch;
        const target = repo.branches.get(targetBranch);
        if (target === undefined || target.files.get(contentPath) === undefined) {
          notFound(ctx, 'Not Found');
          return true;
        }
        const sha = stringField(body, 'sha', '');
        const existing = target.files.get(contentPath) as { sha: string; mode: string };
        if (sha !== '' && sha !== existing.sha) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const changes = new Map<string, { sha: string; mode: string } | null>();
        changes.set(contentPath, null);
        const commitSha = store.createCommit(repo, targetBranch, message, changes);
        sendJson(res, 200, { commit: commitObject(store, repo, commitSha, message) });
        return true;
      }
      return false;
    }

    // Labels.
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelObject(repo, label)));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(body)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const name = stringField(body, 'name');
        if (name === '') {
          unprocessable(ctx, 'name is required');
          return true;
        }
        const color = stringField(body, 'color', '');
        const colorHex = /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : blobShaOfText(name).slice(0, 6);
        const label = store.createLabel(repo, name, colorHex, stringField(body, 'description'));
        if (label === null) {
          unprocessable(ctx, 'Label already exists');
          return true;
        }
        sendJson(res, 201, labelObject(repo, label));
        return true;
      }
      return false;
    }

    // Issues.
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sortKey = query.get('sort') === 'updated' ? 'updatedAt' : 'createdAt';
          const dir = query.get('direction') === 'asc' ? 1 : -1;
          const list = [...repo.issues.values()]
            .filter((issue) => state === 'all' || issue.state === state)
            .sort((a, b) => {
              if (a[sortKey] === b[sortKey]) return dir * (a.number - b.number);
              return dir * (a[sortKey] < b[sortKey] ? -1 : 1);
            });
          const { page, link } = paginate(list, query, req, ctx.path);
          sendJson(res, 200, page.map((issue) => issueObject(store, repo, issue)), link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body)) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const title = stringField(body, 'title');
          if (title === '') {
            unprocessable(ctx, 'title is required');
            return true;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          try {
            const issue = store.createIssue(repo, title, stringField(body, 'body'), labels);
            sendJson(res, 201, issueObject(store, repo, issue));
          } catch (err) {
            unprocessable(ctx, err instanceof Error ? err.message : 'label does not exist');
          }
          return true;
        }
        return false;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isSafeInteger(number)) return false;
      const issue = repo.issues.get(number);
      if (tail.length === 2) {
        if (issue === undefined) {
          notFound(ctx, 'Issue not found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueObject(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!isRecord(body)) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const state = stringField(body, 'state', '');
          if (state === 'open' || state === 'closed') {
            issue.state = state;
            issue.closedAt = state === 'closed' ? nowIso() : null;
          }
          const title = stringField(body, 'title', '');
          if (title !== '') issue.title = title;
          const bodyText = stringField(body, 'body', '');
          if (bodyText !== '') issue.body = bodyText;
          issue.updatedAt = nowIso();
          sendJson(res, 200, issueObject(store, repo, issue));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          notFound(ctx, 'Issue not found');
          return true;
        }
        if (method === 'GET') {
          const { page, link } = paginate(issue.comments, query, req, ctx.path);
          sendJson(res, 200, page.map((comment) => commentObject(store, repo, issue, comment)), link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body)) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const text = stringField(body, 'body');
          if (text === '') {
            unprocessable(ctx, 'body is required');
            return true;
          }
          const now = nowIso();
          const comment: Issue['comments'][number] = {
            id: globalId('IC', `${repo.owner}/${repo.name}:${issue.number}:${issue.comments.length + 1}`),
            num: issue.comments.length + 1,
            body: text,
            user: store.viewerLogin,
            createdAt: now,
            updatedAt: now,
          };
          issue.comments.push(comment);
          issue.updatedAt = now;
          sendJson(res, 201, commentObject(store, repo, issue, comment));
          return true;
        }
        return false;
      }
      return false;
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = [...repo.pulls.values()]
            .filter((pull) => state === 'all' || pull.state === state)
            .sort((a, b) => b.number - a.number);
          const { page, link } = paginate(list, query, req, ctx.path);
          sendJson(res, 200, page.map((pull) => pullObject(store, repo, pull)), link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body)) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const title = stringField(body, 'title');
          const headRaw = stringField(body, 'head');
          const baseRaw = stringField(body, 'base');
          const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
          const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
          if (title === '' || head === '' || base === '') {
            unprocessable(ctx, 'title, head and base are required');
            return true;
          }
          if (!repo.branches.has(head)) {
            unprocessable(ctx, 'Head branch does not exist');
            return true;
          }
          if (!repo.branches.has(base)) {
            unprocessable(ctx, 'Base branch does not exist');
            return true;
          }
          const pull = store.createPull(repo, title, stringField(body, 'body'), head, base);
          if (pull === null) {
            unprocessable(ctx, 'A pull request already exists for this head branch');
            return true;
          }
          sendJson(res, 201, pullObject(store, repo, pull));
          return true;
        }
        return false;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isSafeInteger(number)) return false;
      const pull = repo.pulls.get(number);
      if (tail.length === 2) {
        if (pull === undefined) {
          notFound(ctx, 'Pull request not found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullObject(store, repo, pull));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          notFound(ctx, 'Pull request not found');
          return true;
        }
        if (pull.merged) {
          sendJson(res, 405, { message: 'Pull request is already merged' });
          return true;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is closed' });
          return true;
        }
        const sha = store.squashMerge(repo, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return true;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          notFound(ctx, 'Pull request not found');
          return true;
        }
        const head = repo.branches.get(pull.headRef);
        const base = repo.branches.get(pull.baseRef);
        const files: Record<string, unknown>[] = [];
        if (head?.head != null && base?.head != null) {
          const headFiles = filesAtCommit(repo, head.head);
          const baseFiles = filesAtCommit(repo, base.head);
          for (const path of changedPaths(baseFiles, headFiles)) {
            const oldBlob = baseFiles.get(path);
            const newBlob = headFiles.get(path);
            const oldText = oldBlob === undefined ? '' : (repo.objects.get(oldBlob.sha)?.data.toString('utf8') ?? '');
            const newText = newBlob === undefined ? '' : (repo.objects.get(newBlob.sha)?.data.toString('utf8') ?? '');
            const [added, removed] = lineDiff(oldText, newText);
            const status = oldBlob === undefined ? 'added' : newBlob === undefined ? 'removed' : 'modified';
            files.push({
              sha: newBlob?.sha ?? oldBlob?.sha ?? '',
              filename: path,
              status,
              additions: added,
              deletions: removed,
              changes: added + removed,
              blob_url: '',
              raw_url: '',
              contents_url: '',
              patch: '',
            });
          }
        }
        sendJson(res, 200, files);
        return true;
      }
      return false;
    }

    // Git refs: create (POST) and read (GET).
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (!isRecord(body)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!/^refs\/(heads|tags)\/.+/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
          unprocessable(ctx, 'ref and sha are required');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (obj === undefined) {
          unprocessable(ctx, 'sha does not exist');
          return true;
        }
        if (ref.startsWith('refs/heads/')) {
          if (obj.type !== 'commit') {
            unprocessable(ctx, 'sha is not a commit');
            return true;
          }
          const name = ref.slice('refs/heads/'.length);
          if (repo.branches.has(name)) {
            unprocessable(ctx, 'Reference already exists');
            return true;
          }
          repo.branches.set(name, { name, head: sha, files: filesAtCommit(repo, sha) });
          sendJson(res, 201, {
            ref,
            node_id: globalId('REF', `${repo.owner}/${repo.name}:${ref}`),
            url: '',
            object: { sha, type: 'commit', url: '' },
          });
          return true;
        }
        const name = ref.slice('refs/tags/'.length);
        if (repo.tags.has(name)) {
          unprocessable(ctx, 'Reference already exists');
          return true;
        }
        repo.tags.set(name, sha);
        sendJson(res, 201, {
          ref,
          node_id: globalId('REF', `${repo.owner}/${repo.name}:${ref}`),
          url: '',
          object: { sha, type: obj.type, url: '' },
        });
        return true;
      }
      if (method !== 'GET') return false;
      if (tail.length === 2) {
        const refs: Record<string, unknown>[] = [];
        for (const branch of [...repo.branches.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (branch.head !== null) {
            refs.push({
              ref: `refs/heads/${branch.name}`,
              node_id: globalId('REF', `${repo.owner}/${repo.name}:refs/heads/${branch.name}`),
              url: '',
              object: { sha: branch.head, type: 'commit', url: '' },
            });
          }
        }
        for (const [name, oid] of [...repo.tags.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          refs.push({
            ref: `refs/tags/${name}`,
            node_id: globalId('REF', `${repo.owner}/${repo.name}:refs/tags/${name}`),
            url: '',
            object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' },
          });
        }
        sendJson(res, 200, refs);
        return true;
      }
      const refName = tail.slice(2).join('/');
      if (refName.startsWith('tags/')) {
        const oid = repo.tags.get(refName.slice('tags/'.length));
        if (oid === undefined) {
          notFound(ctx, 'Reference not found');
          return true;
        }
        sendJson(res, 200, {
          ref: `refs/${refName}`,
          node_id: globalId('REF', `${repo.owner}/${repo.name}:refs/${refName}`),
          url: '',
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' },
        });
        return true;
      }
      const branch = repo.branches.get(refName.replace(/^heads\//, ''));
      if (branch === undefined || branch.head === null) {
        notFound(ctx, 'Reference not found');
        return true;
      }
      sendJson(res, 200, {
        ref: `refs/${refName}`,
        node_id: globalId('REF', `${repo.owner}/${repo.name}:refs/${refName}`),
        url: '',
        object: { sha: branch.head, type: 'commit', url: '' },
      });
      return true;
    }
  }

  return false;
}
