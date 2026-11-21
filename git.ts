// ForgeCrypto — the git layer: object storage, packfile reading and writing,
// delta application, and the smart-HTTP upload-pack (v2 and v0) and
// receive-pack (v0) protocols. Node 22 standard library only (crypto, zlib).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  filesAtCommit,
  isAncestor,
  parseCommit,
  parseTree,
  putObject,
  type FileEntry,
  type GitObject,
  type Repo,
} from './store.ts';
import { PKT_FLUSH, nowIso, parsePktLines, pktLine, pktLines, sha1 } from './util.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The agent string the forge advertises. */
const AGENT = 'forgecrypto/1.0';

/** Capabilities the v0 upload-pack advertisement carries. */
const UPLOAD_V0_CAPS = `multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow no-done agent=${AGENT}`;

/** Capabilities the v0 receive-pack advertisement carries. */
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// ---------------------------------------------------------------- packfiles

/** One entry of a packfile before delta resolution. */
interface PackEntry {
  type: number;
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

/** Read a packfile's variable-length size/type header. */
function readSizeType(buf: Buffer, offset: number): { type: number; size: number; next: number } {
  let byte = buf[offset] as number;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next };
}

/** Read an ofs-delta base offset (git's offset encoding). */
function readOfsOffset(buf: Buffer, offset: number): { offset: number; next: number } {
  let byte = buf[offset] as number;
  let value = byte & 0x7f;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[next] as number;
    next += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { offset: value, next };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size does not match');
  const parts: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || outLen !== resultSize) throw new Error('delta result size does not match');
  return out;
}

/** The object type names for pack type numbers. */
const PACK_TYPES: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Parse a whole packfile into objects (type + bytes). Deltas are resolved
 * against their bases wherever they sit in the pack.
 */
export function parsePack(buf: Buffer): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const { type, next } = readSizeType(buf, offset);
    offset = next;
    let entry: PackEntry;
    if (type === 6) {
      const { offset: baseOffset, next: after } = readOfsOffset(buf, offset);
      const data = inflateSync(buf.subarray(after));
      offset = after + (inflateSyncLength(buf.subarray(after)) as number);
      entry = { type, data, baseOffset: start - baseOffset };
    } else if (type === 7) {
      const baseSha = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const data = inflateSync(buf.subarray(offset));
      offset += inflateSyncLength(buf.subarray(offset));
      entry = { type, data, baseSha };
    } else {
      const data = inflateSync(buf.subarray(offset));
      offset += inflateSyncLength(buf.subarray(offset));
      entry = { type, data };
    }
    byOffset.set(start, entries.length);
    entries.push(entry);
  }
  const resolved: (GitObject | null)[] = entries.map(() => null);
  const resolve = (index: number, seen: Set<number>): GitObject => {
    const cached = resolved[index];
    if (cached !== null) return cached;
    if (seen.has(index)) throw new Error('delta cycle in packfile');
    seen.add(index);
    const entry = entries[index] as PackEntry;
    let result: GitObject;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in packfile');
        base = resolve(baseIndex, seen);
      } else if (entry.baseSha !== undefined) {
        const baseIndex = entries.findIndex((e, j) => resolved[j]?.type !== undefined && objectShaOf(resolved[j] as GitObject) === entry.baseSha);
        if (baseIndex < 0) throw new Error('ref-delta base not in packfile');
        base = resolve(baseIndex, seen);
      } else {
        throw new Error('delta without a base');
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = PACK_TYPES[entry.type];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.type}`);
      result = { type, data: entry.data };
    }
    resolved[index] = result;
    return result;
  };
  return entries.map((_, i) => resolve(i, new Set()));
}

/** The length of the zlib stream starting at `buf` (for pack parsing). */
function inflateSyncLength(buf: Buffer): number {
  // inflateSync consumes the whole stream; find its end by trial on the trailing
  // checksum: the stream ends 4 bytes (adler32) after the deflate data. We locate
  // it by inflating progressively: Node's zlib has no consumed-length output, so
  // scan for the end by trying inflateSync on growing prefixes is too slow.
  // Instead, use the fact that pack entries are followed by another entry or the
  // 20-byte pack checksum: try the stream end by binary search on length.
  let low = 1;
  let high = buf.length;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      best = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best < 0) throw new Error('zlib stream has no end in packfile');
  return best;
}

/** The sha of an already-resolved object (content-addressed, as git hashes it). */
function objectShaOf(obj: GitObject): string {
  const header = Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, obj.data]));
}

/** Encode a packfile header + objects (full objects only, no deltas). */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeNumbers: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const type = typeNumbers[obj.type];
    const size = obj.data.length;
    const sizeBytes: number[] = [];
    let remaining = size;
    let first = (type << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    sizeBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(obj.data));
  }
  const trailer = Buffer.concat(parts);
  const checksum = createHashSha1(trailer);
  return Buffer.concat([trailer, checksum]);
}

/** SHA-1 of bytes (the packfile trailer checksum). */
function createHashSha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

/**
 * Collect the objects an upload-pack must send: everything reachable from
 * `wants`, minus everything reachable from `haves`, limited to `deepen`
 * generations when set (1 = the wanted commits and their trees/blobs only).
 */
export function collectObjects(
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  deepen?: number,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const haveReachable = new Set<string>();
  const markReachable = (start: string): void => {
    const queue: string[] = [start];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (haveReachable.has(sha)) continue;
      haveReachable.add(sha);
      const obj = repo.objects.get(sha);
      if (obj === undefined) continue;
      if (obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        queue.push(parsed.tree, ...parsed.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) queue.push(entry.sha);
      }
    }
  };
  for (const have of haves) markReachable(have);
  const addTree = (treeSha: string): void => {
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree' || out.has(treeSha) || haveReachable.has(treeSha)) return;
    out.set(treeSha, obj);
    for (const entry of parseTree(obj.data)) {
      const child = repo.objects.get(entry.sha);
      if (child === undefined) continue;
      if (entry.mode === '40000') addTree(entry.sha);
      else if (!out.has(entry.sha) && !haveReachable.has(entry.sha)) out.set(entry.sha, child);
    }
  };
  const queue: { sha: string; depth: number }[] = wants.map((sha) => ({ sha, depth: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const { sha, depth } = queue.pop() as { sha: string; depth: number };
    if (seenCommits.has(sha) || haveReachable.has(sha)) continue;
    seenCommits.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.set(sha, obj);
    const parsed = parseCommit(obj.data);
    addTree(parsed.tree);
    if (deepen === undefined || depth + 1 < deepen) {
      for (const parent of parsed.parents) queue.push({ sha: parent, depth: depth + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- advertisements

/** The ref lines for a repository: HEAD first, then every branch. */
function refLines(repo: Repo): { sha: string; name: string }[] {
  const lines: { sha: string; name: string }[] = [];
  const defaultBranch = repo.branches.get(repo.defaultBranch);
  if (defaultBranch?.head !== null && defaultBranch?.head !== undefined) {
    lines.push({ sha: defaultBranch.head, name: 'HEAD' });
  }
  for (const branch of [...repo.branches.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (branch.head !== null) lines.push({ sha: branch.head, name: `refs/heads/${branch.name}` });
  }
  return lines;
}

/** The v0 advertisement for upload-pack or receive-pack (with the "# service=" preamble). */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = refLines(repo);
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`), PKT_FLUSH);
  } else {
    const [first, ...rest] = refs as [{ sha: string; name: string }, ...{ sha: string; name: string }[]];
    chunks.push(pktLine(`${first.sha} ${first.name}\0${caps}\n`));
    for (const ref of rest) chunks.push(pktLine(`${ref.sha} ${ref.name}\n`));
    chunks.push(PKT_FLUSH);
  }
  return Buffer.concat(chunks);
}

/** The v2 capability advertisement. */
export function advertisementV2(): Buffer {
  return pktLines(
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  );
}

/** Frame pack bytes as side-band-64k packets (channel byte 1, the raw value 0x01), then a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(offset + maxData, pack.length));
    const size = slice.length + 5;
    const head = Buffer.alloc(4);
    head.write(size.toString(16).padStart(4, '0'), 'ascii');
    chunks.push(Buffer.concat([head, Buffer.from([1]), slice]));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- upload-pack

/** The parsed pieces of an upload-pack request (v0 or v2). */
export interface UploadRequest {
  wants: string[];
  haves: string[];
  deepen?: number;
  refPrefixes: string[];
  command?: string;
}

/** Parse a v0 upload-pack request body. */
export function parseUploadV0(body: Buffer): UploadRequest {
  const { lines, afterFlush } = parsePktLines(body);
  void afterFlush;
  const req: UploadRequest = { wants: [], haves: [], refPrefixes: [] };
  for (const raw of lines) {
    const line = raw.split('\0')[0] as string;
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7).trim(), 10);
  }
  return req;
}

/** Parse a v2 upload-pack request body. */
export function parseUploadV2(body: Buffer): UploadRequest {
  const { lines } = parsePktLines(body);
  const req: UploadRequest = { wants: [], haves: [], refPrefixes: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('command=')) req.command = line.slice('command='.length);
    else if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('ref-prefix ')) req.refPrefixes.push(line.slice('ref-prefix '.length).trim());
  }
  return req;
}

/** Answer a v2 ls-refs request. */
export function answerLsRefs(repo: Repo, req: UploadRequest): Buffer {
  const lines: string[] = [];
  const defaultBranch = repo.branches.get(repo.defaultBranch);
  const hasCommits = defaultBranch?.head !== null && defaultBranch?.head !== undefined;
  const matches = (name: string): boolean =>
    req.refPrefixes.length === 0 || req.refPrefixes.some((prefix) => name.startsWith(prefix));
  if (!hasCommits) {
    if (matches('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
    return pktLines(...lines);
  }
  if (matches('HEAD') && defaultBranch?.head != null) {
    lines.push(`${defaultBranch.head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const branch of [...repo.branches.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = `refs/heads/${branch.name}`;
    if (branch.head !== null && matches(name)) lines.push(`${branch.head} ${name}\n`);
  }
  return pktLines(...lines);
}

/** Answer a v2 fetch request: shallow lines, then "packfile", then the packfile framed as side-band-64k (channel 1), then a flush. */
export function answerFetchV2(repo: Repo, req: UploadRequest): Buffer {
  const objects = collectObjects(repo, req.wants, new Set(req.haves), req.deepen);
  const pack = buildPack([...objects.values()].sort((a, b) => (objectShaOf(a) < objectShaOf(b) ? -1 : 1)));
  const chunks: Buffer[] = [];
  if (req.deepen !== undefined) {
    for (const want of req.wants) chunks.push(pktLine(`shallow ${want}\n`));
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandPack(pack));
  return Buffer.concat(chunks);
}

/** Answer a v0 upload-pack request: ACK lines for the haves we share, then NAK, shallow lines, then the sideband pack. */
export function answerUploadV0(repo: Repo, req: UploadRequest): Buffer {
  const objects = collectObjects(repo, req.wants, new Set(req.haves), req.deepen);
  const pack = buildPack([...objects.values()].sort((a, b) => (objectShaOf(a) < objectShaOf(b) ? -1 : 1)));
  const chunks: Buffer[] = [];
  for (const have of req.haves) {
    const obj = repo.objects.get(have);
    if (obj !== undefined && obj.type === 'commit') chunks.push(pktLine(`ACK ${have} continue\n`));
  }
  chunks.push(pktLine('NAK\n'));
  if (req.deepen !== undefined) {
    for (const want of req.wants) chunks.push(pktLine(`shallow ${want}\n`));
  }
  chunks.push(sidebandPack(pack));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- receive-pack

/** One ref update from a receive-pack request. */
export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Parse a v0 receive-pack request: ref updates, then the packfile bytes. */
export function parseReceive(body: Buffer): { updates: RefUpdate[]; pack: Buffer; sideband: boolean } {
  const { lines, afterFlush } = parsePktLines(body);
  const updates: RefUpdate[] = [];
  let sideband = false;
  for (const raw of lines) {
    const [head, caps] = raw.split('\0');
    if (caps !== undefined && caps.includes('side-band-64k')) sideband = true;
    const line = (head as string).trim();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/heads\/[^\s]+)\s*$/.exec(line);
    if (match !== null) {
      updates.push({ oldSha: match[1] as string, newSha: match[2] as string, ref: match[3] as string });
    }
  }
  return { updates, pack: body.subarray(afterFlush), sideband };
}

/**
 * Apply a receive-pack: store the pack's objects, then apply each ref update
 * (fast-forward only). Returns the report-status lines and whether the client
 * asked for side-band-64k framing.
 */
export function applyReceivePack(repo: Repo, body: Buffer): { lines: string[]; sideband: boolean } {
  const { updates, pack, sideband } = parseReceive(body);
  let objects: GitObject[] = [];
  if (pack.length > 0) objects = parsePack(pack);
  for (const obj of objects) {
    const sha = objectShaOf(obj);
    if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
  }
  const lines: string[] = ['unpack ok'];
  for (const update of updates) {
    const branchName = update.ref.replace('refs/heads/', '');
    const branch = repo.branches.get(branchName);
    const current = branch?.head ?? null;
    if (update.newSha === ZERO_OID) {
      if (current === null) {
        lines.push(`ng ${update.ref} no such ref`);
      } else if (update.oldSha !== ZERO_OID && update.oldSha !== current) {
        lines.push(`ng ${update.ref} old value does not match`);
      } else {
        repo.branches.delete(branchName);
        lines.push(`ok ${update.ref}`);
      }
      continue;
    }
    if (update.oldSha !== ZERO_OID && update.oldSha !== current) {
      lines.push(`ng ${update.ref} old value does not match`);
      continue;
    }
    const newObj = repo.objects.get(update.newSha);
    if (newObj === undefined || newObj.type !== 'commit') {
      lines.push(`ng ${update.ref} new commit not in pack`);
      continue;
    }
    if (current !== null && !isAncestor(repo, current, update.newSha)) {
      lines.push(`ng ${update.ref} non-fast-forward`);
      continue;
    }
    let target = repo.branches.get(branchName);
    if (target === undefined) {
      target = { name: branchName, head: null, files: new Map() };
      repo.branches.set(branchName, target);
    }
    target.head = update.newSha;
    target.files = filesAtCommit(repo, update.newSha);
    repo.updatedAt = nowIso();
    lines.push(`ok ${update.ref}`);
  }
  return { lines, sideband };
}

/**
 * Frame report-status lines. With side-band-64k the status lines are
 * themselves a pkt-line stream carried on sideband channel 1; without it
 * they are plain pkt-lines. Either way the stream ends with a flush.
 */
export function reportStatus(lines: readonly string[], sideband = true): Buffer {
  const framed = pktLines(...lines.map((line) => `${line}\n`));
  return sideband ? sidebandPack(framed) : framed;
}

/** The packfile checksum trailer helper (kept separate for clarity). */
export function packChecksum(packWithoutTrailer: Buffer): Buffer {
  return createHashSha1(packWithoutTrailer);
}
