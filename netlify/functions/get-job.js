import { db, hash, json, audit } from './_lib.js';

export default async (req) => {
  const token = new URL(req.url).searchParams.get('t') || '';
  if (token.length < 20) return json(404, { error: 'This link is not valid.' });
  const { data: s } = await db.from('signers').select('*').eq('token_hash', hash(token)).maybeSingle();
  if (!s) return json(404, { error: 'This link is not valid.' });
  const { data: job } = await db.from('signing_jobs').select('*').eq('id', s.job_id).single();

  if (job.deleted_at || job.status === 'cancelled') return json(410, { error: 'This request was cancelled by the sender.' });
  if (new Date(job.expires_at) < new Date()) return json(410, { error: 'This link has expired. Ask the sender for a new one.' });
  if (s.status === 'completed') return json(409, { error: 'You have already signed this form. Thank you.' });
  if (s.status === 'waiting') return json(425, { error: 'This form is not ready for you yet.' });

  if (s.status === 'sent') {
    await db.from('signers').update({ status: 'opened' }).eq('id', s.id);
    await audit(job.id, s.id, 'link_opened', null, req);
  }
  const file = await db.storage.from('signing-pdfs').createSignedUrl(job.pdf_path, 900);
  if (file.error) return json(500, { error: 'Could not load the form.' });
  return json(200, {
    form: job.form, role: s.role, recipientName: job.recipient_name,
    answers: job.answers, lockedFields: job.locked_fields,
    requiredFields: job.required_fields, pdfUrl: file.data.signedUrl
  });
};
