-- RETENTION-004 order 27: the retention candidates also list orphan verification documents, and upload-mode
-- submit_verification only takes fresh, unnamed document objects (docs/04_DATABASE.md §11).
-- In upload mode a user stores the object first, through the Storage insert policy (order 15), and calls
-- submit_verification later or never; order 26 listed only document objects a submission names.
-- Invariant: a listed orphan_document is 24 hours or more old at p_now (never later than now()), and a new
-- submission takes only objects created less than 12 hours before its now(), so a listed object can never become
-- named. Each uploaded object is named by at most one submission, so the document kind never deletes an object a
-- newer submission still uses.
-- Same signatures, definer, search_path and grants as orders 7 and 26; every earlier kind, its rules and the
-- order are unchanged, and synthetic mode keeps every check of order 7.

-- Due data at p_now (never later than now()), one row per item:
--   document:        an uploaded document of an approved/rejected/revoked submission decided 30 days or more ago
--                    (bucket verification-documents); the submission row and its decision stay.
--   account:         a deleted account 30 days or more after its deletion (storage_path null, then the Auth user is
--                    deleted), plus every photo it registered (submission_id null, bucket profile-photos) and every
--                    uploaded document it submitted (submission_id set, bucket verification-documents).
--   orphan_document: an object in bucket verification-documents created 24 hours or more before p_now that no
--                    public.verification_submissions row of any status or intake mode names; user_id is its uuid
--                    folder and submission_id is null.
--   orphan_photo:    an object in bucket profile-photos created 24 hours or more before p_now that no
--                    public.profile_photos row names; user_id is its uuid folder and submission_id is null. An upload
--                    in flight takes seconds, so it is never listed.
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

-- Order 7 with the upload-mode document checks. Every refusal is the existing 'validation' error, raised before
-- any write: each ref must name a verification-documents object created less than 12 hours before now() (checked
-- with the other input rules), and no submission may already name it (checked after lock_verification_subject,
-- so two concurrent calls by the same user cannot both pass; refs are only ever in the caller's own folder).
create or replace function public.submit_verification(p_kind public.verification_kind, p_document_refs text[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_intake text;
  v_aff    public.affiliations;
  v_id     uuid;
begin
  select c.value into v_intake from private.app_settings c where c.key = 'verification_intake';
  if p_kind is null or p_document_refs is null
     or cardinality(p_document_refs) not between 1 and 4
     or array_position(p_document_refs, null) is not null
     or (select count(distinct x) from unnest(p_document_refs) x) <> cardinality(p_document_refs)
     or v_intake is null or v_intake not in ('synthetic', 'upload')
     or (v_intake = 'synthetic'
         and exists (select 1 from unnest(p_document_refs) x where x !~ '^synthetic:sample-[1-3]$'))
     or (v_intake = 'upload'
         and exists (select 1 from unnest(p_document_refs) x
                     where x !~ ('^' || v_me::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$')
                        or not exists (select 1 from storage.objects so
                                       where so.bucket_id = 'verification-documents' and so.name = x
                                         and so.created_at > now() - interval '12 hours'))) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform private.lock_verification_subject(v_me);

  if v_intake = 'upload'
     and exists (select 1 from public.verification_submissions s where s.document_refs && p_document_refs) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;

  if exists (select 1 from public.verification_submissions s
             where s.user_id = v_me and s.kind = p_kind and s.status in ('submitted', 'in_review')) then
    return private.deny('invalid_state');
  end if;

  if p_kind = 'age' then
    if exists (select 1 from public.account_verifications v
               where v.user_id = v_me and v.age_verified_at is not null and v.age_revoked_at is null) then
      return private.deny('invalid_state');
    end if;
    insert into public.verification_submissions (user_id, kind, intake_mode, document_refs)
    values (v_me, 'age', v_intake, p_document_refs)
    returning id into v_id;
    return private.ok(v_id::text);
  end if;

  select * into v_aff from public.affiliations a where a.user_id = v_me;
  if not found then
    return private.deny('invalid_state');
  end if;
  -- a renewal inside the validity keeps 'confirmed' until the decision; otherwise the affiliation waits as pending
  if v_aff.status in ('unconfirmed', 'rejected') or (v_aff.status = 'confirmed' and v_aff.confirmed_until <= now()) then
    update public.affiliations a
    set status = 'pending', confirmed_until = null, confirmed_by_submission = null
    where a.user_id = v_me;
  end if;
  insert into public.verification_submissions (user_id, kind, intake_mode, document_refs, affiliation_snapshot)
  values (v_me, 'enrollment', v_intake, p_document_refs,
          jsonb_build_object('school_id', v_aff.school_id, 'department_id', v_aff.department_id,
                             'class_id', v_aff.class_id))
  returning id into v_id;
  return private.ok(v_id::text);
end $$;

revoke all on function public.submit_verification(public.verification_kind, text[]) from public, anon, authenticated, service_role;
grant execute on function public.submit_verification(public.verification_kind, text[]) to authenticated;
