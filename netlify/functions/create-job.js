import { randomUUID } from 'node:crypto';
import { db, newToken, hash, json, audit, sendMail, mailHtml, ownerOk, getTpl, siteUrl, esc, DRY } from './_lib.js';

const NAMES = { r18: 'Rooming accommodation agreement (Form R18)', f1a: 'Entry condition report (Form 1a)' };
const PREFILL_NAME = { r18: 'Resident 1 full name/s', f1a: 'Full name of the tenants 1' };
const EMAIL = /^\S+@\S+\.\S+$/;

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!ownerOk(req)) return json(401, { error: 'Wrong password' });

  const b = await req.json();
  const form = b.form;
  if (!NAMES[form]) return json(400, { error: 'Unknown form' });
  const first = b.firstRole === 'staff' ? 'staff' : 'resident';
  const rName = String(b.recipientName || '').trim();
  const rEmail = String(b.recipientEmail || '').trim().toLowerCase();
  const oEmail = String(b.ownerEmail || '').trim().toLowerCase();
  if (!EMAIL.test(rEmail) || !EMAIL.test(oEmail)) return json(400, { error: 'Enter valid email addresses' });

  const pdfRes = await fetch(`${siteUrl()}/forms/${form}.pdf`);
  if (!pdfRes.ok) return json(500, { error: 'The form PDF is missing from the site' });
  const bytes = Buffer.from(await pdfRes.arrayBuffer());
  const tpl = await getTpl(form);

  const jobId = randomUUID();
  const path = `${jobId}/original.pdf`;
  const up = await db.storage.from('signing-pdfs').upload(path, bytes, { contentType: 'application/pdf' });
  if (up.error) return json(500, { error: 'Could not store the PDF: ' + up.error.message });

  const answers = rName ? { [PREFILL_NAME[form]]: rName } : {};
  const ins = await db.from('signing_jobs').insert({
    id: jobId, form, status: 'sent', first_role: first, owner_email: oEmail,
    recipient_name: rName, recipient_email: rEmail, answers,
    required_fields: tpl.filter((f) => f.req).map((f) => f.name), pdf_path: path
  });
  if (ins.error) return json(500, { error: 'Could not save the job: ' + ins.error.message });

  const people = {
    resident: { role: 'resident', name: rName, email: rEmail },
    staff: { role: 'staff', name: String(b.ownerName || '').trim(), email: oEmail }
  };
  const order = first === 'resident' ? [people.resident, people.staff] : [people.staff, people.resident];
  const token = newToken();
  const si = await db.from('signers').insert(order.map((p, i) => ({
    job_id: jobId, role: p.role, position: i + 1, name: p.name, email: p.email,
    token_hash: hash(i === 0 ? token : newToken()), status: i === 0 ? 'sent' : 'waiting'
  })));
  if (si.error) return json(500, { error: 'Could not save the signers: ' + si.error.message });

  const link = `${siteUrl()}/sign.html?t=${token}`;
  const who = order[0];
  await sendMail({
    to: who.email,
    subject: first === 'resident' ? `Please review and sign: ${NAMES[form]}` : `Your turn to complete: ${NAMES[form]}`,
    html: mailHtml(
      first === 'resident' ? 'Please review and sign your tenancy form' : 'Your form is ready',
      `Hi ${esc(who.name || '')}, please open the private link below to ${first === 'resident' ? 'fill in your details and sign' : 'complete your part and sign'}.`,
      link, 'Open the form')
  });
  await audit(jobId, null, 'job_created_and_sent', { form, first }, req);
  return json(200, { ok: true, jobId, firstLink: first === 'staff' || DRY() ? link : undefined });
};
