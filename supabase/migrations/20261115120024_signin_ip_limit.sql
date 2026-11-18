-- SEC-008 order 24 (SECREVIEW-001 M-1, second half): a per-client-IP sign-in limit next to SEC-006's per-address one.
-- SEC-006 stops one address being tried many times but not one client trying many addresses (password spraying).
-- The app passes the client IP only when it runs on Vercel, whose edge overwrites x-forwarded-for / x-real-ip; anywhere
-- else it passes null and only the per-address limit applies.
--   'signin_ip': per IP key. The key is private.signin_rate_key('ip:' || normalised ip), the same peppered sha256 as the
--                address key (order 22), so no plain IP is ever stored. IPv4 is the host address; an IPv4-mapped IPv6
--                address counts as its IPv4 address; any other IPv6 address is cut to its /64, so one host cannot
--                rotate addresses inside its own prefix. Every attempt is counted, successful sign-ins included.
-- One call: service_reserve_signin(p_email, p_ip default null) checks both limits under both locks and records both
-- or neither, so a refusal by either limit records nothing for the other. A second RPC would need two calls, and the
-- first call's record could not be taken back when the second refused.
-- Locks: always the address key first, then the IP key, so two attempts can never wait on each other in a cycle.
-- Retention: service_purge_rate_limits deletes every rate_limit_events row older than 7 days whatever its action, and
-- the 15-minute window is shorter than that, so the purge covers the new events unchanged.

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
    else raise exception 'unknown rate action %', p_action;
  end case;
end $$;

revoke all on function private.rate_policy(text) from public, anon, authenticated, service_role;

-- The rate key of a client IP. A value that is not a single IPv4 or IPv6 host address raises validation; a missing
-- pepper raises forbidden (through signin_rate_key). Either way nothing is counted.
create function private.signin_ip_rate_key(p_ip text) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_ip inet;
begin
  if p_ip is null or char_length(p_ip) > 64 then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  begin
    v_ip := p_ip::inet;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'validation';
  end;
  if masklen(v_ip) <> (case family(v_ip) when 4 then 32 else 128 end) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if family(v_ip) = 6 and v_ip << '::ffff:0.0.0.0/96'::inet then
    v_ip := '0.0.0.0'::inet + (v_ip - '::ffff:0.0.0.0'::inet);
  end if;
  return private.signin_rate_key('ip:' || case family(v_ip)
    when 4 then host(v_ip)
    else network(set_masklen(v_ip, 64))::text
  end);
end $$;

revoke all on function private.signin_ip_rate_key(text) from public, anon, authenticated, service_role;

-- The one-argument form from order 22 is replaced, not overloaded: an overload with a defaulted second argument would
-- make a call with p_email alone ambiguous.
drop function public.service_reserve_signin(text);

-- E-1 only (service_role): one sign-in attempt for the typed address and, when given, the client IP, before the server
-- calls Auth. Only ok is recorded, for both keys at once; an invalid address or IP raises validation and records nothing.
create function public.service_reserve_signin(p_email text, p_ip text default null)
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
  perform private.lock_rate(v_key, 'signin');
  if v_ip_key is not null then
    perform private.lock_rate(v_ip_key, 'signin_ip');
  end if;
  if not private.rate_ok(v_key, 'signin') then
    return private.deny('rate_limited');
  end if;
  if v_ip_key is not null and not private.rate_ok(v_ip_key, 'signin_ip') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_key, 'signin');
  if v_ip_key is not null then
    perform private.rate_record(v_ip_key, 'signin_ip');
  end if;
  return private.ok(null);
end $$;

revoke all on function public.service_reserve_signin(text, text) from public, anon, authenticated, service_role;
grant execute on function public.service_reserve_signin(text, text) to service_role;
