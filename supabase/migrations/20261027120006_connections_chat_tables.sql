-- BE-001 order 6: requests, connections, conversations, messages (tables only; RPCs in order 8)
-- (docs/04_DATABASE.md §3.6, §3.7, §6, §7).

create table public.connection_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  recipient_id uuid not null references public.profiles(user_id) on delete cascade,
  mode         public.discover_mode not null,
  message      text check (char_length(message) <= 200),
  status       public.request_status not null default 'pending',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',   -- P4
  closed_at    timestamptz,
  check (requester_id <> recipient_id),
  check ((status = 'pending') = (closed_at is null)),
  check (status <> 'expired' or closed_at = expires_at),
  check (closed_at is null or closed_at <= expires_at)
);
create unique index one_pending_per_pair on public.connection_requests
  (least(requester_id, recipient_id), greatest(requester_id, recipient_id)) where status = 'pending';
create index on public.connection_requests (recipient_id, status);
create index on public.connection_requests (requester_id, status);

create table public.connections (
  id                uuid primary key default gen_random_uuid(),
  user_low          uuid not null references public.profiles(user_id) on delete cascade,
  user_high         uuid not null references public.profiles(user_id) on delete cascade,
  origin_request_id uuid not null unique references public.connection_requests(id) on delete cascade,
  mode              public.discover_mode not null,
  created_at        timestamptz not null default now(),
  ended_at          timestamptz,
  ended_reason      public.connection_end,
  check (user_low < user_high),
  check ((ended_at is null) = (ended_reason is null))
);
create unique index one_active_connection_per_pair
  on public.connections (user_low, user_high) where ended_at is null;

create table public.conversations (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references public.connections(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.profiles(user_id) on delete cascade,
  client_msg_id   uuid not null,
  body            text not null check (char_length(body) between 1 and 2000 and body !~ '^\s*$'),
  created_at      timestamptz not null default now(),
  unique (sender_id, client_msg_id)
);
create index on public.messages (conversation_id, id desc);

create table public.conversation_reads (
  conversation_id      uuid not null references public.conversations(id) on delete cascade,
  user_id              uuid not null references public.profiles(user_id) on delete cascade,
  last_read_message_id bigint,
  primary key (conversation_id, user_id)
);

-- §7 request: pending -> accepted/declined/cancelled/invalidated/expired; terminal states never change
create function private.request_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' or new.status = 'pending'
     or (new.id, new.requester_id, new.recipient_id, new.mode, new.message, new.created_at, new.expires_at)
        is distinct from (old.id, old.requester_id, old.recipient_id, old.mode, old.message, old.created_at, old.expires_at)
     or (new.status = 'expired' and old.expires_at > now()) then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger connection_requests_transition before update on public.connection_requests
  for each row execute function private.request_transition();

-- §7 connection: active -> ended (unmatched/blocked/account_deleted); an ended connection never returns
create function private.connection_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.ended_at is not null or new.ended_at is null
     or (new.id, new.user_low, new.user_high, new.origin_request_id, new.mode, new.created_at)
        is distinct from (old.id, old.user_low, old.user_high, old.origin_request_id, old.mode, old.created_at) then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger connections_transition before update on public.connections
  for each row execute function private.connection_transition();

revoke all on function private.request_transition(), private.connection_transition()
from public, anon, authenticated, service_role;

alter table public.connection_requests enable row level security;
alter table public.connections         enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.conversation_reads  enable row level security;

revoke all on table public.connection_requests, public.connections, public.conversations,
  public.messages, public.conversation_reads
from public, anon, authenticated, service_role;
revoke all on sequence public.messages_id_seq from public, anon, authenticated, service_role;

-- messages: SELECT grant and the member policy come with the visibility functions (order 7)
grant select on table public.conversation_reads to authenticated;
create policy conversation_reads_own on public.conversation_reads for select to authenticated
  using (user_id = (select auth.uid()));
