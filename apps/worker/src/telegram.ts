/** fetch() hides the real network error in err.cause; surface its code (never the URL, which holds the token). */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const c = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  return c ? `${err.message} (${c.code ?? ''}${c.code && c.message ? ': ' : ''}${c.message ?? ''})` : err.message;
}

/** Minimal Telegram Bot API sender. Failures are logged, never thrown: alerts must not stop the poll loop. */
export async function sendTelegram(cfg: { token: string; chatId: string }, html: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // never print the token; the URL contains it
      console.error(`[telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] send failed:', describe(err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks that the token works and that the bot may post in the chat. Never prints or returns the token.
 * Returns a one-line human-readable status.
 */
export async function checkTelegram(cfg: { token: string; chatId: string }): Promise<{ ok: boolean; message: string }> {
  const call = async (method: string, body?: Record<string, unknown>) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      return (await res.json()) as { ok: boolean; description?: string; result?: Record<string, unknown> };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const me = await call('getMe');
    if (!me.ok || !me.result) return { ok: false, message: `bot token rejected (${me.description ?? 'getMe failed'})` };
    const botId = me.result.id as number;
    const botName = `@${me.result.username as string}`;
    const member = await call('getChatMember', { chat_id: cfg.chatId, user_id: botId });
    if (!member.ok || !member.result) return { ok: false, message: `${botName} cannot see chat ${cfg.chatId} (${member.description ?? 'getChatMember failed'})` };
    const status = member.result.status as string;
    const canPost = status === 'creator' || (status === 'administrator' && member.result.can_post_messages !== false);
    return canPost
      ? { ok: true, message: `${botName} can post to ${cfg.chatId}` }
      : { ok: false, message: `${botName} is "${status}" in ${cfg.chatId} without permission to post — make it an admin with "Post messages"` };
  } catch (err) {
    return { ok: false, message: `Telegram unreachable: ${describe(err)}` };
  }
}
