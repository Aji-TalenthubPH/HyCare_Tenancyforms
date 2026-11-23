import { db, json, ownerOk, newToken, hash, audit, sendMail, mailHtml, siteUrl, esc, DRY } from './_lib.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!ownerOk(req)) return json(401, { error: 'Wrong password' });
  const { action, jobId } = await req.json();
  const { data: job } = await db.from('signing_jobs').select('*').eq('id', jobId).maybeSingle();
  if (!job) return json(404, { error: 'Job not found' });

  if (action === 'cancel') {
    if (job.status === 'finished') return json(400, { error: 'This job is already finished.' });
    await db.from('signing_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', jobId);
    await audit(jobId, null, 'cancelled_by_owner', null, req);
    return json(200, { ok: true });
  }
  if (action === 'resend') {
    if (!['sent', 'in_progress'].includes(job.status)) return json(400, { error: 'This job is not waiting for anyone.' });
    const { data: signers } = await db.from('signers').select('*').eq('job_id', jobId).order('position');
    const cur = signers.find((s) => s.status === 'sent' || s.status === 'opened');
    if (!cur) return json(400, { error: 'Nobody is waiting to sign.' });
    const t = newToken(); // the old link stops working
    await db.from('signers').update({ token_hash: hash(t), status: 'sent' }).eq('id', cur.id);
    await db.from('signing_jobs').update({ expires_at: new Date(Date.now() + 14 * 864e5).toISOString() }).eq('id', jobId);
    const link = `${siteUrl()}/sign.html?t=${t}`;
    await sendMail({
      to: cur.email, subject: 'Reminder: please complete your tenancy form',
      html: mailHtml('A quick reminder', `Hi ${esc(cur.name || '')}, your form is still waiting for you. The earlier link no longer works, so please use this one.`, link, 'Open the form')
    });
    await audit(jobId, cur.id, 'link_resent', null, req);
    return json(200, { ok: true, link: DRY() ? link : undefined });
  }
  if (action === 'archive') {
    if (job.deleted_at) return json(200, { ok: true });
    const live = ['sent', 'in_progress', 'finalizing'].includes(job.status);
    const now = new Date().toISOString();
    const patch = { deleted_at: now, updated_at: now };
    if (live) patch.status = 'cancelled';
    const { error } = await db.from('signing_jobs').update(patch).eq('id', jobId);
    if (error) return json(500, { error: error.message });
    if (live) await audit(jobId, null, 'cancelled_by_owner', { via: 'archive' }, req);
    await audit(jobId, null, 'job_archived', { previous_status: job.status }, req);
    return json(200, { ok: true });
  }
  return json(400, { error: 'Unknown action' });
};
