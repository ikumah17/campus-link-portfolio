-- SEC-012 order 25 (SECREVIEW-001 M-1, docs/39 M-1): app-side limits on sign-up attempts.
-- Sign-up reaches Supabase Auth from the Next.js server, so Auth's own limits count the server's IP. Each sign-up
-- sends a confirmation email, so one client could flood one address or use up the project's email sending limit and
-- block real sign-ups. The app now reserves one attempt here before every auth.signUp and calls Auth only on ok.
--   'signup':    per typed address key, private.signin_rate_key(lower(btrim(email))) from order 22, unchanged.
--   'signup_ip': per client IP key, private.signin_ip_rate_key(ip) from order 24, unchanged (IPv4 host, IPv4-mapped
--                as IPv4, other IPv6 cut to /64). The app passes the IP only on Vercel, else null.
-- Both keys are the same uuids as sign-in's, but the actions keep separate counters from 'signin' and 'signin_ip'.
-- Every attempt is counted, including ones Auth later refuses or treats as an existing address; the key depends only
-- on the typed address, so an unknown address and a real account get the same answers.
-- One call: service_reserve_signup(p_email, p_ip default null) checks both limits under both locks and records both
-- or neither, as service_reserve_signin does.
-- Locks: always the address key first, then the IP key, so two attempts can never wait on each other in a cycle.
-- Retention: service_purge_rate_limits deletes every rate_limit_events row older than 7 days whatever its action, and
-- the 1-hour window is shorter than that, so the purge covers the new events unchanged.

-- P4 values are provisional (docs/03_ARCHITECTURE.md §12 P4); every earlier action keeps its value.
-- create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
create or replace function private.rate_policy(p_action text, out max_count int, out window_length interval)
language plpgsql immutable set search_path = '' as $$
begin
  case p_action
    when 'request'   then max_count := 20;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'report'    then max_count := 10;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'message'   then max_count := 30;   window_length := interval '1 minute';
    when 'block'     then max_count := 20;   window_length := interval '1 day';
    when 'privacy'   then max_count := 20;   window_length := interval '1 day';
    when 'photo'     then max_count := 10;   window_length := interval '10 minutes'; -- reserved uploads (decodes)
    when 'signin'    then max_count := 10;   window_length := interval '15 minutes'; -- per address key, successes included
    when 'mfa'       then max_count := 10;   window_length := interval '10 minutes'; -- per user, successes included
    when 'signin_ip' then max_count := 30;   window_length := interval '15 minutes'; -- per IP key, successes included
    when 'signup'    then max_count := 5;    window_length := interval '1 hour';     -- per address key, every attempt
    when 'signup_ip' then max_count := 10;   window_length := interval '1 hour';     -- per IP key, every attempt
    else raise exception 'unknown rate action %', p_action;
  end case;
end $$;

revoke all on function private.rate_policy(text) from public, anon, authenticated, service_role;

-- E-1 only (service_role): one sign-up attempt for the typed address and, when given, the client IP, before the server
-- calls Auth. Only ok is recorded, for both keys at once; an invalid address or IP raises validation and records nothing.
create function public.service_reserve_signup(p_email text, p_ip text default null)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_email  text := lower(btrim(p_email));
  v_key    uuid;
  v_ip_key uuid;
begin
  if v_email is null or v_email = '' or char_length(v_email) > 320 then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  v_key := private.signin_rate_key(v_email);
  if p_ip is not null then
    v_ip_key := private.signin_ip_rate_key(p_ip);
  end if;
  perform private.lock_rate(v_key, 'signup');
  if v_ip_key is not null then
    perform private.lock_rate(v_ip_key, 'signup_ip');
  end if;
  if not private.rate_ok(v_key, 'signup') then
    return private.deny('rate_limited');
  end if;
  if v_ip_key is not null and not private.rate_ok(v_ip_key, 'signup_ip') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_key, 'signup');
  if v_ip_key is not null then
    perform private.rate_record(v_ip_key, 'signup_ip');
  end if;
  return private.ok(null);
end $$;

revoke all on function public.service_reserve_signup(text, text) from public, anon, authenticated, service_role;
grant execute on function public.service_reserve_signup(text, text) to service_role;
