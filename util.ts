// ForgeCrypto — small shared helpers: hashing, pkt-line framing, deterministic
// time, JSON answers. Node 22 standard library only; nothing here touches the
// network, the clock, or any randomness.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** SHA-1 of bytes or text, as lowercase hex (git's object id). */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Base64url of bytes, no padding (opaque global ids). */
export function b64url(data: Buffer): string {
  return data.toString('base64url');
}

/** An opaque, stable global id for one entity: prefix + base64url(SHA-1(kind + ':' + key)). */
export function globalId(prefix: string, key: string): string {
  return `${prefix}_${b64url(createHash('sha1').update(`${prefix}:${key}`).digest())}`;
}

/** One pkt-line: 4 hex digits of (4 + payload bytes) + payload. */
export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const size = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The pkt-line flush packet. */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');

/** Several pkt-lines plus a flush, concatenated. */
export function pktLines(...texts: readonly string[]): Buffer {
  return Buffer.concat([...texts.map(pktLine), PKT_FLUSH]);
}

/**
 * Parse a pkt-line stream: returns the text lines (without their length prefix)
 * up to the first flush, and the byte offset just past that flush. A line that is
 * not valid pkt-line framing throws. The v2 delim packet (0001) between a command
 * and its arguments is skipped; a response-end packet (0002) stops the parse.
 */
export function parsePktLines(buf: Buffer): { lines: string[]; afterFlush: number } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('pkt-line stream ends mid-length');
    const size = Number.parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size) || size < 0) throw new Error('pkt-line stream has a bad length');
    if (size === 0) return { lines, afterFlush: offset + 4 };
    if (size === 1) {
      offset += 4;
      continue;
    }
    if (size === 2) return { lines, afterFlush: offset + 4 };
    if (size < 4 || offset + size > buf.length) throw new Error('pkt-line stream ends mid-line');
    lines.push(buf.subarray(offset + 4, offset + size).toString('utf8'));
    offset += size;
  }
}

/** Read a whole request body as bytes, up to `limit` bytes (default 64 MiB). */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; throws on malformed JSON or a non-object body. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw new Error('malformed JSON');
  }
}

/** Parse an ISO-8601 timestamp into epoch milliseconds, or null when invalid. Pure arithmetic, no Date construction, so the trial clock stays deterministic. */
function parseIsoToEpochMs(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (match === null) return null;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  const hour = Number.parseInt(match[4] as string, 10);
  const minute = Number.parseInt(match[5] as string, 10);
  const second = Number.parseInt(match[6] as string, 10);
  const millis = match[7] === undefined ? 0 : Number.parseInt((match[7] as string).padEnd(3, '0'), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  let epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const zone = match[8];
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetMin = Number.parseInt(digits.slice(0, 2), 10) * 60 + Number.parseInt(digits.slice(2, 4), 10);
    epochMs -= sign * offsetMin * 60_000;
  }
  return epochMs;
}

/** Format epoch milliseconds as an ISO-8601 UTC string (civil-from-days). */
function epochMsToIso(epochMs: number): string {
  const totalSeconds = Math.floor(epochMs / 1000);
  const millis = epochMs - totalSeconds * 1000;
  const days = Math.floor(totalSeconds / 86400);
  const secondsOfDay = totalSeconds - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`;
}

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW when set, else a fixed constant. */
export function nowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const epochMs = parseIsoToEpochMs(raw);
    if (epochMs !== null) return epochMsToIso(epochMs);
  }
  return '2025-01-01T00:00:00.000Z';
}

/** The trial's fixed epoch seconds, matching nowIso(). */
export function nowEpochSec(): number {
  const epochMs = parseIsoToEpochMs(nowIso());
  return epochMs === null ? 1735689600 : Math.floor(epochMs / 1000);
}

/** A git-style author line timestamp: "<epoch> +0000". */
export function gitTimestamp(): string {
  return `${nowEpochSec()} +0000`;
}

let requestSeq = 0;

/** A deterministic per-request id (counter only, so replays agree). */
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

/** Whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string field of a record, or `fallback` when it is missing or not a string. */
export function stringField(record: Record<string, unknown>, name: string, fallback = ''): string {
  const value = record[name];
  return typeof value === 'string' ? value : fallback;
}

/** A boolean field of a record, or `fallback` when it is missing or not a boolean. */
export function boolField(record: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = record[name];
  return typeof value === 'boolean' ? value : fallback;
}

/** Send a JSON body with the given status and extra headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Send raw bytes with the given status, content type and extra headers. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

/** The path part of a request URL, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
