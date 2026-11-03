// Sends emails (Pro expiry reminders) through SMTP. Sign-in emails come from Clerk.
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
