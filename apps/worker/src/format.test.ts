import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, pct, compactUsd } from './format.js';
import type { BoardRow } from '@stockguard/core';

const row = {
  symbol: 'AAPL',
  name: 'Apple <Inc>',
  navUsd: 233.5,
  dexUsd: 227.1,
  premiumBps: -274,
  depegBps: 274,
  liquidityUsd: 412_000,
  dexId: 'uniswap',
  grade: 'C',
} as BoardRow;

test('percent and money helpers', () => {
  assert.equal(pct(-274), '−2.74%');
  assert.equal(pct(31), '+0.31%');
  assert.equal(compactUsd(412_000), '$412.0k');
  assert.equal(compactUsd(null), 'unknown');
});

test('depeg alert escapes HTML and carries the disclaimer', () => {
  const t = formatAlert({ kind: 'DEPEG', symbol: 'AAPL', row, quiet: false }, { marketClosed: true, appUrl: 'https://x.app' });
  assert.match(t, /Apple &lt;Inc&gt;/);
  assert.match(t, /−2\.74%/);
  assert.match(t, /discount/);
  assert.match(t, /not offered to US persons/);
  assert.match(t, /https:\/\/x\.app\/#AAPL/);
});

test('recovery message', () => {
  const t = formatAlert({ kind: 'RECOVERED', symbol: 'AAPL', row: { ...row, premiumBps: -40 }, peakBps: 310, durationMs: 42 * 60_000, quiet: false }, { marketClosed: false, appUrl: null });
  assert.match(t, /back near NAV/);
  assert.match(t, /42 min/);
  assert.match(t, /3\.10%/);
});
