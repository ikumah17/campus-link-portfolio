-- SEC-013 order 29 (SECREVIEW-002 N-3): a staff role acts only while the account still has the TOTP factor it was
-- granted with. Order 20 checks for a verified TOTP factor only when a role is granted; private.require_staff then
-- checked only aal2 and the role row. If an operator deleted a lost authenticator, the role row stayed, and anyone with
-- the password could enroll a new TOTP, reach aal2 and read identity documents and birth dates.
-- private.staff_role_effective is true only for an active row whose account has a verified TOTP factor created at or
-- before the row's granted_at, and no verified factor of any type created after it. A deleted, replaced, added or
-- unverified factor therefore makes the role refuse.
-- It replaces the role-row test in private.require_staff (which every admin RPC calls; lock, aal2 rule, error and
-- return unchanged) and in public.my_staff_roles, so /admin offers no dashboard whose RPCs all refuse.
-- Unchanged on purpose: the grant-time checks (order 20 admin_grant_role, admin_grant_role_by_email, the duplicate
-- check), admin_revoke_role and its last-admin rule, and admin_list_staff, which still lists every active row so an
-- admin can see and revoke a role that no longer acts.
-- Recovery after a factor is replaced: an admin revokes the role and grants it again. The new row's granted_at is after
-- the new factor. Revoking never needs the target's role to be effective. If the only admin's role stops acting, nobody
-- can grant through the app and no bypass is added here: an operator uses the service role or the SQL editor (docs/38).
-- Clock: auth.mfa_factors.created_at is written by Auth and granted_at by Postgres. Enrolment, verification and grant
-- are separate human steps, seconds apart or more, so ordinary clock skew is accepted.

create function private.staff_role_effective(p_user uuid, p_role public.staff_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.staff_roles r
    where r.user_id = p_user and r.role = p_role and r.revoked_at is null
      and exists (select 1 from auth.mfa_factors f
                  where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified'
                    and f.created_at <= r.granted_at)
      and not exists (select 1 from auth.mfa_factors f
                      where f.user_id = p_user and f.status = 'verified' and f.created_at > r.granted_at))
$$;

revoke all on function private.staff_role_effective(uuid, public.staff_role) from public, anon, authenticated, service_role;

-- §4 role check (r4, ARCH-R3-FINAL-02): volatile so the statement after the lock reads the latest role rows
create or replace function private.require_staff(p_role public.staff_role, p_exclusive boolean default false) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.require_user();
begin
  perform private.lock_staff_roles(p_exclusive);
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
     or not private.staff_role_effective(v_uid, p_role) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return v_uid;
end $$;

create or replace function public.my_staff_roles()
returns table(role public.staff_role)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select r.role
    from private.staff_roles r
    where r.user_id = v_me and r.revoked_at is null and private.staff_role_effective(v_me, r.role)
    order by r.role;
end $$;

-- create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
revoke all on function private.require_staff(public.staff_role, boolean) from public, anon, authenticated, service_role;
revoke all on function public.my_staff_roles() from public, anon, authenticated, service_role;
grant execute on function public.my_staff_roles() to authenticated;
