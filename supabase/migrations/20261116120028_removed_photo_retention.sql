-- RETENTION-005 order 28: the retention candidates also list removed photos' objects, and the document upload
-- policy takes only names under the path rule, at most 16 per folder (docs/04_DATABASE.md §9, §11).
-- removePhoto marks the row removed and then deletes the object once; when that delete fails, the row still named
-- the object and order 26 never listed it. The verification-documents insert policy (orders 5 and 15) checked only
-- the folder and upload mode, so a name outside the path rule (which submission, orphan_document and account all
-- require) could be stored and was never swept; upload mode is off today (verification_intake = 'synthetic').
-- Invariants:
--   removed is final for a row: remove_photo and reorder_photos' first statement only move rows from active to
--   removed, reorder_photos' second statement makes active again only ids that were active when it started (inside
--   the same transaction), service_register_photo inserts active rows for a path no row names yet, and no role has
--   write privileges on public.profile_photos. A listed removed photo's object can never be shown again.
--   orphan_photo never lists an active photo, an object younger than 24 hours at p_now, or a photo row of a
--   purgeable account (the account kind lists those), so no path appears under two kinds.
--   The document insert check counts the folder's objects before the new row is stored, so a user keeps at most 16
--   objects in verification-documents (best effort under concurrent inserts).
-- Unchanged: both functions' signatures, definer, search_path, volatility and grants; every other kind, its rules
-- and the order; submit_verification; the policy verification_documents_insert itself.

-- Due data at p_now (never later than now()), one row per item:
--   document:        an uploaded document of an approved/rejected/revoked submission decided 30 days or more ago
--                    (bucket verification-documents); the submission row and its decision stay.
--   account:         a deleted account 30 days or more after its deletion (storage_path null, then the Auth user is
--                    deleted), plus every photo it registered (submission_id null, bucket profile-photos) and every
--                    uploaded document it submitted (submission_id set, bucket verification-documents).
--   orphan_document: an object in bucket verification-documents created 24 hours or more before p_now that no
--                    public.verification_submissions row of any status or intake mode names; user_id is its uuid
--                    folder and submission_id is null.
--   orphan_photo:    an object in bucket profile-photos created 24 hours or more before p_now that no active
--                    public.profile_photos row and no row of a purgeable account names (a removed photo's row stays);
--                    user_id is its uuid folder and submission_id is null. An upload in flight takes seconds, so it
--                    is never listed.
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
      -- a removed row no longer names its object, unless the account kind lists it (one path, one kind)
      and not exists (select 1 from public.profile_photos ph
                      where ph.storage_path = so.name
                        and (ph.status = 'active'
                             or exists (select 1 from purgeable_accounts a where a.user_id = ph.user_id)))
    union all
    -- same cast guard; a ref named by any submission (any status or intake mode) is never an orphan
    select 'orphan_document', case when so.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                                   then split_part(so.name, '/', 1)::uuid end,
           null::uuid, so.name, 'verification-documents'
    from storage.objects so
    where so.bucket_id = 'verification-documents' and so.created_at <= p_now - interval '24 hours'
      and not exists (select 1 from public.verification_submissions s where so.name = any (s.document_refs))
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

-- Order 5 with the path rule and the per-folder cap. The policy checks the new row before it is stored, so the count
-- sees only earlier objects: 16 stored objects in the caller's folder refuse a 17th.
create or replace function private.rls_document_upload_allowed(p_object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.uid is not null
     and split_part(p_object_name, '/', 1) = s.uid::text
     and p_object_name ~ ('^' || s.uid::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$')
     and (select c.value = 'upload' from private.app_settings c
          where c.key = 'verification_intake')
     and (select count(*) from (select 1 from storage.objects so
                                where so.bucket_id = 'verification-documents'
                                  and so.name like s.uid::text || '/%'
                                limit 16) n) < 16, false)
  from (select private.session_uid() as uid) s
$$;

revoke all on function private.rls_document_upload_allowed(text) from public, anon, authenticated, service_role;
grant execute on function private.rls_document_upload_allowed(text) to authenticated;
