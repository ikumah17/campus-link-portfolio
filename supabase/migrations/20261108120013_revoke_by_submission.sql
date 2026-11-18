-- VERIFY-004: docs/04_DATABASE.md §5 admin_revoke_verification, §12 order 13.
-- Resolve the immutable subject first, then check the current confirmation after its lock.

drop function public.admin_revoke_verification(uuid, public.verification_kind, text);

create function public.admin_revoke_verification(p_submission uuid, p_reason text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' volatile as $$
declare
  v_me   uuid := private.require_staff('reviewer');
  v_user uuid;
  v_kind public.verification_kind;
  v_sub  uuid;
begin
  if p_submission is null or p_reason is null or p_reason !~ '^[a-z0-9_]{1,64}$' then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select s.user_id, s.kind into v_user, v_kind
  from public.verification_submissions s where s.id = p_submission;
  if not found then
    return private.deny('invalid_state');
  end if;
  perform private.lock_verification_subject(v_user);
  if v_kind = 'age' then
    select s.id into v_sub
    from public.account_verifications v
    join public.verification_submissions s on s.id = v.age_submission_id
    where v.user_id = v_user and v.age_submission_id = p_submission
      and v.age_verified_at is not null and v.age_revoked_at is null and s.status = 'approved';
    if v_sub is null then
      return private.deny('invalid_state');
    end if;
    update public.account_verifications v set age_revoked_at = now() where v.user_id = v_user;
  else
    select s.id into v_sub
    from public.affiliations a
    join public.verification_submissions s on s.id = a.confirmed_by_submission
    where a.user_id = v_user and a.confirmed_by_submission = p_submission
      and a.status = 'confirmed' and s.status = 'approved';
    if v_sub is null then
      return private.deny('invalid_state');
    end if;
    update public.affiliations a
    set status = 'rejected', confirmed_until = null, confirmed_by_submission = null
    where a.user_id = v_user;
  end if;
  update public.verification_submissions s
  set status = 'revoked', reviewer_id = v_me, decided_at = now(), decision_reason = p_reason,
      version = s.version + 1
  where s.id = p_submission;
  perform private.audit(v_me, 'revoke_verification', 'verification_submission', p_submission::text,
                        jsonb_build_object('kind', v_kind));
  return private.ok(p_submission::text);
end $$;

revoke all on function public.admin_revoke_verification(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_revoke_verification(uuid, text) to authenticated;
