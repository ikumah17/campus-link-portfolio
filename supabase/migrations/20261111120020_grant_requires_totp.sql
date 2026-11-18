-- SEC-003 order 20 (SECREVIEW-001 M-3): a staff role exists only for an account that already holds a verified TOTP
-- factor. Before, admin_grant_role granted to any Auth user; if that user had no factor yet, whoever first signed in
-- with the password could enroll their own and reach aal2 over birth dates and identity documents.
-- The new refusal code mfa_required lets /admin/staff tell this apart from not_available (no such account) and
-- invalid_state (role already active). The check runs after every existing check, so their order and codes are
-- unchanged (a duplicate is still invalid_state), and before any write, so a refusal writes no role and no audit row.
-- admin_grant_role_by_email is not replaced: it grants only through public.admin_grant_role and returns
-- private.deny(v_result.code), so it gives the same refusal with no write.
-- Revocation and existing roles are untouched. A current holder without TOTP keeps the row but still cannot act:
-- every admin RPC calls private.require_staff, which requires aal2.

alter type public.outcome_code add value 'mfa_required';

create or replace function public.admin_grant_role(p_user uuid, p_role public.staff_role)
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
  if not exists (select 1 from auth.mfa_factors f
                 where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified') then
    return private.deny('mfa_required');
  end if;
  insert into private.staff_roles (user_id, role, granted_by) values (p_user, p_role, v_me);
  perform private.audit(v_me, 'grant_role', 'staff_role', p_user::text, jsonb_build_object('role', p_role));
  return private.ok(p_user::text);
end $$;

-- create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
revoke all on function public.admin_grant_role(uuid, public.staff_role) from public, anon, authenticated, service_role;
grant execute on function public.admin_grant_role(uuid, public.staff_role) to authenticated;
