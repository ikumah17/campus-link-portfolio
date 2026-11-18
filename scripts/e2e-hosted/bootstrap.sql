-- Hosted E2E bootstrap for campus-link-dev (run in the SQL editor as postgres; idempotent, safe to re-run).
-- Needs migration order 29 (private.staff_role_effective, HOSTED-016).
-- 1. The fictional affiliation master from supabase/seed.sql (no users).
-- 2. The first staff roles for the fictional test admin e2e-admin@example.invalid (created by admin-user.mjs),
--    the maintenance path for the first admin (docs/04_DATABASE.md §8), with one audit row per role.
-- 3. Re-anchor (SEC-013 order 29, FIX-010): a role acts only when the account's verified TOTP was created at or before
--    the row's granted_at. A role row that does not act is revoked and granted anew (the documented recovery), with
--    the revoke_role/grant_role audit rows of admin_revoke_role and admin_grant_role and a null actor, only when the
--    test admin's one and only verified factor is a TOTP created within the last 10 minutes. No TOTP, a second
--    verified factor or an older TOTP: nothing changes. No other account is touched.
-- A fresh environment runs this file, enrolls the TOTP on /admin/mfa (the first adminPage()), then runs it again
-- within 10 minutes of the enrolment.
-- The result row shows each active role of the test admin as role=acting (true/false), the created_at of its verified
-- factors (factor_created_at; confirm it is the factor just enrolled) and reanchor: done, none_needed (every role
-- already acts), or why nothing changed (no_factor, several_factors, factor_too_old; no_account, several_accounts).
-- No id or email is printed.
begin;
insert into public.schools (id, name, sort_order) values
  ('00000000-0000-4000-8000-00000000a001', 'デモ学校A（架空）', 1),
  ('00000000-0000-4000-8000-00000000a002', 'デモ学校B（架空）', 2)
on conflict (id) do nothing;

insert into public.departments (id, school_id, name, sort_order) values
  ('00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-00000000a001', 'デモ学科A1（架空）', 1),
  ('00000000-0000-4000-8000-00000000b012', '00000000-0000-4000-8000-00000000a001', 'デモ学科A2（架空）', 2),
  ('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-00000000a002', 'デモ学科B1（架空）', 1),
  ('00000000-0000-4000-8000-00000000b022', '00000000-0000-4000-8000-00000000a002', 'デモ学科B2（架空）', 2)
on conflict (id) do nothing;

insert into public.classes (id, department_id, name) values
  ('00000000-0000-4000-8000-00000000c111', '00000000-0000-4000-8000-00000000b011', 'デモクラスA1-1（架空）'),
  ('00000000-0000-4000-8000-00000000c112', '00000000-0000-4000-8000-00000000b011', 'デモクラスA1-2（架空）'),
  ('00000000-0000-4000-8000-00000000c121', '00000000-0000-4000-8000-00000000b012', 'デモクラスA2-1（架空）'),
  ('00000000-0000-4000-8000-00000000c122', '00000000-0000-4000-8000-00000000b012', 'デモクラスA2-2（架空）'),
  ('00000000-0000-4000-8000-00000000c211', '00000000-0000-4000-8000-00000000b021', 'デモクラスB1-1（架空）'),
  ('00000000-0000-4000-8000-00000000c212', '00000000-0000-4000-8000-00000000b021', 'デモクラスB1-2（架空）'),
  ('00000000-0000-4000-8000-00000000c221', '00000000-0000-4000-8000-00000000b022', 'デモクラスB2-1（架空）'),
  ('00000000-0000-4000-8000-00000000c222', '00000000-0000-4000-8000-00000000b022', 'デモクラスB2-2（架空）')
on conflict (id) do nothing;

do $boot$
declare v_user uuid; r public.staff_role;
begin
  select u.id into v_user from auth.users u where u.email = 'e2e-admin@example.invalid' and u.email_confirmed_at is not null;
  if v_user is null then raise exception 'bootstrap: test admin missing'; end if;
  perform private.lock_staff_roles(true);
  foreach r in array array['admin', 'moderator', 'reviewer']::public.staff_role[] loop
    if not exists (select 1 from private.staff_roles s where s.user_id = v_user and s.role = r and s.revoked_at is null) then
      insert into private.staff_roles (user_id, role, granted_by) values (v_user, r, null);
      perform private.audit(null, 'grant_role', 'staff_role', v_user::text, jsonb_build_object('role', r, 'via', 'bootstrap'));
    end if;
  end loop;
end
$boot$;

-- >>> re-anchor (scripts/db/HOSTED-016/bundle.mjs embeds this block verbatim; edit it only here)
-- Only the confirmed e2e-admin@example.invalid (and only when exactly one account has that email), only when its one
-- verified factor of any type is a TOTP created within the last 10 minutes (FIX-010, docs/39 P-3: the operator runs
-- this right after enrolling, so an older factor or a second one, which someone else may have enrolled, is never
-- bound to the roles), only its active rows that private.staff_role_effective reports as not acting. Revoke as
-- admin_revoke_role does (revoked_at = now() on the active row; the row stays as history), then insert a new row as
-- admin_grant_role does (granted_at = now(), after the factor). The exclusive staff_roles lock is held until commit,
-- so no admin RPC sees the gap, and the same role is granted again in the same transaction, so the last-admin rule
-- (never zero active admins) holds at commit and no in_review claim needs releasing.
-- The outcome goes to the session setting campus.bootstrap_reanchor (set on every path, rolled back with the
-- transaction): done, none_needed, or the refusal no_account, several_accounts, no_factor, several_factors,
-- factor_too_old, after which nothing has changed.
do $reanchor$
declare v_user uuid; v_factors int; v_totp int; v_created timestamptz; v_outcome text; r public.staff_role;
begin
  select u.id into v_user from auth.users u where u.email = 'e2e-admin@example.invalid' and u.email_confirmed_at is not null;
  if v_user is null then
    v_outcome := 'no_account';
  elsif (select count(*) from auth.users u where u.email = 'e2e-admin@example.invalid') <> 1 then
    v_outcome := 'several_accounts';
  else
    select count(*), count(*) filter (where f.factor_type = 'totp'), max(f.created_at)
      into v_factors, v_totp, v_created
      from auth.mfa_factors f where f.user_id = v_user and f.status = 'verified';
    if v_totp = 0 then
      v_outcome := 'no_factor';
    elsif v_factors > 1 then
      v_outcome := 'several_factors';
    elsif v_created < now() - interval '10 minutes' then
      v_outcome := 'factor_too_old';
    end if;
  end if;
  if v_outcome is null then
    perform private.lock_staff_roles(true);
    v_outcome := 'none_needed';
    for r in
      select s.role from private.staff_roles s
      where s.user_id = v_user and s.revoked_at is null and not private.staff_role_effective(v_user, s.role)
      order by s.role
    loop
      update private.staff_roles s set revoked_at = now()
      where s.user_id = v_user and s.role = r and s.revoked_at is null;
      perform private.audit(null, 'revoke_role', 'staff_role', v_user::text, jsonb_build_object('role', r, 'via', 'reanchor'));
      insert into private.staff_roles (user_id, role, granted_by) values (v_user, r, null);
      perform private.audit(null, 'grant_role', 'staff_role', v_user::text, jsonb_build_object('role', r, 'via', 'reanchor'));
      v_outcome := 'done';
    end loop;
  end if;
  perform set_config('campus.bootstrap_reanchor', v_outcome, false);
end
$reanchor$;
-- <<< re-anchor
commit;
select (select count(*) from public.schools) as schools, (select count(*) from public.departments) as departments,
       (select count(*) from public.classes) as classes,
       (select string_agg(s.role::text || '=' || private.staff_role_effective(s.user_id, s.role)::text, ',' order by s.role::text)
          from private.staff_roles s join auth.users u on u.id = s.user_id
         where u.email = 'e2e-admin@example.invalid' and s.revoked_at is null) as admin_roles,
       (select string_agg(f.created_at::text, ',' order by f.created_at)
          from auth.mfa_factors f join auth.users u on u.id = f.user_id
         where u.email = 'e2e-admin@example.invalid' and f.status = 'verified') as factor_created_at,
       current_setting('campus.bootstrap_reanchor', true) as reanchor;
