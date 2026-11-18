-- BE-001 order 9: reports, blocks and report RPCs (docs/04_DATABASE.md §3.8, §5.5, §6, §7).

create table public.reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid references public.profiles(user_id) on delete set null,
  target_user_id uuid references public.profiles(user_id) on delete set null,
  context        public.report_context not null,
  request_id     uuid references public.connection_requests(id) on delete set null,
  message_id     bigint references public.messages(id) on delete set null,
  reason         public.report_reason not null,
  detail         text check (char_length(detail) <= 1000),
  status         public.report_status not null default 'open',
  created_at     timestamptz not null default now(),
  check (reporter_id <> target_user_id)
);

create table private.report_evidence (
  report_id          uuid primary key references public.reports(id) on delete cascade,
  conversation_id    uuid,
  message_body       text,
  message_created_at timestamptz,
  captured_at        timestamptz not null default now()
);

create table private.report_actions (
  id         bigint generated always as identity primary key,
  report_id  uuid not null references public.reports(id) on delete cascade,
  actor_id   uuid not null,
  action     text not null,
  note       text check (char_length(note) <= 1000),
  created_at timestamptz not null default now()
);

-- §7 report: open -> triaged -> actioned/dismissed, open -> dismissed (FK set-null updates keep the status)
create function private.report_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and (old.status::text || '>' || new.status::text) not in (
       'open>triaged', 'open>dismissed', 'triaged>actioned', 'triaged>dismissed') then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger reports_transition before update on public.reports
  for each row execute function private.report_transition();
revoke all on function private.report_transition() from public, anon, authenticated, service_role;

alter table public.reports          enable row level security;
alter table private.report_evidence enable row level security;
alter table private.report_actions  enable row level security;
revoke all on table public.reports, private.report_evidence, private.report_actions
  from public, anon, authenticated, service_role;
revoke all on sequence private.report_actions_id_seq from public, anon, authenticated, service_role;

-- r3 (ARCH-R2-02): the same single row and the same answer whatever the target is (exists, visible,
-- blocked the caller, ineligible). The name is kept only if the caller could see the identity at that moment.
create function public.block_user(p_target uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_target is null or p_target = v_me then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  perform private.lock_rate(v_me, 'block');
  if not private.rate_ok(v_me, 'block')
     or (select count(*) from public.blocks b where b.blocker_id = v_me) >= private.block_total_limit() then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_me, 'block');
  perform private.lock_pair(v_me, p_target, false);

  insert into public.blocks (blocker_id, blocked_id, blocked_name_snapshot)
  select v_me, p_target,
         case when private.can_see_identity(v_me, p_target)
              then (select p.display_name from public.profiles p where p.user_id = p_target) end
  on conflict (blocker_id, blocked_id) do nothing;

  perform private.expire_stale_requests(v_me, p_target);
  update public.connection_requests q set status = 'invalidated', closed_at = now()
  where q.status = 'pending'
    and least(q.requester_id, q.recipient_id) = least(v_me, p_target)
    and greatest(q.requester_id, q.recipient_id) = greatest(v_me, p_target);
  update public.connections k set ended_at = now(), ended_reason = 'blocked'
  where k.ended_at is null and k.user_low = least(v_me, p_target) and k.user_high = greatest(v_me, p_target);
  return private.ok(null);
end $$;

create function public.unblock_user(p_target uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_target is null or p_target = v_me then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  perform private.lock_pair(v_me, p_target, false);
  delete from public.blocks b where b.blocker_id = v_me and b.blocked_id = p_target;
  return private.ok(null);
end $$;

-- the only projection of blocks: the id the caller gave, the snapshot taken at block time, the time
create function public.list_my_blocks()
returns table(blocked_id uuid, blocked_name_snapshot text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select b.blocked_id, b.blocked_name_snapshot, b.created_at
    from public.blocks b
    where b.blocker_id = v_me
    order by b.created_at desc, b.blocked_id;
end $$;

create function public.submit_report(
  p_target     uuid,
  p_context    public.report_context,
  p_reason     public.report_reason,
  p_detail     text   default null,
  p_request_id uuid   default null,
  p_message_id bigint default null)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me       uuid := private.require_user();
  v_allowed  boolean;
  v_related  boolean;
  v_message  public.messages;
  v_id       uuid;
begin
  if p_target is null or p_target = v_me or p_context is null or p_reason is null
     or char_length(p_detail) > 1000
     or (p_context = 'profile' and (p_request_id is not null or p_message_id is not null))
     or (p_context = 'request' and (p_request_id is null or p_message_id is not null))
     or (p_context = 'message' and (p_message_id is null or p_request_id is not null)) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  perform private.lock_rate(v_me, 'report');
  v_allowed := private.rate_ok(v_me, 'report');
  perform private.rate_record(v_me, 'report');
  if not v_allowed then
    return private.deny('rate_limited');
  end if;

  if p_context = 'message' then
    select m.* into v_message
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.connections k on k.id = c.connection_id
    where m.id = p_message_id and m.sender_id = p_target
      and k.user_low = least(v_me, p_target) and k.user_high = greatest(v_me, p_target);
    v_related := found;
  elsif p_context = 'request' then
    v_related := exists (select 1 from public.connection_requests q
                         where q.id = p_request_id
                           and least(q.requester_id, q.recipient_id) = least(v_me, p_target)
                           and greatest(q.requester_id, q.recipient_id) = greatest(v_me, p_target));
  else
    v_related := exists (select 1 from public.connection_requests q
                         where least(q.requester_id, q.recipient_id) = least(v_me, p_target)
                           and greatest(q.requester_id, q.recipient_id) = greatest(v_me, p_target))
              or exists (select 1 from public.connections k
                         where k.user_low = least(v_me, p_target) and k.user_high = greatest(v_me, p_target))
              or private.pair_visible(v_me, p_target);
  end if;
  if not v_related then
    return private.deny('not_available');
  end if;

  insert into public.reports (reporter_id, target_user_id, context, request_id, message_id, reason, detail)
  values (v_me, p_target, p_context, p_request_id, p_message_id, p_reason, p_detail)
  returning id into v_id;
  if p_context = 'message' then
    insert into private.report_evidence (report_id, conversation_id, message_body, message_created_at)
    values (v_id, v_message.conversation_id, v_message.body, v_message.created_at);
  end if;
  return private.ok(v_id::text);
end $$;

create function public.my_reports()
returns table(id uuid, created_at timestamptz, status public.report_status)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select r.id, r.created_at, r.status
    from public.reports r
    where r.reporter_id = v_me
    order by r.created_at desc, r.id;
end $$;

revoke all on function
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.list_my_blocks(),
  public.submit_report(uuid, public.report_context, public.report_reason, text, uuid, bigint),
  public.my_reports()
from public, anon, authenticated, service_role;

grant execute on function
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.list_my_blocks(),
  public.submit_report(uuid, public.report_context, public.report_reason, text, uuid, bigint),
  public.my_reports()
to authenticated;
