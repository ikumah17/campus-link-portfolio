-- ADMIN-005 order 19: my_staff_roles names the caller's own active staff roles, so /admin shows its dashboard to
-- staff only (HOSTED-E2E-006 saw the link list for a non-staff caller at aal2). It reads no other user and grants
-- nothing: every admin RPC still checks its own role with private.require_staff at aal2. private.require_user refuses
-- a signed-out, anonymous or unconfirmed caller and, from order 17, a deleted account. It needs no aal2 because it
-- only names the caller's own roles; the page requires aal2 before it shows anything.

create function public.my_staff_roles()
returns table(role public.staff_role)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select r.role
    from private.staff_roles r
    where r.user_id = v_me and r.revoked_at is null
    order by r.role;
end $$;

revoke all on function public.my_staff_roles() from public, anon, authenticated, service_role;
grant execute on function public.my_staff_roles() to authenticated;
