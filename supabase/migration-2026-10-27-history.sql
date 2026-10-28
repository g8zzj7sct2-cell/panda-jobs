-- Panda Jobs — job history (archive) migration (2026-10-27)
-- Idempotent: safe to run more than once in the Supabase SQL editor.
-- Adds archived_at: when the owner presses "Complete & move to History"
-- on an invoiced job, archived_at is stamped; the job leaves the Jobs
-- board and lives in the History tab (searchable by client name, phone
-- or email). Clearing archived_at (Restore in History) un-archives it.
-- Also exposes archivedAt through the client-portal RPC.
-- Run this BEFORE deploying app code that reads/writes the column.

alter table public.jobs
  add column if not exists archived_at timestamptz;

-- Full replacement of the token-checked portal RPC (same body as
-- schema.sql, now including 'archivedAt').
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
    'completedAt', coalesce(j.completed_at::text, ''),
    'archivedAt', coalesce(j.archived_at::text, ''),
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
