import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from './store.js';

/**
 * Append-only, hash-chained audit trail.
 *
 * v1 wrote plain JSON lines, so any line could be edited or deleted without trace — it could not
 * honestly be called tamper-proof. v2 chains every record to the previous one:
 *   recordHash = sha256(canonical(record without recordHash))   and   record.prevHash = previous recordHash
 * verifyAuditChain() detects any edit, deletion or reordering. Anchoring the latest recordHash on-chain
 * (e.g. as StockGuardRegistry reportHash) makes the whole log externally verifiable.
 *
 * Note: reportHash / recordHash are SHA-256, not keccak256. Both fit a bytes32; say "SHA-256" in docs.
 */

export type AuditNetwork = 'base' | 'base-sepolia' | 'reactive' | 'offchain';

export interface AuditEntryInput {
  actor: string;
  network: AuditNetwork;
  action: string;
  assetAddress?: string;
  grade?: string;
  depegBps?: number;
  txHash?: string;
  /** Hash of the full evaluation payload (what gets attested on-chain). */
  reportHash?: `0x${string}`;
}

export interface AuditRecord extends AuditEntryInput {
  seq: number;
  timestamp: number;
  prevHash: `0x${string}`;
  recordHash: `0x${string}`;
}

const GENESIS = `0x${'0'.repeat(64)}` as const;
const MAX_FIELD = 200;

function auditFile(): string {
  const dir = process.env.STOCKGUARD_AUDIT_DIR ?? path.join(dataDir(), 'audit');
  return path.join(dir, 'stockguard-audit.jsonl');
}

/** Deterministic JSON: keys sorted at every depth, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeReportHash(payload: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

function clip(v: string | undefined): string | undefined {
  return v === undefined ? undefined : String(v).slice(0, MAX_FIELD);
}

async function readAll(): Promise<AuditRecord[]> {
  try {
    const raw = await readFile(auditFile(), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// Serialise appends inside this process so two requests cannot read the same prevHash.
let queue: Promise<unknown> = Promise.resolve();

export function appendAuditRecord(entry: AuditEntryInput): Promise<AuditRecord> {
  const run = async (): Promise<AuditRecord> => {
    const existing = await readAll();
    const last = existing[existing.length - 1];
    const body = {
      ...entry,
      actor: clip(entry.actor) ?? 'unknown',
      action: clip(entry.action) ?? 'unknown',
      assetAddress: clip(entry.assetAddress),
      txHash: clip(entry.txHash),
      seq: (last?.seq ?? 0) + 1,
      timestamp: Date.now(),
      prevHash: last?.recordHash ?? GENESIS,
    };
    const record: AuditRecord = { ...body, recordHash: computeReportHash(body) };
    const file = auditFile();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export async function readAuditRecords(limit = 50): Promise<AuditRecord[]> {
  const all = await readAll();
  return all.slice(-Math.max(1, Math.min(limit, 500))).reverse();
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  headHash: `0x${string}`;
  brokenAtSeq?: number;
  reason?: string;
}

export async function verifyAuditChain(): Promise<ChainVerification> {
  const all = await readAll();
  let prev: `0x${string}` = GENESIS;
  for (let i = 0; i < all.length; i++) {
    const { recordHash, ...body } = all[i];
    if (body.seq !== i + 1) return { ok: false, count: all.length, headHash: prev, brokenAtSeq: body.seq, reason: 'sequence gap' };
    if (body.prevHash !== prev) return { ok: false, count: all.length, headHash: prev, brokenAtSeq: body.seq, reason: 'prevHash mismatch' };
    if (computeReportHash(body) !== recordHash) return { ok: false, count: all.length, headHash: prev, brokenAtSeq: body.seq, reason: 'record edited' };
    prev = recordHash;
  }
  return { ok: true, count: all.length, headHash: prev };
}
