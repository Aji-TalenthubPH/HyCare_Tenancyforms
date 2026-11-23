-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query > paste > Run)
create extension if not exists pgcrypto;

create table if not exists signing_jobs (
  id uuid primary key default gen_random_uuid(),
  form text not null check (form in ('r18','f1a')),
  status text not null default 'sent'
    check (status in ('sent','in_progress','finalizing','finished','cancelled')),
  first_role text not null default 'resident' check (first_role in ('resident','staff')),
  owner_email text not null,
  recipient_name text,
  recipient_email text not null,
  answers jsonb not null default '{}',
  locked_fields jsonb not null default '[]',
  required_fields jsonb not null default '[]',
  pdf_path text not null,
  final_pdf_path text,
  final_sha256 text,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists signers (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references signing_jobs(id) on delete cascade,
  role text not null check (role in ('resident','staff')),
  position int not null,
  name text,
  email text not null,
  token_hash text not null unique,
  status text not null default 'waiting' check (status in ('waiting','sent','opened','completed')),
  signature_png text,
  signed_at timestamptz,
  consent_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigserial primary key,
  job_id uuid not null references signing_jobs(id) on delete cascade,
  signer_id uuid references signers(id) on delete set null,
  event text not null,
  detail jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists signers_job_idx on signers (job_id);
create index if not exists audit_job_idx on audit_events (job_id);

-- No policies on purpose: only the Netlify Functions (service/secret key) can read or write.
alter table signing_jobs enable row level security;
alter table signers enable row level security;
alter table audit_events enable row level security;

insert into storage.buckets (id, name, public)
values ('signing-pdfs', 'signing-pdfs', false)
on conflict (id) do nothing;
