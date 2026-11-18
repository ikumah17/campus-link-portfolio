-- BE-001 order 10: management RPCs (docs/04_DATABASE.md §5.6, §7, §8).
-- Each RPC calls private.require_staff once, before its first write: the role is checked under the
-- staff_roles lock (shared; exclusive for grant/revoke) held until commit. One audit row per successful operation.

create function public.admin_list_submissions(p_status public.verification_status default 'submitted')
returns table(
  id          uuid,
  user_id     uuid,
  kind        public.verification_kind,
  status      public.verification_status,
  reviewer_id uuid,
  claimed_at  timestamptz,
  version     int,
  created_at  timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('reviewer');
begin
  perform private.audit(v_me, 'list_submissions', 'verification_submission', null,
                        jsonb_build_object('status', p_status));
  return query
    select s.id, s.user_id, s.kind, s.status, s.reviewer_id, s.claimed_at, s.version, s.created_at
    from public.verification_submissions s
    where p_status is null or s.status = p_status
    order by s.created_at, s.id;
end $$;

create function public.admin_claim_submission(p_id uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_staff('reviewer');
  v_user uuid;
  v_id   uuid;
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select s.user_id into v_user from public.verification_submissions s where s.id = p_id;
  if not found then
    return private.deny('not_available');
  end if;
  perform private.lock_verification_subject(v_user);
  update public.verification_submissions s
  set status = 'in_review', reviewer_id = v_me, claimed_at = now(), version = s.version + 1
  where s.id = p_id and s.status = 'submitted' and s.user_id <> v_me
  returning s.id into v_id;
  if v_id is null then
    return private.deny('invalid_state');
  end if;
  perform private.audit(v_me, 'claim_submission', 'verification_submission', p_id::text, null);
  return private.ok(p_id::text);
end $$;

create function public.admin_release_submission(p_id uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_staff('reviewer');
  v_user uuid;
  v_id   uuid;
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select s.user_id into v_user from public.verification_submissions s where s.id = p_id;
  if not found then
    return private.deny('not_available');
  end if;
  perform private.lock_verification_subject(v_user);
  update public.verification_submissions s
  set status = 'submitted', reviewer_id = null, claimed_at = null, version = s.version + 1
  where s.id = p_id and s.status = 'in_review' and s.reviewer_id = v_me
  returning s.id into v_id;
  if v_id is null then
    return private.deny('invalid_state');
  end if;
  perform private.audit(v_me, 'release_submission', 'verification_submission', p_id::text, null);
  return private.ok(p_id::text);
end $$;

-- assigned reviewer only; otherwise 0 rows and no audit
create function public.admin_get_submission(p_id uuid)
returns table(
  id              uuid,
  user_id         uuid,
  kind            public.verification_kind,
  status          public.verification_status,
  version         int,
  birth_date      date,
  school_name     text,
  department_name text,
  class_name      text,
  document_refs   text[],
  created_at      timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('reviewer');
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from public.verification_submissions s
                 where s.id = p_id and s.status = 'in_review' and s.reviewer_id = v_me) then
    return;
  end if;
  perform private.audit(v_me, 'view_submission', 'verification_submission', p_id::text, null);
  return query
    select s.id, s.user_id, s.kind, s.status, s.version, u.birth_date, sc.name, d.name, c.name,
           s.document_refs, s.created_at
    from public.verification_submissions s
    left join private.user_private u on u.user_id = s.user_id
    left join public.schools sc      on sc.id = (s.affiliation_snapshot ->> 'school_id')::uuid
    left join public.departments d   on d.id = (s.affiliation_snapshot ->> 'department_id')::uuid
    left join public.classes c       on c.id = (s.affiliation_snapshot ->> 'class_id')::uuid
    where s.id = p_id;
end $$;

-- per-request authorization for the document delivery route (E-2); audited before the references are returned
create function public.admin_authorize_document_view(p_id uuid)
returns table(n int, document_ref text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('reviewer');
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from public.verification_submissions s
                 where s.id = p_id and s.status = 'in_review' and s.reviewer_id = v_me) then
    return;
  end if;
  perform private.audit(v_me, 'authorize_document_view', 'verification_submission', p_id::text, null);
  return query
    select o.n::int, o.ref
    from public.verification_submissions s
    cross join lateral unnest(s.document_refs) with ordinality as o(ref, n)
    where s.id = p_id
    order by o.n;
end $$;

create function public.admin_decide_submission(
  p_id               uuid,
  p_approve          boolean,
  p_reason           text,
  p_valid_until      timestamptz,
  p_expected_version int)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_staff('reviewer');
  v_user  uuid;
  v_sub   public.verification_submissions;
  v_aff   public.affiliations;
  v_birth date;
begin
  if p_id is null or p_approve is null or p_expected_version is null
     or (p_reason is not null and p_reason !~ '^[a-z0-9_]{1,64}$') then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select s.user_id into v_user from public.verification_submissions s where s.id = p_id;
  if not found then
    return private.deny('not_available');
  end if;
  perform private.lock_verification_subject(v_user);
  select * into v_sub from public.verification_submissions s where s.id = p_id;
  if v_sub.status <> 'in_review' or v_sub.reviewer_id is distinct from v_me or v_sub.version <> p_expected_version then
    return private.deny('invalid_state');   -- also stops a stale decision on a superseded submission
  end if;
  if p_approve and v_sub.kind = 'enrollment' and p_valid_until is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;

  if not p_approve then
    update public.verification_submissions s
    set status = 'rejected', decided_at = now(), decision_reason = p_reason, version = s.version + 1
    where s.id = p_id;
    if v_sub.kind = 'enrollment' then
      -- a renewal inside the validity keeps its confirmation; a first submission is rejected
      update public.affiliations a set status = 'rejected' where a.user_id = v_user and a.status = 'pending';
    end if;
  elsif v_sub.kind = 'enrollment' then
    select * into v_aff from public.affiliations a where a.user_id = v_user;
    if not found or v_aff.status not in ('pending', 'confirmed')
       or v_aff.school_id is distinct from (v_sub.affiliation_snapshot ->> 'school_id')::uuid
       or v_aff.department_id is distinct from (v_sub.affiliation_snapshot ->> 'department_id')::uuid
       or v_aff.class_id is distinct from (v_sub.affiliation_snapshot ->> 'class_id')::uuid
       or p_valid_until <= now() then
      return private.deny('invalid_state');
    end if;
    update public.affiliations a
    set status = 'confirmed',
        confirmed_until = greatest(p_valid_until, case when a.status = 'confirmed' then a.confirmed_until end),
        confirmed_by_submission = p_id
    where a.user_id = v_user;
    update public.verification_submissions s
    set status = 'approved', decided_at = now(), decision_reason = p_reason, valid_until = p_valid_until,
        version = s.version + 1
    where s.id = p_id;
  else
    select u.birth_date into v_birth from private.user_private u where u.user_id = v_user;
    if not found or private.adult_from(v_birth) > private.today_jst() then
      return private.deny('invalid_state');
    end if;
    update public.account_verifications v
    set age_verified_at = now(), age_submission_id = p_id, age_revoked_at = null
    where v.user_id = v_user;
    update private.user_private u set birth_date_locked_at = coalesce(u.birth_date_locked_at, now())
    where u.user_id = v_user;
    update public.verification_submissions s
    set status = 'approved', decided_at = now(), decision_reason = p_reason, version = s.version + 1
    where s.id = p_id;
  end if;
  perform private.audit(v_me, case when p_approve then 'approve_submission' else 'reject_submission' end,
                        'verification_submission', p_id::text, jsonb_build_object('kind', v_sub.kind));
  return private.ok(p_id::text);
end $$;

create function public.admin_revoke_verification(p_user uuid, p_kind public.verification_kind, p_reason text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_staff('reviewer');
  v_sub uuid;
begin
  if p_user is null or p_kind is null or p_reason is null or p_reason !~ '^[a-z0-9_]{1,64}$' then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.lock_verification_subject(p_user);
  if p_kind = 'age' then
    select s.id into v_sub
    from public.account_verifications v
    join public.verification_submissions s on s.id = v.age_submission_id
    where v.user_id = p_user and v.age_verified_at is not null and v.age_revoked_at is null and s.status = 'approved';
    if v_sub is null then
      return private.deny('invalid_state');
    end if;
    update public.account_verifications v set age_revoked_at = now() where v.user_id = p_user;
  else
    select s.id into v_sub
    from public.affiliations a
    join public.verification_submissions s on s.id = a.confirmed_by_submission
    where a.user_id = p_user and a.status = 'confirmed' and s.status = 'approved';
    if v_sub is null then
      return private.deny('invalid_state');
    end if;
    update public.affiliations a
    set status = 'rejected', confirmed_until = null, confirmed_by_submission = null
    where a.user_id = p_user;
  end if;
  update public.verification_submissions s
  set status = 'revoked', reviewer_id = v_me, decided_at = now(), decision_reason = p_reason,
      version = s.version + 1
  where s.id = v_sub;
  perform private.audit(v_me, 'revoke_verification', 'verification_submission', v_sub::text,
                        jsonb_build_object('kind', p_kind));
  return private.ok(v_sub::text);
end $$;

create function public.admin_set_account_status(p_user uuid, p_status public.account_status, p_reason text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_staff('admin');
  v_status public.account_status;
begin
  if p_user is null or p_status is null or p_status not in ('suspended', 'active')
     or (p_reason is not null and p_reason !~ '^[a-z0-9_]{1,64}$') then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select p.account_status into v_status from public.profiles p where p.user_id = p_user for update;
  if not found then
    return private.deny('not_available');
  end if;
  if not ((p_status = 'suspended' and v_status in ('active', 'deactivated'))
          or (p_status = 'active' and v_status = 'suspended')) then
    return private.deny('invalid_state');
  end if;
  update public.profiles p set account_status = p_status where p.user_id = p_user;
  perform private.audit(v_me, 'set_account_status', 'profile', p_user::text,
                        jsonb_build_object('from', v_status, 'to', p_status, 'reason', p_reason));
  return private.ok(p_user::text);
end $$;

create function public.admin_upsert_school(p_id uuid, p_name text, p_is_active boolean, p_sort_order int)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_staff('admin');
  v_id uuid := p_id;
begin
  if p_name is null or char_length(p_name) not between 1 and 80 or btrim(p_name) = ''
     or p_is_active is null or p_sort_order is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if v_id is not null and not exists (select 1 from public.schools s where s.id = v_id) then
    return private.deny('not_available');
  end if;
  if exists (select 1 from public.schools s where s.name = p_name and s.id is distinct from v_id) then
    return private.deny('invalid_state');
  end if;
  if v_id is null then
    insert into public.schools (name, is_active, sort_order) values (p_name, p_is_active, p_sort_order)
    returning id into v_id;
  else
    update public.schools s set name = p_name, is_active = p_is_active, sort_order = p_sort_order where s.id = v_id;
  end if;
  perform private.audit(v_me, 'upsert_school', 'school', v_id::text, jsonb_build_object('created', p_id is null));
  return private.ok(v_id::text);
end $$;

create function public.admin_upsert_department(p_id uuid, p_school_id uuid, p_name text, p_is_active boolean, p_sort_order int)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_staff('admin');
  v_id     uuid := p_id;
  v_school uuid;
begin
  if p_school_id is null or p_name is null or char_length(p_name) not between 1 and 80 or btrim(p_name) = ''
     or p_is_active is null or p_sort_order is null
     or not exists (select 1 from public.schools s where s.id = p_school_id) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if v_id is not null then
    select d.school_id into v_school from public.departments d where d.id = v_id;
    if not found then
      return private.deny('not_available');
    end if;
    if v_school <> p_school_id then
      return private.deny('invalid_state');   -- a department never moves to another school
    end if;
  end if;
  if exists (select 1 from public.departments d
             where d.school_id = p_school_id and d.name = p_name and d.id is distinct from v_id) then
    return private.deny('invalid_state');
  end if;
  if v_id is null then
    insert into public.departments (school_id, name, is_active, sort_order)
    values (p_school_id, p_name, p_is_active, p_sort_order)
    returning id into v_id;
  else
    update public.departments d set name = p_name, is_active = p_is_active, sort_order = p_sort_order
    where d.id = v_id;
  end if;
  perform private.audit(v_me, 'upsert_department', 'department', v_id::text, jsonb_build_object('created', p_id is null));
  return private.ok(v_id::text);
end $$;

create function public.admin_upsert_class(p_id uuid, p_department_id uuid, p_name text, p_academic_year smallint, p_is_active boolean)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_staff('admin');
  v_id   uuid := p_id;
  v_dept uuid;
begin
  if p_department_id is null or p_name is null or char_length(p_name) not between 1 and 40 or btrim(p_name) = ''
     or p_is_active is null
     or not exists (select 1 from public.departments d where d.id = p_department_id) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if v_id is not null then
    select c.department_id into v_dept from public.classes c where c.id = v_id;
    if not found then
      return private.deny('not_available');
    end if;
    if v_dept <> p_department_id then
      return private.deny('invalid_state');   -- a class never moves to another department
    end if;
  end if;
  if exists (select 1 from public.classes c
             where c.department_id = p_department_id and c.name = p_name
               and c.academic_year is not distinct from p_academic_year and c.id is distinct from v_id) then
    return private.deny('invalid_state');
  end if;
  if v_id is null then
    insert into public.classes (department_id, name, academic_year, is_active)
    values (p_department_id, p_name, p_academic_year, p_is_active)
    returning id into v_id;
  else
    update public.classes c set name = p_name, academic_year = p_academic_year, is_active = p_is_active
    where c.id = v_id;
  end if;
  perform private.audit(v_me, 'upsert_class', 'class', v_id::text, jsonb_build_object('created', p_id is null));
  return private.ok(v_id::text);
end $$;

-- moderators never see or handle reports they are a party of
create function public.admin_list_reports(p_status public.report_status default 'open')
returns table(
  id             uuid,
  reporter_id    uuid,
  target_user_id uuid,
  context        public.report_context,
  reason         public.report_reason,
  status         public.report_status,
  created_at     timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('moderator');
begin
  perform private.audit(v_me, 'list_reports', 'report', null, jsonb_build_object('status', p_status));
  return query
    select r.id, r.reporter_id, r.target_user_id, r.context, r.reason, r.status, r.created_at
    from public.reports r
    where (p_status is null or r.status = p_status)
      and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me
    order by r.created_at, r.id;
end $$;

create function public.admin_get_report(p_id uuid)
returns table(
  id                 uuid,
  reporter_id        uuid,
  target_user_id     uuid,
  context            public.report_context,
  reason             public.report_reason,
  detail             text,
  status             public.report_status,
  request_id         uuid,
  message_id         bigint,
  created_at         timestamptz,
  evidence_conversation_id    uuid,
  evidence_message_body       text,
  evidence_message_created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('moderator');
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from public.reports r
                 where r.id = p_id
                   and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me) then
    return;
  end if;
  perform private.audit(v_me, 'view_report', 'report', p_id::text, null);
  return query
    select r.id, r.reporter_id, r.target_user_id, r.context, r.reason, r.detail, r.status, r.request_id,
           r.message_id, r.created_at, e.conversation_id, e.message_body, e.message_created_at
    from public.reports r
    left join private.report_evidence e on e.report_id = r.id
    where r.id = p_id;
end $$;

create function public.admin_update_report(p_id uuid, p_status public.report_status, p_note text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_staff('moderator');
  v_rep public.reports;
begin
  if p_id is null or p_status is null or char_length(p_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select * into v_rep from public.reports r where r.id = p_id for update;
  if not found then
    return private.deny('not_available');
  end if;
  if v_rep.reporter_id is not distinct from v_me or v_rep.target_user_id is not distinct from v_me
     or (v_rep.status::text || '>' || p_status::text) not in (
       'open>triaged', 'open>dismissed', 'triaged>actioned', 'triaged>dismissed') then
    return private.deny('invalid_state');
  end if;
  update public.reports r set status = p_status where r.id = p_id;
  insert into private.report_actions (report_id, actor_id, action, note) values (p_id, v_me, p_status::text, p_note);
  perform private.audit(v_me, 'update_report', 'report', p_id::text,
                        jsonb_build_object('from', v_rep.status, 'to', p_status));
  return private.ok(p_id::text);
end $$;

create function public.admin_grant_role(p_user uuid, p_role public.staff_role)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_staff('admin', true);
begin
  if p_user is null or p_role is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return private.deny('not_available');
  end if;
  if exists (select 1 from private.staff_roles r where r.user_id = p_user and r.role = p_role and r.revoked_at is null) then
    return private.deny('invalid_state');
  end if;
  insert into private.staff_roles (user_id, role, granted_by) values (p_user, p_role, v_me);
  perform private.audit(v_me, 'grant_role', 'staff_role', p_user::text, jsonb_build_object('role', p_role));
  return private.ok(p_user::text);
end $$;

-- r4 (ARCH-R3-FINAL-02): exclusive from the start; a revoked reviewer's in-review submissions return to
-- 'submitted' in the same transaction (enumerated after the exclusive lock, so earlier claims are included)
create function public.admin_revoke_role(p_user uuid, p_role public.staff_role)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_staff('admin', true);
  r     record;
  r_sub record;
begin
  if p_user is null or p_role is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from private.staff_roles s where s.user_id = p_user and s.role = p_role and s.revoked_at is null) then
    return private.deny('invalid_state');
  end if;
  if p_role = 'admin'
     and (select count(*) from private.staff_roles s where s.role = 'admin' and s.revoked_at is null) <= 1 then
    return private.deny('invalid_state');   -- never zero active admins
  end if;
  update private.staff_roles s set revoked_at = now()
  where s.user_id = p_user and s.role = p_role and s.revoked_at is null;
  perform private.audit(v_me, 'revoke_role', 'staff_role', p_user::text, jsonb_build_object('role', p_role));

  if p_role = 'reviewer' then
    for r in
      select distinct s.user_id
      from public.verification_submissions s
      where s.status = 'in_review' and s.reviewer_id = p_user
      order by s.user_id
    loop
      perform private.lock_verification_subject(r.user_id);
      for r_sub in
        update public.verification_submissions s
        set status = 'submitted', reviewer_id = null, claimed_at = null, version = s.version + 1
        where s.user_id = r.user_id and s.status = 'in_review' and s.reviewer_id = p_user
        returning s.id
      loop
        perform private.audit(v_me, 'release_submission_on_role_revocation', 'verification_submission',
                              r_sub.id::text, jsonb_build_object('previous_reviewer', p_user));
      end loop;
    end loop;
  end if;
  return private.ok(p_user::text);
end $$;

revoke all on function
  public.admin_list_submissions(public.verification_status),
  public.admin_claim_submission(uuid),
  public.admin_release_submission(uuid),
  public.admin_get_submission(uuid),
  public.admin_authorize_document_view(uuid),
  public.admin_decide_submission(uuid, boolean, text, timestamptz, int),
  public.admin_revoke_verification(uuid, public.verification_kind, text),
  public.admin_set_account_status(uuid, public.account_status, text),
  public.admin_upsert_school(uuid, text, boolean, int),
  public.admin_upsert_department(uuid, uuid, text, boolean, int),
  public.admin_upsert_class(uuid, uuid, text, smallint, boolean),
  public.admin_list_reports(public.report_status),
  public.admin_get_report(uuid),
  public.admin_update_report(uuid, public.report_status, text),
  public.admin_grant_role(uuid, public.staff_role),
  public.admin_revoke_role(uuid, public.staff_role)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_list_submissions(public.verification_status),
  public.admin_claim_submission(uuid),
  public.admin_release_submission(uuid),
  public.admin_get_submission(uuid),
  public.admin_authorize_document_view(uuid),
  public.admin_decide_submission(uuid, boolean, text, timestamptz, int),
  public.admin_revoke_verification(uuid, public.verification_kind, text),
  public.admin_set_account_status(uuid, public.account_status, text),
  public.admin_upsert_school(uuid, text, boolean, int),
  public.admin_upsert_department(uuid, uuid, text, boolean, int),
  public.admin_upsert_class(uuid, uuid, text, smallint, boolean),
  public.admin_list_reports(public.report_status),
  public.admin_get_report(uuid),
  public.admin_update_report(uuid, public.report_status, text),
  public.admin_grant_role(uuid, public.staff_role),
  public.admin_revoke_role(uuid, public.staff_role)
to authenticated;
