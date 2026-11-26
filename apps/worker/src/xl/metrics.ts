/** Pure helpers for StockGuard XL (no network). */

/** Quote assets treated as $1. Symbols alone can be faked, so guard.ts also pins their addresses. */
export const STABLE_SYMBOLS = ['USDG', 'wUSDG', 'USDC', 'USDT', 'USD₮0', 'USDT0'];

/** "wAAPLx" → "AAPL", "ANTx" → "ANT", "wBRK.Bx" → "BRK.B"; null if it does not look like an xStock symbol */
export function tickerOf(symbol: string): string | null {
  const m = /^w?([A-Z]{1,6}(?:\.[A-Z])?)x$/.exec(symbol);
  return m ? m[1] : null;
}

/** price of currency0 in units of currency1 (human units) */
export function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r * 10 ** (dec0 - dec1);
}

/**
 * Price impact of buying the stock with `usd` of the quote asset, inside the current tick range
 * (concentrated-liquidity math: Δ√P = Δy / L for token1 in, Δ(1/√P) = Δx / L for token0 in).
 * `usd` is the amount in quote-asset units (for a $1 stable it is dollars).
 * Returns a fraction (0.02 = +2 %). Infinity when the pool has no active liquidity.
 * This is an estimate that ignores tick crossings; guard.ts prefers a real on-chain quote when one exists.
 */
export function buyImpact(opts: {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  stableIsToken0: boolean;
  stableDecimals: number;
  usd: number;
}): number {
  const { sqrtPriceX96, liquidity, stableIsToken0, stableDecimals, usd } = opts;
  if (liquidity === 0n || sqrtPriceX96 === 0n) return Infinity;
  const L = Number(liquidity);
  const sp = Number(sqrtPriceX96) / 2 ** 96; // raw units
  const amountIn = usd * 10 ** stableDecimals;
  if (!stableIsToken0) {
    // stable = token1 in, stock = token0 out; stock price (in token1) = P → rises
    const sp2 = sp + amountIn / L;
    return (sp2 / sp) ** 2 - 1;
  }
  // stable = token0 in, stock = token1 out; stock price (in token0) = 1/P → rises
  const inv2 = 1 / sp + amountIn / L;
  return (inv2 * sp) ** 2 - 1;
}

/**
 * Execution cost of a real quoted buy: what you paid per share versus the pool's mid price.
 * spentUsd = dollars in, sharesOut = stock received (human units), midUsd = pool mid price in dollars.
 * Includes the pool fee and every tick crossed. Infinity when nothing comes out.
 */
export function execImpact(spentUsd: number, sharesOut: number, midUsd: number): number {
  if (!(sharesOut > 0) || !(midUsd > 0)) return Infinity;
  return spentUsd / sharesOut / midUsd - 1;
}

export function gapBps(price: number, ref: number): number {
  return Math.round(((price - ref) / ref) * 10_000);
}
