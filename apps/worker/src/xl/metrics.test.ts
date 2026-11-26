import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickerOf, buyImpact, priceFromSqrt, gapBps } from './metrics.js';

test('tickerOf', () => {
  assert.equal(tickerOf('wAAPLx'), 'AAPL');
  assert.equal(tickerOf('ANTx'), 'ANT');
  assert.equal(tickerOf('USDG'), null);
  assert.equal(tickerOf('oaoa'), null);
});

test('price and impact are consistent in both orientations', () => {
  // stock (18 dp) = token0, USDG (6 dp) = token1, price $84
  const p0in1raw = 84 * 1e6 / 1e18;
  const sqrt = BigInt(Math.round(Math.sqrt(p0in1raw) * 2 ** 96));
  assert.ok(Math.abs(priceFromSqrt(sqrt, 18, 6) - 84) < 1e-6);
  const deep = buyImpact({ sqrtPriceX96: sqrt, liquidity: 10n ** 18n, stableIsToken0: false, stableDecimals: 6, usd: 1000 });
  const shallow = buyImpact({ sqrtPriceX96: sqrt, liquidity: 9_523_456_905_352n, stableIsToken0: false, stableDecimals: 6, usd: 1000 });
  assert.ok(deep < 0.02, `deep pool impact ${deep}`);
  assert.ok(shallow > 1, `shallow pool impact ${shallow}`); // the real ANTx/USDG pool: >100 %
  assert.equal(buyImpact({ sqrtPriceX96: sqrt, liquidity: 0n, stableIsToken0: false, stableDecimals: 6, usd: 1000 }), Infinity);
  // mirrored orientation gives the same impact
  const sqrtInv = BigInt(Math.round(Math.sqrt(1 / p0in1raw) * 2 ** 96));
  const mirrored = buyImpact({ sqrtPriceX96: sqrtInv, liquidity: 10n ** 18n, stableIsToken0: true, stableDecimals: 6, usd: 1000 });
  assert.ok(Math.abs(mirrored - deep) / deep < 1e-6, `${mirrored} vs ${deep}`);
});

test('gapBps', () => {
  assert.equal(gapBps(62.64, 83.92), -2536); // BSC ANTX vs Ethereum, Nov 26
  assert.equal(gapBps(83.74, 83.92), -21);
});
