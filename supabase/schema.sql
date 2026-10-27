-- Panda Jobs — Supabase schema (Plan Task 2, live mode)
-- Run this once in the Supabase SQL editor after creating the project.
-- Access model:
--   * Owner (Rigoberto): Supabase Auth user. RLS gives authenticated users
--     full access to their business data.
--   * Clients: NO account. They can only read ONE job through the
--     token-checked RPC get_job_by_token(), and sign through the
--     sign-and-email Edge Function (service_role, server-side).
--   * Anonymous role has NO direct table access.
-- Secrets (NEVER in the repo): SUPABASE_SERVICE_ROLE_KEY and
-- GMAIL_APP_PASSWORD are function secrets only.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text default '',
  email text not null,
  address text default '',
  equipment text default '',
  notes text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  title text default '',
  status text not null default 'draft'
    check (status in ('draft','quote','signed','scheduled','in_progress','done','invoiced')),
  deposit numeric not null default 0,
  terms text default '',
  version int not null default 1,
  signed_version int not null default 0,
  scheduled_at timestamptz,
  work_notes text default '',
  materials text default '',
  final_total numeric,
  payment_status text not null default 'pending' check (payment_status in ('pending','paid')),
  photos jsonb not null default '{"assessment":[],"before":[],"after":[]}'::jsonb,
  copy_email_status text default '',
  copy_email_failed boolean not null default false,
  -- Owner-side log of direct quote sends from the panel's "Send to client"
  -- buttons: [{channel: 'Text message'|'Email', at: iso8601}].
  -- Mirrors job.sendLog in the app (data.js). Owner-only; never exposed
  -- through get_job_by_token.
  send_log jsonb not null default '[]'::jsonb,
  -- Last recipient typed in the panel's "Send to email" field for this job
  -- (mirrors job.sendEmail in data.js). May differ from the client's stored
  -- email (spouse, office, property manager…). Email send_log entries also
  -- record it per send as {channel: 'Email', to, at}. Owner-only; never
  -- exposed through get_job_by_token.
  send_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  description text not null default '',
  qty numeric not null default 1,
  price numeric not null default 0,
  optional boolean not null default false,
  accepted boolean not null default true,
  sort_order int not null default 0
);

create table if not exists public.signatures (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  version int not null,
  signer_name text not null,
  signature_image_url text not null,        -- data URL / storage URL of the signature image
  signed_at timestamptz not null default now(),
  unique (job_id, version)                  -- a signed version can never be signed twice nor altered
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('assessment','before','after')),
  image_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  version int not null,
  kind text not null default 'signed-pdf',
  file_url text default '',
  created_at timestamptz not null default now()
);

-- ---------- storage buckets ----------
insert into storage.buckets (id, name, public) values ('job-photos', 'job-photos', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;

-- ---------- row level security ----------
alter table public.clients enable row level security;
alter table public.jobs enable row level security;
alter table public.quote_items enable row level security;
alter table public.signatures enable row level security;
alter table public.photos enable row level security;
alter table public.documents enable row level security;

-- Owner-only: any authenticated user of this project (only Rigo has an
-- account) can manage everything. Anonymous (anon) gets nothing directly.
do $$
declare t text;
begin
  foreach t in array array['clients','jobs','quote_items','signatures','photos','documents'] loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Storage: authenticated can write job photos; reads of job-photos are public
-- so the client portal links render. Documents bucket stays private.
drop policy if exists job_photos_read on storage.objects;
create policy job_photos_read on storage.objects for select
  using (bucket_id = 'job-photos');
drop policy if exists job_photos_write on storage.objects;
create policy job_photos_write on storage.objects for all to authenticated
  using (bucket_id = 'job-photos') with check (bucket_id = 'job-photos');
drop policy if exists documents_owner on storage.objects;
create policy documents_owner on storage.objects for all to authenticated
  using (bucket_id = 'documents') with check (bucket_id = 'documents');

-- ---------- client portal RPC (token-checked) ----------
-- Returns ONE job (with client, items, signature, photos) as JSON, or NULL
-- when the token does not match — so a wrong token can never leak data.
create or replace function public.get_job_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.jobs%rowtype;
  c public.clients%rowtype;
  result jsonb;
begin
  select * into j from public.jobs where token = p_token;
  if not found then return null; end if;
  select * into c from public.clients where id = j.client_id;
  result := jsonb_build_object(
    'id', j.id, 'clientId', j.client_id, 'token', j.token, 'title', j.title,
    'status', j.status, 'deposit', j.deposit, 'terms', j.terms,
    'version', j.version, 'signedVersion', j.signed_version,
    'scheduledAt', coalesce(j.scheduled_at::text, ''), 'workNotes', j.work_notes,
    'materials', j.materials, 'finalTotal', j.final_total,
    'paymentStatus', j.payment_status,
    'copyEmailStatus', case when j.copy_email_failed then 'failed' else j.copy_email_status end,
    'createdAt', j.created_at, 'updatedAt', j.updated_at,
    'client', jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone,
                                 'email', c.email, 'address', c.address, 'equipment', c.equipment),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'desc', qi.description, 'qty', qi.qty, 'price', qi.price,
        'optional', qi.optional, 'accepted', qi.accepted) order by qi.sort_order)
      from public.quote_items qi where qi.job_id = j.id), '[]'::jsonb),
    'signatures', coalesce((select jsonb_agg(jsonb_build_object(
        'version', s.version, 'name', s.signer_name,
        'signatureDataUrl', s.signature_image_url, 'signedAt', s.signed_at))
      from public.signatures s where s.job_id = j.id), '[]'::jsonb),
    'photos', jsonb_build_object(
      'assessment', coalesce((select jsonb_agg(p.image_url order by p.created_at) from public.photos p where p.job_id = j.id and p.kind = 'assessment'), '[]'::jsonb),
      'before',     coalesce((select jsonb_agg(p.image_url order by p.created_at) from public.photos p where p.job_id = j.id and p.kind = 'before'), '[]'::jsonb),
      'after',      coalesce((select jsonb_agg(p.image_url order by p.created_at) from public.photos p where p.job_id = j.id and p.kind = 'after'), '[]'::jsonb))
  );
  return result;
end $$;

revoke all on function public.get_job_by_token(text) from public;
grant execute on function public.get_job_by_token(text) to anon, authenticated;
