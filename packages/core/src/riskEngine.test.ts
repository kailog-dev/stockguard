import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDepegBps,
  computeGrade,
  evaluateTokenizedStockRisk,
  isUsMarketClosed,
  RiskInputError,
  toE8,
  type TokenizedStockSpec,
} from './riskEngine.js';

const REGISTRY: TokenizedStockSpec[] = [
  {
    ticker: 'NVDA',
    name: 'Test NVDA',
    chainId: 8453,
    officialContract: '0x00000000000000000000000000000000000000a1',
    issuer: 'test',
  },
];
const OFFICIAL = '0x00000000000000000000000000000000000000A1'; // mixed case on purpose
const FAKE = '0x00000000000000000000000000000000000000ff';

test('depeg uses floor division like Solidity (49.99 bps -> 49, grade A)', () => {
  assert.equal(computeDepegBps(toE8(100), toE8(100.4999)), 49);
  assert.equal(computeGrade(true, 49), 'A');
  // v1 used Math.round and graded this B while the contract graded it A
  const r = evaluateTokenizedStockRisk({
    contractAddress: OFFICIAL,
    officialRegistry: REGISTRY,
    navPriceUsd: 100,
    dexPriceUsd: 100.4999,
    poolLiquidityUsd: 1_000_000,
    isMarketClosed: false,
  });
  assert.equal(r.depegBps, 49);
  assert.equal(r.grade, 'A');
});

test('grade thresholds match StockGuardRegistry.computeGrade', () => {
  assert.equal(computeGrade(true, 50), 'B');
  assert.equal(computeGrade(true, 199), 'B');
  assert.equal(computeGrade(true, 200), 'C');
  assert.equal(computeGrade(true, 499), 'C');
  assert.equal(computeGrade(true, 500), 'CRITICAL');
  assert.equal(computeGrade(false, 0), 'CRITICAL');
});

test('official lookup is case-insensitive; unknown address is CRITICAL', () => {
  const base = { officialRegistry: REGISTRY, navPriceUsd: 10, dexPriceUsd: 10, isMarketClosed: false, poolLiquidityUsd: 1e6 };
  assert.equal(evaluateTokenizedStockRisk({ ...base, contractAddress: OFFICIAL }).isOfficialIssuer, true);
  const fake = evaluateTokenizedStockRisk({ ...base, contractAddress: FAKE });
  assert.equal(fake.grade, 'CRITICAL');
  assert.ok(fake.flags.includes('NOT_IN_OFFICIAL_REGISTRY'));
});

test('NaN / zero / negative prices are rejected instead of graded A (v1 bug)', () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        evaluateTokenizedStockRisk({
          contractAddress: OFFICIAL,
          officialRegistry: REGISTRY,
          navPriceUsd: 100,
          dexPriceUsd: bad,
          isMarketClosed: false,
        }),
      RiskInputError,
    );
  }
});

test('malformed address is rejected', () => {
  assert.throws(
    () =>
      evaluateTokenizedStockRisk({
        contractAddress: '0x1234',
        officialRegistry: REGISTRY,
        navPriceUsd: 1,
        dexPriceUsd: 1,
        isMarketClosed: false,
      }),
    RiskInputError,
  );
});

test('thin liquidity after hours escalates advice but not the on-chain grade', () => {
  const r = evaluateTokenizedStockRisk({
    contractAddress: OFFICIAL,
    officialRegistry: REGISTRY,
    navPriceUsd: 100,
    dexPriceUsd: 100.1,
    poolLiquidityUsd: 10_000,
    isMarketClosed: true,
  });
  assert.equal(r.grade, 'A');
  assert.equal(r.recommendedAction, 'CAUTION_SPREAD');
  assert.ok(r.flags.includes('THIN_DEX_LIQUIDITY_UNDER_50K'));
});

test('unknown liquidity is flagged, not assumed', () => {
  const r = evaluateTokenizedStockRisk({
    contractAddress: OFFICIAL,
    officialRegistry: REGISTRY,
    navPriceUsd: 100,
    dexPriceUsd: 100,
    isMarketClosed: false,
  });
  assert.ok(r.flags.includes('DEX_LIQUIDITY_UNKNOWN'));
});

test('stale NAV is flagged after 26h', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const r = evaluateTokenizedStockRisk({
    contractAddress: OFFICIAL,
    officialRegistry: REGISTRY,
    navPriceUsd: 100,
    dexPriceUsd: 100,
    isMarketClosed: true,
    navUpdatedAt: '2026-11-21T20:00:00Z',
    now,
  });
  assert.ok(r.flags.includes('NAV_STALE_OVER_26H'));
});

test('US market hours helper', () => {
  assert.equal(isUsMarketClosed(new Date('2026-11-21T15:00:00Z')), true); // Saturday
  assert.equal(isUsMarketClosed(new Date('2026-11-23T15:00:00Z')), false); // Mon 10:00 ET
  assert.equal(isUsMarketClosed(new Date('2026-11-23T22:00:00Z')), true); // Mon 17:00 ET
});
