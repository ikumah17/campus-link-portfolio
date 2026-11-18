-- ACCOUNT-003 order 17: a deleted account is no longer a signed-in caller anywhere in the database.
-- A deleted account keeps its Auth user until the retention sweep, so a token issued before deletion (or minted
-- afterwards with the public key) still reaches PostgREST and Realtime. Every caller-acting path takes the caller
-- from private.session_uid() (require_user, require_staff, the messages/Realtime and storage self-checks) or from
-- auth.uid() in the own-row policies; both now refuse an explicit 'deleted' profile. Staff without a profile and
-- active, deactivated and suspended accounts are unchanged. my_account keeps answering 'deleted' (the app's gates
-- read it). Service-role maintenance (scripts/maintenance/retention.mjs) never uses these checks.

-- The signed-in caller before the deleted check (the former session_uid body): only my_account uses it.
create function private.session_uid_any_status() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.uid
  from (select auth.uid() as uid) s
  where s.uid is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and private.auth_account_ok(s.uid)
$$;

create or replace function private.session_uid() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.uid
  from (select private.session_uid_any_status() as uid) s
  where s.uid is not null
    and not exists (select 1 from public.profiles p where p.user_id = s.uid and p.account_status = 'deleted')
$$;

-- §6 own-row policies: auth.uid() as before, or null for a deleted account.
create function private.rls_own_uid() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.uid
  from (select auth.uid() as uid) s
  where not exists (select 1 from public.profiles p where p.user_id = s.uid and p.account_status = 'deleted')
$$;

revoke all on function private.session_uid_any_status(), private.rls_own_uid()
from public, anon, authenticated, service_role;
grant execute on function private.rls_own_uid() to authenticated;

alter policy profiles_own on public.profiles using (user_id = (select private.rls_own_uid()));
alter policy profile_modes_own on public.profile_modes using (user_id = (select private.rls_own_uid()));
alter policy profile_photos_own on public.profile_photos using (user_id = (select private.rls_own_uid()));
alter policy account_verifications_own on public.account_verifications using (user_id = (select private.rls_own_uid()));
alter policy affiliations_own on public.affiliations using (user_id = (select private.rls_own_uid()));
alter policy privacy_settings_own on public.privacy_settings using (user_id = (select private.rls_own_uid()));
alter policy hidden_affiliations_own on public.hidden_affiliations using (user_id = (select private.rls_own_uid()));
alter policy verification_submissions_own on public.verification_submissions using (user_id = (select private.rls_own_uid()));
alter policy conversation_reads_own on public.conversation_reads using (user_id = (select private.rls_own_uid()));

-- §5.2 my_account: unchanged columns and rows, but it takes the caller before the deleted check, so a deleted
-- account still reads exactly one row with account_status 'deleted' (never "no profile").
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
