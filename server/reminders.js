// Emails Pro users before (and when) their plan ends.
// Runs from the daily cron job. Each reminder is sent once per Pro period:
// renewing changes pro_until, which starts the reminders afresh.
import { one, query } from "./db.js";
import { sendMail } from "./mailer.js";

// Most urgent first. "days" = send when this many days or fewer are left.
const STAGES = [
  { stage: "expired", days: 0 },
  { stage: "1d", days: 1 },
  { stage: "7d", days: 7 },
];
const RANK = { "7d": 1, "1d": 2, expired: 3 };

function stageFor(proUntil, now = Date.now()) {
  const daysLeft = (new Date(proUntil).getTime() - now) / 864e5;

  if (daysLeft <= 0) return daysLeft > -1 ? "expired" : null; // only on the day it ends
  return STAGES.find((s) => s.days > 0 && daysLeft <= s.days)?.stage ?? null;
}

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function reminderEmail(user, stage, siteUrl) {
  const until = formatDate(user.pro_until);
  const link = `${siteUrl}/?renew=1`;
  const copy = {
    "7d": {
      subject: "Your Pro plan ends in 7 days",
      line: `Your Image Converter Pro plan ends on ${until}. Renew now to keep unlimited conversions and bigger batches.`,
    },
    "1d": {
      subject: "Your Pro plan ends tomorrow",
      line: `Your Image Converter Pro plan ends on ${until}. Renew today so nothing stops working.`,
    },
    expired: {
      subject: "Your Pro plan has ended",
      line: `Your Image Converter Pro plan ended on ${until}. Renew any time to get unlimited conversions back.`,
    },
  }[stage];

  const text = `Hi ${user.name},\n\n${copy.line}\n\nRenew: ${link}\n\nImage Converter Pro`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1a17">
      <h2 style="margin:0 0 12px">${copy.subject}</h2>
      <p style="color:#555">Hi ${user.name.replace(/[<>&"]/g, "")},</p>
      <p style="color:#555">${copy.line}</p>
      <p style="margin:24px 0">
        <a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#e8572a;color:#fff;text-decoration:none;font-weight:bold">Renew Pro</a>
      </p>
      <p style="color:#888;font-size:13px">Image Converter Pro</p>
    </div>`;

  return { subject: copy.subject, text, html };
}

/** Sends any due reminders. Returns how many were sent per stage. */
export async function sendExpiryReminders(siteUrl) {
  // Users whose Pro ends within 7 days, or ended in the last day.
  const users = await query(
    `SELECT id, email, name, pro_until, expiry_reminder_for, expiry_reminder_stage FROM users
     WHERE role = 'user' AND pro_until IS NOT NULL
       AND pro_until BETWEEN now() - interval '1 day' AND now() + interval '7 days'`
  );

  const sent = { "7d": 0, "1d": 0, expired: 0, failed: 0 };

  for (const user of users) {
    const stage = stageFor(user.pro_until);

    if (!stage) continue;

    const samePeriod =
      user.expiry_reminder_for &&
      new Date(user.expiry_reminder_for).getTime() === new Date(user.pro_until).getTime();

    // Already sent this (or a more urgent) reminder for this Pro period.
    if (samePeriod && RANK[user.expiry_reminder_stage] >= RANK[stage]) continue;

    try {
      await sendMail({ to: user.email, ...reminderEmail(user, stage, siteUrl) });
      await one("UPDATE users SET expiry_reminder_for = $1, expiry_reminder_stage = $2 WHERE id = $3", [
        user.pro_until,
        stage,
        user.id,
      ]);
      sent[stage]++;
    } catch (error) {
      console.error(`[reminders] ${user.email}:`, error.message);
      sent.failed++;
    }
  }

  return sent;
}
