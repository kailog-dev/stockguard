/**
 * The StockGuard board: one row per official Coinbase tokenized stock on Base, comparing the
 * Chainlink-based NAV with the deepest DEX pool price. Pure functions only (no I/O), so the worker,
 * the API and the tests all compute the same thing.
 */
import type { OfficialRegistrySnapshot } from './officialRegistry.js';
import type { DexQuote } from './dexPrice.js';
import {
  computePremiumBps,
  evaluateTokenizedStockRisk,
  isUsMarketClosed,
  type RecommendedAction,
  type RiskGrade,
} from './riskEngine.js';

export type RowStatus = 'OK' | 'NO_NAV' | 'NO_DEX_QUOTE';

export interface BoardRow {
  symbol: string;
  name: string;
  address: `0x${string}`;
  multiplier: number | null;
  totalSupply: number | null;
  navUsd: number | null;
  navUpdatedAt: string | null;
  dexUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  dexId: string | null;
  pairUrl: string | null;
  status: RowStatus;
  depegBps: number | null;
  premiumBps: number | null;
  grade: RiskGrade | null;
  flags: string[];
  recommendedAction: RecommendedAction | null;
  /** True only when the numbers are trustworthy enough to raise a public alert. */
  alertable: boolean;
  /** Why the row is not alertable (empty when alertable). */
  notAlertableReasons: string[];
  /** On-chain circuit-breaker state on Base Sepolia, for assets registered in StockGuardRegistry (else null). */
  onchain: { breakerActive: boolean; lastDepegBps: number; triggeredAt: number } | null;
}

export interface BoardSnapshot {
  version: 1;
  generatedAt: number;
  marketClosed: boolean;
  sources: {
    registry: { source: OfficialRegistrySnapshot['source']; fetchedAt: number | null; error?: string };
    dex: { source: 'dexscreener'; errors: string[] };
  };
  summary: {
    total: number;
    quoted: number;
    alertable: number;
    worst: { symbol: string; premiumBps: number } | null;
  };
  rows: BoardRow[];
}

export interface BoardConfig {
  /** Pools below this USD liquidity never raise public alerts (they are still shown). */
  minAlertLiquidityUsd: number;
}

export const DEFAULT_BOARD_CONFIG: BoardConfig = { minAlertLiquidityUsd: 10_000 };

const BLOCKING_FLAGS = ['NAV_BASIS_UNVERIFIED', 'NAV_STALE_OVER_26H', 'DEX_LIQUIDITY_UNKNOWN', 'ISSUER_FEATURES_PAUSED'];

export function buildBoard(
  registry: OfficialRegistrySnapshot,
  quotes: Map<string, DexQuote>,
  dexErrors: string[],
  now = Date.now(),
  cfg: BoardConfig = DEFAULT_BOARD_CONFIG,
): BoardSnapshot {
  const marketClosed = isUsMarketClosed(new Date(now));
  const rows: BoardRow[] = registry.assets.map((spec) => {
    const q = quotes.get(spec.officialContract.toLowerCase()) ?? null;
    const base: BoardRow = {
      symbol: spec.ticker,
      name: spec.name,
      address: spec.officialContract,
      multiplier: spec.multiplier ?? null,
      totalSupply: spec.totalSupply ?? null,
      navUsd: spec.navPriceUsd ?? null,
      navUpdatedAt: spec.navUpdatedAt ?? null,
      dexUsd: q?.priceUsd ?? null,
      liquidityUsd: q?.liquidityUsd ?? null,
      volume24hUsd: q?.volume24hUsd ?? null,
      dexId: q?.dexId ?? null,
      pairUrl: q?.url ?? null,
      status: 'OK',
      depegBps: null,
      premiumBps: null,
      grade: null,
      flags: [],
      recommendedAction: null,
      alertable: false,
      notAlertableReasons: [],
      onchain: null,
    };
    if (!spec.navPriceUsd) return { ...base, status: 'NO_NAV', notAlertableReasons: ['no NAV published'] };
    if (!q) return { ...base, status: 'NO_DEX_QUOTE', notAlertableReasons: ['no Base DEX pool found'] };

    const r = evaluateTokenizedStockRisk({
      contractAddress: spec.officialContract,
      officialRegistry: registry.assets,
      navPriceUsd: spec.navPriceUsd,
      dexPriceUsd: q.priceUsd,
      poolLiquidityUsd: q.liquidityUsd,
      isMarketClosed: marketClosed,
      navUpdatedAt: spec.navUpdatedAt,
      now,
    });
    const reasons = r.flags.filter((f) => BLOCKING_FLAGS.includes(f));
    if (q.liquidityUsd !== null && q.liquidityUsd < cfg.minAlertLiquidityUsd) {
      reasons.push(`pool liquidity under $${cfg.minAlertLiquidityUsd.toLocaleString('en-US')}`);
    }
    return {
      ...base,
      depegBps: r.depegBps,
      premiumBps: computePremiumBps(BigInt(r.navPriceE8), BigInt(r.dexPriceE8)),
      grade: r.grade,
      flags: r.flags,
      recommendedAction: r.recommendedAction,
      alertable: reasons.length === 0,
      notAlertableReasons: reasons,
    };
  });

  rows.sort((a, b) => Math.abs(b.premiumBps ?? -1) - Math.abs(a.premiumBps ?? -1) || a.symbol.localeCompare(b.symbol));
  const quoted = rows.filter((r) => r.status === 'OK');
  const worstRow = quoted[0];

  return {
    version: 1,
    generatedAt: now,
    marketClosed,
    sources: {
      registry: { source: registry.source, fetchedAt: registry.fetchedAt, error: registry.error },
      dex: { source: 'dexscreener', errors: dexErrors },
    },
    summary: {
      total: rows.length,
      quoted: quoted.length,
      alertable: rows.filter((r) => r.alertable).length,
      worst: worstRow && worstRow.premiumBps !== null ? { symbol: worstRow.symbol, premiumBps: worstRow.premiumBps } : null,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------------------------
// Alert state machine with confirmation and hysteresis, so one bad tick never posts an alert and
// a price hovering around the threshold does not spam the channel.
// ---------------------------------------------------------------------------------------------

export interface AlertConfig {
  triggerBps: number;
  clearBps: number;
  confirmPolls: number;
  /**
   * A new depeg within this many ms of the last recovery on the same symbol is "quiet": it is still recorded
   * (audit log, on-chain report) but not posted publicly again, so a price flapping around the threshold at the
   * US open does not spam the channel. 0 disables.
   */
  rearmMs: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = { triggerBps: 200, clearBps: 100, confirmPolls: 2, rearmMs: 60 * 60_000 };

export interface SymbolAlertState {
  phase: 'normal' | 'alerting';
  consecutive: number;
  since: number | null;
  peakBps: number;
  /** When this symbol last recovered (for the re-arm window). Optional so older state files still load. */
  lastRecoveredAt?: number | null;
  /** True while the current alert was not posted publicly (its recovery is then not posted either). */
  quiet?: boolean;
}

export type AlertEvent =
  | { kind: 'DEPEG'; symbol: string; row: BoardRow; quiet: boolean }
  | { kind: 'RECOVERED'; symbol: string; row: BoardRow; peakBps: number; durationMs: number; quiet: boolean };

export const INITIAL_ALERT_STATE: SymbolAlertState = { phase: 'normal', consecutive: 0, since: null, peakBps: 0, lastRecoveredAt: null, quiet: false };

export function stepAlert(
  prev: SymbolAlertState | undefined,
  row: BoardRow,
  now: number,
  cfg: AlertConfig = DEFAULT_ALERT_CONFIG,
): { state: SymbolAlertState; event: AlertEvent | null } {
  const s = prev ?? INITIAL_ALERT_STATE;
  const bps = row.depegBps;
  const lastRecoveredAt = s.lastRecoveredAt ?? null;
  const idle: SymbolAlertState = { ...INITIAL_ALERT_STATE, lastRecoveredAt };

  if (s.phase === 'alerting') {
    if (row.alertable && bps !== null && bps < cfg.clearBps) {
      return {
        state: { ...INITIAL_ALERT_STATE, lastRecoveredAt: now },
        event: { kind: 'RECOVERED', symbol: row.symbol, row, peakBps: s.peakBps, durationMs: now - (s.since ?? now), quiet: Boolean(s.quiet) },
      };
    }
    // Unknown data never clears an alert; only a trustworthy recovered price does.
    return { state: { ...s, peakBps: Math.max(s.peakBps, bps ?? 0) }, event: null };
  }

  if (!row.alertable || bps === null || bps < cfg.triggerBps) {
    return { state: idle, event: null };
  }
  const consecutive = s.consecutive + 1;
  if (consecutive >= cfg.confirmPolls) {
    const quiet = cfg.rearmMs > 0 && lastRecoveredAt !== null && now - lastRecoveredAt < cfg.rearmMs;
    return {
      state: { phase: 'alerting', consecutive, since: now, peakBps: bps, lastRecoveredAt, quiet },
      event: { kind: 'DEPEG', symbol: row.symbol, row, quiet },
    };
  }
  return { state: { ...s, consecutive, lastRecoveredAt }, event: null };
}
