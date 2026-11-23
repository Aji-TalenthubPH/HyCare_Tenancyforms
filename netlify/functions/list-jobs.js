import { db, json, ownerOk } from './_lib.js';

export default async (req) => {
  if (!ownerOk(req)) return json(401, { error: 'Wrong password' });
  const { data, error } = await db.from('signing_jobs')
    .select('id, form, status, recipient_name, recipient_email, owner_email, created_at, expires_at, final_pdf_path, signers(role, position, status, name, signed_at)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return json(500, { error: error.message });
  const jobs = [];
  for (const j of data) {
    let finalUrl;
    if (j.final_pdf_path) {
      const f = await db.storage.from('signing-pdfs').createSignedUrl(j.final_pdf_path, 3600);
      finalUrl = f.data && f.data.signedUrl;
    }
    jobs.push({ ...j, final_pdf_path: undefined, finalUrl, signers: (j.signers || []).sort((a, b) => a.position - b.position) });
  }
  return json(200, { jobs });
};
