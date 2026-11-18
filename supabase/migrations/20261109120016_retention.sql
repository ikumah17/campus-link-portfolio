-- RETENTION-001 order 16: retention sweep support (docs/04_DATABASE.md §11; the periods are proposals, O4).
-- The maintenance script scripts/maintenance/retention.mjs lists due data with service_retention_candidates,
-- deletes the Storage objects and the Auth users itself, then purges old rate-limit records.

-- §11 account deletion time. No existing column records it reliably (updated_at moves on every update), so the
-- move to 'deleted' stamps it. Only request_account_deletion makes that move (admin_set_account_status cannot).
alter table public.profiles add column deleted_at timestamptz;
-- accounts deleted before this migration: updated_at is at or after their deletion, so none becomes due early
update public.profiles p set deleted_at = p.updated_at where p.account_status = 'deleted';
alter table public.profiles add constraint profiles_deleted_at_check
  check ((account_status = 'deleted') = (deleted_at is not null));

create function private.stamp_account_deletion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.account_status = 'deleted' and (tg_op = 'INSERT' or old.account_status <> 'deleted') then
    new.deleted_at := now();
  end if;
  return new;
end $$;
create trigger profiles_deleted_at before insert or update on public.profiles
  for each row execute function private.stamp_account_deletion();

revoke all on function private.stamp_account_deletion() from public, anon, authenticated, service_role;

-- Due data at p_now (never later than now()), one row per item:
--   document: an uploaded document of an approved/rejected/revoked submission decided 30 days or more ago
--             (bucket verification-documents); the submission row and its decision stay.
--   account:  a deleted account 30 days or more after its deletion (storage_path null, then the Auth user is
--             deleted), plus every photo it registered (submission_id null, bucket profile-photos) and every
--             uploaded document it submitted (submission_id set, bucket verification-documents).
-- skipped_reviewer: an expired deleted account referenced as reviewer_id; keep decision history and Auth user.
-- Paths are the stored ones, only in the owner's folder, and only while the Storage object still exists,
-- so a re-run after a partial apply lists what is left. Each account's own row comes after its objects: a
-- response cut at the server's row limit then leaves at most the last account incomplete, without its row.
create function public.service_retention_candidates(p_now timestamptz default now())
returns table (kind text, user_id uuid, submission_id uuid, storage_path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_now is null or p_now > now() then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  return query
  with accounts as (
    select p.user_id from public.profiles p
    where p.account_status = 'deleted' and p.deleted_at <= p_now - interval '30 days'
  ), purgeable_accounts as (
    select a.user_id from accounts a
    where not exists (select 1 from public.verification_submissions s where s.reviewer_id = a.user_id)
  ), objects as (
    select 'account'::text as kind, a.user_id, null::uuid as submission_id, ph.storage_path as path,
           'profile-photos'::text as bucket
    from purgeable_accounts a join public.profile_photos ph on ph.user_id = a.user_id
    union all
    select 'account', a.user_id, s.id, d.ref, 'verification-documents'
    from purgeable_accounts a
    join public.verification_submissions s on s.user_id = a.user_id and s.intake_mode = 'upload'
    cross join lateral unnest(s.document_refs) as d(ref)
    union all
    select 'document', s.user_id, s.id, d.ref, 'verification-documents'
    from public.verification_submissions s
    cross join lateral unnest(s.document_refs) as d(ref)
    where s.intake_mode = 'upload' and s.status in ('approved', 'rejected', 'revoked')
      and s.decided_at <= p_now - interval '30 days'
      and not exists (select 1 from purgeable_accounts a where a.user_id = s.user_id)
  )
  select y.kind, y.user_id, y.submission_id, y.storage_path
  from (select distinct x.kind, x.user_id, x.submission_id, x.storage_path
        from (select 'account'::text as kind, a.user_id, null::uuid as submission_id, null::text as storage_path
              from purgeable_accounts a
              union all
              select 'skipped_reviewer', a.user_id, null::uuid, null::text
              from accounts a where not exists (select 1 from purgeable_accounts p where p.user_id = a.user_id)
              union all
              select o.kind, o.user_id, o.submission_id, o.path
              from objects o
              where o.path ~ ('^' || o.user_id::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$')
                and exists (select 1 from storage.objects so where so.bucket_id = o.bucket and so.name = o.path)) x) y
  order by y.kind, y.user_id, y.storage_path is null, y.submission_id nulls first, y.storage_path;
end $$;

-- §11: rate-limit records older than 7 days (the longest rate window is 1 day). Returns the number deleted.
create function public.service_purge_rate_limits(p_now timestamptz default now())
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if p_now is null or p_now > now() then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  delete from private.rate_limit_events e where e.created_at < p_now - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function
  public.service_retention_candidates(timestamptz),
  public.service_purge_rate_limits(timestamptz)
from public, anon, authenticated, service_role;
grant execute on function
  public.service_retention_candidates(timestamptz),
  public.service_purge_rate_limits(timestamptz)
to service_role;
