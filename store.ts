// ForgeCrypto — the in-memory store: repositories, branches, git objects,
// issues, labels, pull requests and comments. Everything is deterministic:
// ids come from counters and hashes, timestamps from the trial's fixed now.

import { createHash } from 'node:crypto';
import { gitTimestamp, globalId, nowIso, sha1 } from './util.ts';

/** The token owner's login, from the suite's fixed scenario seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** One git object: its type and raw bytes. */
export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

/** One file in a branch's working tree: its blob sha and mode. */
export interface FileEntry {
  sha: string;
  mode: string;
}

/** One branch: its head commit and its flat file map. */
export interface Branch {
  name: string;
  head: string | null;
  files: Map<string, FileEntry>;
}

/** One label. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

/** One issue comment. */
export interface IssueComment {
  id: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

/** One issue. */
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

/** One pull request. */
export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

/** One repository. */
export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  branches: Map<string, Branch>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, Label>;
  labelSeq: number;
  pulls: Map<number, PullRequest>;
  pullSeq: number;
}

/** A parsed commit object. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** A parsed tree entry. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? '';
  const parents: string[] = [];
  for (const match of head.matchAll(/^parent ([0-9a-f]{40})$/gm)) {
    if (match[1] !== undefined) parents.push(match[1]);
  }
  return { tree, parents, message };
}

/** Parse a tree object's bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, offset);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from sorted entries; returns its bytes. */
export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Store one object, returning its sha (content-addressed, idempotent). */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = sha1(Buffer.concat([header, data]));
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** The flat file map of a commit, by walking its trees. */
export function filesAtCommit(repo: Repo, commitSha: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return out;
  const parsed = parseCommit(obj.data);
  const walk = (treeSha: string, prefix: string): void => {
    const treeObj = repo.objects.get(treeSha);
    if (treeObj === undefined || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  };
  walk(parsed.tree, '');
  return out;
}

/** Materialize a tree object for a flat file map, storing every tree; returns the root tree sha. */
export function materializeTree(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return putObject(repo, 'tree', buildTreeBytes(entries));
  };
  return build(root);
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits (the newest common ancestor), or null when none exists. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const current = queueA.pop() as string;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    queueA.push(...parseCommit(obj.data).parents);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const current = queueB.pop() as string;
    if (seenB.has(current)) continue;
    seenB.add(current);
    if (ancestorsA.has(current)) return current;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    queueB.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** The three-way merge of `head` into `base` over `mergeBaseFiles`; null when conflicted. */
export function threeWayMerge(
  baseFiles: Map<string, FileEntry>,
  headFiles: Map<string, FileEntry>,
  ancestorFiles: Map<string, FileEntry>,
): Map<string, FileEntry> | null {
  const merged = new Map<string, FileEntry>(baseFiles);
  const paths = new Set<string>([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const anc = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    const headChanged = (head?.sha ?? null) !== (anc?.sha ?? null);
    const baseChanged = (base?.sha ?? null) !== (anc?.sha ?? null);
    if (headChanged && baseChanged && (head?.sha ?? null) !== (base?.sha ?? null)) return null;
    if (headChanged) {
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
    }
  }
  return merged;
}

/** The paths that differ between two file maps. */
export function changedPaths(a: Map<string, FileEntry>, b: Map<string, FileEntry>): string[] {
  const out: string[] = [];
  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  for (const path of paths) {
    if ((a.get(path)?.sha ?? null) !== (b.get(path)?.sha ?? null)) out.push(path);
  }
  return out.sort();
}

/** A cheap line diff: [added, removed] counts by common prefix/suffix. */
export function lineDiff(oldText: string, newText: string): [number, number] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [newLines.length - prefix - suffix, oldLines.length - prefix - suffix];
}

/** The store: every repository, keyed by "owner/name". */
export class Store {
  readonly viewerLogin = VIEWER_LOGIN;
  readonly viewerId = VIEWER_ID;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextLabelSeq = 1;

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** Whether a Bearer token authenticates (exact match when the trial set one). */
  tokenOk(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (match === null) return false;
    const presented = match[1] as string;
    if (this.token === '') return presented !== '';
    return presented === this.token;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(this.viewerLogin, name))) return null;
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      branches: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 0,
      labels: new Map(),
      labelSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The repository's global (Relay) id: opaque, stable across reads. */
  repoGlobalId(repo: Repo): string {
    return globalId('R', `${repo.owner}/${repo.name}`);
  }

  /** Create a commit on a branch from a file delta; returns the commit sha. */
  createCommit(
    repo: Repo,
    branchName: string,
    message: string,
    changes: Map<string, FileEntry | null>,
    authorLogin: string = this.viewerLogin,
  ): string {
    let branch = repo.branches.get(branchName);
    if (branch === undefined) {
      branch = { name: branchName, head: null, files: new Map() };
      repo.branches.set(branchName, branch);
    }
    for (const [path, entry] of changes) {
      if (entry === null) branch.files.delete(path);
      else branch.files.set(path, entry);
    }
    const treeSha = materializeTree(repo, branch.files);
    const parents = branch.head === null ? [] : [branch.head];
    const stamp = gitTimestamp();
    const author = `${authorLogin} <${authorLogin}@example.invalid> ${stamp}`;
    let body = `tree ${treeSha}\n`;
    for (const parent of parents) body += `parent ${parent}\n`;
    body += `author ${author}\ncommitter ${author}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
    const sha = putObject(repo, 'commit', Buffer.from(body, 'utf8'));
    branch.head = sha;
    repo.updatedAt = nowIso();
    repo.pushedAt = nowIso();
    return sha;
  }

  /** Refresh a branch's file map from its head commit (after a push). */
  refreshBranchFiles(repo: Repo, branchName: string): void {
    const branch = repo.branches.get(branchName);
    if (branch === undefined || branch.head === null) return;
    branch.files = filesAtCommit(repo, branch.head);
  }

  /** Create a label; null when the name already exists. */
  createLabel(repo: Repo, name: string, color: string, description: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.nextLabelSeq, name, color, description };
    this.nextLabelSeq += 1;
    repo.labelSeq += 1;
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; throws when it names an unknown label. */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new Error(`label does not exist: ${name}`);
    }
    repo.issueSeq += 1;
    const number = repo.issueSeq;
    const now = nowIso();
    const issue: Issue = {
      id: globalId('I', `${repo.owner}/${repo.name}:${number}`),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewerLogin,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** Create a pull request; null when an open one already exists from the same head. */
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    for (const existing of repo.pulls.values()) {
      if (existing.headRef === headRef && existing.state === 'open') return null;
    }
    const head = repo.branches.get(headRef);
    const base = repo.branches.get(baseRef);
    repo.pullSeq += 1;
    const number = repo.pullSeq;
    const now = nowIso();
    const pull: PullRequest = {
      id: globalId('PR', `${repo.owner}/${repo.name}:${number}`),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha: head?.head ?? '',
      baseSha: base?.head ?? '',
      mergeCommitSha: null,
      mergedAt: null,
      closedAt: null,
      user: this.viewerLogin,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Whether a pull request merges cleanly right now. */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const head = repo.branches.get(pull.headRef);
    const base = repo.branches.get(pull.baseRef);
    if (head === undefined || base === undefined || head.head === null || base.head === null) return 'UNKNOWN';
    const ancestor = mergeBase(repo, head.head, base.head);
    if (ancestor === null) return 'UNKNOWN';
    const merged = threeWayMerge(filesAtCommit(repo, base.head), filesAtCommit(repo, head.head), filesAtCommit(repo, ancestor));
    return merged === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The paths a pull request changes (head vs merge-base). */
  pullFiles(repo: Repo, pull: PullRequest): string[] {
    const head = repo.branches.get(pull.headRef);
    const base = repo.branches.get(pull.baseRef);
    if (head === undefined || base === undefined || head.head === null || base.head === null) return [];
    const ancestor = mergeBase(repo, head.head, base.head);
    if (ancestor === null) return changedPaths(filesAtCommit(repo, base.head), filesAtCommit(repo, head.head));
    return changedPaths(filesAtCommit(repo, ancestor), filesAtCommit(repo, head.head));
  }

  /** Squash-merge a pull request; returns the squash commit sha, or null when conflicted. */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    const head = repo.branches.get(pull.headRef);
    const base = repo.branches.get(pull.baseRef);
    if (head === undefined || base === undefined || head.head === null || base.head === null) return null;
    const ancestor = mergeBase(repo, head.head, base.head);
    if (ancestor === null) return null;
    const merged = threeWayMerge(filesAtCommit(repo, base.head), filesAtCommit(repo, head.head), filesAtCommit(repo, ancestor));
    if (merged === null) return null;
    const now = nowIso();
    const changes = new Map<string, FileEntry | null>();
    const baseFiles = filesAtCommit(repo, base.head);
    for (const path of new Set([...baseFiles.keys(), ...merged.keys()])) {
      const entry = merged.get(path);
      if (entry === undefined) changes.set(path, null);
      else if (baseFiles.get(path)?.sha !== entry.sha) changes.set(path, entry);
    }
    const sha = this.createCommit(repo, pull.baseRef, `${pull.title} (#${pull.number})`, changes);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    return sha;
  }

  /** The SHA-1 of a blob's content (as git hashes it). */
  blobSha(content: Buffer): string {
    return putObjectShaless(content);
  }
}

/** The git blob id of content, without storing it. */
export function putObjectShaless(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, content]));
}

/** A short hash prefix for logs (never a full id). */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The SHA-1 of a UTF-8 string's blob form. */
export function blobShaOfText(text: string): string {
  return putObjectShaless(Buffer.from(text, 'utf8'));
}

/** The deterministic "now" used by every timestamp the forge writes. */
export function trialNow(): string {
  return nowIso();
}

/** A repo's node id as GitHub spells it (the same opaque id GraphQL returns). */
export function repoNodeId(repo: Repo): string {
  return globalId('R', `${repo.owner}/${repo.name}`);
}

/** A stable hash of a string, for opaque ids in tests. */
export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
