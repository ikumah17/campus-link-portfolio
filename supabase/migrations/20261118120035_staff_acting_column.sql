-- STAFF-001 order 35 (docs/39 P-2): admin_list_staff says which listed roles act. Since order 29 an active role row acts
-- only while private.staff_role_effective is true, but order 14 admin_list_staff listed every active row without saying
-- so, and an admin could not see that the last acting admin was gone.
-- One new output column, acting boolean[], aligned 1:1 with roles: both arrays are built in the same group with the same
-- `order by r.role`, and a user holds at most one active row per role, so acting[i] = staff_role_effective(user, roles[i]).
-- Unchanged on purpose: the caller check and its shared staff lock (require_staff('admin')), the rows (one per user with
-- an active role row, acting or not), their order, every other column, volatile, security definer, search_path and the
-- grants (EXECUTE for authenticated only). A changed return type needs drop and create, so the grants are restated.

drop function public.admin_list_staff();

create function public.admin_list_staff()
returns table(user_id uuid, display_name text, roles public.staff_role[], is_me boolean, acting boolean[])
language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := private.require_staff('admin');
begin
  return query
    select r.user_id, p.display_name, array_agg(r.role order by r.role), r.user_id = v_me,
           array_agg(private.staff_role_effective(r.user_id, r.role) order by r.role)
    from private.staff_roles r
    left join public.profiles p on p.user_id = r.user_id
    where r.revoked_at is null
    group by r.user_id, p.display_name
    order by p.display_name nulls last, r.user_id;
end $$;

revoke all on function public.admin_list_staff() from public, anon, authenticated, service_role;
grant execute on function public.admin_list_staff() to authenticated;
