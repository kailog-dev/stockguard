/** Pure helpers for StockGuard XL (no network). */

/** Quote assets treated as $1. Symbols alone can be faked, so guard.ts also pins their addresses. */
export const STABLE_SYMBOLS = ['USDG', 'wUSDG', 'USDC', 'USDT', 'USD₮0', 'USDT0'];

/** "wAAPLx" → "AAPL", "ANTx" → "ANT"; null if it does not look like an xStock symbol */
export function tickerOf(symbol: string): string | null {
  const m = /^w?([A-Z]{1,6})x$/.exec(symbol);
  return m ? m[1] : null;
}

/** price of currency0 in units of currency1 (human units) */
export function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r * 10 ** (dec0 - dec1);
}

/**
 * Price impact of buying the stock with `usd` of the stable quote, inside the current tick range
 * (concentrated-liquidity math: Δ√P = Δy / L for token1 in, Δ(1/√P) = Δx / L for token0 in).
 * Returns a fraction (0.02 = +2 %). Infinity when the pool has no active liquidity.
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

export function gapBps(price: number, ref: number): number {
  return Math.round(((price - ref) / ref) * 10_000);
}
