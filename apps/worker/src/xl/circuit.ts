/**
 * StockGuard XL — the routing rule as a TapeOut circuit (NAND netlist, TAP-02 binary format).
 *
 * Question it answers for a wallet, router or agent: "may I route a trade of this tokenized stock
 * through this X Layer pool right now?"
 *
 * Inputs (bit i of the eval input = input pin i):
 *   0 UNTRUSTED  token or quote asset is not on the trusted list (look-alike, junk pair)
 *   1 THIN       a $1,000 buy would cost more than 1 % over the pool mid price
 *   2 GAP        pool price is ≥ 2 % away from the reference price
 *   3 CONFIRMED  the gap was also there on the previous check
 *   4 CLOSED     US market closed → the reference share price is frozen
 *   5 STALE      no fresh reference price is available
 *
 * Outputs (bit 0 = DO_NOT_ROUTE, bit 1 = CAUTION; neither = ROUTE_OK):
 *   DO_NOT_ROUTE = UNTRUSTED ∨ THIN ∨ (GAP ∧ CONFIRMED) ∨ (STALE ∧ ¬CLOSED)
 *   CAUTION      = ¬DO_NOT_ROUTE ∧ (GAP ∨ CLOSED)
 *
 * Consumers must treat "could not evaluate" as DO_NOT_ROUTE (fail closed).
 * Format: signals 0/1 = constants, inputs start at 2, each NAND appends one signal,
 * NAND = 0x00 | u24 a | u24 b (big-endian), the last nOut signals are the outputs.
 */
import { keccak256, toHex } from 'viem';

export const INPUTS = ['UNTRUSTED', 'THIN', 'GAP', 'CONFIRMED', 'CLOSED', 'STALE'] as const;
export const OUTPUTS = ['DO_NOT_ROUTE', 'CAUTION'] as const;
export type InputName = (typeof INPUTS)[number];
export type Verdict = 'DO_NOT_ROUTE' | 'CAUTION' | 'ROUTE_OK';

const s = (name: InputName) => 2 + INPUTS.indexOf(name);
const FIRST_GATE = 2 + INPUTS.length; // 8

/** [a, b, meaning] — output signal of gate i is FIRST_GATE + i */
export const GATES: [number, number, string][] = [
  [s('GAP'), s('CONFIRMED'), '¬(GAP∧CONFIRMED)'], //                 8
  [s('CLOSED'), s('CLOSED'), '¬CLOSED'], //                          9
  [s('STALE'), 9, '¬(STALE∧¬CLOSED)'], //                            10
  [8, 10, 'A = (GAP∧CONFIRMED) ∨ (STALE∧¬CLOSED)'], //               11
  [s('UNTRUSTED'), s('UNTRUSTED'), '¬UNTRUSTED'], //                 12
  [s('THIN'), s('THIN'), '¬THIN'], //                                13
  [12, 13, 'UNTRUSTED∨THIN'], //                                     14
  [14, 14, '¬(UNTRUSTED∨THIN)'], //                                  15
  [11, 11, '¬A'], //                                                 16
  [15, 16, 'DNR = UNTRUSTED∨THIN∨A'], //                             17
  [s('GAP'), s('GAP'), '¬GAP'], //                                   18
  [18, 9, 'GAP∨CLOSED'], //                                          19
  [17, 17, '¬DNR'], //                                               20
  [20, 19, '¬(¬DNR ∧ (GAP∨CLOSED))'], //                             21
  [20, 20, 'DO_NOT_ROUTE (output 0)'], //                            22
  [21, 21, 'CAUTION (output 1)'], //                                 23
];

export function encodeNetlist(): Uint8Array {
  const out = new Uint8Array(GATES.length * 7);
  GATES.forEach(([a, b], i) => {
    const self = FIRST_GATE + i;
    if (a >= self || b >= self) throw new Error(`gate ${i} references a future signal`);
    const o = i * 7;
    out.set([0x00, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff], o);
  });
  return out;
}

/** Evaluate the encoded netlist exactly as the on-chain VM does (NAND only). */
export function simulate(netlist: Uint8Array, input: number, nIn = INPUTS.length, nOut = OUTPUTS.length): number {
  const sig: number[] = [0, 1];
  for (let i = 0; i < nIn; i++) sig.push((input >> i) & 1);
  for (let o = 0; o < netlist.length; o += 7) {
    if (netlist[o] !== 0x00) throw new Error(`unsupported opcode ${netlist[o]} at ${o}`);
    const a = (netlist[o + 1] << 16) | (netlist[o + 2] << 8) | netlist[o + 3];
    const b = (netlist[o + 4] << 16) | (netlist[o + 5] << 8) | netlist[o + 6];
    if (a >= sig.length || b >= sig.length) throw new Error('future signal');
    sig.push(sig[a] & sig[b] ? 0 : 1);
  }
  return sig.slice(sig.length - nOut).reduce((acc, v, i) => acc | (v << i), 0);
}

/** The rule written plainly, used to prove the gates are right. */
export function reference(input: number): { DO_NOT_ROUTE: boolean; CAUTION: boolean } {
  const v = (n: InputName) => ((input >> INPUTS.indexOf(n)) & 1) === 1;
  const DO_NOT_ROUTE = v('UNTRUSTED') || v('THIN') || (v('GAP') && v('CONFIRMED')) || (v('STALE') && !v('CLOSED'));
  const CAUTION = !DO_NOT_ROUTE && (v('GAP') || v('CLOSED'));
  return { DO_NOT_ROUTE, CAUTION };
}

export function packInputs(x: Partial<Record<InputName, boolean>>): number {
  return INPUTS.reduce((acc, n, i) => acc | ((x[n] ? 1 : 0) << i), 0);
}

export function decodeOutputs(out: number): Verdict {
  if (out & 1) return 'DO_NOT_ROUTE';
  if (out & 2) return 'CAUTION';
  return 'ROUTE_OK';
}

export const NETLIST = encodeNetlist();
export const NETLIST_HEX = toHex(NETLIST);
export const NETLIST_HASH = keccak256(NETLIST);

export function evaluate(x: Partial<Record<InputName, boolean>>): Verdict {
  return decodeOutputs(simulate(NETLIST, packInputs(x)));
}

// CLI: print the netlist, its hash and the full truth table
if (process.argv[1]?.endsWith('circuit.ts')) {
  const n = INPUTS.length;
  console.log(`StockGuard XL routing circuit: ${n} inputs, ${OUTPUTS.length} outputs, ${GATES.length} NAND, ${NETLIST.length} bytes`);
  console.log(`netlist    ${NETLIST_HEX}`);
  console.log(`keccak256  ${NETLIST_HASH}\n`);
  console.log(`${INPUTS.map((x) => x.slice(0, 9).padEnd(9)).join(' ')} → verdict`);
  let bad = 0;
  for (let x = 0; x < 1 << n; x++) {
    const got = simulate(NETLIST, x);
    const ref = reference(x);
    const ok = ((got & 1) === 1) === ref.DO_NOT_ROUTE && ((got & 2) === 2) === ref.CAUTION;
    if (!ok) bad++;
    console.log(`${INPUTS.map((_, i) => String((x >> i) & 1).padEnd(9)).join(' ')} → ${decodeOutputs(got)}${ok ? '' : '  ✗ MISMATCH'}`);
  }
  console.log(`\n${bad === 0 ? `✓ all ${1 << n} input combinations match the rule` : `✗ ${bad} mismatches`}`);
  if (bad) process.exit(1);
}
