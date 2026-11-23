import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, stepAlert, INITIAL_ALERT_STATE, type BoardRow } from './board.js';
import { computePremiumBps } from './riskEngine.js';
import type { OfficialRegistrySnapshot } from './officialRegistry.js';
import type { DexQuote } from './dexPrice.js';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const C = '0x3333333333333333333333333333333333333333' as const;
const NOW = Date.parse('2026-11-24T16:00:00Z'); // Tuesday 11:00 New York, market open

function registry(): OfficialRegistrySnapshot {
  return {
    source: 'coinbase-tokenized-stocks-api',
    fetchedAt: NOW,
    assets: [
      { ticker: 'AAA', name: 'A', chainId: 8453, officialContract: A, issuer: 'x', navPriceUsd: 100, navUpdatedAt: new Date(NOW - 60_000).toISOString(), multiplier: 1 },
      { ticker: 'BBB', name: 'B', chainId: 8453, officialContract: B, issuer: 'x', navPriceUsd: 50, navUpdatedAt: new Date(NOW - 60_000).toISOString(), multiplier: 1.0123 },
      { ticker: 'CCC', name: 'C', chainId: 8453, officialContract: C, issuer: 'x', navPriceUsd: 10, navUpdatedAt: new Date(NOW - 60_000).toISOString(), multiplier: 1 },
    ],
  };
}

function quote(price: number, liq: number | null): DexQuote {
  return { priceUsd: price, liquidityUsd: liq, volume24hUsd: null, pairAddress: '0x', dexId: 'uniswap', url: null, source: 'dexscreener', fetchedAt: NOW };
}

test('premium is signed, depeg is absolute', () => {
  assert.equal(computePremiumBps(100_00000000n, 97_00000000n), -300);
  assert.equal(computePremiumBps(100_00000000n, 103_00000000n), 300);
});

test('board sorts by absolute premium and marks missing quotes honestly', () => {
  const q = new Map([[A.toLowerCase(), quote(97, 200_000)], [B.toLowerCase(), quote(50.5, 200_000)]]);
  const b = buildBoard(registry(), q, [], NOW);
  assert.equal(b.rows[0].symbol, 'AAA');
  assert.equal(b.rows[0].premiumBps, -300);
  assert.equal(b.rows[0].alertable, true);
  const c = b.rows.find((r) => r.symbol === 'CCC')!;
  assert.equal(c.status, 'NO_DEX_QUOTE');
  assert.equal(c.dexUsd, null);
  assert.equal(c.alertable, false);
  assert.equal(b.summary.quoted, 2);
  assert.equal(b.marketClosed, false);
});

test('multiplier != 1 blocks alerts instead of guessing the unit', () => {
  const q = new Map([[B.toLowerCase(), quote(40, 200_000)]]);
  const row = buildBoard(registry(), q, [], NOW).rows.find((r) => r.symbol === 'BBB')!;
  assert.ok(row.flags.includes('NAV_BASIS_UNVERIFIED'));
  assert.equal(row.alertable, false);
});

test('thin or unknown liquidity is shown but not alertable', () => {
  const q = new Map([[A.toLowerCase(), quote(90, 2_000)], [C.toLowerCase(), quote(9, null)]]);
  const b = buildBoard(registry(), q, [], NOW);
  assert.equal(b.rows.find((r) => r.symbol === 'AAA')!.alertable, false);
  assert.equal(b.rows.find((r) => r.symbol === 'CCC')!.alertable, false);
});

function row(depegBps: number | null, alertable = true): BoardRow {
  return { symbol: 'AAA', depegBps, alertable } as BoardRow;
}

test('alert needs confirmation, then clears with hysteresis', () => {
  let s = INITIAL_ALERT_STATE;
  let r = stepAlert(s, row(250), 1);
  assert.equal(r.event, null); // first tick only
  r = stepAlert(r.state, row(260), 2);
  assert.equal(r.event?.kind, 'DEPEG');
  s = r.state;
  r = stepAlert(s, row(150), 3); // between clear and trigger: still alerting
  assert.equal(r.event, null);
  assert.equal(r.state.phase, 'alerting');
  r = stepAlert(r.state, row(null, false), 4); // missing data never clears
  assert.equal(r.state.phase, 'alerting');
  r = stepAlert(r.state, row(80), 5);
  assert.equal(r.event?.kind, 'RECOVERED');
  assert.equal(r.event?.kind === 'RECOVERED' && r.event.peakBps, 260);
});

test('a single spike that disappears never alerts', () => {
  let r = stepAlert(undefined, row(900), 1);
  r = stepAlert(r.state, row(10), 2);
  assert.equal(r.event, null);
  assert.equal(r.state.consecutive, 0);
});

test('non-alertable rows reset the confirmation counter', () => {
  let r = stepAlert(undefined, row(300), 1);
  r = stepAlert(r.state, row(300, false), 2);
  assert.equal(r.event, null);
  r = stepAlert(r.state, row(300), 3);
  assert.equal(r.event, null);
});

test('a re-depeg within the re-arm window is quiet, and so is its recovery', () => {
  const cfg = { triggerBps: 200, clearBps: 100, confirmPolls: 2, rearmMs: 60 * 60_000 };
  const MIN = 60_000;
  let r = stepAlert(undefined, row(250), 0, cfg);
  r = stepAlert(r.state, row(250), 1 * MIN, cfg);
  assert.equal(r.event?.kind === 'DEPEG' && r.event.quiet, false); // first alert is public
  r = stepAlert(r.state, row(50), 7 * MIN, cfg);
  assert.equal(r.event?.kind, 'RECOVERED');
  assert.equal(r.event?.quiet, false);
  r = stepAlert(r.state, row(220), 40 * MIN, cfg);
  r = stepAlert(r.state, row(220), 41 * MIN, cfg);
  assert.equal(r.event?.kind, 'DEPEG');
  assert.equal(r.event?.quiet, true); // 34 min after recovery: recorded, not posted
  r = stepAlert(r.state, row(60), 52 * MIN, cfg);
  assert.equal(r.event?.kind, 'RECOVERED');
  assert.equal(r.event?.quiet, true);
  r = stepAlert(r.state, row(230), 200 * MIN, cfg);
  r = stepAlert(r.state, row(230), 201 * MIN, cfg);
  assert.equal(r.event?.kind === 'DEPEG' && r.event.quiet, false); // window passed: public again
});

test('state files written before the re-arm fields still load', () => {
  const old = { phase: 'alerting' as const, consecutive: 2, since: 0, peakBps: 300 };
  const r = stepAlert(old, row(40), 10);
  assert.equal(r.event?.kind, 'RECOVERED');
  assert.equal(r.event?.quiet, false);
  assert.equal(r.state.lastRecoveredAt, 10);
});
