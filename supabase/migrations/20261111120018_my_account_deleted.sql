-- ACCOUNT-004 order 18: my_account tells a deleted account only that it is deleted.
-- After order 17 a deleted caller still read its full my_account row (birth_date, verification, affiliation, photo,
-- mode and eligibility) with a token from before the deletion, until the retention sweep purges the Auth user. The
-- app's gates only need account_status 'deleted' from it. A deleted caller now gets exactly one row: its own id,
-- has_profile true, 'deleted', and null or false everywhere else. Every other caller (no profile, staff without a
-- profile, active, deactivated, suspended) gets the order 17 row unchanged. Signature, columns, security definer,
-- search_path and grants are unchanged (create or replace keeps the ACL).

-- §5.2 my_account. The function is stable, so the deleted check and the row query see the same snapshot.
create or replace function public.my_account()
returns table(
  user_id               uuid,
  has_profile           boolean,
  account_status        public.account_status,
  profile_completed     boolean,
  age_verified          boolean,
  adult                 boolean,
  affiliation_status    public.affiliation_status,
  affiliation_confirmed boolean,
  has_active_photo      boolean,
  has_mode              boolean,
  eligible              boolean,
  birth_date            date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.session_uid_any_status();
begin
  if v_me is null then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if exists (select 1 from public.profiles p where p.user_id = v_me and p.account_status = 'deleted') then
    return query
      select v_me, true, 'deleted'::public.account_status, false, false, false,
             null::public.affiliation_status, false, false, false, false, null::date;
    return;
  end if;
  return query
    select v_me,
           p.user_id is not null,
           p.account_status,
           coalesce(p.profile_completed_at is not null, false),
           coalesce(v.age_verified_at is not null and v.age_revoked_at is null, false),
           coalesce(private.adult_from(u.birth_date) <= private.today_jst(), false),
           a.status,
           coalesce(a.status = 'confirmed' and a.confirmed_until > now(), false),
           exists (select 1 from public.profile_photos ph where ph.user_id = v_me and ph.status = 'active'),
           exists (select 1 from public.profile_modes m where m.user_id = v_me),
           private.is_eligible(v_me),
           u.birth_date
    from (select 1) one
    left join public.profiles p              on p.user_id = v_me
    left join private.user_private u         on u.user_id = v_me
    left join public.account_verifications v on v.user_id = v_me
    left join public.affiliations a          on a.user_id = v_me;
end $$;
