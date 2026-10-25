import { isEmail } from './security.js';

const MONTH_MS = 31 * 86400000;

/**
 * Outbound email. Every message is recorded in the `outbox` table.
 *   EMAIL_DRIVER=log     (default) record only - safe for development and demos
 *   EMAIL_DRIVER=resend  send through the Resend HTTP API (RESEND_API_KEY, EMAIL_FROM)
 */
export function createMailer({ db, env, fetchImpl, now, appName }) {
  const driver = (env.EMAIL_DRIVER || 'log').toLowerCase();

  const record = (userId, msg, status, error = null) =>
    db.run(
      `INSERT INTO outbox (user_id, to_email, subject, body, reply_to, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId ?? null,
      msg.to,
      msg.subject,
      msg.text,
      msg.replyTo ?? null,
      status,
      error,
      now(),
    ).id;

  return {
    driver,

    /** Messages recorded for this user in the trailing ~month (used for plan quotas). */
    sentThisMonth(userId) {
      return db.get(
        `SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND status IN ('sent','logged') AND created_at > ?`,
        userId,
        now() - MONTH_MS,
      ).n;
    },

    async send({ userId = null, to, subject, text, replyTo = null, fromName = appName, footer = true }) {
      if (!isEmail(to)) return { ok: false, error: 'Invalid recipient address' };
      if (/[\r\n]/.test(subject) || /[\r\n]/.test(String(fromName)) || (replyTo && !isEmail(replyTo))) {
        return { ok: false, error: 'Invalid header value' };
      }
      const body = footer
        ? `${text}\n\n--\nSent with ${appName} on behalf of ${fromName}. Reply to this email to reach ${fromName} directly.`
        : text;
      const msg = { to, subject: subject.slice(0, 200), text: body, replyTo };

      if (driver !== 'resend') {
        const id = record(userId, msg, 'logged');
        if (env.NODE_ENV !== 'test') console.log(`[mail:log] to=${to} subject=${JSON.stringify(msg.subject)}`);
        return { ok: true, id, driver };
      }

      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: `${String(fromName).replace(/[<>"]/g, '')} <${env.EMAIL_FROM}>`,
            to: [to],
            subject: msg.subject,
            text: msg.text,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          const id = record(userId, msg, 'failed', `HTTP ${res.status}: ${detail}`);
          return { ok: false, id, error: `Email provider returned ${res.status}` };
        }
        return { ok: true, id: record(userId, msg, 'sent'), driver };
      } catch (err) {
        const id = record(userId, msg, 'failed', String(err.message));
        return { ok: false, id, error: 'Email provider unreachable' };
      }
    },
  };
}
