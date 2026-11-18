-- ROLE-001: docs/04_DATABASE.md §5 admin_list_staff / admin_grant_role_by_email, §12 order 14.
-- Authorize under the shared/exclusive staff lock before reading any target.
create function public.admin_list_staff()
returns table(user_id uuid, display_name text, roles public.staff_role[], is_me boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := private.require_staff('admin');
begin
  return query
    select r.user_id, p.display_name, array_agg(r.role order by r.role), r.user_id = v_me
    from private.staff_roles r
    left join public.profiles p on p.user_id = r.user_id
    where r.revoked_at is null
    group by r.user_id, p.display_name
    order by p.display_name nulls last, r.user_id;
end $$;

create function public.admin_grant_role_by_email(p_email text, p_role public.staff_role)
returns public.rpc_outcome
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := private.require_staff('admin', true);
  v_users uuid[];
  v_result public.rpc_outcome;
begin
  if p_email is null or char_length(trim(p_email)) not between 3 and 254
     or char_length(trim(p_email)) - char_length(replace(trim(p_email), '@', '')) <> 1
     or p_role is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select array_agg(u.id) into v_users
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.email_confirmed_at is not null and u.is_anonymous = false
    and private.auth_account_ok(u.id);
  -- Fail closed even if differently-cased addresses exist for multiple accounts.
  if coalesce(cardinality(v_users), 0) <> 1 then
    return private.deny('not_available');
  end if;
  v_result := public.admin_grant_role(v_users[1], p_role);
  if v_result.ok then return private.ok(null); end if;
  return private.deny(v_result.code);
end $$;

revoke all on function public.admin_list_staff(), public.admin_grant_role_by_email(text, public.staff_role)
from public, anon, authenticated, service_role;
grant execute on function public.admin_list_staff(), public.admin_grant_role_by_email(text, public.staff_role)
to authenticated;
