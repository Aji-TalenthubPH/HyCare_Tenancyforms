import { db, hash, newToken, json, audit, sendMail, mailHtml, getTpl, allowedFields, isEmpty, clientIp, siteUrl, esc, DRY } from './_lib.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const { token, answers = {}, signaturePng, consent } = await req.json();
  const { data: s } = await db.from('signers').select('*').eq('token_hash', hash(token || '')).maybeSingle();
  if (!s || s.status === 'completed' || s.status === 'waiting') return json(400, { error: 'This link cannot be used.' });
  const { data: job } = await db.from('signing_jobs').select('*').eq('id', s.job_id).single();
  if (job.status === 'cancelled' || new Date(job.expires_at) < new Date()) return json(410, { error: 'This request is no longer active.' });

  if (consent !== true) return json(400, { error: 'Please agree to sign electronically.' });
  if (typeof signaturePng !== 'string' || !signaturePng.startsWith('data:image/png;base64,') || signaturePng.length > 400000)
    return json(400, { error: 'A signature is required.' });

  // Only accept fields this signer is allowed to edit and that nobody has locked yet.
  const tpl = await getTpl(job.form);
  const locked = new Set(job.locked_fields || []);
  const mine = allowedFields(tpl, s.role).filter((f) => !locked.has(f.name));
  const mineNames = new Set(mine.map((f) => f.name));
  const clean = {};
  for (const [k, v] of Object.entries(answers)) {
    if (mineNames.has(k) && (typeof v === 'string' || typeof v === 'boolean')) clean[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  const merged = { ...job.answers, ...clean };

  // Required fields: this role's own fields, plus shared fields when the resident is signing.
  const missing = mine
    .filter((f) => f.req && (f.role === s.role || (f.role === 'all' && s.role === 'resident')))
    .filter((f) => isEmpty(merged[f.name]))
    .map((f) => f.label);
  if (missing.length) return json(400, { error: 'Required fields are empty: ' + missing.slice(0, 5).join(', '), missing });

  // Lock this signer's own fields, and shared fields they filled in. Empty shared fields stay open.
  const newLocks = mine.filter((f) => f.role === s.role || !isEmpty(merged[f.name])).map((f) => f.name);
  const now = new Date().toISOString();

  await db.from('signers').update({
    status: 'completed', signature_png: signaturePng, signed_at: now, consent_at: now,
    ip: clientIp(req), user_agent: req.headers.get('user-agent')
  }).eq('id', s.id);
  await db.from('signing_jobs').update({
    answers: merged, locked_fields: [...new Set([...(job.locked_fields || []), ...newLocks])],
    status: 'in_progress', updated_at: now
  }).eq('id', job.id);
  await audit(job.id, s.id, 'signed', { role: s.role }, req);

  const { data: all } = await db.from('signers').select('*').eq('job_id', job.id).order('position');
  const next = all.find((x) => x.position === s.position + 1);
  let nextLink;
  if (next) {
    const t = newToken();
    await db.from('signers').update({ token_hash: hash(t), status: 'sent' }).eq('id', next.id);
    nextLink = `${siteUrl()}/sign.html?t=${t}`;
    const toOwner = next.role === 'staff';
    await sendMail({
      to: next.email,
      subject: toOwner ? `${job.recipient_name || 'The resident'} has signed. Your turn.` : 'Your tenancy form is ready for your part',
      html: mailHtml(toOwner ? 'The resident has finished their part' : 'The sender has completed their part',
        `Hi ${esc(next.name || '')}, please open the private link below to ${toOwner ? 'fill in your part and sign' : 'complete your part and sign'}.`,
        nextLink, 'Open the form')
    });
    await audit(job.id, next.id, 'next_signer_notified', null, req);
  } else {
    await fetch(`${siteUrl()}/.netlify/functions/finalize-background`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id })
    });
  }
  return json(200, { ok: true, nextLink: DRY() ? nextLink : undefined, finishing: !next });
};
