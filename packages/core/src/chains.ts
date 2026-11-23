/** Network constants used across StockGuard. Verified against docs.base.org / dev.reactive.network. */
export const BASE_MAINNET_ID = 8453;
export const BASE_SEPOLIA_ID = 84532;
export const REACTIVE_LASNA_ID = 5318007;

/** Reactive callback proxies (the only address allowed to call triggerCircuitBreaker). */
export const REACTIVE_CALLBACK_PROXY = {
  [BASE_SEPOLIA_ID]: '0x476F44b11F5C942c58f4c8E3d0300E5710743585',
  [BASE_MAINNET_ID]: '0xCc780DdE33f56f55dE778D42c930959374a4a068',
} as const;

export const EXPLORER = {
  [BASE_MAINNET_ID]: 'https://basescan.org',
  [BASE_SEPOLIA_ID]: 'https://sepolia.basescan.org',
  [REACTIVE_LASNA_ID]: 'https://lasna.reactscan.net',
} as const;

export function txUrl(chainId: number, hash: string): string {
  const base = (EXPLORER as Record<number, string>)[chainId];
  return base ? `${base}/tx/${hash}` : hash;
}
