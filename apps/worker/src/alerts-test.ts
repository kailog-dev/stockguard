/**
 * Checks the Telegram setup and posts one clearly labelled test message to the alert channel.
 *   npm run alerts:test            (check only)
 *   npm run alerts:test -- --send  (check, then post the test message; delete it from the channel afterwards)
 */
import { loadConfig } from './config.js';
import { checkTelegram, sendTelegram } from './telegram.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.telegram) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set in .env.');
    process.exit(1);
  }
  const t = await checkTelegram(cfg.telegram);
  console.log(`${t.ok ? '✓' : '✗'} ${t.message}`);
  if (!t.ok) process.exit(1);
  if (!process.argv.includes('--send')) {
    console.log('Setup looks right. Add --send to post a test message.');
    return;
  }
  const sent = await sendTelegram(
    cfg.telegram,
    '🧪 <b>StockGuard test</b> — checking the alert pipeline. Not a market alert; this message will be deleted.',
  );
  console.log(sent ? '✓ Test message posted. Check the channel, then delete it there.' : '✗ Sending failed (see the error above).');
  if (!sent) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
