/**
 * StockGuard API — read-only market-integrity data for Coinbase tokenized stocks on Base.
 * No trading, swaps, quotes-to-execute or order routing, by design.
 *
 * Free (humans, the web app):
 *   GET  /api/health
 *   GET  /api/board                    latest board written by the worker
 *   GET  /api/assets/:symbol           one row + 24h history + on-chain events
 *   GET  /api/history/:symbol?hours=24
 *   GET  /api/onchain                  Base Sepolia mirror log (reports, drills, breaker callbacks)
 *   GET  /api/alerts                   hash-chained alert log + chain verification
 *   POST /api/scan  { address }        "is this token an official Coinbase tokenized stock?"
 *   GET  /api/agent                    machine-readable description of the paid agent endpoint
 *   GET  /api/xl                       X Layer routing verdicts (apps/api/src/xl.ts)
 * Paid (agents, x402):
 *   GET  /api/agent/risk?symbol=AAPLc   same data as one board row, settled per call in USDC via x402
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import {
  BASE_SEPOLIA_ID,
  computeReportHash,
  dataDir,
  evaluateTokenizedStockRisk,
  fetchDexQuote,
  findOfficial,
  getOfficialRegistry,
  isEvmAddress,
  isUsMarketClosed,
  readAuditRecords,
  readBoard,
  readHistory,
  readOnchainLog,
  REACTIVE_CALLBACK_PROXY,
  RiskInputError,
  verifyAuditChain,
} from '@stockguard/core';
import { registerXl } from './xl.js';

const PORT = Number(process.env.PORT ?? 8787);
const STALE_BOARD_SEC = 300;
const DISCLAIMER =
  'Market-integrity data only. Not trading or investment advice. Coinbase tokenized stocks are not offered to US persons.';

const app = new Hono();

// ------------------------------------------------------------------ basics: CORS, body limit, rate limit
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use('*', cors({ origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null), exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'] }));
app.use('/api/*', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'Body too large' }, 413) }));

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
const hits = new Map<string, { count: number; resetAt: number }>();
const clientIp = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';

app.use('/api/*', async (c, next) => {
  const ip = clientIp(c);
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.resetAt) hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else if (++h.count > MAX_PER_WINDOW) return c.json({ error: 'Too many requests' }, 429);
  if (hits.size > 10_000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  await next();
});

app.onError((err, c) => {
  if (err instanceof RiskInputError) return c.json({ error: err.message }, 400);
  console.error('[api]', err);
  return c.json({ error: 'Internal error' }, 500);
});

// ------------------------------------------------------------------ usage counters (traction you can show)
// Per-UTC-day counters in .data/usage/YYYY-MM-DD.json. Every counter (not only new visitors) is persisted with a
// short debounce, and the day's file is reloaded on start, so a restart never loses or overwrites numbers.
// Visitors are counted with a salted hash of IP + user agent; raw IPs are never stored. A restart rotates the salt,
// so a returning visitor may be counted once more that day (documented, conservative to report as an upper bound).
interface DayUsage {
  day: string;
  visitors: number;
  boardRequests: number;
  scans: number;
  agentPaid: number;
}
const usage = { startedAt: Date.now(), today: { day: '', visitors: 0, boardRequests: 0, scans: 0, agentPaid: 0 } as DayUsage };
const seen = new Set<string>();
const SALT = crypto.randomUUID();
let saveTimer: NodeJS.Timeout | null = null;

function usageFile(day: string) {
  return path.join(dataDir(), 'usage', `${day}.json`);
}

function rollDay(): DayUsage {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.today.day !== day) {
    if (usage.today.day) flushUsage(); // close out yesterday
    seen.clear();
    let loaded: Partial<DayUsage> = {};
    try {
      loaded = JSON.parse(readFileSync(usageFile(day), 'utf8')) as Partial<DayUsage>;
    } catch {
      /* first request of the day */
    }
    usage.today = {
      day,
      visitors: Number(loaded.visitors) || 0,
      boardRequests: Number(loaded.boardRequests) || 0,
      scans: Number(loaded.scans) || 0,
      agentPaid: Number(loaded.agentPaid) || 0,
    };
  }
  return usage.today;
}

function flushUsage() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snap = { ...usage.today };
  if (!snap.day) return;
  try {
    mkdirSync(path.dirname(usageFile(snap.day)), { recursive: true });
    writeFileSync(usageFile(snap.day), JSON.stringify(snap));
  } catch (err) {
    console.error('[usage] save failed:', err instanceof Error ? err.message : err);
  }
}

function bump(field: 'boardRequests' | 'scans' | 'agentPaid', c?: Context) {
  const t = rollDay();
  t[field]++;
  if (c) {
    const id = createHash('sha256').update(`${SALT}|${t.day}|${clientIp(c)}|${c.req.header('user-agent') ?? ''}`).digest('hex');
    if (!seen.has(id)) {
      seen.add(id);
      t.visitors++;
    }
  }
  // paid calls are the most valuable number: write immediately; everything else within 5 s
  if (field === 'agentPaid') flushUsage();
  else if (!saveTimer) saveTimer = setTimeout(flushUsage, 5_000);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    flushUsage();
    process.exit(0);
  });
}

// ------------------------------------------------------------------ x402 (agents pay per call)
const X402_PAY_TO = process.env.X402_PAY_TO?.trim();
const X402_NETWORK = (process.env.X402_NETWORK?.trim() || 'eip155:84532') as `${string}:${string}`;
const X402_PRICE = process.env.X402_PRICE?.trim() || '$0.001';
const X402_FACILITATOR = process.env.X402_FACILITATOR_URL?.trim() || 'https://x402.org/facilitator';
const x402Enabled = Boolean(X402_PAY_TO && isEvmAddress(X402_PAY_TO));

if (x402Enabled) {
  const facilitator = new HTTPFacilitatorClient({ url: X402_FACILITATOR });
  const server = new x402ResourceServer(facilitator).register(X402_NETWORK, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        'GET /api/agent/risk': {
          accepts: [{ scheme: 'exact', price: X402_PRICE, network: X402_NETWORK, payTo: X402_PAY_TO as `0x${string}` }],
          description: 'StockGuard risk check for one Coinbase tokenized stock on Base (NAV vs DEX, grade, flags)',
          mimeType: 'application/json',
        },
      },
      server,
    ),
  );
}

// ------------------------------------------------------------------ helpers
async function boardOr503(c: Context) {
  const board = await readBoard();
  if (!board) {
    c.status(503);
    return { board: null, res: c.json({ error: 'No data yet — start the worker (npm run worker).' }) };
  }
  return { board, res: null };
}

function boardAgeSec(generatedAt: number) {
  return Math.round((Date.now() - generatedAt) / 1000);
}

// ------------------------------------------------------------------ routes
app.get('/api/health', async (c) => {
  const board = await readBoard();
  const age = board ? boardAgeSec(board.generatedAt) : null;
  return c.json({
    ok: age !== null && age < STALE_BOARD_SEC && board?.sources.registry.source !== 'unavailable',
    registry: board?.sources.registry ?? null,
    boardAgeSec: age,
    x402: x402Enabled ? { network: X402_NETWORK, price: X402_PRICE } : null,
    onchain: process.env.STOCKGUARD_REGISTRY_ADDRESS ? { chainId: BASE_SEPOLIA_ID, registry: process.env.STOCKGUARD_REGISTRY_ADDRESS } : null,
    usage: { startedAt: usage.startedAt, today: rollDay() },
  });
});

app.get('/api/board', async (c) => {
  const { board, res } = await boardOr503(c);
  if (!board) return res;
  bump('boardRequests', c);
  return c.json({ ...board, ageSec: boardAgeSec(board.generatedAt), stale: boardAgeSec(board.generatedAt) > STALE_BOARD_SEC, disclaimer: DISCLAIMER });
});

app.get('/api/assets/:symbol', async (c) => {
  const { board, res } = await boardOr503(c);
  if (!board) return res;
  const symbol = c.req.param('symbol').toUpperCase();
  const row = board.rows.find((r) => r.symbol.toUpperCase() === symbol);
  if (!row) return c.json({ error: 'Unknown symbol' }, 404);
  const [history, onchain] = await Promise.all([readHistory(row.symbol, 24), readOnchainLog()]);
  return c.json({
    row,
    generatedAt: board.generatedAt,
    history,
    onchain: onchain.filter((e) => e.symbol === row.symbol).slice(-20).reverse(),
    disclaimer: DISCLAIMER,
  });
});

app.get('/api/history/:symbol', async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 24) || 24, 1), 24 * 14);
  return c.json({ symbol: c.req.param('symbol').toUpperCase(), points: await readHistory(c.req.param('symbol').toUpperCase(), hours) });
});

app.get('/api/onchain', async (c) =>
  c.json({
    chainId: BASE_SEPOLIA_ID,
    registry: process.env.STOCKGUARD_REGISTRY_ADDRESS || null,
    sentinel: process.env.STOCKGUARD_RSC_ADDRESS || null,
    callbackProxy: REACTIVE_CALLBACK_PROXY[BASE_SEPOLIA_ID],
    events: (await readOnchainLog()).slice(-100).reverse(),
  }),
);

app.get('/api/alerts', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500);
  const [records, chain] = await Promise.all([readAuditRecords(limit), verifyAuditChain()]);
  return c.json({ chain, records });
});

app.post('/api/scan', async (c) => {
  let body: { address?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'JSON body required' }, 400);
  }
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!isEvmAddress(address)) return c.json({ error: 'address must be a 0x… 20-byte address' }, 400);
  bump('scans', c);

  const registry = await getOfficialRegistry();
  if (registry.source === 'unavailable') return c.json({ error: 'Official list unavailable right now', detail: registry.error }, 503);
  const official = findOfficial(address, registry.assets);
  if (!official) {
    return c.json({
      address,
      verdict: 'NOT_OFFICIAL',
      message: 'This address is not in the Coinbase Tokenized Stocks list for Base. Treat any "tokenized stock" at this address as unverified.',
      registryFetchedAt: registry.fetchedAt,
      disclaimer: DISCLAIMER,
    });
  }
  const quote = await fetchDexQuote(address);
  if (!official.navPriceUsd || !quote) {
    return c.json({ address, verdict: 'OFFICIAL', symbol: official.ticker, name: official.name, nav: official.navPriceUsd ?? null, dex: quote, message: 'Official token. No DEX price comparison available right now.', disclaimer: DISCLAIMER });
  }
  const result = evaluateTokenizedStockRisk({
    contractAddress: address,
    officialRegistry: registry.assets,
    navPriceUsd: official.navPriceUsd,
    dexPriceUsd: quote.priceUsd,
    poolLiquidityUsd: quote.liquidityUsd,
    isMarketClosed: isUsMarketClosed(),
    navUpdatedAt: official.navUpdatedAt,
  });
  return c.json({ address, verdict: 'OFFICIAL', symbol: official.ticker, name: official.name, nav: official.navPriceUsd, dex: quote, result, reportHash: computeReportHash(result), disclaimer: DISCLAIMER });
});

app.get('/api/agent', (c) =>
  c.json({
    name: 'StockGuard risk check',
    description: 'NAV-vs-DEX deviation, grade and risk flags for Coinbase tokenized stocks on Base. Read-only.',
    endpoint: '/api/agent/risk?symbol=<TICKER>',
    payment: x402Enabled ? { protocol: 'x402', scheme: 'exact', network: X402_NETWORK, price: X402_PRICE } : null,
    status: x402Enabled ? 'live' : 'disabled (X402_PAY_TO not set)',
    freeAlternative: '/api/board',
    disclaimer: DISCLAIMER,
  }),
);

app.get('/api/agent/risk', async (c) => {
  if (!x402Enabled) return c.json({ error: 'x402 is not configured on this server (X402_PAY_TO).' }, 503);
  const { board, res } = await boardOr503(c);
  if (!board) return res;
  const symbol = (c.req.query('symbol') ?? '').toUpperCase();
  const row = board.rows.find((r) => r.symbol.toUpperCase() === symbol);
  if (!row) return c.json({ error: 'Unknown symbol', known: board.rows.map((r) => r.symbol) }, 404);
  bump('agentPaid', c);
  const payload = { row, generatedAt: board.generatedAt, marketClosed: board.marketClosed };
  return c.json({ ...payload, reportHash: computeReportHash(payload), disclaimer: DISCLAIMER });
});

registerXl(app);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[api] http://localhost:${info.port}  x402 ${x402Enabled ? `on (${X402_NETWORK}, ${X402_PRICE})` : 'off'}`);
});
