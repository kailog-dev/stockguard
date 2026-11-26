/**
 * StockGuard XL — routing verdicts for tokenized-stock pools on X Layer.
 *
 * For every xStock pool found by discover.ts it reads the live pool state on X Layer (Uniswap v4
 * StateView), measures depth (price impact of a $1,000 buy), compares the price with a reference,
 * and runs the result through the routing circuit (circuit.ts) → DO_NOT_ROUTE / CAUTION / ROUTE_OK.
 *
 * Reference price, in order of preference:
 *   1. the same token's deepest pool on another chain (DexScreener, ≥ $50k liquidity) — same contract,
 *      same units, so no share/multiplier conversion is needed
 *   2. the Coinbase tokenized-stock NAV for the same ticker from StockGuard's own board (.data/board.json)
 *   none → STALE
 *
 *   npx tsx apps/worker/src/xl/guard.ts          # one pass, writes .data/xl-board.json
 *   npx tsx apps/worker/src/xl/guard.ts --loop   # every 60 s
 *
 * Read-only: no key, no transactions.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, parseAbi, type Address, type Hex } from 'viem';
import { evaluate, NETLIST_HASH, type InputName, type Verdict } from './circuit.js';
import { buyImpact, gapBps, priceFromSqrt, STABLE_SYMBOLS, tickerOf } from './metrics.js';

const RPC = process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech';
const STATE_VIEW: Address = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
const GAP_BPS = 200; // 2 %
const THIN_IMPACT = 0.02; // a $1,000 buy moving the price > 2 %
const PROBE_USD = 1_000;
const REF_MIN_LIQ_USD = 50_000;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STOCKGUARD_DATA_DIR ? resolve(process.env.STOCKGUARD_DATA_DIR) : resolve(here, '../../../../.data');
const POOLS_FILE = resolve(DATA_DIR, 'xl-pools.json');
const BOARD_FILE = resolve(DATA_DIR, 'board.json');
const OUT_FILE = resolve(DATA_DIR, 'xl-board.json');

/**
 * Quote assets accepted as $1, pinned by address once verified (symbols can be copied by anyone).
 * Until an address is pinned for a symbol, the most-used address for that symbol is accepted and the
 * row is marked trust: "heuristic".
 */
const PINNED_STABLES: Record<string, string> = {
  // 'usdg-address-lowercase': 'USDG',
};

const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain: xLayer, transport: http(RPC, { timeout: 30_000, retryCount: 6, retryDelay: 2_000 }) });
const stateView = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

type Tok = { address: Address; symbol: string; name: string; decimals: number };
type PoolRow = { poolId: Hex; currency0: Tok; currency1: Tok; hooks: Address; fee: number };
type Ref = { usd: number; source: string; liquidityUsd?: number } | null;

function loadPools(): PoolRow[] {
  if (!existsSync(POOLS_FILE)) throw new Error(`${POOLS_FILE} not found — run discover.ts first`);
  const d = JSON.parse(readFileSync(POOLS_FILE, 'utf8')) as { pools: PoolRow[] };
  const seen = new Set<string>();
  return d.pools.filter((p) => {
    const isStock = [p.currency0, p.currency1].some((t) => tickerOf(t.symbol) && /xStock/i.test(t.name));
    if (!isStock || seen.has(p.poolId)) return false;
    seen.add(p.poolId);
    return true;
  });
}

/** stable-symbol → most-used address among discovered pools (fallback while not pinned) */
function stableAddressGuess(pools: PoolRow[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const p of pools)
    for (const t of [p.currency0, p.currency1]) {
      if (!STABLE_SYMBOLS.includes(t.symbol)) continue;
      const m = counts.get(t.symbol) ?? new Map<string, number>();
      m.set(t.address.toLowerCase(), (m.get(t.address.toLowerCase()) ?? 0) + 1);
      counts.set(t.symbol, m);
    }
  const best = new Map<string, string>();
  for (const [sym, m] of counts) best.set(sym, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

async function crossChainRefs(addresses: string[]): Promise<Map<string, Ref>> {
  const out = new Map<string, Ref>();
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json()) as { pairs?: any[] };
      for (const a of chunk) {
        const best = (j.pairs ?? [])
          .filter((p) => p.chainId !== 'xlayer' && p.baseToken?.address?.toLowerCase() === a && (p.liquidity?.usd ?? 0) >= REF_MIN_LIQ_USD && Number(p.priceUsd) > 0)
          .sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];
        if (best) out.set(a, { usd: Number(best.priceUsd), source: `${best.chainId}:${best.dexId}`, liquidityUsd: Math.round(best.liquidity.usd) });
      }
    } catch (e) {
      console.warn('[xl] DexScreener reference fetch failed:', e instanceof Error ? e.message : e);
    }
  }
  return out;
}

function coinbaseNav(): { refs: Map<string, Ref>; marketClosed: boolean } {
  const refs = new Map<string, Ref>();
  if (!existsSync(BOARD_FILE)) return { refs, marketClosed: false };
  const b = JSON.parse(readFileSync(BOARD_FILE, 'utf8')) as { marketClosed: boolean; rows: any[] };
  for (const r of b.rows ?? []) {
    const t = /^([A-Z]{1,6})c$/.exec(r.symbol)?.[1];
    if (t && typeof r.navUsd === 'number' && r.navUsd > 0) refs.set(t, { usd: r.navUsd, source: `coinbase-nav:${r.symbol}` });
  }
  return { refs, marketClosed: !!b.marketClosed };
}

async function pass() {
  const pools = loadPools();
  const stableGuess = stableAddressGuess(pools);
  const pinned = new Map(Object.entries(PINNED_STABLES).map(([a, s]) => [a.toLowerCase(), s]));
  const prev = existsSync(OUT_FILE) ? (JSON.parse(readFileSync(OUT_FILE, 'utf8')) as { rows: any[] }) : { rows: [] };
  const prevGap = new Map(prev.rows.map((r: any) => [r.poolId, !!r.inputs?.GAP]));
  const { refs: navRefs, marketClosed } = coinbaseNav();
  const stockAddrs = pools.flatMap((p) => [p.currency0, p.currency1].filter((t) => tickerOf(t.symbol)).map((t) => t.address));
  const xRefs = await crossChainRefs(stockAddrs);

  const rows = [];
  for (const p of pools) {
    const stockIs0 = !!tickerOf(p.currency0.symbol) && /xStock/i.test(p.currency0.name);
    const stock = stockIs0 ? p.currency0 : p.currency1;
    const quote = stockIs0 ? p.currency1 : p.currency0;
    const ticker = tickerOf(stock.symbol)!;
    const qa = quote.address.toLowerCase();
    const quoteTrust: 'pinned' | 'heuristic' | 'untrusted' = pinned.has(qa)
      ? 'pinned'
      : STABLE_SYMBOLS.includes(quote.symbol) && stableGuess.get(quote.symbol) === qa
        ? 'heuristic'
        : 'untrusted';

    let price: number | null = null;
    let impact = Infinity;
    try {
      const [sqrtP] = await client.readContract({ address: STATE_VIEW, abi: stateView, functionName: 'getSlot0', args: [p.poolId] });
      const liq = await client.readContract({ address: STATE_VIEW, abi: stateView, functionName: 'getLiquidity', args: [p.poolId] });
      const p0in1 = priceFromSqrt(sqrtP, p.currency0.decimals, p.currency1.decimals);
      price = stockIs0 ? p0in1 : p0in1 > 0 ? 1 / p0in1 : null;
      if (quoteTrust !== 'untrusted')
        impact = buyImpact({ sqrtPriceX96: sqrtP, liquidity: liq, stableIsToken0: !stockIs0, stableDecimals: quote.decimals, usd: PROBE_USD });
    } catch (e) {
      console.warn(`[xl] ${stock.symbol}/${quote.symbol} read failed:`, e instanceof Error ? e.message : e);
    }

    const ref: Ref = xRefs.get(stock.address.toLowerCase()) ?? navRefs.get(ticker) ?? null;
    const gap = price !== null && ref && quoteTrust !== 'untrusted' ? gapBps(price, ref.usd) : null;
    const inputs: Record<InputName, boolean> = {
      UNTRUSTED: quoteTrust === 'untrusted' || price === null,
      THIN: !(impact <= THIN_IMPACT),
      GAP: gap !== null && Math.abs(gap) >= GAP_BPS,
      CONFIRMED: false,
      CLOSED: marketClosed,
      STALE: !ref,
    };
    inputs.CONFIRMED = inputs.GAP && prevGap.get(p.poolId) === true;
    const verdict: Verdict = evaluate(inputs);
    rows.push({
      poolId: p.poolId,
      pair: `${stock.symbol}/${quote.symbol}`,
      ticker,
      stock: stock.address,
      quote: { symbol: quote.symbol, address: quote.address, trust: quoteTrust },
      hooks: p.hooks,
      priceUsd: price,
      reference: ref,
      gapBps: gap,
      impactPct1k: Number.isFinite(impact) ? Math.round(impact * 10_000) / 100 : null,
      inputs,
      verdict,
    });
  }

  const order = { DO_NOT_ROUTE: 0, CAUTION: 1, ROUTE_OK: 2 } as const;
  rows.sort((a, b) => order[b.verdict as Verdict] - order[a.verdict as Verdict] || a.pair.localeCompare(b.pair));
  const summary = rows.reduce((acc: Record<string, number>, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
  const out = { version: 1, generatedAt: Date.now(), chainId: 196, marketClosed, circuit: { netlistHash: NETLIST_HASH }, thresholds: { GAP_BPS, THIN_IMPACT, PROBE_USD }, summary, rows };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`\n[xl] ${new Date().toISOString()} ${rows.length} pools · ${JSON.stringify(summary)} · market ${marketClosed ? 'closed' : 'open'}`);
  for (const r of rows) {
    const px = r.priceUsd === null ? 'n/a' : `$${r.priceUsd.toPrecision(6)}`;
    const ref = r.reference ? `ref $${r.reference.usd.toPrecision(6)} (${r.reference.source})` : 'no ref';
    const gap = r.gapBps === null ? '' : ` gap ${(r.gapBps / 100).toFixed(2)}%`;
    const imp = r.impactPct1k === null ? 'impact ∞' : `impact ${r.impactPct1k}%`;
    const on = (Object.keys(r.inputs) as InputName[]).filter((k) => r.inputs[k]).join('+') || '-';
    console.log(`  ${r.verdict.padEnd(12)} ${r.pair.padEnd(16)} ${px.padEnd(12)} ${ref}${gap} · ${imp} · quote ${r.quote.trust} · [${on}]`);
  }
  const quotes = [...new Map(rows.map((r) => [r.quote.address.toLowerCase(), `${r.quote.symbol} ${r.quote.address} (${r.quote.trust})`])).values()];
  console.log(`  quote assets seen: ${quotes.join(' | ')}`);
  console.log(`[xl] saved ${OUT_FILE}`);
}

async function main() {
  const loop = process.argv.includes('--loop');
  do {
    try {
      await pass();
    } catch (e) {
      console.error('[xl] pass failed:', e instanceof Error ? e.message : e);
      if (!loop) process.exit(1);
    }
    if (loop) await new Promise((r) => setTimeout(r, 60_000));
  } while (loop);
}

main();
