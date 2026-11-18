-- RETENTION-003 order 26: the retention candidates also list orphan photo objects (docs/04_DATABASE.md §11).
-- uploadPhoto stores the object before service_register_photo and removes it when registration fails; when that
-- removal fails too, the object stays with no public.profile_photos row, and order 16 listed only objects a row
-- points to. Same signature, definer, search_path and service_role-only execute as order 16; every earlier kind,
-- its rules and the order are unchanged.

-- Due data at p_now (never later than now()), one row per item:
--   document:     an uploaded document of an approved/rejected/revoked submission decided 30 days or more ago
--                 (bucket verification-documents); the submission row and its decision stay.
--   account:      a deleted account 30 days or more after its deletion (storage_path null, then the Auth user is
--                 deleted), plus every photo it registered (submission_id null, bucket profile-photos) and every
--                 uploaded document it submitted (submission_id set, bucket verification-documents).
--   orphan_photo: an object in bucket profile-photos created 24 hours or more before p_now that no
--                 public.profile_photos row names; user_id is its uuid folder and submission_id is null. An upload
--                 in flight takes seconds, so it is never listed.
-- skipped_reviewer: an expired deleted account referenced as reviewer_id; keep decision history and Auth user.
-- Paths are the stored ones, only in the owner's folder, and only while the Storage object still exists,
-- so a re-run after a partial apply lists what is left. Each account's own row comes after its objects: a
-- response cut at the server's row limit then leaves at most the last account incomplete, without its row.
create or replace function public.service_retention_candidates(p_now timestamptz default now())
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
    union all
    -- the cast runs only for a lowercase uuid folder (a case, so no pushed-down qual can cast a bad name);
    -- the path rule below then checks the whole name against that uuid
    select 'orphan_photo', case when so.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                                then split_part(so.name, '/', 1)::uuid end,
           null::uuid, so.name, 'profile-photos'
    from storage.objects so
    where so.bucket_id = 'profile-photos' and so.created_at <= p_now - interval '24 hours'
      and not exists (select 1 from public.profile_photos ph where ph.storage_path = so.name)
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
              where o.user_id is not null
                and o.path ~ ('^' || o.user_id::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$')
                and exists (select 1 from storage.objects so where so.bucket_id = o.bucket and so.name = o.path)) x) y
  order by y.kind, y.user_id, y.storage_path is null, y.submission_id nulls first, y.storage_path;
end $$;

revoke all on function public.service_retention_candidates(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.service_retention_candidates(timestamptz) to service_role;
