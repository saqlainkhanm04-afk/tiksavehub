/**
 * Email notification helper — sends alert emails to the admin when
 * Instagram cookies need attention.
 *
 * Env vars (all required for email):
 *   SMTP_HOST     — SMTP server (e.g. smtp.gmail.com)
 *   SMTP_PORT     — port (default 465 for SSL, 587 for STARTTLS)
 *   SMTP_USER     — login username (your email)
 *   SMTP_PASS     — login password (Gmail: use App Password, not real password)
 *   SMTP_FROM     — sender address (usually same as SMTP_USER)
 *   NOTIFY_TO     — recipient email (where alerts go)
 *
 * All must be set for email to fire. Missing any = silent no-op.
 */

import nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function emailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM &&
    process.env.NOTIFY_TO
  );
}

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = port === 465; // SSL for 465, STARTTLS for 587

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10_000,
  });

  return transporter;
}

/**
 * Send an HTML email. Returns true on success, false on failure.
 * Never throws — notification failures must never crash the server.
 */
export async function sendEmail(subject: string, htmlBody: string): Promise<boolean> {
  if (!emailConfigured()) return false;

  try {
    const info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.NOTIFY_TO,
      subject,
      html: htmlBody,
    });
    console.log(`[notify] Email sent: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error('[notify] Email send failed:', (err as Error)?.message ?? err);
    // Reset transporter on failure so next attempt creates a fresh connection
    transporter = null;
    return false;
  }
}

/**
 * Check if notifications are enabled (either email or Telegram).
 */
export function notificationsEnabled(): boolean {
  return emailConfigured();
}
