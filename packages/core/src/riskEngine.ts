/**
 * StockGuard Core Risk & Depeg Engine (shared by the API, web app and future adapters).
 *
 * Parity rule: the grade and depeg numbers here MUST equal StockGuardRegistry.sol.
 *   - prices are converted to integer 8-decimal units (E8), like Chainlink feeds
 *   - depegBps = floor(|dex - nav| * 10_000 / nav)   (Solidity floor division)
 *   - grade thresholds: < 50 A, 50-199 B, 200-499 C, >= 500 or unofficial CRITICAL
 * Liquidity and market-hours only add flags / a stricter recommended action; they never change the
 * grade, because the contract cannot see them.
 *
 * No trading or order-execution logic lives here.
 */

export type RiskGrade = 'A' | 'B' | 'C' | 'CRITICAL';

export const GRADE_B_BPS = 50;
export const GRADE_C_BPS = 200;
export const CRITICAL_BPS = 500;
export const THIN_LIQUIDITY_USD = 50_000;
/** |multiplier - 1| above this means we cannot be sure nav_price and the DEX price use the same unit. */
export const MULTIPLIER_TOLERANCE = 0.001;

export interface TokenizedStockSpec {
  ticker: string;
  name: string;
  chainId: number;
  officialContract: `0x${string}`;
  issuer: string;
  decimals?: number;
  /** Chainlink-based reference value from the Coinbase Tokenized Stocks API (not an execution price). */
  navPriceUsd?: number;
  navUpdatedAt?: string;
  multiplier?: number;
  pausedFeatures?: number[];
  chainlinkFeed?: `0x${string}`;
  totalSupply?: number;
}

export interface RiskEvaluationInput {
  contractAddress: string;
  officialRegistry: TokenizedStockSpec[];
  navPriceUsd: number;
  dexPriceUsd: number;
  /** Optional: unknown liquidity is flagged, not assumed. */
  poolLiquidityUsd?: number | null;
  /** Weekend or US after-hours. */
  isMarketClosed: boolean;
  /** ISO timestamp of the NAV observation; used to flag stale NAV. */
  navUpdatedAt?: string | null;
  now?: number;
}

export type RecommendedAction = 'SAFE_TO_MONITOR' | 'CAUTION_SPREAD' | 'TRIGGER_CIRCUIT_BREAKER';

export interface RiskEvaluationResult {
  isOfficialIssuer: boolean;
  matchedTicker: string | null;
  navPriceE8: string;
  dexPriceE8: string;
  depegBps: number;
  depegPct: number;
  grade: RiskGrade;
  flags: string[];
  recommendedAction: RecommendedAction;
  evaluatedAt: number;
}

export class RiskInputError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NAV_STALE_MS = 26 * 60 * 60 * 1000; // mirrors StockGuardRegistry.maxNavAge default

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

/** USD float -> integer 8-decimal units, rejecting NaN / Infinity / <= 0. */
export function toE8(priceUsd: number, label = 'price'): bigint {
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new RiskInputError(`${label} must be a positive finite number`);
  }
  const e8 = BigInt(Math.round(priceUsd * 1e8));
  if (e8 <= 0n) throw new RiskInputError(`${label} is below 1e-8 USD`);
  return e8;
}

/** floor(|dex - nav| * 10_000 / nav) on integers — identical to the Solidity implementation. */
export function computeDepegBps(navPriceE8: bigint, dexPriceE8: bigint): number {
  if (navPriceE8 <= 0n) throw new RiskInputError('NAV must be positive');
  const diff = navPriceE8 > dexPriceE8 ? navPriceE8 - dexPriceE8 : dexPriceE8 - navPriceE8;
  return Number((diff * 10_000n) / navPriceE8);
}

export function computeGrade(isOfficial: boolean, depegBps: number): RiskGrade {
  if (!isOfficial || depegBps >= CRITICAL_BPS) return 'CRITICAL';
  if (depegBps >= GRADE_C_BPS) return 'C';
  if (depegBps >= GRADE_B_BPS) return 'B';
  return 'A';
}

/** Solidity enum index for StockGuardRegistry.RiskGrade (0 = UNVERIFIED). */
export function gradeToEnum(grade: RiskGrade): 1 | 2 | 3 | 4 {
  return ({ A: 1, B: 2, C: 3, CRITICAL: 4 } as const)[grade];
}

export function navBasisUnverified(multiplier: number | undefined): boolean {
  return typeof multiplier === 'number' && Number.isFinite(multiplier) && Math.abs(multiplier - 1) > MULTIPLIER_TOLERANCE;
}

/** Signed premium (+) / discount (-) of the DEX price versus NAV, in bps, truncated toward zero. */
export function computePremiumBps(navPriceE8: bigint, dexPriceE8: bigint): number {
  if (navPriceE8 <= 0n) throw new RiskInputError('NAV must be positive');
  return Number(((dexPriceE8 - navPriceE8) * 10_000n) / navPriceE8);
}

export function findOfficial(
  contractAddress: string,
  registry: TokenizedStockSpec[],
): TokenizedStockSpec | undefined {
  const normalized = contractAddress.trim().toLowerCase();
  return registry.find((item) => item.officialContract.toLowerCase() === normalized);
}

export function evaluateTokenizedStockRisk(input: RiskEvaluationInput): RiskEvaluationResult {
  if (!isEvmAddress(input.contractAddress)) {
    throw new RiskInputError('contractAddress must be a 0x-prefixed 20-byte hex address');
  }
  const navE8 = toE8(input.navPriceUsd, 'navPriceUsd');
  const dexE8 = toE8(input.dexPriceUsd, 'dexPriceUsd');
  const now = input.now ?? Date.now();

  const match = findOfficial(input.contractAddress, input.officialRegistry);
  const isOfficialIssuer = Boolean(match);
  const depegBps = computeDepegBps(navE8, dexE8);
  const grade = computeGrade(isOfficialIssuer, depegBps);
  const flags: string[] = [];

  if (!isOfficialIssuer) flags.push('NOT_IN_OFFICIAL_REGISTRY');
  if (depegBps >= CRITICAL_BPS) flags.push('SEVERE_DEPEG_OVER_5PCT');
  else if (depegBps >= GRADE_C_BPS) flags.push('ELEVATED_DEPEG_OVER_2PCT');
  else if (depegBps >= GRADE_B_BPS) flags.push('MINOR_DEPEG_OVER_0_5PCT');

  if (input.isMarketClosed) flags.push('US_AFTER_HOURS_OR_WEEKEND');

  const liq = input.poolLiquidityUsd;
  const liquidityKnown = typeof liq === 'number' && Number.isFinite(liq) && liq >= 0;
  if (!liquidityKnown) flags.push('DEX_LIQUIDITY_UNKNOWN');
  else if (liq < THIN_LIQUIDITY_USD) flags.push('THIN_DEX_LIQUIDITY_UNDER_50K');

  if (input.navUpdatedAt) {
    const t = Date.parse(input.navUpdatedAt);
    if (Number.isFinite(t) && now - t > NAV_STALE_MS) flags.push('NAV_STALE_OVER_26H');
  }
  if (match?.pausedFeatures && match.pausedFeatures.length > 0) flags.push('ISSUER_FEATURES_PAUSED');
  // Coinbase docs do not say whether nav_price is per token or per underlying share. When the
  // multiplier is not 1 the comparison may be off by that factor, so we say so instead of alerting.
  if (match && navBasisUnverified(match.multiplier)) flags.push('NAV_BASIS_UNVERIFIED');

  let recommendedAction: RecommendedAction = 'SAFE_TO_MONITOR';
  if (grade === 'CRITICAL' || grade === 'C') recommendedAction = 'TRIGGER_CIRCUIT_BREAKER';
  else if (grade === 'B') recommendedAction = 'CAUTION_SPREAD';
  // Thin liquidity while the market is closed: escalate the advice, keep the on-chain grade.
  if (
    recommendedAction === 'SAFE_TO_MONITOR' &&
    input.isMarketClosed &&
    liquidityKnown &&
    (liq as number) < THIN_LIQUIDITY_USD
  ) {
    recommendedAction = 'CAUTION_SPREAD';
  }

  return {
    isOfficialIssuer,
    matchedTicker: match?.ticker ?? null,
    navPriceE8: navE8.toString(),
    dexPriceE8: dexE8.toString(),
    depegBps,
    depegPct: depegBps / 100,
    grade,
    flags,
    recommendedAction,
    evaluatedAt: now,
  };
}

/**
 * NYSE full-day closures and 1:00 p.m. ET early closes (nyse.com/trade/hours-calendars).
 * Update once a year; a date missing here is treated as a normal session.
 */
export const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
export const NYSE_EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

/**
 * US regular session check (09:30-16:00 America/New_York, Mon-Fri), with NYSE holidays and
 * 13:00 early closes. The flag is advisory only.
 */
export function isUsMarketClosed(at: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return true;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (NYSE_HOLIDAYS.has(date)) return true;
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const close = NYSE_EARLY_CLOSES.has(date) ? 13 * 60 : 16 * 60;
  return minutes < 9 * 60 + 30 || minutes >= close;
}

/** Base Builder Code format guard (ERC-8021). The suffix itself is built with `ox/erc8021` in apps/web. */
export function assertValidBuilderCode(code: string | undefined): string {
  if (!code || !/^bc_[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error('Missing valid Base Builder Code (expected format: bc_xxxxxxxx)');
  }
  return code;
}
