-- Panda Jobs — migration 2026-11-02 (Rigo's stage-flow round).
-- PENDING: run this once in the Supabase SQL Editor (project
-- hgfbzsnwihbdgdkuyubj). It is idempotent — safe to run even if the
-- live database already matches.
--
-- 1) Guarantee the jobs.status CHECK allows the full stage flow,
--    including the 'in_progress' stage (Signed/Approved -> Scheduled
--    -> In Progress -> Done). Any existing CHECK on jobs whose
--    definition is the status list (contains 'draft' and 'scheduled')
--    is dropped and recreated with the full list; other CHECKs
--    (payment_status etc.) are left untouched.
-- 2) started_at / finished_at: when the owner pressed "Start work"
--    (Inicio de trabajo) / "Finish work" (Termino de trabajo) on the
--    In Progress screen.
-- 3) amount_paid: how much the client has actually paid (deposit
--    received or partial payment) — shown in the Scheduled money
--    summary and on the invoice (total / paid / balance due).
-- 4) photos_deleted_at: when the owner confirmed receipt of the
--    evidence email and deleted the job's photos from the app
--    (photos are temporary; the evidence lives in the PDF + email).

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where rel.relname = 'jobs' and nsp.nspname = 'public'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%''draft''%'
      and pg_get_constraintdef(con.oid) ilike '%''scheduled''%'
  loop
    execute format('alter table public.jobs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('draft','quote','signed','scheduled','in_progress','done','invoiced'));

alter table public.jobs add column if not exists started_at timestamptz;
alter table public.jobs add column if not exists finished_at timestamptz;
alter table public.jobs add column if not exists amount_paid numeric not null default 0;
alter table public.jobs add column if not exists photos_deleted_at timestamptz;
