-- SEC-004 order 21 (SECREVIEW-001 M-2): a per-user limit on photo uploads, counted before the image is decoded.
-- uploadPhoto decodes up to 8 MB and 40 megapixels with sharp, stores the result and only then registers it, so a
-- signed-in caller could repeat that without bound. The app now calls public.reserve_photo_upload after its session
-- and account checks and decodes only on ok. The limit reuses the existing rate mechanism (private.rate_policy,
-- lock_rate, rate_ok, rate_record over private.rate_limit_events) under the new action 'photo'.
-- Only successful reservations are recorded, so the count is the number of decodes the caller was allowed.
-- The caller is refused exactly as service_register_photo refuses a user: private.require_user (no session,
-- anonymous, unconfirmed or deleted caller) and private.require_account(caller, true) (no profile, suspended or
-- deleted; deactivated is allowed, as for registration).
-- Retention: service_purge_rate_limits deletes every rate_limit_events row older than 7 days whatever its action, and
-- the 10-minute window is shorter than that, so the purge covers the new events unchanged.

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
    else raise exception 'unknown rate action %', p_action;
  end case;
end $$;

revoke all on function private.rate_policy(text) from public, anon, authenticated, service_role;

-- §5.2: one upload reservation for the signed-in caller; called before the server decodes the image.
create function public.reserve_photo_upload()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_user();
begin
  perform private.require_account(v_me, true);
  perform private.lock_rate(v_me, 'photo');
  if not private.rate_ok(v_me, 'photo') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_me, 'photo');
  return private.ok(null);
end $$;

revoke all on function public.reserve_photo_upload() from public, anon, authenticated, service_role;
grant execute on function public.reserve_photo_upload() to authenticated;
