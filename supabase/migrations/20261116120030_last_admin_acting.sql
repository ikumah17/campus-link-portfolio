-- SEC-014 order 30 (SEC-013 edge): the last-admin rule counts admins whose role acts. Order 10 admin_revoke_role
-- refused to revoke the last admin by counting active admin rows. Since order 29 an active row acts only while
-- private.staff_role_effective is true, so an acting admin could revoke their own admin while the only other admin row
-- did not act, which left no admin that can act (recovery then needs the operator SQL in docs/38 §2).
-- Revoking 'admin' from p_user is now refused with the same invalid_state unless some other user (<> p_user) holds an
-- active admin row that acts. With one admin row no other admin exists, so the old case is still refused. The caller
-- always acts (require_staff), so only a caller revoking their own admin with no other acting admin is refused; an
-- acting admin can still revoke a row that does not act.
-- The check runs under the same exclusive staff lock (require_staff('admin', true)), before any write.
-- Unchanged on purpose: every other check, its order and code, the reviewer release loop, the audit rows, the
-- signature and the grants; admin_grant_role and admin_list_staff. This replaces the order-10 definition, the newest.

create or replace function public.admin_revoke_role(p_user uuid, p_role public.staff_role)
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
     and not exists (select 1 from private.staff_roles s
                     where s.role = 'admin' and s.revoked_at is null and s.user_id <> p_user
                       and private.staff_role_effective(s.user_id, 'admin')) then
    return private.deny('invalid_state');   -- never zero acting admins
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

-- create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
revoke all on function public.admin_revoke_role(uuid, public.staff_role) from public, anon, authenticated, service_role;
grant execute on function public.admin_revoke_role(uuid, public.staff_role) to authenticated;
