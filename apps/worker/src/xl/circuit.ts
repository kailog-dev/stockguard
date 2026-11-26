/**
 * StockGuard XL — the breaker rule as a TapeOut circuit (NAND netlist, TAP-02 binary format).
 *
 * Inputs (bit i of the eval input byte = input pin i):
 *   0 GAP        |DEX − NAV| ≥ 2 % on this check
 *   1 CONFIRMED  the gap was also there on the previous check
 *   2 CLOSED     US market closed → NAV is frozen
 *   3 STALE      NAV older than the freshness limit
 *   4 THIN       pool liquidity below the floor
 *
 * Outputs (bit 0 = HALT, bit 1 = WARN):
 *   HALT = (GAP ∧ CONFIRMED) ∨ (STALE ∧ ¬CLOSED)
 *          a confirmed depeg, or an oracle that stopped updating while the market is open
 *   WARN = ¬HALT ∧ (GAP ∨ THIN ∨ CLOSED)
 *          an unconfirmed gap, a thin pool, or after-hours trading against a frozen NAV
 *   OK   = neither
 *
 * Consumers must treat "could not evaluate" as HALT (fail closed).
 *
 * Netlist format (verified on X Layer mainnet by other builders):
 *   signals 0/1 = constants, inputs start at 2, each gate appends one signal,
 *   NAND = 0x00 | u24 a | u24 b (big-endian), the last nOut signals are the outputs.
 */
import { keccak256, toHex } from 'viem';

export const INPUTS = ['GAP', 'CONFIRMED', 'CLOSED', 'STALE', 'THIN'] as const;
export const OUTPUTS = ['HALT', 'WARN'] as const;
export type InputName = (typeof INPUTS)[number];

const sig = (name: InputName) => 2 + INPUTS.indexOf(name);
const FIRST_GATE = 2 + INPUTS.length; // 7

/** [a, b, comment] — output signal of gate i is FIRST_GATE + i */
export const GATES: [number, number, string][] = [
  [sig('GAP'), sig('CONFIRMED'), '¬(GAP∧CONFIRMED)'], //            7
  [sig('CLOSED'), sig('CLOSED'), '¬CLOSED'], //                    8
  [sig('STALE'), 8, '¬(STALE∧¬CLOSED)'], //                        9
  [7, 9, 'HALT₀ = (GAP∧CONFIRMED) ∨ (STALE∧¬CLOSED)'], //          10
  [sig('GAP'), sig('GAP'), '¬GAP'], //                             11
  [sig('THIN'), sig('THIN'), '¬THIN'], //                          12
  [11, 12, 'GAP∨THIN'], //                                         13
  [13, 13, '¬(GAP∨THIN)'], //                                      14
  [14, 8, 'GAP∨THIN∨CLOSED'], //                                   15
  [10, 10, '¬HALT₀'], //                                           16
  [16, 15, '¬(¬HALT₀ ∧ (GAP∨THIN∨CLOSED))'], //                    17
  [16, 16, 'HALT (output 0)'], //                                  18
  [17, 17, 'WARN (output 1)'], //                                  19
];

export function encodeNetlist(): Uint8Array {
  const out = new Uint8Array(GATES.length * 7);
  GATES.forEach(([a, b], i) => {
    const self = FIRST_GATE + i;
    if (a >= self || b >= self) throw new Error(`gate ${i} references a future signal`);
    const o = i * 7;
    out[o] = 0x00;
    out[o + 1] = (a >> 16) & 0xff; out[o + 2] = (a >> 8) & 0xff; out[o + 3] = a & 0xff;
    out[o + 4] = (b >> 16) & 0xff; out[o + 5] = (b >> 8) & 0xff; out[o + 6] = b & 0xff;
  });
  return out;
}

/** Evaluate the encoded netlist exactly as the on-chain VM does (NAND only). */
export function simulate(netlist: Uint8Array, inputByte: number, nIn = INPUTS.length, nOut = OUTPUTS.length): number {
  const s: number[] = [0, 1];
  for (let i = 0; i < nIn; i++) s.push((inputByte >> i) & 1);
  for (let o = 0; o < netlist.length; o += 7) {
    if (netlist[o] !== 0x00) throw new Error(`unsupported opcode ${netlist[o]} at ${o}`);
    const a = (netlist[o + 1] << 16) | (netlist[o + 2] << 8) | netlist[o + 3];
    const b = (netlist[o + 4] << 16) | (netlist[o + 5] << 8) | netlist[o + 6];
    if (a >= s.length || b >= s.length) throw new Error('future signal');
    s.push(s[a] & s[b] ? 0 : 1);
  }
  let out = 0;
  const outs = s.slice(s.length - nOut);
  outs.forEach((v, i) => (out |= v << i));
  return out;
}

/** The rule written plainly, used to prove the gates are right. */
export function reference(inputByte: number): { HALT: boolean; WARN: boolean } {
  const v = (n: InputName) => ((inputByte >> INPUTS.indexOf(n)) & 1) === 1;
  const HALT = (v('GAP') && v('CONFIRMED')) || (v('STALE') && !v('CLOSED'));
  const WARN = !HALT && (v('GAP') || v('THIN') || v('CLOSED'));
  return { HALT, WARN };
}

export function packInputs(x: Partial<Record<InputName, boolean>>): number {
  return INPUTS.reduce((acc, n, i) => acc | ((x[n] ? 1 : 0) << i), 0);
}

export function decodeOutputs(out: number): 'HALT' | 'WARN' | 'OK' {
  if (out & 1) return 'HALT';
  if (out & 2) return 'WARN';
  return 'OK';
}

export const NETLIST = encodeNetlist();
export const NETLIST_HEX = toHex(NETLIST);
export const NETLIST_HASH = keccak256(NETLIST);

// CLI: print the netlist, its hash and the full truth table
if (process.argv[1]?.endsWith('circuit.ts')) {
  console.log(`StockGuard XL breaker circuit: ${INPUTS.length} inputs, ${OUTPUTS.length} outputs, ${GATES.length} NAND, ${NETLIST.length} bytes`);
  console.log(`netlist      ${NETLIST_HEX}`);
  console.log(`keccak256    ${NETLIST_HASH}\n`);
  console.log(`${INPUTS.map((n) => n.padEnd(9)).join(' ')} → state`);
  let mismatches = 0;
  for (let x = 0; x < 1 << INPUTS.length; x++) {
    const got = simulate(NETLIST, x);
    const ref = reference(x);
    const ok = ((got & 1) === 1) === ref.HALT && ((got & 2) === 2) === ref.WARN;
    if (!ok) mismatches++;
    console.log(`${INPUTS.map((_, i) => String((x >> i) & 1).padEnd(9)).join(' ')} → ${decodeOutputs(got).padEnd(4)}${ok ? '' : '  ✗ MISMATCH'}`);
  }
  console.log(`\n${mismatches === 0 ? '✓ all 32 input combinations match the rule' : `✗ ${mismatches} mismatches`}`);
  if (mismatches) process.exit(1);
}
