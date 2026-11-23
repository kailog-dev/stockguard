/**
 * Official Base tokenized-stock list from the Coinbase Tokenized Stocks API.
 *   GET https://api.coinbase.com/v1/tokenized-stocks  (no API key; page_size max 500; next_page_token)
 *   Docs: https://docs.base.org/sdks/tokenized-stocks/api-reference/list-tokenized-stocks
 *
 * This replaces the hard-coded placeholder addresses (0x...b201 etc.) used in v1. Never ship
 * invented contract addresses: a wrong "official" list is exactly the scam StockGuard warns about.
 */
import type { TokenizedStockSpec } from './riskEngine.js';
import { isEvmAddress } from './riskEngine.js';

export const COINBASE_TOKENIZED_STOCKS_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
const BASE_MAINNET_CHAIN_ID = 8453;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 20;

interface ApiToken {
  contract_address?: string;
  symbol?: string;
  name?: string;
  decimals?: number | string;
  multiplier?: number;
  paused_features?: Array<number | string>;
  nav_price?: number;
  nav_price_updated_at?: string;
  total_supply?: number;
}

interface ApiPage {
  tokens?: ApiToken[];
  next_page_token?: string;
}

export interface OfficialRegistrySnapshot {
  source: 'coinbase-tokenized-stocks-api' | 'unavailable';
  fetchedAt: number | null;
  assets: TokenizedStockSpec[];
  error?: string;
}

let cache: OfficialRegistrySnapshot | null = null;

function toSpec(t: ApiToken): TokenizedStockSpec | null {
  if (!isEvmAddress(t.contract_address) || !t.symbol) return null;
  const nav = typeof t.nav_price === 'number' && Number.isFinite(t.nav_price) && t.nav_price > 0 ? t.nav_price : undefined;
  return {
    ticker: t.symbol,
    name: t.name ?? t.symbol,
    chainId: BASE_MAINNET_CHAIN_ID,
    officialContract: t.contract_address.trim() as `0x${string}`,
    issuer: 'Coinbase (Tokenized Stocks API)',
    decimals: t.decimals === undefined ? undefined : Number(t.decimals),
    navPriceUsd: nav,
    navUpdatedAt: t.nav_price_updated_at,
    multiplier: typeof t.multiplier === 'number' ? t.multiplier : undefined,
    pausedFeatures: (t.paused_features ?? []).map(Number).filter(Number.isFinite),
    totalSupply: typeof t.total_supply === 'number' && Number.isFinite(t.total_supply) ? t.total_supply : undefined,
  };
}

async function fetchPage(pageToken: string | undefined, signal: AbortSignal): Promise<ApiPage> {
  const url = new URL(COINBASE_TOKENIZED_STOCKS_URL);
  url.searchParams.set('page_size', '500');
  if (pageToken) url.searchParams.set('page_token', pageToken);
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  return (await res.json()) as ApiPage;
}

/**
 * Returns the cached list (10 min TTL). On failure it keeps serving the last good list and reports
 * the error, or returns an empty "unavailable" snapshot. It never invents data.
 */
export async function getOfficialRegistry(force = false): Promise<OfficialRegistrySnapshot> {
  if (!force && cache && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const assets: TokenizedStockSpec[] = [];
    let token: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await fetchPage(token, ctrl.signal);
      for (const t of page.tokens ?? []) {
        const spec = toSpec(t);
        if (spec) assets.push(spec);
      }
      token = page.next_page_token || undefined;
      if (!token) break;
    }
    cache = { source: 'coinbase-tokenized-stocks-api', fetchedAt: Date.now(), assets };
    return cache;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'fetch failed';
    if (cache && cache.assets.length > 0) return { ...cache, error: `stale cache: ${error}` };
    return { source: 'unavailable', fetchedAt: null, assets: [], error };
  } finally {
    clearTimeout(timer);
  }
}
