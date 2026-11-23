import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export const siteUrl = () => (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const isEmpty = (v) => v === undefined || v === null || v === '' || v === false;
export const DRY = () => process.env.DRY_RUN_EMAIL === 'true' || !process.env.MS_CLIENT_ID;

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export const clientIp = (req) => req.headers.get('x-nf-client-connection-ip') || null;

export function ownerOk(req) {
  const given = req.headers.get('x-owner-key') || '';
  const real = process.env.HYCARE_PASSWORD || '';
  if (!real || given.length !== real.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(real));
}

export async function audit(job_id, signer_id, event, detail, req) {
  await db.from('audit_events').insert({
    job_id,
    signer_id: signer_id || null,
    event,
    detail: detail || null,
    ip: req ? clientIp(req) : null,
    user_agent: req ? req.headers.get('user-agent') : null
  });
}

const tplCache = {};
export async function getTpl(form) {
  if (!tplCache[form]) {
    const r = await fetch(`${siteUrl()}/forms/${form}.json`);
    if (!r.ok) throw new Error('Form template not found');
    tplCache[form] = await r.json();
  }
  return tplCache[form];
}

// Which PDF fields a signer may edit: shared ("all") fields plus their own role's fields.
export const allowedFields = (tpl, role) => tpl.filter((f) => f.role === 'all' || f.role === role);

export function mailHtml(heading, para, link, linkText) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;color:#14202b">
<h2 style="margin:0 0 12px">${heading}</h2><p>${para}</p>
${link ? `<p><a href="${link}" style="background:#0f5f8a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${linkText}</a></p>
<p style="color:#666;font-size:13px">This private link is only for you. Please do not forward it. It expires in 14 days.</p>` : ''}</div>`;
}

async function graphToken() {
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error));
  return j.access_token;
}

// Sends from MAIL_FROM through Microsoft Graph. In test mode (no MS_CLIENT_ID or DRY_RUN_EMAIL=true)
// the email is only written to the function log, so you can test before the Entra app exists.
export async function sendMail({ to, subject, html, attachment }) {
  if (DRY()) {
    console.log('[DRY RUN EMAIL]', JSON.stringify({ to, subject, html, attachment: attachment && attachment.name }));
    return { dryRun: true };
  }
  const token = await graphToken();
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [].concat(to).map((address) => ({ emailAddress: { address } }))
  };
  if (attachment) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.name,
      contentType: 'application/pdf',
      contentBytes: attachment.base64
    }];
  }
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true })
  });
  if (!r.ok) throw new Error('Email failed: ' + (await r.text()));
  return { dryRun: false };
}
