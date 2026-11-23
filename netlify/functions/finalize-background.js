import { db, audit, sendMail, mailHtml, esc } from './_lib.js';
import { buildFinalPdf, FORM_NAMES } from './_pdf.js';

// Background function: Netlify answers 202 straight away and lets this run for several minutes.
export default async (req) => {
  const { jobId } = await req.json();
  const { data: job } = await db.from('signing_jobs').select('*').eq('id', jobId).single();
  if (!job || job.status !== 'in_progress') return;
  const { data: signers } = await db.from('signers').select('*').eq('job_id', jobId).order('position');
  if (!signers.length || signers.some((s) => s.status !== 'completed')) return;

  // Claim the job so a double call cannot finalise twice.
  const claim = await db.from('signing_jobs').update({ status: 'finalizing' }).eq('id', jobId).eq('status', 'in_progress').select();
  if (!claim.data || !claim.data.length) return;

  try {
    const dl = await db.storage.from('signing-pdfs').download(job.pdf_path);
    if (dl.error) throw new Error('Original PDF missing');
    const original = Buffer.from(await dl.data.arrayBuffer());
    const { data: events } = await db.from('audit_events').select('*').eq('job_id', jobId).order('created_at');

    const out = await buildFinalPdf({ original, form: job.form, answers: job.answers, signers, events: events || [], job });
    const finalPath = `${jobId}/final.pdf`;
    const up = await db.storage.from('signing-pdfs').upload(finalPath, Buffer.from(out.bytes), { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error('Could not store the final PDF: ' + up.error.message);

    await db.from('signing_jobs').update({
      status: 'finished', final_pdf_path: finalPath, final_sha256: out.finalHash, updated_at: new Date().toISOString()
    }).eq('id', jobId);
    await audit(jobId, null, 'finalized', { finalSha256: out.finalHash, preCertificateSha256: out.preHash, fieldsSkipped: out.skipped });

    const base64 = Buffer.from(out.bytes).toString('base64');
    for (const s of signers) {
      await sendMail({
        to: s.email,
        subject: `Completed: ${FORM_NAMES[job.form] || 'your form'}`,
        html: mailHtml('Everyone has signed', `Hi ${esc(s.name || '')}, the signed copy is attached to this email. Please keep it for your records.`),
        attachment: { name: `${job.form}-signed.pdf`, base64 }
      });
    }
    await audit(jobId, null, 'final_copy_emailed', null);
  } catch (e) {
    console.error('finalize failed', e);
    await db.from('signing_jobs').update({ status: 'in_progress' }).eq('id', jobId);
    await audit(jobId, null, 'finalize_failed', { message: String(e.message || e) });
  }
};
