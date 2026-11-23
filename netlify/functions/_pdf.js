import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } from 'pdf-lib';

// Signature box (page, [x0, top, x1, bottom] in points from the top-left) and signature date field per role.
export const SIGS = {
  r18: {
    staff: { page: 11, box: [23, 491, 207, 530], date: 'Date of signature (dd/mm/yyyy)1' },
    resident: { page: 11, box: [23, 621, 207, 660], date: 'Date of signature (dd/mm/yyyy)2' }
  },
  f1a: {
    staff: { page: 8, box: [562, 414, 735, 445], date: 'Date of signature (dd/mm/yyyy) 1' },
    resident: { page: 8, box: [23, 478, 196, 512], date: 'Date of signature (dd/mm/yyyy) 2' }
  }
};
export const FORM_NAMES = { r18: 'Rooming accommodation agreement (Form R18)', f1a: 'Entry condition report (Form 1a)' };

const ascii = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?');
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const fmtAU = (iso) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso)).replace(',', '');
export const dateAU = (iso) => fmtAU(iso).slice(0, 10);

export async function buildFinalPdf({ original, form, answers, signers, events, job }) {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true });
  const pdfForm = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const dates = {};
  for (const s of signers) {
    const slot = SIGS[form] && SIGS[form][s.role];
    if (slot && s.signed_at) dates[slot.date] = dateAU(s.signed_at);
  }
  let skipped = 0;
  for (const [name, v] of Object.entries({ ...answers, ...dates })) {
    try {
      const f = pdfForm.getField(name);
      if (f instanceof PDFTextField) f.setText(String(v ?? ''));
      else if (f instanceof PDFCheckBox) { v ? f.check() : f.uncheck(); }
      else if ((f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList) && v) f.select(String(v));
    } catch (e) { skipped++; }
  }

  for (const s of signers) {
    const slot = SIGS[form] && SIGS[form][s.role];
    if (!slot || !s.signature_png) continue;
    const img = await doc.embedPng(Buffer.from(s.signature_png.split(',')[1], 'base64'));
    const pg = doc.getPages()[slot.page - 1];
    const H = pg.getHeight();
    const [x0, top, x1, bot] = slot.box;
    const ix = x0 + 40, iw = x1 - 3 - ix, it = top + 2, ih = bot - 9 - it;
    const sc = Math.min(iw / img.width, ih / img.height), w = img.width * sc, h = img.height * sc;
    pg.drawImage(img, { x: ix + (iw - w) / 2, y: H - (it + (ih - h) / 2) - h, width: w, height: h });
    pg.drawText('Signed electronically ' + fmtAU(s.signed_at), { x: x0 + 3, y: H - (bot - 3), size: 5.5, font, color: rgb(0.35, 0.35, 0.35) });
  }

  pdfForm.flatten();
  const preHash = sha256(await doc.save());

  const page = doc.addPage([595.28, 841.89]);
  let y = 800;
  const line = (t, { size = 10, b = false, gap = 14 } = {}) => {
    page.drawText(ascii(t).slice(0, 105), { x: 50, y, size, font: b ? bold : font, color: rgb(0.1, 0.12, 0.15) });
    y -= gap;
  };
  line('Certificate of completion', { size: 18, b: true, gap: 28 });
  line('Document: ' + (FORM_NAMES[form] || form));
  line('Reference: ' + job.id);
  line('Sent: ' + fmtAU(job.created_at) + '   Completed: ' + fmtAU(signers.reduce((m, s) => (s.signed_at > m ? s.signed_at : m), job.created_at)) + ' (Brisbane time)');
  line('Fingerprint of the signed form before this page (SHA-256):', { gap: 12 });
  line(preHash, { size: 8, gap: 24 });
  line('Signers', { size: 13, b: true, gap: 20 });
  for (const s of signers) {
    line((s.role === 'staff' ? 'Sender: ' : 'Resident: ') + (s.name || '-') + '  <' + s.email + '>', { b: true });
    line('Signed: ' + (s.signed_at ? fmtAU(s.signed_at) : '-') + '   Agreed to sign electronically: ' + (s.consent_at ? fmtAU(s.consent_at) : '-'), { gap: 12 });
    line('IP address: ' + (s.ip || '-'), { gap: 12 });
    line('Browser: ' + (s.user_agent || '-').slice(0, 95), { size: 8, gap: 20 });
  }
  line('Activity', { size: 13, b: true, gap: 20 });
  for (const e of events.slice(0, 30)) line(fmtAU(e.created_at) + '   ' + e.event.replace(/_/g, ' ') + (e.ip ? '   (' + e.ip + ')' : ''), { size: 9, gap: 12 });
  y -= 10;
  line('Signatures on this document are electronic. This page records who signed, when, and the sending history.', { size: 8, gap: 11 });

  const bytes = await doc.save();
  return { bytes, preHash, finalHash: sha256(bytes), skipped };
}
