# Tenancy e-signing (Netlify + Supabase + Microsoft 365 mail)

Two people sign the same tenancy form, one after the other. Each gets a private link by email, fills in their own questions, signs, and the app locks their answers, notifies the next person, and finally emails everyone the finished PDF with a certificate page.

Forms included: **Form R18** and **Form 1a**. Pick who goes first when you send (R18 defaults to the resident first, Form 1a to you first).

## What is in this folder

```
supabase.sql                     run once in Supabase (tables + private storage bucket)
netlify.toml, package.json       build settings and the two dependencies
public/index.html                owner page: log in, send a form, see jobs, resend, cancel, download
public/sign.html                 the signing page people open from their email link
public/done.html                 thank-you page
public/forms/r18|f1a .pdf/.json  blank forms and their question setups (labels, steps, required fields)
netlify/functions/
  _lib.js                        database, tokens, email (Microsoft Graph), shared helpers
  _pdf.js                        fills the PDF, stamps signatures, adds the certificate page
  create-job.js                  owner sends a form
  get-job.js                     a signer opens their link
  complete-signer.js             a signer finishes (locks their fields, notifies the next person)
  finalize-background.js         builds the final PDF and emails the copies
  list-jobs.js, job-action.js    owner dashboard, resend, cancel
```

## Set up, in order

1. **Supabase.** Create a project in the Sydney region. Open SQL Editor, paste `supabase.sql`, click Run. This also creates the private `signing-pdfs` bucket.
2. **GitHub.** Put this folder in a new GitHub repository.
3. **Netlify.** Add new site, Import an existing project, pick the repository. No build command is needed.
4. **Environment variables** (Site configuration, Environment variables). Paste these in Netlify only, never in chat or in code:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key from Project Settings, API Keys |
| `OWNER_PASSWORD` | a long password you choose, used on the owner page |
| `SITE_URL` | optional, your site address if you use a custom domain |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MAIL_FROM` | add these later, in step 6 |

5. **Test mode (no email yet).** While the `MS_*` variables are not set, no email is sent. The app writes each email to the function log (Netlify, Logs, Functions) and shows the signing links on screen. Try a full run:
   - Open your site, log in, send an R18 using your own email for both people.
   - Open the link shown, fill the required fields (marked *), sign, press Finish and send.
   - Open the next link that appears, sign as the owner.
   - Wait about a minute, press Refresh, then Download signed PDF.
6. **Switch on real email.** In the Microsoft Entra admin centre: App registrations, New registration, then API permissions, Add a permission, Microsoft Graph, Application permissions, Mail.Send, Grant admin consent. Under Certificates and secrets create a client secret. Copy the tenant ID, client ID and the secret value into the `MS_*` variables, and set `MAIL_FROM` to your mailbox address. Then limit the app to your mailbox only using an Exchange application access policy, so it cannot send as anyone else. Microsoft is moving this to "RBAC for Applications", so follow their current guide.

## How it works

- Links are random and stored only as a hash. They expire after 14 days, work once per person, and Resend replaces the old link.
- Each person can only change their own fields. Fields are locked when that person finishes, and the other person sees them read-only. The server enforces this, not just the page.
- Required fields (marked * on the page) block Finish until they are filled in.
- The final PDF is flattened (no longer editable), has the signatures stamped with date and time in Brisbane time, and ends with a certificate page listing each signer, IP address, consent time and the activity trail. The file fingerprint is saved in the database.

## Things to know

- Signatures are drawn or typed images with a timestamp and an audit trail. They do not verify identity. Confirm this meets your compliance needs for tenancy documents; this is not legal advice.
- The blank RTA forms sit in `public/forms` and are publicly downloadable. Completed forms are stored only in the private bucket.
- Microsoft Graph attachments are limited to about 3 MB per email. The Form 1a is about 1 MB, so this is fine.
- Decide how long you keep finished PDFs and set up deletion for old jobs.
- Anyone who has the owner password can send forms and see all jobs. Use a long password.
