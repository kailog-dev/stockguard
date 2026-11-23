/**
 * StockGuard worker — the engine behind the board.
 *
 * Every POLL_INTERVAL_SEC:
 *   1. official tokenized-stock list + NAV from the Coinbase Tokenized Stocks API
 *   2. deepest Base DEX pool price per token from DexScreener
 *   3. build the board, save it (.data/board.json) and append history
 *   4. run the alert state machine (confirmation + hysteresis)
 *   5. on a confirmed depeg: hash-chained audit record, Telegram alert, and (if configured) reportMarket()
 *      on Base Sepolia, which the Reactive sentinel turns into a circuit-breaker callback
 *
 * Run:  npm run worker          (loop)
 *       npm run worker:once     (single pass, prints a summary)
 */
import {
  appendAuditRecord,
  appendHistory,
  buildBoard,
  computeReportHash,
  fetchDexQuotes,
  getOfficialRegistry,
  readAlertState,
  readOnchainLog,
  stepAlert,
  writeAlertState,
  writeBoard,
  type AlertEvent,
  type BoardSnapshot,
} from '@stockguard/core';
import { loadConfig } from './config.js';
import { formatAlert, pct } from './format.js';
import { checkTelegram, sendTelegram } from './telegram.js';
import { createMirror } from './onchain.js';

const cfg = loadConfig();
const mirror = createMirror(cfg.onchain);
const once = process.argv.includes('--once');
const lastHeartbeat = new Map<string, number>();

async function handleEvent(e: AlertEvent, board: BoardSnapshot) {
  const r = e.row;
  await appendAuditRecord({
    actor: 'worker',
    network: 'offchain',
    action: e.quiet ? `${e.kind}_QUIET` : e.kind,
    assetAddress: r.address,
    grade: r.grade ?? undefined,
    depegBps: r.depegBps ?? undefined,
    reportHash: computeReportHash({ symbol: r.symbol, nav: r.navUsd, dex: r.dexUsd, premiumBps: r.premiumBps, at: board.generatedAt }),
  });
  console.log(`[alert] ${e.kind}${e.quiet ? ' (quiet: re-arm window)' : ''} ${r.symbol} ${pct(r.premiumBps)}`);

  // Quiet events are recorded and still reported on-chain (the breaker must stay strict), but not re-posted.
  if (cfg.telegram && !e.quiet) await sendTelegram(cfg.telegram, formatAlert(e, { marketClosed: board.marketClosed, appUrl: cfg.publicAppUrl }));

  if (!mirror) return;
  try {
    const rep = await mirror.report(r, 'REPORT', undefined, e.kind);
    lastHeartbeat.set(r.symbol, Date.now());
    if (e.kind === 'DEPEG' && rep.alertEmitted) {
      // don't block the poll loop while Reactive delivers the callback
      void mirror.waitForBreaker(r, rep.blockNumber).then((cb) => {
        if (!cb) console.warn(`[onchain] no breaker callback for ${r.symbol} within 5 min — check RSC funding / debt`);
      });
    }
    if (e.kind === 'RECOVERED' && cfg.onchain.autoClearBreaker) await mirror.clearBreaker(r);
  } catch (err) {
    console.error(`[onchain] ${r.symbol}:`, err instanceof Error ? err.message : err);
  }
}

async function heartbeats(board: BoardSnapshot) {
  if (!mirror || cfg.onchain.heartbeatSymbols.length === 0) return;
  if (lastHeartbeat.size === 0) {
    // restore from the on-chain log so a restart does not re-send every heartbeat
    for (const ev of await readOnchainLog()) {
      if (ev.kind === 'HEARTBEAT' || ev.kind === 'REPORT') lastHeartbeat.set(ev.symbol, Math.max(lastHeartbeat.get(ev.symbol) ?? 0, ev.at));
    }
  }
  const due = cfg.onchain.heartbeatHours * 3600_000;
  for (const sym of cfg.onchain.heartbeatSymbols) {
    const row = board.rows.find((r) => r.symbol.toUpperCase() === sym);
    if (!row || row.status !== 'OK') continue;
    if (Date.now() - (lastHeartbeat.get(row.symbol) ?? 0) < due) continue;
    try {
      await mirror.report(row, 'HEARTBEAT');
      lastHeartbeat.set(row.symbol, Date.now());
    } catch (err) {
      console.error(`[onchain] heartbeat ${sym}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Adds the on-chain breaker state (Base Sepolia) to rows whose asset is registered in our registry. */
async function attachBreakerStates(board: BoardSnapshot) {
  if (!mirror) return;
  const registered = new Set((await readOnchainLog()).filter((e) => e.kind === 'REGISTER').map((e) => e.asset.toLowerCase()));
  if (registered.size === 0) return;
  const rows = board.rows.filter((r) => registered.has(r.address.toLowerCase()));
  const states = await mirror.breakerStates(rows.map((r) => r.address));
  for (const r of rows) {
    const s = states.get(r.address.toLowerCase());
    if (s?.registered) r.onchain = { breakerActive: s.active, lastDepegBps: s.lastDepegBps, triggeredAt: s.triggeredAt };
  }
}

async function tick(): Promise<BoardSnapshot> {
  const registry = await getOfficialRegistry(true);
  if (registry.source === 'unavailable') console.warn(`[registry] unavailable: ${registry.error}`);
  else if (registry.error) console.warn(`[registry] ${registry.error}`);

  const { quotes, errors } = await fetchDexQuotes(registry.assets.map((a) => a.officialContract));
  for (const e of errors) console.warn(`[dex] ${e}`);

  const board = buildBoard(registry, quotes, errors, Date.now(), { minAlertLiquidityUsd: cfg.minAlertLiquidityUsd });
  await attachBreakerStates(board);
  await writeBoard(board);
  await appendHistory(board);

  // A failed registry fetch must not look like "everything recovered": skip alert evaluation.
  if (registry.source !== 'unavailable') {
    const state = await readAlertState();
    const events: AlertEvent[] = [];
    for (const row of board.rows) {
      const { state: next, event } = stepAlert(state[row.symbol], row, board.generatedAt, cfg.alert);
      state[row.symbol] = next;
      if (event) events.push(event);
    }
    await writeAlertState(state);
    for (const e of events) await handleEvent(e, board);
  }
  await heartbeats(board);
  return board;
}

function summary(b: BoardSnapshot) {
  const w = b.summary.worst;
  return `${b.summary.quoted}/${b.summary.total} quoted, ${b.summary.alertable} alertable, worst ${w ? `${w.symbol} ${pct(w.premiumBps)}` : 'n/a'}${b.marketClosed ? ' (US market closed)' : ''}`;
}

async function main() {
  console.log(`[worker] poll every ${cfg.pollIntervalSec}s · trigger ${cfg.alert.triggerBps} bps · clear ${cfg.alert.clearBps} bps · confirm ${cfg.alert.confirmPolls} · re-arm ${cfg.alert.rearmMs / 60_000} min`);
  console.log(`[worker] telegram ${cfg.telegram ? 'on' : 'off'} · on-chain mirror ${mirror ? `on (${mirror.registry})` : 'off'}`);
  if (cfg.telegram) {
    const t = await checkTelegram(cfg.telegram);
    console[t.ok ? 'log' : 'warn'](`[telegram] ${t.ok ? '✓' : '✗'} ${t.message}`);
  }
  if (mirror) {
    const s = await mirror.status();
    console.log(`[onchain] reporter ${mirror.account} · reporter=${s.isReporter} owner=${s.isOwner} · ${s.balanceEth} ETH`);
    if (!s.isReporter) console.warn('[onchain] this key is not a reporter yet — run `npm run onchain:setup`');
    if (Number(s.balanceEth) < 0.002) console.warn('[onchain] low Base Sepolia ETH — get some from a faucet');
  }

  if (once) {
    const b = await tick();
    console.log(`[worker] ${summary(b)}`);
    for (const r of b.rows.slice(0, 10)) {
      console.log(`  ${r.symbol.padEnd(8)} ${r.status.padEnd(13)} nav ${String(r.navUsd ?? '-').padEnd(10)} dex ${String(r.dexUsd ?? '-').padEnd(10)} ${pct(r.premiumBps)}${r.alertable ? '' : `  (${r.notAlertableReasons.join('; ')})`}`);
    }
    return;
  }

  let running = false;
  let stopped = false;
  const loop = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const b = await tick();
      console.log(`[${new Date().toISOString()}] ${summary(b)}`);
    } catch (err) {
      console.error('[worker] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  await loop();
  const timer = setInterval(loop, cfg.pollIntervalSec * 1000);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    console.log('[worker] stopping');
    setTimeout(() => process.exit(0), running ? 5_000 : 0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[worker] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
