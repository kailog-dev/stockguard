/**
 * StockGuard XL — read-only routing verdicts for tokenized-stock pools on X Layer (chain 196).
 *
 *   GET /api/xl    latest .data/xl-board.json written by apps/worker/src/xl/guard.ts
 *
 * Kept in its own file so the Base / Reactive API surface is untouched.
 * No trading, swaps or order routing: the verdict says where NOT to route, it never routes.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { dataDir } from '@stockguard/core';

const STALE_SEC = 300;
const DISCLAIMER = 'Market-integrity data only. Not trading or investment advice. StockGuard never routes or executes trades.';

let cache: { mtimeMs: number; body: any } | null = null;

async function readXlBoard(): Promise<any | null> {
  const file = path.join(dataDir(), 'xl-board.json');
  try {
    const s = await stat(file);
    if (!cache || cache.mtimeMs !== s.mtimeMs) cache = { mtimeMs: s.mtimeMs, body: JSON.parse(await readFile(file, 'utf8')) };
    return cache.body;
  } catch {
    return null;
  }
}

export function registerXl(app: Hono) {
  app.get('/api/xl', async (c) => {
    const board = await readXlBoard();
    if (!board) return c.json({ error: 'X Layer board not ready yet' }, 503);
    const ageSec = Math.round((Date.now() - board.generatedAt) / 1000);
    c.header('Cache-Control', 'public, max-age=15');
    return c.json({ ...board, ageSec, stale: ageSec > STALE_SEC, disclaimer: DISCLAIMER });
  });
}
