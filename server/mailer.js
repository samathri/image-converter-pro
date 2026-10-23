// Sends emails (signup codes, password reset codes) through SMTP.
// Gmail: SMTP_USER = your Gmail address, SMTP_PASS = a Google App Password.
// Without SMTP settings, local development prints emails to the console.
import nodemailer from "nodemailer";

const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = (process.env.SMTP_PASS || "").replace(/\s+/g, ""); // App Passwords are shown with spaces
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER && `Image Converter Pro <${SMTP_USER}>`);

export const emailConfigured = Boolean(SMTP_USER && SMTP_PASS);

let transport;

function getTransport() {
  transport ||= nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transport;
}

export async function sendMail({ to, subject, text, html }) {
  if (!emailConfigured) {
    if (process.env.VERCEL) {
      throw Object.assign(new Error("Email isn't set up yet. Please try again later."), { status: 503 });
    }

    console.log(`[mail] (not sent, SMTP not configured) To: ${to} | ${subject}\n${text}`);
    return;
  }

  try {
    await getTransport().sendMail({ from: MAIL_FROM, to, subject, text, html });
  } catch (error) {
    console.error("[mail] send failed:", error.message);
    throw Object.assign(new Error("We couldn't send the email. Please try again."), { status: 502 });
  }
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Email with a 6-digit code, used for signup and password reset. */
export function sendCodeEmail(to, { title, intro, code }) {
  const text = `${intro}\n\nYour code: ${code}\n\nIt expires in 10 minutes. If you didn't ask for this, you can ignore this email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1a17">
      <h2 style="margin:0 0 8px">${escape(title)}</h2>
      <p style="color:#555">${escape(intro)}</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0;padding:16px;text-align:center;background:#fff3ec;border-radius:12px;color:#e8572a">${escape(code)}</p>
      <p style="color:#888;font-size:13px">The code expires in 10 minutes. If you didn't ask for this, you can ignore this email.</p>
      <p style="color:#888;font-size:13px">Image Converter Pro</p>
    </div>`;

  return sendMail({ to, subject: `${title}: ${code}`, text, html });
}
