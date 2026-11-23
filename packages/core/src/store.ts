/**
 * Tiny file store shared by the worker (writer) and the API (reader). Plain JSON on disk, no native
 * database driver, so `npm install` never needs a compiler.
 *
 *   .data/board.json              latest BoardSnapshot (atomic replace)
 *   .data/history/YYYY-MM-DD.jsonl one compact line per poll
 *   .data/alert-state.json        per-symbol alert state
 *   .data/onchain.json            on-chain mirror log (reportMarket / breaker events, drills marked)
 *
 * Only the worker writes. The API only reads, so there is a single writer per file.
 */
import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardSnapshot, SymbolAlertState } from './board.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function dataDir(): string {
  return process.env.STOCKGUARD_DATA_DIR ? path.resolve(process.env.STOCKGUARD_DATA_DIR) : path.join(REPO_ROOT, '.data');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1));
  await rename(tmp, file);
}

// ---- board ----------------------------------------------------------------------------------
export const readBoard = () => readJson<BoardSnapshot | null>(path.join(dataDir(), 'board.json'), null);
export const writeBoard = (b: BoardSnapshot) => writeJsonAtomic(path.join(dataDir(), 'board.json'), b);

// ---- history --------------------------------------------------------------------------------
/** [symbol, navUsd, dexUsd, premiumBps] */
export type HistoryTuple = [string, number | null, number | null, number | null];
export interface HistoryLine {
  t: number;
  r: HistoryTuple[];
}

function dayFile(t: number): string {
  return path.join(dataDir(), 'history', `${new Date(t).toISOString().slice(0, 10)}.jsonl`);
}

export async function appendHistory(b: BoardSnapshot): Promise<void> {
  const line: HistoryLine = {
    t: b.generatedAt,
    r: b.rows.map((r) => [r.symbol, r.navUsd, r.dexUsd, r.premiumBps]),
  };
  const file = dayFile(b.generatedAt);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`);
}

export interface HistoryPoint {
  t: number;
  nav: number | null;
  dex: number | null;
  premiumBps: number | null;
}

export async function readHistory(symbol: string, hours = 24, maxPoints = 400): Promise<HistoryPoint[]> {
  const since = Date.now() - hours * 3600_000;
  const dir = path.join(dataDir(), 'history');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const firstDay = new Date(since).toISOString().slice(0, 10);
  const points: HistoryPoint[] = [];
  for (const f of files.filter((f) => f.slice(0, 10) >= firstDay)) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    for (const l of raw.split('\n')) {
      if (!l) continue;
      try {
        const line = JSON.parse(l) as HistoryLine;
        if (line.t < since) continue;
        const hit = line.r.find((x) => x[0] === symbol);
        if (hit) points.push({ t: line.t, nav: hit[1], dex: hit[2], premiumBps: hit[3] });
      } catch {
        /* skip a torn line */
      }
    }
  }
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => points[Math.floor(i * step)]);
}

// ---- alert state ----------------------------------------------------------------------------
export const readAlertState = () =>
  readJson<Record<string, SymbolAlertState>>(path.join(dataDir(), 'alert-state.json'), {});
export const writeAlertState = (s: Record<string, SymbolAlertState>) =>
  writeJsonAtomic(path.join(dataDir(), 'alert-state.json'), s);

// ---- on-chain mirror log --------------------------------------------------------------------
export interface OnchainEvent {
  at: number;
  kind: 'REGISTER' | 'REPORT' | 'HEARTBEAT' | 'DRILL' | 'BREAKER_TRIPPED' | 'BREAKER_CLEARED';
  symbol: string;
  asset: `0x${string}`;
  chainId: number;
  txHash: `0x${string}`;
  depegBps?: number;
  note?: string;
}

const onchainFile = () => path.join(dataDir(), 'onchain.json');
export const readOnchainLog = () => readJson<OnchainEvent[]>(onchainFile(), []);
export async function appendOnchainEvent(e: OnchainEvent): Promise<void> {
  const all = await readOnchainLog();
  all.push(e);
  await writeJsonAtomic(onchainFile(), all.slice(-500));
}
