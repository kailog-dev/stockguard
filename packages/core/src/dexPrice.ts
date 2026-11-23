/**
 * Best-effort DEX price lookup for Base tokens via DexScreener's public API (no key).
 *   GET https://api.dexscreener.com/latest/dex/tokens/{addr1,addr2,...}   (up to 30 addresses per call)
 * For each token we keep the Base pair with the most USD liquidity where the token is the BASE asset.
 *
 * This is a market-data source for the board, not an oracle: DexScreener can lag or be down, so a
 * missing quote is returned as "no quote", never as a guessed price.
 */

export interface DexQuote {
  priceUsd: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairAddress: string;
  dexId: string;
  url: string | null;
  source: 'dexscreener';
  fetchedAt: number;
}

interface DsPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

const DS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const CHUNK = 30;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickBest(pairs: DsPair[], token: string, fetchedAt: number): DexQuote | null {
  const wanted = token.toLowerCase();
  const best = pairs
    .filter((p) => p.chainId === 'base' && (p.baseToken?.address ?? '').toLowerCase() === wanted)
    .map((p) => ({ p, price: num(p.priceUsd), liq: num(p.liquidity?.usd) }))
    .filter((x): x is { p: DsPair; price: number; liq: number | null } => x.price !== null && x.price > 0)
    .sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0))[0];
  if (!best) return null;
  return {
    priceUsd: best.price,
    liquidityUsd: best.liq,
    volume24hUsd: num(best.p.volume?.h24),
    pairAddress: best.p.pairAddress ?? '',
    dexId: best.p.dexId ?? 'unknown',
    url: best.p.url ?? null,
    source: 'dexscreener',
    fetchedAt,
  };
}

async function fetchChunk(addresses: string[], signal: AbortSignal): Promise<DsPair[]> {
  const res = await fetch(DS_URL + addresses.join(','), { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const json = (await res.json()) as { pairs?: DsPair[] | null };
  return json.pairs ?? [];
}

export interface DexQuoteBatch {
  quotes: Map<string, DexQuote>;
  errors: string[];
}

/** Quotes for many tokens. Keys of `quotes` are lower-case addresses; tokens with no Base pair are absent. */
export async function fetchDexQuotes(addresses: string[], timeoutMs = 10_000): Promise<DexQuoteBatch> {
  const quotes = new Map<string, DexQuote>();
  const errors: string[] = [];
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const pairs = await fetchChunk(chunk, ctrl.signal);
      const at = Date.now();
      for (const addr of chunk) {
        const q = pickBest(pairs, addr, at);
        if (q) quotes.set(addr, q);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'DexScreener fetch failed');
    } finally {
      clearTimeout(timer);
    }
  }
  return { quotes, errors };
}

export async function fetchDexQuote(address: string): Promise<DexQuote | null> {
  const { quotes } = await fetchDexQuotes([address]);
  return quotes.get(address.toLowerCase()) ?? null;
}
