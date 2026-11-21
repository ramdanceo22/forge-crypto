// ForgeCrypto — the GraphQL v4 endpoint: a small parser for the documents gh
// and github-mcp-server send, plus resolvers over the same store REST uses.
// Unknown fields answer HTTP 200 with an `errors` array naming the field;
// an unknown repository answers data.repository = null with no errors.

import {
  filesAtCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { globalId, isRecord } from './util.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
      } else if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.expectName();
        const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
        this.skipDirectives();
        operations.push({ operation: keyword, name, variables, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected keyword ${keyword} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; type: string; defaultValue: ValueNode | null }[] {
    const defs: { name: string; type: string; defaultValue: ValueNode | null }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    if (this.isPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let type = `[${inner}]`;
      if (this.isPunct('!')) {
        this.next();
        type += '!';
      }
      return type;
    }
    const name = this.expectName();
    let type = name;
    if (this.isPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        const token = this.peek();
        if (token.kind === 'name' && token.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (token.kind === 'name') {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selection = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(constValue: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (constValue) throw new Error('a variable is not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue(constValue));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constValue) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Resolve a value node against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- introspection data

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'url'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files',
  'body', 'createdAt', 'updatedAt', 'author', 'headRef', 'baseRef', 'mergeCommit', 'url',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  'createdAt', 'updatedAt', 'isPrivate', 'fork',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------- execution

/** One resolved value plus the type it carries, for nested selections. */
interface Resolved {
  kind: string;
  value: unknown;
}

interface ExecContext {
  store: Store;
  doc: DocumentNode;
  variables: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function stringArg(field: FieldNode, name: string, ctx: ExecContext): string {
  const value = argValue(field, name, ctx);
  return typeof value === 'string' ? value : '';
}

function intArg(field: FieldNode, name: string, ctx: ExecContext): number | undefined {
  const value = argValue(field, name, ctx);
  return typeof value === 'number' ? value : undefined;
}

function findRepoById(store: Store, id: string): Repo | null {
  for (const repo of store.repos.values()) {
    if (store.repoGlobalId(repo) === id) return repo;
  }
  return null;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return null;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return null;
}

function sortedIssues(repo: Repo): Issue[] {
  return [...repo.issues.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? b.number - a.number : a.createdAt < b.createdAt ? 1 : -1,
  );
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(store: Store, repo: Repo, pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(store: Store, repo: Repo, pull: PullRequest): string {
  return store.pullMergeable(repo, pull);
}

/** Resolve one field of a parent value. */
function resolveField(parent: Resolved, field: FieldNode, ctx: ExecContext): Resolved | null {
  const { store } = ctx;
  const name = field.name;
  switch (parent.kind) {
    case 'Query': {
      if (name === 'viewer') return { kind: 'User', value: { login: store.viewerLogin } };
      if (name === 'repository') {
        const owner = stringArg(field, 'owner', ctx);
        const repoName = stringArg(field, 'name', ctx);
        const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;
        return { kind: 'Repository', value: repo ?? null };
      }
      if (name === 'node') {
        const id = stringArg(field, 'id', ctx);
        const repo = findRepoById(store, id);
        return { kind: 'Repository', value: repo };
      }
      if (name === '__type') {
        const typeName = stringArg(field, 'name', ctx);
        const known = typeName === 'Issue' || typeName === 'PullRequest' || typeName === 'Repository' || typeName === 'SearchType';
        return { kind: '__Type', value: known ? typeName : null };
      }
      if (name === '__schema') {
        return { kind: '__Schema', value: {} };
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
      return null;
    }
    case 'User': {
      if (name === 'login') return { kind: 'Scalar', value: (parent.value as { login: string }).login };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "User".` });
      return null;
    }
    case 'Repository': {
      const repo = parent.value as Repo;
      if (name === 'id') return { kind: 'Scalar', value: store.repoGlobalId(repo) };
      if (name === 'databaseId') return { kind: 'Scalar', value: repo.id };
      if (name === 'name') return { kind: 'Scalar', value: repo.name };
      if (name === 'nameWithOwner') return { kind: 'Scalar', value: `${repo.owner}/${repo.name}` };
      if (name === 'owner') return { kind: 'User', value: { login: repo.owner } };
      if (name === 'defaultBranchRef') {
        const branch = repo.branches.get(repo.defaultBranch);
        if (branch === undefined || branch.head === null) return { kind: 'Ref', value: null };
        return { kind: 'Ref', value: { name: repo.defaultBranch } };
      }
      if (name === 'viewerPermission') return { kind: 'Scalar', value: 'ADMIN' };
      if (name === 'hasIssuesEnabled') return { kind: 'Scalar', value: true };
      if (name === 'description') return { kind: 'Scalar', value: repo.description };
      if (name === 'isPrivate') return { kind: 'Scalar', value: repo.isPrivate };
      if (name === 'createdAt') return { kind: 'Scalar', value: repo.createdAt };
      if (name === 'updatedAt') return { kind: 'Scalar', value: repo.updatedAt };
      if (name === 'url') return { kind: 'Scalar', value: '' };
      if (name === 'issue') {
        const number = intArg(field, 'number', ctx);
        const issue = number === undefined ? undefined : repo.issues.get(number);
        return { kind: 'Issue', value: issue ?? null };
      }
      if (name === 'issues') {
        const states = argValue(field, 'states', ctx);
        const orderBy = argValue(field, 'orderBy', ctx);
        const first = intArg(field, 'first', ctx);
        const after = argValue(field, 'after', ctx);
        let list = sortedIssues(repo);
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state)));
          list = list.filter((issue) => wanted.has(issueState(issue)));
        }
        if (isRecord(orderBy)) {
          const orderField = String(orderBy.field ?? 'CREATED_AT');
          const direction = String(orderBy.direction ?? 'DESC');
          const key = orderField === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
          list = [...list].sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            if (av === bv) return direction === 'ASC' ? a.number - b.number : b.number - a.number;
            return direction === 'ASC' ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
          });
        }
        let afterNumber: number | null = null;
        if (typeof after === 'string' && after !== '') afterNumber = decodeCursor(after);
        if (afterNumber !== null) {
          const index = list.findIndex((issue) => issue.number === afterNumber);
          if (index >= 0) list = list.slice(index + 1);
        }
        const total = list.length;
        const limited = first === undefined ? list : list.slice(0, first);
        const endCursor = limited.length > 0 ? encodeCursor((limited[limited.length - 1] as Issue).number) : null;
        return {
          kind: 'IssueConnection',
          value: { nodes: limited, pageInfo: { hasNextPage: limited.length < total, endCursor } },
        };
      }
      if (name === 'pullRequests') {
        const first = intArg(field, 'first', ctx);
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        return { kind: 'PullRequestConnection', value: { nodes: first === undefined ? list : list.slice(0, first) } };
      }
      if (name === 'pullRequest') {
        const number = intArg(field, 'number', ctx);
        const pull = number === undefined ? undefined : repo.pulls.get(number);
        return { kind: 'PullRequest', value: pull ?? null };
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
      return null;
    }
    case 'Ref': {
      if (name === 'name') return { kind: 'Scalar', value: (parent.value as { name: string }).name };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
      return null;
    }
    case 'Issue': {
      const issue = parent.value as Issue;
      if (name === 'id') return { kind: 'Scalar', value: issue.id };
      if (name === 'number') return { kind: 'Scalar', value: issue.number };
      if (name === 'title') return { kind: 'Scalar', value: issue.title };
      if (name === 'state') return { kind: 'Scalar', value: issueState(issue) };
      if (name === 'body') return { kind: 'Scalar', value: issue.body };
      if (name === 'createdAt') return { kind: 'Scalar', value: issue.createdAt };
      if (name === 'updatedAt') return { kind: 'Scalar', value: issue.updatedAt };
      if (name === 'url') return { kind: 'Scalar', value: '' };
      if (name === 'author') return { kind: 'User', value: { login: issue.user } };
      if (name === 'comments') return { kind: 'IssueCommentConnection', value: { nodes: issue.comments } };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
      return null;
    }
    case 'PullRequest': {
      const pull = parent.value as PullRequest;
      const repo = findRepoForPull(store, pull);
      if (name === 'id') return { kind: 'Scalar', value: pull.id };
      if (name === 'number') return { kind: 'Scalar', value: pull.number };
      if (name === 'title') return { kind: 'Scalar', value: pull.title };
      if (name === 'state') return { kind: 'Scalar', value: repo === null ? 'OPEN' : pullState(store, repo, pull) };
      if (name === 'merged') return { kind: 'Scalar', value: pull.merged };
      if (name === 'mergeable') return { kind: 'Scalar', value: repo === null ? 'UNKNOWN' : pullMergeable(store, repo, pull) };
      if (name === 'headRefName') return { kind: 'Scalar', value: pull.headRef };
      if (name === 'baseRefName') return { kind: 'Scalar', value: pull.baseRef };
      if (name === 'body') return { kind: 'Scalar', value: pull.body };
      if (name === 'createdAt') return { kind: 'Scalar', value: pull.createdAt };
      if (name === 'updatedAt') return { kind: 'Scalar', value: pull.updatedAt };
      if (name === 'url') return { kind: 'Scalar', value: '' };
      if (name === 'author') return { kind: 'User', value: { login: pull.user } };
      if (name === 'files') {
        const first = intArg(field, 'first', ctx);
        const paths = repo === null ? [] : store.pullFiles(repo, pull);
        const limited = first === undefined ? paths : paths.slice(0, first);
        return { kind: 'PullRequestChangedFileConnection', value: { nodes: limited.map((path) => ({ path })) } };
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
      return null;
    }
    case 'IssueConnection': {
      const conn = parent.value as { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (name === 'nodes') return { kind: 'IssueList', value: conn.nodes };
      if (name === 'pageInfo') return { kind: 'PageInfo', value: conn.pageInfo };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueConnection".` });
      return null;
    }
    case 'PullRequestConnection': {
      const conn = parent.value as { nodes: PullRequest[] };
      if (name === 'nodes') return { kind: 'PullRequestList', value: conn.nodes };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestConnection".` });
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = parent.value as { nodes: { path: string }[] };
      if (name === 'nodes') return { kind: 'PullRequestChangedFileList', value: conn.nodes };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestChangedFileConnection".` });
      return null;
    }
    case 'IssueCommentConnection': {
      const conn = parent.value as { nodes: Issue['comments'] };
      if (name === 'nodes') return { kind: 'IssueCommentList', value: conn.nodes };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueCommentConnection".` });
      return null;
    }
    case 'IssueList': {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
      return null;
    }
    case 'PullRequestList': {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
      return null;
    }
    case 'PullRequestChangedFileList': {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestChangedFile".` });
      return null;
    }
    case 'IssueCommentList': {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueComment".` });
      return null;
    }
    case 'PageInfo': {
      const info = parent.value as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return { kind: 'Scalar', value: info.hasNextPage };
      if (name === 'endCursor') return { kind: 'Scalar', value: info.endCursor };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
      return null;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return { kind: 'Scalar', value: (parent.value as { path: string }).path };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestChangedFile".` });
      return null;
    }
    case 'IssueComment': {
      const comment = parent.value as Issue['comments'][number];
      if (name === 'id') return { kind: 'Scalar', value: comment.id };
      if (name === 'body') return { kind: 'Scalar', value: comment.body };
      if (name === 'author') return { kind: 'User', value: { login: comment.user } };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueComment".` });
      return null;
    }
    case '__Type': {
      const typeName = parent.value as string;
      if (name === 'name') return { kind: 'Scalar', value: typeName };
      if (name === 'kind') {
        return { kind: 'Scalar', value: typeName === 'SearchType' ? 'ENUM' : 'OBJECT' };
      }
      if (name === 'fields') {
        const fields =
          typeName === 'Issue'
            ? ISSUE_FIELDS
            : typeName === 'PullRequest'
              ? PULL_REQUEST_FIELDS
              : typeName === 'Repository'
                ? REPOSITORY_FIELDS
                : [];
        return { kind: '__FieldList', value: fields.map((fieldName) => ({ name: fieldName })) };
      }
      if (name === 'enumValues') {
        const values = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : [];
        return { kind: '__EnumValueList', value: values.map((value) => ({ name: value })) };
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
      return null;
    }
    case '__Field': {
      if (name === 'name') return { kind: 'Scalar', value: (parent.value as { name: string }).name };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "__Field".` });
      return null;
    }
    case '__FieldList':
    case '__EnumValueList': {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return { kind: '__Type', value: 'Query' };
      if (name === 'mutationType') return { kind: '__Type', value: 'Mutation' };
      ctx.errors.push({ message: `Cannot query field "${name}" on type "__Schema".` });
      return null;
    }
    case 'Mutation': {
      return resolveMutation(parent, field, ctx);
    }
    default: {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "${parent.kind}".` });
      return null;
    }
  }
}

/** The repository that owns a pull request (by global id). */
function findRepoForPull(store: Store, pull: PullRequest): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.pulls.get(pull.number)?.id === pull.id) return repo;
  }
  return null;
}

/** The mutation root's fields. */
function resolveMutation(parent: Resolved, field: FieldNode, ctx: ExecContext): Resolved | null {
  const { store } = ctx;
  const name = field.name;
  const input = argValue(field, 'input', ctx);
  const inputRecord = isRecord(input) ? input : {};
  if (name === 'createIssue') {
    const repositoryId = typeof inputRecord.repositoryId === 'string' ? inputRecord.repositoryId : '';
    const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
    const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
    const repo = findRepoById(store, repositoryId);
    if (repo === null || title === '') {
      ctx.errors.push({ message: 'createIssue: the repository does not exist.' });
      return null;
    }
    const issue = store.createIssue(repo, title, body, []);
    return { kind: 'CreateIssuePayload', value: { issue } };
  }
  if (name === 'closeIssue') {
    const issueId = typeof inputRecord.issueId === 'string' ? inputRecord.issueId : '';
    const found = findIssueById(store, issueId);
    if (found === null) {
      ctx.errors.push({ message: 'closeIssue: the issue does not exist.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = found.issue.updatedAt;
    return { kind: 'CloseIssuePayload', value: { issue: found.issue } };
  }
  if (name === 'createPullRequest') {
    const repositoryId = typeof inputRecord.repositoryId === 'string' ? inputRecord.repositoryId : '';
    const baseRefName = typeof inputRecord.baseRefName === 'string' ? inputRecord.baseRefName : '';
    const headRefName = typeof inputRecord.headRefName === 'string' ? inputRecord.headRefName : '';
    const title = typeof inputRecord.title === 'string' ? inputRecord.title : '';
    const repo = findRepoById(store, repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'createPullRequest: the repository does not exist.' });
      return null;
    }
    const pull = store.createPull(repo, title, '', headRefName, baseRefName);
    if (pull === null) {
      ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head branch.' });
      return null;
    }
    return { kind: 'CreatePullRequestPayload', value: { pullRequest: pull, repo } };
  }
  if (name === 'mergePullRequest') {
    const pullRequestId = typeof inputRecord.pullRequestId === 'string' ? inputRecord.pullRequestId : '';
    const found = findPullById(store, pullRequestId);
    if (found === null) {
      ctx.errors.push({ message: 'mergePullRequest: the pull request does not exist.' });
      return null;
    }
    const sha = store.squashMerge(found.repo, found.pull);
    if (sha === null) {
      ctx.errors.push({ message: 'mergePullRequest: the pull request conflicts.' });
      return null;
    }
    return { kind: 'MergePullRequestPayload', value: { pullRequest: found.pull, repo: found.repo } };
  }
  if (name === 'addComment') {
    const subjectId = typeof inputRecord.subjectId === 'string' ? inputRecord.subjectId : '';
    const body = typeof inputRecord.body === 'string' ? inputRecord.body : '';
    const found = findIssueById(store, subjectId);
    if (found === null) {
      ctx.errors.push({ message: 'addComment: the subject does not exist.' });
      return null;
    }
    const comment = {
      id: globalId('IC', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${found.issue.comments.length + 1}`),
      body,
      user: store.viewerLogin,
      createdAt: found.issue.createdAt,
      updatedAt: found.issue.createdAt,
    };
    found.issue.comments.push(comment);
    return { kind: 'AddCommentPayload', value: { commentEdge: { node: comment } } };
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

/** Resolve a selection set against a parent value, returning the JSON object. */
function executeSelection(
  parent: Resolved,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (parent.value === null || parent.value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined) {
        const nested = executeSelection(parent, fragment.selection, ctx);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parent.kind) {
        const nested = executeSelection(parent, selection.selection, ctx);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = resolveField(parent, field, ctx);
    if (resolved === null) {
      out[key] = null;
      continue;
    }
    out[key] = executeValue(resolved, field.selection, ctx);
  }
  return out;
}

/** Execute a resolved field's sub-selection (or return the scalar/list value). */
function executeValue(resolved: Resolved, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (selection === null) return resolved.value;
  if (resolved.value === null || resolved.value === undefined) return null;
  if (resolved.kind === 'IssueList') {
    return (resolved.value as Issue[]).map((issue) => executeSelection({ kind: 'Issue', value: issue }, selection, ctx));
  }
  if (resolved.kind === 'PullRequestList') {
    return (resolved.value as PullRequest[]).map((pull) =>
      executeSelection({ kind: 'PullRequest', value: pull }, selection, ctx),
    );
  }
  if (resolved.kind === 'PullRequestChangedFileList') {
    return (resolved.value as { path: string }[]).map((file) =>
      executeSelection({ kind: 'PullRequestChangedFile', value: file }, selection, ctx),
    );
  }
  if (resolved.kind === 'IssueCommentList') {
    return (resolved.value as Issue['comments']).map((comment) =>
      executeSelection({ kind: 'IssueComment', value: comment }, selection, ctx),
    );
  }
  if (resolved.kind === '__FieldList' || resolved.kind === '__EnumValueList') {
    return (resolved.value as { name: string }[]).map((entry) => executeSelection({ kind: '__Field', value: entry }, selection, ctx));
  }
  if (resolved.kind === 'CreateIssuePayload') {
    const payload = resolved.value as { issue: Issue };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'issue') {
        out[sel.field.alias ?? 'issue'] = executeSelection({ kind: 'Issue', value: payload.issue }, sel.field.selection ?? [], ctx);
      }
    }
    return out;
  }
  if (resolved.kind === 'CloseIssuePayload') {
    const payload = resolved.value as { issue: Issue };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'issue') {
        out[sel.field.alias ?? 'issue'] = executeSelection({ kind: 'Issue', value: payload.issue }, sel.field.selection ?? [], ctx);
      }
    }
    return out;
  }
  if (resolved.kind === 'CreatePullRequestPayload') {
    const payload = resolved.value as { pullRequest: PullRequest; repo: Repo };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'pullRequest') {
        out[sel.field.alias ?? 'pullRequest'] = executeSelection(
          { kind: 'PullRequest', value: payload.pullRequest },
          sel.field.selection ?? [],
          ctx,
        );
      }
    }
    return out;
  }
  if (resolved.kind === 'MergePullRequestPayload') {
    const payload = resolved.value as { pullRequest: PullRequest; repo: Repo };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'pullRequest') {
        out[sel.field.alias ?? 'pullRequest'] = executeSelection(
          { kind: 'PullRequest', value: payload.pullRequest },
          sel.field.selection ?? [],
          ctx,
        );
      }
    }
    return out;
  }
  if (resolved.kind === 'AddCommentPayload') {
    const payload = resolved.value as { commentEdge: { node: Issue['comments'][number] } };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const inner of sel.field.selection ?? []) {
          if (inner.kind !== 'field') continue;
          if (inner.field.name === 'node') {
            edge[inner.field.alias ?? 'node'] = executeSelection(
              { kind: 'IssueComment', value: payload.commentEdge.node },
              inner.field.selection ?? [],
              ctx,
            );
          }
        }
        out[sel.field.alias ?? 'commentEdge'] = edge;
      }
    }
    return out;
  }
  if (resolved.kind === '__Field') {
    const entry = resolved.value as { name: string };
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      if (sel.field.name === 'name') out[sel.field.alias ?? 'name'] = entry.name;
    }
    return out;
  }
  return executeSelection(resolved, selection, ctx);
}

/** Execute one operation document. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: { message: string; path?: (string | number)[] }[] } {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode | null = doc.operations[0] ?? null;
  if (operationName !== undefined && operationName !== '') {
    operation = doc.operations.find((op) => op.name === operationName) ?? null;
  }
  if (operation === null) return { data: null, errors: [{ message: 'no operation to run' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (!(def.name in vars) && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: ExecContext = { store, doc, variables: vars, errors: [] };
  const rootKind = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection({ kind: rootKind, value: {} }, operation.selection, ctx);
  return { data, errors: ctx.errors };
}

/** Handle one GraphQL HTTP body (one operation or a batch array). */
export function handleGraphQL(
  store: Store,
  body: unknown,
): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'each batched operation needs a query string' }] };
      }
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      return executeGraphQL(store, entry.query, variables, operationName);
    });
    return { status: 200, payload: results };
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { status: 400, payload: { errors: [{ message: 'the request body needs a query string' }] } };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const result = executeGraphQL(store, body.query, variables, operationName);
  return { status: 200, payload: result };
}
