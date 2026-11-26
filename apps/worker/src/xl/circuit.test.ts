import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETLIST, GATES, INPUTS, simulate, reference, evaluate } from './circuit.js';

test('netlist is 7 bytes per NAND gate', () => assert.equal(NETLIST.length, GATES.length * 7));

test('all 64 input combinations match the plain-language rule', () => {
  for (let x = 0; x < 1 << INPUTS.length; x++) {
    const got = simulate(NETLIST, x);
    const ref = reference(x);
    assert.equal((got & 1) === 1, ref.DO_NOT_ROUTE, `DNR x=${x}`);
    assert.equal((got & 2) === 2, ref.CAUTION, `CAUTION x=${x}`);
    assert.ok(!((got & 1) && (got & 2)), 'never both');
  }
});

test('cases from real X Layer data (Nov 2026)', () => {
  // ANTx/USDG: price fine but ~$9 of liquidity → a $1k trade moves it far more than 2 %
  assert.equal(evaluate({ THIN: true }), 'DO_NOT_ROUTE');
  // wAAPLx/oaoa: Apple xStock paired with an unknown token, price $88M
  assert.equal(evaluate({ UNTRUSTED: true, GAP: true }), 'DO_NOT_ROUTE');
  // deep, trusted pool, after hours, in line with the reference
  assert.equal(evaluate({ CLOSED: true }), 'CAUTION');
  // first sighting of a gap on a deep, trusted pool
  assert.equal(evaluate({ GAP: true }), 'CAUTION');
  // same gap seen twice
  assert.equal(evaluate({ GAP: true, CONFIRMED: true }), 'DO_NOT_ROUTE');
  // no reference while the market is open → cannot verify → do not route
  assert.equal(evaluate({ STALE: true }), 'DO_NOT_ROUTE');
  // deep, trusted, open market, in line
  assert.equal(evaluate({}), 'ROUTE_OK');
});
