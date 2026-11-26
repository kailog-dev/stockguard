import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETLIST, GATES, simulate, reference, packInputs, decodeOutputs } from './circuit.js';

test('netlist is 7 bytes per NAND gate', () => assert.equal(NETLIST.length, GATES.length * 7));

test('all 32 input combinations match the plain-language rule', () => {
  for (let x = 0; x < 32; x++) {
    const got = simulate(NETLIST, x);
    const ref = reference(x);
    assert.equal((got & 1) === 1, ref.HALT, `HALT x=${x}`);
    assert.equal((got & 2) === 2, ref.WARN, `WARN x=${x}`);
    assert.ok(!(got & 1 && got & 2), 'HALT and WARN never both on');
  }
});

test('real cases', () => {
  // Nov 24 after the close: +2.30% confirmed twice → HALT
  assert.equal(decodeOutputs(simulate(NETLIST, packInputs({ GAP: true, CONFIRMED: true, CLOSED: true }))), 'HALT');
  // first sighting of a gap → WARN, not HALT
  assert.equal(decodeOutputs(simulate(NETLIST, packInputs({ GAP: true }))), 'WARN');
  // calm, after hours → WARN (NAV frozen)
  assert.equal(decodeOutputs(simulate(NETLIST, packInputs({ CLOSED: true }))), 'WARN');
  // NAV frozen while the market is open → oracle problem → HALT
  assert.equal(decodeOutputs(simulate(NETLIST, packInputs({ STALE: true }))), 'HALT');
  // stale NAV after hours is expected → only WARN
  assert.equal(decodeOutputs(simulate(NETLIST, packInputs({ STALE: true, CLOSED: true }))), 'WARN');
  // calm, open, deep pool → OK
  assert.equal(decodeOutputs(simulate(NETLIST, 0)), 'OK');
});
