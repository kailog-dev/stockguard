/**
 * StockGuard XL — routing verdicts for tokenized-stock pools on X Layer.
 *
 * For every xStock pool found by discover.ts (Uniswap v4) and discover-v3.ts (Uniswap v3) it reads the
 * live pool state on X Layer, measures depth, compares the price with a reference, and runs the result
 * through the routing circuit (circuit.ts) → DO_NOT_ROUTE / CAUTION / ROUTE_OK.
 *
 * Depth = cost of a $1,000 buy versus the pool's mid price.
 *   v3: a real quote from the official Uniswap QuoterV2 (eth_call, crosses ticks, includes the fee)
 *   v4: concentrated-liquidity estimate inside the current range (metrics.buyImpact)
 *
 * Quote asset:
 *   - a pinned stablecoin ($1)
 *   - another stock whose price is known from its own healthy stable pool ("derived"), e.g. wAAPLx/wSPYx
 *     is priced through wSPYx/USDG — so the cross pairs are judged with on-chain data only
 *   - anything else (xBTC, xETH, unknown tokens) → listed as not judged
 *
 * Reference price, in order of preference:
 *   1. the same token's deepest pool on another chain (DexScreener, ≥ $50k liquidity)
 *   2. the Coinbase tokenized-stock NAV for the same ticker from StockGuard's own board (.data/board.json)
 *   3. the unwrapped xStock ("SPYx") on another chain (DexScreener search, ≥ $50k liquidity)
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
import { evaluate, GATES, INPUTS, NETLIST_HASH, NETLIST_HEX, OUTPUTS, type InputName, type Verdict } from './circuit.js';
import { buyImpact, execImpact, gapBps, priceFromSqrt, STABLE_SYMBOLS, tickerOf } from './metrics.js';
import { isStockToken } from './discover-v3.js';

const RPC = process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech';
// Official Uniswap deployments on X Layer (developers.uniswap.org)
const STATE_VIEW: Address = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990'; // v4
const QUOTER_V2: Address = '0xd1b797d92d87b688193a2b976efc8d577d204343'; // v3
const GAP_BPS = 200; // 2 %
const THIN_IMPACT = 0.01; // a $1,000 buy costing > 1 % over mid (healthy pools here cost 0.05-0.35 %)
const PROBE_USD = 1_000;
const REF_MIN_LIQ_USD = 50_000;
/** A pool price this far from the reference is not a market price (broken or junk initialisation). */
const ABSURD_BPS = 5_000;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STOCKGUARD_DATA_DIR ? resolve(process.env.STOCKGUARD_DATA_DIR) : resolve(here, '../../../../.data');
const V4_POOLS_FILE = resolve(DATA_DIR, 'xl-pools.json');
const V3_POOLS_FILE = resolve(DATA_DIR, 'xl-v3-pools.json');
const BOARD_FILE = resolve(DATA_DIR, 'board.json');
const OUT_FILE = resolve(DATA_DIR, 'xl-board.json');

/**
 * Quote assets accepted as $1, pinned by address once verified (symbols can be copied by anyone).
 * Until an address is pinned for a symbol, the most-used address for that symbol is accepted and the
 * row is marked trust: "heuristic".
 */
const PINNED_STABLES: Record<string, string> = {
  // Paxos Global Dollar on X Layer (BitGo token list, Global Dollar Network launch, Sep 2025)
  '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8': 'USDG',
  // Circle-issued native USDC on X Layer (Circle contract-address table, Aug 2026)
  '0xb6ceceab302e2e4948951ee7843fc24e92933061': 'USDC',
  // USDC supported by the X Layer official bridge and OKX deposits (X Layer docs)
  '0x74b7f16337b8972027f6196a17a631ac6de26d22': 'USDC',
};
/** Seen in pools but not verified from an issuer source yet → treated as untrusted. */
const UNVERIFIED_STABLES = new Set(['0x0ff7a742b035504118a9d435c8264619a8428e1c' /* wUSDG */]);

const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain: xLayer, transport: http(RPC, { timeout: 30_000, retryCount: 6, retryDelay: 2_000 }) });
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const v3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

type Tok = { address: Address; symbol: string; name: string; decimals: number };
type Ref = { usd: number; source: string; liquidityUsd?: number } | null;
type Venue = {
  kind: 'uniswap-v4' | 'uniswap-v3';
  id: string; // v4 poolId, v3 pool address
  token0: Tok;
  token1: Tok;
  fee: number;
  hooks?: Address;
  listing?: { liquidityUsd: number; volume24hUsd: number };
};
type QuoteTrust = 'pinned' | 'heuristic' | 'derived' | 'untrusted';
type Row = {
  venue: Venue['kind'];
  poolId: string;
  pair: string;
  ticker: string;
  stock: Address;
  quote: { symbol: string; address: Address; trust: QuoteTrust; usd: number | null; via?: string };
  fee: number;
  hooks?: Address;
  priceUsd: number | null;
  reference: Ref;
  gapBps: number | null;
  broken: boolean;
  impactPct1k: number | null;
  impactMethod: 'quoter' | 'estimate' | 'none';
  listing?: { liquidityUsd: number; volume24hUsd: number; turnover: number | null };
  inputs: Record<InputName, boolean>;
  verdict: Verdict;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lc = (a: string) => a.toLowerCase();

function loadVenues(): Venue[] {
  const out: Venue[] = [];
  const seen = new Set<string>();
  if (existsSync(V4_POOLS_FILE)) {
    const d = JSON.parse(readFileSync(V4_POOLS_FILE, 'utf8')) as { pools: { poolId: Hex; currency0: Tok; currency1: Tok; hooks: Address; fee: number }[] };
    for (const p of d.pools) {
      if (seen.has(p.poolId) || ![p.currency0, p.currency1].some(isStockToken)) continue;
      seen.add(p.poolId);
      out.push({ kind: 'uniswap-v4', id: p.poolId, token0: p.currency0, token1: p.currency1, fee: p.fee, hooks: p.hooks });
    }
  }
  if (existsSync(V3_POOLS_FILE)) {
    const d = JSON.parse(readFileSync(V3_POOLS_FILE, 'utf8')) as { pools: { pool: Address; token0: Tok; token1: Tok; fee: number; listing: { liquidityUsd: number; volume24hUsd: number } }[] };
    for (const p of d.pools) {
      if (seen.has(lc(p.pool))) continue;
      seen.add(lc(p.pool));
      out.push({ kind: 'uniswap-v3', id: p.pool, token0: p.token0, token1: p.token1, fee: p.fee, listing: p.listing });
    }
  }
  if (!out.length) throw new Error('no pools — run discover.ts and/or discover-v3.ts first');
  return out;
}

/** stable-symbol → most-used address among discovered pools (fallback while not pinned) */
function stableAddressGuess(venues: Venue[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const v of venues)
    for (const t of [v.token0, v.token1]) {
      if (!STABLE_SYMBOLS.includes(t.symbol)) continue;
      const m = counts.get(t.symbol) ?? new Map<string, number>();
      m.set(lc(t.address), (m.get(lc(t.address)) ?? 0) + 1);
      counts.set(t.symbol, m);
    }
  const best = new Map<string, string>();
  for (const [sym, m] of counts) best.set(sym, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

async function crossChainRefs(addresses: string[]): Promise<Map<string, Ref>> {
  const out = new Map<string, Ref>();
  const uniq = [...new Set(addresses.map(lc))];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json()) as { pairs?: any[] };
      for (const a of chunk) {
        const best = (j.pairs ?? [])
          .filter((p) => p.chainId !== 'xlayer' && lc(p.baseToken?.address ?? '') === a && (p.liquidity?.usd ?? 0) >= REF_MIN_LIQ_USD && Number(p.priceUsd) > 0)
          .sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];
        if (best) out.set(a, { usd: Number(best.priceUsd), source: `${best.chainId}:${best.dexId}`, liquidityUsd: Math.round(best.liquidity.usd) });
      }
    } catch (e) {
      console.warn('[xl] DexScreener reference fetch failed:', e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** The unwrapped xStock ("SPYx") on another chain, matched by exact symbol, deepest pool ≥ $50k. */
async function xStockSymbolRefs(tickers: string[]): Promise<Map<string, Ref>> {
  const out = new Map<string, Ref>();
  for (const t of [...new Set(tickers)]) {
    const sym = `${t}x`;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`, { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json()) as { pairs?: any[] };
      const best = (j.pairs ?? [])
        .filter((p) => p.chainId !== 'xlayer' && p.baseToken?.symbol === sym && (p.liquidity?.usd ?? 0) >= REF_MIN_LIQ_USD && Number(p.priceUsd) > 0)
        .sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];
      if (best) out.set(t, { usd: Number(best.priceUsd), source: `xstock:${best.chainId}:${best.dexId}`, liquidityUsd: Math.round(best.liquidity.usd) });
    } catch (e) {
      console.warn(`[xl] DexScreener search ${sym} failed:`, e instanceof Error ? e.message : e);
    }
    await sleep(300);
  }
  return out;
}

function coinbaseNav(): { refs: Map<string, Ref>; marketClosed: boolean } {
  const refs = new Map<string, Ref>();
  if (!existsSync(BOARD_FILE)) return { refs, marketClosed: false };
  const b = JSON.parse(readFileSync(BOARD_FILE, 'utf8')) as { marketClosed: boolean; rows: any[] };
  for (const r of b.rows ?? []) {
    const t = /^([A-Z]{1,6}(?:\.[A-Z])?)c$/.exec(r.symbol)?.[1];
    if (t && typeof r.navUsd === 'number' && r.navUsd > 0) refs.set(t, { usd: r.navUsd, source: `coinbase-nav:${r.symbol}` });
  }
  return { refs, marketClosed: !!b.marketClosed };
}

/** Reads one pool and returns its mid price (stock in quote units) and the $1,000-buy cost. */
async function readVenue(v: Venue, stock: Tok, quote: Tok, quoteUsd: number) {
  const stockIs0 = lc(v.token0.address) === lc(stock.address);
  let sqrtP: bigint;
  let liq: bigint;
  if (v.kind === 'uniswap-v4') {
    [sqrtP] = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [v.id as Hex] });
    liq = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [v.id as Hex] });
  } else {
    [sqrtP] = await client.readContract({ address: v.id as Address, abi: v3PoolAbi, functionName: 'slot0' });
    liq = await client.readContract({ address: v.id as Address, abi: v3PoolAbi, functionName: 'liquidity' });
  }
  const p0in1 = priceFromSqrt(sqrtP, v.token0.decimals, v.token1.decimals);
  const midInQuote = stockIs0 ? p0in1 : p0in1 > 0 ? 1 / p0in1 : NaN;
  const midUsd = midInQuote * quoteUsd;
  const quoteUnits = PROBE_USD / quoteUsd;

  if (v.kind === 'uniswap-v3' && Number.isFinite(midUsd) && midUsd > 0) {
    try {
      const amountIn = BigInt(Math.round(quoteUnits * 10 ** Math.min(quote.decimals, 12))) * 10n ** BigInt(Math.max(quote.decimals - 12, 0));
      const { result } = await client.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: quote.address, tokenOut: stock.address, amountIn, fee: v.fee, sqrtPriceLimitX96: 0n }],
      });
      const sharesOut = Number(result[0]) / 10 ** stock.decimals;
      return { midUsd, impact: execImpact(PROBE_USD, sharesOut, midUsd), method: 'quoter' as const };
    } catch (e) {
      // QuoterV2 reverts when the pool cannot fill the amount at all
      console.warn(`[xl] quoter ${stock.symbol}/${quote.symbol} failed, using estimate:`, e instanceof Error ? e.message.split('\n')[0] : e);
    }
  }
  const impact = buyImpact({ sqrtPriceX96: sqrtP, liquidity: liq, stableIsToken0: !stockIs0, stableDecimals: quote.decimals, usd: quoteUnits });
  return { midUsd, impact, method: 'estimate' as const };
}

async function pass() {
  const venues = loadVenues();
  const stableGuess = stableAddressGuess(venues);
  const pinned = new Map(Object.entries(PINNED_STABLES).map(([a, s]) => [lc(a), s]));
  const prev = existsSync(OUT_FILE) ? (JSON.parse(readFileSync(OUT_FILE, 'utf8')) as { rows: any[] }) : { rows: [] };
  const prevGap = new Map(prev.rows.map((r: any) => [lc(r.poolId), !!r.inputs?.GAP]));
  const { refs: navRefs, marketClosed } = coinbaseNav();

  const stableTrust = (t: Tok): QuoteTrust | null => {
    const a = lc(t.address);
    if (pinned.has(a)) return 'pinned';
    if (!STABLE_SYMBOLS.includes(t.symbol)) return null; // not a stable at all
    return !UNVERIFIED_STABLES.has(a) && stableGuess.get(t.symbol) === a ? 'heuristic' : 'untrusted';
  };

  // references for every stock token seen
  const stocks = new Map<string, Tok>();
  for (const v of venues) for (const t of [v.token0, v.token1]) if (isStockToken(t)) stocks.set(lc(t.address), t);
  const xRefs = await crossChainRefs([...stocks.keys()]);
  const missing = [...stocks.values()].filter((t) => !xRefs.has(lc(t.address)) && !navRefs.has(tickerOf(t.symbol)!)).map((t) => tickerOf(t.symbol)!);
  const symRefs = await xStockSymbolRefs(missing);
  const refOf = (t: Tok): Ref => xRefs.get(lc(t.address)) ?? navRefs.get(tickerOf(t.symbol)!) ?? symRefs.get(tickerOf(t.symbol)!) ?? null;

  async function judge(v: Venue, stock: Tok, quote: Tok, trust: QuoteTrust, quoteUsd: number | null, via?: string): Promise<Row> {
    const ticker = tickerOf(stock.symbol)!;
    let price: number | null = null;
    let impact = Infinity;
    let method: Row['impactMethod'] = 'none';
    if (quoteUsd !== null) {
      try {
        const r = await readVenue(v, stock, quote, quoteUsd);
        price = Number.isFinite(r.midUsd) ? r.midUsd : null;
        if (trust !== 'untrusted') ({ impact, method } = r);
      } catch (e) {
        console.warn(`[xl] ${stock.symbol}/${quote.symbol} (${v.kind}) read failed:`, e instanceof Error ? e.message.split('\n')[0] : e);
      }
    }
    const ref = refOf(stock);
    const gap = price !== null && ref && trust !== 'untrusted' ? gapBps(price, ref.usd) : null;
    const broken = price === null || !Number.isFinite(price) || (gap !== null && Math.abs(gap) >= ABSURD_BPS);
    const inputs: Record<InputName, boolean> = {
      UNTRUSTED: trust === 'untrusted' || broken,
      THIN: !(impact <= THIN_IMPACT),
      GAP: !broken && gap !== null && Math.abs(gap) >= GAP_BPS,
      CONFIRMED: false,
      CLOSED: marketClosed,
      STALE: !ref,
    };
    inputs.CONFIRMED = inputs.GAP && prevGap.get(lc(v.id)) === true;
    const turnover = v.listing && v.listing.liquidityUsd > 0 ? Math.round((v.listing.volume24hUsd / v.listing.liquidityUsd) * 10) / 10 : null;
    return {
      venue: v.kind,
      poolId: v.id,
      pair: `${stock.symbol}/${quote.symbol}`,
      ticker,
      stock: stock.address,
      quote: { symbol: quote.symbol, address: quote.address, trust, usd: quoteUsd, ...(via ? { via } : {}) },
      fee: v.fee,
      ...(v.hooks ? { hooks: v.hooks } : {}),
      priceUsd: price,
      reference: ref,
      gapBps: broken ? null : gap,
      broken,
      impactPct1k: Number.isFinite(impact) ? Math.round(impact * 10_000) / 100 : null,
      impactMethod: method,
      ...(v.listing ? { listing: { ...v.listing, turnover } } : {}),
      inputs,
      verdict: evaluate(inputs),
    };
  }

  // pass A — stock / stablecoin pools
  const rows: Row[] = [];
  const cross: { v: Venue; a: Tok; b: Tok }[] = [];
  const notJudged: { poolId: string; pair: string; why: string }[] = [];
  for (const v of venues) {
    const [t0, t1] = [v.token0, v.token1];
    const s0 = isStockToken(t0);
    const s1 = isStockToken(t1);
    if (s0 && s1) {
      cross.push({ v, a: t0, b: t1 });
      continue;
    }
    const stock = s0 ? t0 : t1;
    const quote = s0 ? t1 : t0;
    const trust = stableTrust(quote);
    if (trust === null) {
      notJudged.push({ poolId: v.id, pair: `${stock.symbol}/${quote.symbol}`, why: `quote ${quote.symbol} has no trusted USD price` });
      continue;
    }
    rows.push(await judge(v, stock, quote, trust, 1));
  }

  // a stock's USD price, from its deepest pool that is not DO_NOT_ROUTE (on-chain only)
  const anchor = new Map<string, { usd: number; impact: number; pair: string }>();
  for (const r of rows) {
    if (r.verdict === 'DO_NOT_ROUTE' || r.priceUsd === null || r.impactPct1k === null) continue;
    const k = lc(r.stock);
    const cur = anchor.get(k);
    if (!cur || r.impactPct1k < cur.impact) anchor.set(k, { usd: r.priceUsd, impact: r.impactPct1k, pair: r.pair });
  }

  // pass B — stock / stock pools, priced through the deeper leg
  for (const { v, a, b } of cross) {
    const A = anchor.get(lc(a.address));
    const B = anchor.get(lc(b.address));
    if (!A && !B) {
      notJudged.push({ poolId: v.id, pair: `${a.symbol}/${b.symbol}`, why: 'neither stock has a healthy stablecoin pool to price it' });
      continue;
    }
    // quote = the leg with the more reliable anchor (lower $1k cost); judge the other leg
    const quoteIsB = !!B && (!A || B.impact <= A.impact);
    const [stock, quote, q] = quoteIsB ? [a, b, B!] : [b, a, A!];
    rows.push(await judge(v, stock, quote, 'derived', q.usd, q.pair));
  }

  const order = { DO_NOT_ROUTE: 0, CAUTION: 1, ROUTE_OK: 2 } as const;
  rows.sort((x, y) => order[y.verdict] - order[x.verdict] || x.ticker.localeCompare(y.ticker) || (x.impactPct1k ?? 1e9) - (y.impactPct1k ?? 1e9));
  const summary = rows.reduce((acc: Record<string, number>, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
  const byVenue = rows.reduce((acc: Record<string, number>, r) => ((acc[r.venue] = (acc[r.venue] ?? 0) + 1), acc), {});
  const out = {
    version: 2,
    generatedAt: Date.now(),
    chainId: 196,
    marketClosed,
    circuit: { netlistHash: NETLIST_HASH, netlistHex: NETLIST_HEX, inputs: INPUTS, outputs: OUTPUTS, gates: GATES, firstGate: 2 + INPUTS.length },
    thresholds: { GAP_BPS, THIN_IMPACT, PROBE_USD, ABSURD_BPS },
    summary,
    byVenue,
    rows,
    notJudged,
  };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`\n[xl] ${new Date().toISOString()} ${rows.length} pools ${JSON.stringify(byVenue)} · ${JSON.stringify(summary)} · market ${marketClosed ? 'closed' : 'open'}`);
  for (const r of rows) {
    const px = r.priceUsd === null ? 'n/a' : r.broken ? 'broken' : `$${r.priceUsd.toPrecision(6)}`;
    const ref = r.reference ? `ref $${r.reference.usd.toPrecision(6)} (${r.reference.source})` : 'no ref';
    const gap = r.gapBps === null ? '' : ` gap ${(r.gapBps / 100).toFixed(2)}%`;
    const imp = r.impactPct1k === null ? 'cost ∞' : `cost ${r.impactPct1k}% (${r.impactMethod})`;
    const on = (Object.keys(r.inputs) as InputName[]).filter((k) => r.inputs[k]).join('+') + (r.broken ? '+BROKEN_PRICE' : '') || '-';
    const v = r.venue === 'uniswap-v3' ? 'v3' : 'v4';
    const via = r.quote.via ? ` via ${r.quote.via}` : '';
    console.log(`  ${r.verdict.padEnd(12)} ${v} ${r.pair.padEnd(18)} ${px.padEnd(11)} ${ref}${gap} · ${imp} · quote ${r.quote.trust}${via} · [${on}]`);
  }
  for (const n of notJudged) console.log(`  not judged   ${n.pair.padEnd(18)} ${n.why}`);
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
    if (loop) await sleep(60_000);
  } while (loop);
}

main();
