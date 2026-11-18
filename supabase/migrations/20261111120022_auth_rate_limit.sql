-- SEC-006 order 22 (SECREVIEW-001 M-1): app-side limits on sign-in attempts and TOTP codes.
-- Sign-in and TOTP verification reach Supabase Auth from the Next.js server, so Auth's own limits count the server's
-- IP and limit no single attacker. The app now reserves one attempt here before every Auth call and calls Auth only
-- on ok. Both limits reuse the existing rate mechanism (private.rate_policy, lock_rate, rate_ok, rate_record over
-- private.rate_limit_events):
--   'signin': per typed address. rate_limit_events.user_id has no foreign key, so the key is a uuid derived from
--             sha256(pepper || lower(btrim(email))), first 16 bytes. It depends only on the typed address, so an
--             unknown address and a real account get the same answers. The pepper keeps a plain email hash out of
--             the events. Every attempt is counted, successful sign-ins included.
--   'mfa':    per signed-in user (aal1 allowed: enrolment and the step-up both verify at aal1). No require_account,
--             so profileless staff still reach aal2.
-- No client IP: the hosting is not chosen and a forwarded-IP header cannot be trusted without it (before release).
-- Retention: service_purge_rate_limits deletes every rate_limit_events row older than 7 days whatever its action,
-- and both windows are shorter than that, so the purge covers the new events unchanged.

-- P4 values are provisional (docs/03_ARCHITECTURE.md §12 P4); every earlier action keeps its value.
-- create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
create or replace function private.rate_policy(p_action text, out max_count int, out window_length interval)
language plpgsql immutable set search_path = '' as $$
begin
  case p_action
    when 'request' then max_count := 20;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'report'  then max_count := 10;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'message' then max_count := 30;   window_length := interval '1 minute';
    when 'block'   then max_count := 20;   window_length := interval '1 day';
    when 'privacy' then max_count := 20;   window_length := interval '1 day';
    when 'photo'   then max_count := 10;   window_length := interval '10 minutes'; -- reserved uploads (decodes)
    when 'signin'  then max_count := 10;   window_length := interval '15 minutes'; -- per address key, successes included
    when 'mfa'     then max_count := 10;   window_length := interval '10 minutes'; -- per user, successes included
    else raise exception 'unknown rate action %', p_action;
  end case;
end $$;

revoke all on function private.rate_policy(text) from public, anon, authenticated, service_role;

-- 32 random bytes as 64 hex characters, from two v4 uuids (built in; no extension). Written once, never replaced.
-- private.app_settings is readable by no API role (order 5).
insert into private.app_settings (key, value)
values ('auth_rate_pepper', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- The rate key of a normalised address. Raises forbidden when the pepper is missing, so no unkeyed attempt is counted.
create function private.signin_rate_key(p_email text) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_pepper text;
begin
  select c.value into v_pepper from private.app_settings c where c.key = 'auth_rate_pepper';
  if v_pepper is null or length(v_pepper) < 64 or p_email is null then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return encode(substring(sha256(convert_to(v_pepper || p_email, 'UTF8')) from 1 for 16), 'hex')::uuid;
end $$;

revoke all on function private.signin_rate_key(text) from public, anon, authenticated, service_role;

-- E-1 only (service_role): one sign-in attempt for the typed address, before the server calls Auth.
-- Only ok is recorded; an empty or over-long address raises validation and records nothing.
create function public.service_reserve_signin(p_email text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_key   uuid;
begin
  if v_email is null or v_email = '' or char_length(v_email) > 320 then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  v_key := private.signin_rate_key(v_email);
  perform private.lock_rate(v_key, 'signin');
  if not private.rate_ok(v_key, 'signin') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_key, 'signin');
  return private.ok(null);
end $$;

revoke all on function public.service_reserve_signin(text) from public, anon, authenticated, service_role;
grant execute on function public.service_reserve_signin(text) to service_role;

-- §5.1: one TOTP verification attempt for the signed-in caller, before the server calls Auth's challenge and verify.
create function public.reserve_mfa_attempt()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_user();
begin
  perform private.lock_rate(v_me, 'mfa');
  if not private.rate_ok(v_me, 'mfa') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_me, 'mfa');
  return private.ok(null);
end $$;

revoke all on function public.reserve_mfa_attempt() from public, anon, authenticated, service_role;
grant execute on function public.reserve_mfa_attempt() to authenticated;
