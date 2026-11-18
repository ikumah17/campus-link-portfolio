-- ADMIN-006 order 23: admin_list_suspended_accounts lists the suspended accounts, so an admin can lift a suspension
-- whose report is closed or that came from no report. It is for admins at aal2, like admin_set_account_status, which
-- stays the only way to change a status. It returns the minimum: the id, the display name and the time and reason
-- code of the latest suspension audit row (null when there is none); never a birth date, affiliation, photo, email
-- or report text, and never the caller's own row.

create function public.admin_list_suspended_accounts()
returns table(user_id uuid, display_name text, suspended_at timestamptz, reason text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('admin');
begin
  perform private.audit(v_me, 'list_suspended_accounts', 'profile', null, '{}'::jsonb);
  return query
    with latest as (
      select distinct on (a.target_id) a.target_id, a.created_at, a.detail ->> 'reason' as reason
      from private.audit_log a
      where a.action = 'set_account_status' and a.target_type = 'profile' and a.detail ->> 'to' = 'suspended'
      order by a.target_id, a.created_at desc, a.id desc
    )
    select p.user_id, p.display_name, l.created_at, l.reason
    from public.profiles p
    left join latest l on l.target_id = p.user_id::text
    where p.account_status = 'suspended' and p.user_id <> v_me
    order by l.created_at nulls last, p.user_id;
end $$;

revoke all on function public.admin_list_suspended_accounts() from public, anon, authenticated, service_role;
grant execute on function public.admin_list_suspended_accounts() to authenticated;
