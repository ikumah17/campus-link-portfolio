-- BE-001 order 1: foundation (docs/04_DATABASE.md §1, §3.1, §4, §8, §12).
-- Requires the auth schema (Supabase, or the BE-001 test shim) to exist first.

create schema private;
revoke all on schema private from public;
-- RLS/storage policy expressions call two private self-check functions (§4).
grant usage on schema private to authenticated;

-- Supabase grants new public objects to the API roles by default (§1).
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;

-- §3.1 enums and the return type of state-changing public RPCs
create type public.discover_mode       as enum ('romance', 'friends');
create type public.account_status      as enum ('active', 'deactivated', 'suspended', 'deleted');
create type public.affiliation_status  as enum ('unconfirmed', 'pending', 'confirmed', 'rejected');
create type public.verification_kind   as enum ('age', 'enrollment');
create type public.verification_status as enum ('submitted', 'in_review', 'approved', 'rejected', 'withdrawn', 'revoked', 'superseded');
create type public.request_status      as enum ('pending', 'accepted', 'declined', 'cancelled', 'invalidated', 'expired');
create type public.connection_end      as enum ('unmatched', 'blocked', 'account_deleted');
create type public.report_context      as enum ('profile', 'request', 'message');
create type public.report_reason       as enum ('harassment', 'inappropriate_content', 'spam', 'impersonation', 'underage_suspected', 'other');
create type public.report_status       as enum ('open', 'triaged', 'actioned', 'dismissed');
create type public.staff_role          as enum ('reviewer', 'moderator', 'admin');
create type public.outcome_code        as enum ('ok', 'not_available', 'invalid_state', 'already_pending', 'already_connected', 'rate_limited');
create type public.rpc_outcome         as (ok boolean, code public.outcome_code, ref text);

-- rpc_outcome constructors (§5 two-way classification)
create function private.ok(p_ref text) returns public.rpc_outcome
language sql immutable set search_path = '' as $$
  select row(true, 'ok', p_ref)::public.rpc_outcome
$$;

create function private.deny(p_code public.outcome_code) returns public.rpc_outcome
language sql immutable set search_path = '' as $$
  select row(false, p_code, null)::public.rpc_outcome
$$;

-- §4 date helpers
create function private.today_jst() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Tokyo')::date
$$;

-- n-th birthday; Feb 29 births reach it on Mar 1 in common years (conservative, L1)
create function private.anniversary(p_birth date, p_years int) returns date
language sql immutable set search_path = '' as $$
  select case
    when extract(month from p_birth) = 2 and extract(day from p_birth) = 29
     and not (   (extract(year from p_birth)::int + p_years) % 400 = 0
              or ((extract(year from p_birth)::int + p_years) % 4 = 0
                  and (extract(year from p_birth)::int + p_years) % 100 <> 0))
    then make_date(extract(year from p_birth)::int + p_years, 3, 1)
    else (p_birth + make_interval(years => p_years))::date
  end
$$;

create function private.adult_from(p_birth date) returns date
language sql immutable set search_path = '' as $$ select private.anniversary(p_birth, 18) $$;

create function private.age_years(p_birth date, p_today date) returns int
language sql immutable set search_path = '' as $$
  select (extract(year from p_today)::int - extract(year from p_birth)::int)
       - case when private.anniversary(p_birth, extract(year from p_today)::int - extract(year from p_birth)::int) > p_today
              then 1 else 0 end
$$;

-- profiles.hobbies: at most 10 entries, each 1-20 characters
create function private.hobbies_ok(p_hobbies text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    cardinality(p_hobbies) <= 10
    and not exists (select 1 from unnest(p_hobbies) h where h is null or char_length(h) not between 1 and 20),
    false)
$$;

-- §4 current session check (r4, ARCH-R3-FINAL-01)
create function private.auth_account_ok(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.email_confirmed_at is not null and u.is_anonymous = false
                   from auth.users u where u.id = p_user), false)
$$;

create function private.session_uid() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.uid
  from (select auth.uid() as uid) s
  where s.uid is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and private.auth_account_ok(s.uid)
$$;

create function private.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.session_uid();
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return v_uid;
end $$;

-- §8 advisory locks (transaction scope). Order: rate -> staff_roles -> verification -> pair -> row.
create function private.lock_rate(p_user uuid, p_action text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_user::text || ':' || p_action, 0));
end $$;

create function private.lock_staff_roles(p_exclusive boolean) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('staff_roles', 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('staff_roles', 0));
  end if;
end $$;

create function private.lock_verification_subject(p_user uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('verification:' || p_user::text, 0));
end $$;

create function private.lock_pair(p_a uuid, p_b uuid, p_shared boolean) returns void
language plpgsql volatile set search_path = '' as $$
declare v_key bigint := hashtextextended('pair:' || least(p_a, p_b)::text || ':' || greatest(p_a, p_b)::text, 0);
begin
  if p_shared then
    perform pg_advisory_xact_lock_shared(v_key);
  else
    perform pg_advisory_xact_lock(v_key);
  end if;
end $$;

-- shared trigger functions
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function private.deny_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'audit_log is append-only';
end $$;

revoke all on function
  private.ok(text), private.deny(public.outcome_code), private.today_jst(),
  private.anniversary(date, int), private.adult_from(date), private.age_years(date, date),
  private.hobbies_ok(text[]), private.auth_account_ok(uuid), private.session_uid(),
  private.require_user(), private.lock_rate(uuid, text), private.lock_staff_roles(boolean),
  private.lock_verification_subject(uuid), private.lock_pair(uuid, uuid, boolean),
  private.set_updated_at(), private.deny_audit_change()
from public, anon, authenticated, service_role;
