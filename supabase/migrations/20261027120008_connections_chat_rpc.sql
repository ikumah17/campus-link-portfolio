-- BE-001 order 8: request, connection and chat RPCs (docs/04_DATABASE.md §5, §5.3, §5.4, §8).
-- Business rejections return rpc_outcome and commit; only forbidden/validation raise, before any write.

create function private.expire_stale_requests(p_a uuid, p_b uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.connection_requests q
  set status = 'expired', closed_at = q.expires_at
  where q.status = 'pending' and q.expires_at <= now()
    and least(q.requester_id, q.recipient_id) = least(p_a, p_b)
    and greatest(q.requester_id, q.recipient_id) = greatest(p_a, p_b)
$$;
revoke all on function private.expire_stale_requests(uuid, uuid) from public, anon, authenticated, service_role;

create function public.send_connection_request(p_target uuid, p_mode public.discover_mode, p_message text default null)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := private.require_user();
  v_allowed boolean;
  v_last    public.connection_requests;
  v_id      uuid;
begin
  if p_target is null or p_mode is null or p_target = v_me or char_length(p_message) > 200 then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  -- (1) every attempt is recorded under the user x action lock, whatever the target
  perform private.lock_rate(v_me, 'request');
  v_allowed := private.rate_ok(v_me, 'request');
  perform private.rate_record(v_me, 'request');
  if not v_allowed then
    return private.deny('rate_limited');
  end if;
  -- (2) pair lock, (3) settle expired pending requests of the pair at closed_at = expires_at
  perform private.lock_pair(v_me, p_target, false);
  perform private.expire_stale_requests(v_me, p_target);
  -- (4) not visible, missing, blocked either way or ineligible: one indistinguishable answer
  if not private.can_view_profile(v_me, p_target, p_mode) then
    return private.deny('not_available');
  end if;
  -- (5)
  if private.has_active_connection(v_me, p_target) then
    return private.deny('already_connected');
  end if;
  if exists (select 1 from public.connection_requests q
             where q.status = 'pending'
               and least(q.requester_id, q.recipient_id) = least(v_me, p_target)
               and greatest(q.requester_id, q.recipient_id) = greatest(v_me, p_target)) then
    return private.deny('already_pending');
  end if;
  -- (6) same wait for every non-accepted end; its end point depends on closed_at only
  select * into v_last from public.connection_requests q
  where q.requester_id = v_me and q.recipient_id = p_target
  order by q.created_at desc, q.id desc
  limit 1;
  if found and v_last.status <> 'accepted' and v_last.closed_at + private.request_retry_wait() > now() then
    return private.deny('rate_limited');
  end if;
  -- (7)
  insert into public.connection_requests (requester_id, recipient_id, mode, message)
  values (v_me, p_target, p_mode, p_message)
  returning id into v_id;
  return private.ok(v_id::text);
end $$;

create function public.respond_connection_request(p_request uuid, p_accept boolean)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_user();
  v_req  public.connection_requests;
  v_conn uuid;
begin
  if p_request is null or p_accept is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  -- §5 account restriction on the actor, before the expiry settlement and either answer (BE-FINAL-01)
  perform private.require_account(v_me, false);
  select * into v_req from public.connection_requests q where q.id = p_request;
  if not found or v_req.recipient_id <> v_me then
    return private.deny('not_available');
  end if;
  perform private.lock_pair(v_req.requester_id, v_req.recipient_id, false);
  select * into v_req from public.connection_requests q where q.id = p_request for update;
  if not found then
    return private.deny('not_available');
  end if;
  if v_req.status = 'pending' and v_req.expires_at <= now() then
    update public.connection_requests q set status = 'expired', closed_at = q.expires_at where q.id = p_request;
    return private.deny('invalid_state');
  end if;
  if v_req.status <> 'pending' then
    return private.deny('invalid_state');
  end if;
  if not p_accept then
    update public.connection_requests q set status = 'declined', closed_at = now() where q.id = p_request;
    return private.ok(p_request::text);
  end if;
  -- visibility is re-evaluated at acceptance; the invalidation commits with the rejection (ARCH-R2-04)
  if not private.can_view_profile(v_me, v_req.requester_id, v_req.mode) then
    update public.connection_requests q set status = 'invalidated', closed_at = now() where q.id = p_request;
    return private.deny('not_available');
  end if;
  if private.has_active_connection(v_req.requester_id, v_req.recipient_id) then
    return private.deny('invalid_state');
  end if;
  update public.connection_requests q set status = 'accepted', closed_at = now() where q.id = p_request;
  insert into public.connections (user_low, user_high, origin_request_id, mode)
  values (least(v_req.requester_id, v_req.recipient_id), greatest(v_req.requester_id, v_req.recipient_id),
          p_request, v_req.mode)
  returning id into v_conn;
  insert into public.conversations (connection_id) values (v_conn);
  return private.ok(v_conn::text);
end $$;

create function public.cancel_connection_request(p_request uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_user();
  v_req public.connection_requests;
begin
  if p_request is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  select * into v_req from public.connection_requests q where q.id = p_request;
  if not found or v_req.requester_id <> v_me then
    return private.deny('not_available');
  end if;
  perform private.lock_pair(v_req.requester_id, v_req.recipient_id, false);
  select * into v_req from public.connection_requests q where q.id = p_request for update;
  if not found then
    return private.deny('not_available');
  end if;
  if v_req.status = 'pending' and v_req.expires_at <= now() then
    update public.connection_requests q set status = 'expired', closed_at = q.expires_at where q.id = p_request;
    return private.deny('invalid_state');
  end if;
  if v_req.status <> 'pending' then
    return private.deny('invalid_state');
  end if;
  update public.connection_requests q set status = 'cancelled', closed_at = now() where q.id = p_request;
  return private.ok(p_request::text);
end $$;

create function public.end_connection(p_connection uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_user();
  v_conn public.connections;
begin
  if p_connection is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  select * into v_conn from public.connections k where k.id = p_connection;
  if not found or v_me not in (v_conn.user_low, v_conn.user_high) then
    return private.deny('not_available');
  end if;
  perform private.lock_pair(v_conn.user_low, v_conn.user_high, false);
  select * into v_conn from public.connections k where k.id = p_connection for update;
  if not found then
    return private.deny('not_available');
  end if;
  if v_conn.ended_at is not null then
    return private.deny('invalid_state');
  end if;
  update public.connections k set ended_at = now(), ended_reason = 'unmatched' where k.id = p_connection;
  return private.ok(p_connection::text);
end $$;

-- received: pending, unexpired and currently viewable only. sent: two-valued status, profile only when viewable.
create function public.list_my_requests()
returns table(
  request_id     uuid,
  direction      text,
  mode           public.discover_mode,
  message        text,
  status         text,
  created_at     timestamptz,
  counterpart_id uuid,
  counterpart    public.profile_view)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select q.id, 'received'::text, q.mode, q.message, 'pending'::text, q.created_at, q.requester_id,
           private.profile_view_of(q.requester_id, q.mode)
    from public.connection_requests q
    where q.recipient_id = v_me and q.status = 'pending' and q.expires_at > now()
      and private.can_view_profile(v_me, q.requester_id, q.mode)
    union all
    select q.id, 'sent'::text, q.mode, q.message,
           case when q.status = 'pending' and q.expires_at > now() then 'pending' else 'closed' end,
           q.created_at, q.recipient_id,
           case when private.can_view_profile(v_me, q.recipient_id, q.mode)
                then private.profile_view_of(q.recipient_id, q.mode) end
    from public.connection_requests q
    where q.requester_id = v_me
    order by 6 desc, 1;
end $$;

create function public.list_my_conversations()
returns table(
  conversation_id      uuid,
  connection_id        uuid,
  counterpart_id       uuid,
  counterpart_name     text,
  counterpart_photo_id uuid,
  last_message_id      bigint,
  last_message_body    text,
  last_message_at      timestamptz,
  last_message_mine    boolean,
  unread               boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select c.id, k.id, o.other, p.display_name,
           (select ph.id from public.profile_photos ph
            where ph.user_id = o.other and ph.status = 'active' order by ph.position limit 1),
           m.id, m.body, m.created_at, m.sender_id = v_me,
           -- unread: any incoming message above the read cursor, independent of the preview (BE-FINAL-02)
           exists (select 1 from public.messages u
                   where u.conversation_id = c.id and u.sender_id <> v_me
                     and u.id > coalesce(cr.last_read_message_id, 0))
    from public.connections k
    join public.conversations c on c.connection_id = k.id
    cross join lateral (select case when k.user_low = v_me then k.user_high else k.user_low end as other) o
    join public.profiles p on p.user_id = o.other
    left join lateral (select x.id, x.body, x.created_at, x.sender_id from public.messages x
                       where x.conversation_id = c.id order by x.id desc limit 1) m on true
    left join public.conversation_reads cr on cr.conversation_id = c.id and cr.user_id = v_me
    where k.ended_at is null and v_me in (k.user_low, k.user_high)
      and private.can_access_conversation(v_me, c.id)
    order by coalesce(m.created_at, c.created_at) desc, c.id;
end $$;

create function public.list_messages(p_conversation uuid, p_before bigint default null, p_limit int default 50)
returns table(id bigint, sender_id uuid, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_me    uuid := private.require_user();
  v_limit int  := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if p_conversation is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not private.can_access_conversation(v_me, p_conversation) then
    return;
  end if;
  return query
    select m.id, m.sender_id, m.body, m.created_at
    from public.messages m
    where m.conversation_id = p_conversation and (p_before is null or m.id < p_before)
    order by m.id desc
    limit v_limit;
end $$;

create function public.send_message(p_conversation uuid, p_client_msg_id uuid, p_body text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me       uuid := private.require_user();
  v_low      uuid;
  v_high     uuid;
  v_existing public.messages;
  v_id       bigint;
begin
  if p_conversation is null or p_client_msg_id is null or p_body is null
     or char_length(p_body) not between 1 and 2000 or p_body ~ '^\s*$' then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.lock_rate(v_me, 'message');
  select k.user_low, k.user_high into v_low, v_high
  from public.conversations c join public.connections k on k.id = c.connection_id
  where c.id = p_conversation;
  if not found then
    return private.deny('not_available');
  end if;
  perform private.lock_pair(v_low, v_high, true);
  if not private.can_access_conversation(v_me, p_conversation) then
    return private.deny('not_available');
  end if;
  select * into v_existing from public.messages m where m.sender_id = v_me and m.client_msg_id = p_client_msg_id;
  if found then
    if v_existing.conversation_id <> p_conversation then
      return private.deny('invalid_state');
    end if;
    return private.ok(v_existing.id::text);   -- resend: same row, no duplicate
  end if;
  if not private.rate_ok(v_me, 'message') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_me, 'message');
  insert into public.messages (conversation_id, sender_id, client_msg_id, body)
  values (p_conversation, v_me, p_client_msg_id, p_body)
  returning id into v_id;
  return private.ok(v_id::text);
end $$;

create function public.mark_read(p_conversation uuid, p_message_id bigint)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_conversation is null or p_message_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not private.can_access_conversation(v_me, p_conversation)
     or not exists (select 1 from public.messages m where m.id = p_message_id and m.conversation_id = p_conversation) then
    return private.deny('not_available');
  end if;
  insert into public.conversation_reads as r (conversation_id, user_id, last_read_message_id)
  values (p_conversation, v_me, p_message_id)
  on conflict (conversation_id, user_id) do update
    set last_read_message_id = greatest(coalesce(r.last_read_message_id, 0), excluded.last_read_message_id);
  return private.ok(null);
end $$;

revoke all on function
  public.send_connection_request(uuid, public.discover_mode, text),
  public.respond_connection_request(uuid, boolean),
  public.cancel_connection_request(uuid),
  public.end_connection(uuid),
  public.list_my_requests(),
  public.list_my_conversations(),
  public.list_messages(uuid, bigint, int),
  public.send_message(uuid, uuid, text),
  public.mark_read(uuid, bigint)
from public, anon, authenticated, service_role;

grant execute on function
  public.send_connection_request(uuid, public.discover_mode, text),
  public.respond_connection_request(uuid, boolean),
  public.cancel_connection_request(uuid),
  public.end_connection(uuid),
  public.list_my_requests(),
  public.list_my_conversations(),
  public.list_messages(uuid, bigint, int),
  public.send_message(uuid, uuid, text),
  public.mark_read(uuid, bigint)
to authenticated;
