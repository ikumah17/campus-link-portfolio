-- MOD-001 order 33: a moderator at aal2 takes the content a report points at out of view (docs/40 §1.3(c), §1.4).
-- Until now the only action from a report was suspending the whole account (admin_set_account_status). Article 12(1)
-- of the 出会い系サイト規制法 asks the operator to make a prohibited solicitation unviewable promptly; this adds a
-- proportionate action per item. The content kinds and how each one leaves every participant read path:
--   message:         public.messages.body is overwritten with a fixed placeholder and the original moves to
--                    private.hidden_messages. Participants read messages through list_messages,
--                    list_my_conversations, the messages_member policy and Realtime (order 12, replica identity
--                    default, so an UPDATE carries only the new row). All four read the stored body, so none of them
--                    can return the original. list_messages also returns a hidden flag for the placeholder UI.
--   request_message: public.connection_requests.message stays (private.request_transition refuses any change of it)
--                    and private.hidden_request_messages names the request. Participants read a request message only
--                    through list_my_requests (connection_requests has no grant), which now returns null and a
--                    message_hidden flag for a hidden one.
--   bio_romance / bio_friends: the bio moves to private.hidden_bios and the profiles column becomes null. A bio is
--                    shown only through private.profile_view_of (discover_profiles, get_profile, list_my_requests), so
--                    it disappears everywhere at once; the owner's next update_profile with a bio shows that new one.
--   photo:           the photo becomes 'removed', as remove_photo does, even when it is the owner's last active photo
--                    (then private.is_eligible is false until the owner uploads another, so the profile leaves
--                    discovery, profiles, requests and chats). Order 28 sweeps its object after 24 hours, so there is
--                    no undo.
-- Only a moderator (private.require_staff('moderator'): aal2 and an effective role; reviewer or admin alone is
-- refused) who is not a party to the report may act, and only on the content of that report authored by its target:
-- the message itself (submit_report already requires sender = target), the request if the target sent it, the
-- target's bios and active photos. Undo exists for message and request_message only (mistake recovery).
-- Every hide, undo and content view writes private.audit with the report, the item and the moderator. The original
-- text stays in the private tables and in private.report_evidence (taken at report time, never changed here). No
-- participant read path says who hid an item or when.
-- Retention: the private rows cascade with the message, request or profile they hide, so the existing account
-- deletion and retention remove them with the content. Unchanged: submit_report and the other report RPCs, report
-- statuses, admin_set_account_status, the retention candidates and every other read path.

create table private.hidden_messages (
  message_id    bigint primary key references public.messages(id) on delete cascade,
  original_body text not null,
  report_id     uuid not null references public.reports(id),
  hidden_by     uuid not null,
  hidden_at     timestamptz not null default now()
);

create table private.hidden_request_messages (
  request_id uuid primary key references public.connection_requests(id) on delete cascade,
  report_id  uuid not null references public.reports(id),
  hidden_by  uuid not null,
  hidden_at  timestamptz not null default now()
);

-- one row per hide; the owner may write a new bio that is hidden again later
create table private.hidden_bios (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(user_id) on delete cascade,
  mode          public.discover_mode not null,
  original_text text not null,
  report_id     uuid not null references public.reports(id),
  hidden_by     uuid not null,
  hidden_at     timestamptz not null default now()
);
create index on private.hidden_bios (user_id, mode, hidden_at desc);
create index on private.hidden_messages (report_id);
create index on private.hidden_request_messages (report_id);
create index on private.hidden_bios (report_id);

alter table private.hidden_messages         enable row level security;
alter table private.hidden_request_messages enable row level security;
alter table private.hidden_bios             enable row level security;
revoke all on table private.hidden_messages, private.hidden_request_messages, private.hidden_bios
  from public, anon, authenticated, service_role;
revoke all on sequence private.hidden_bios_id_seq from public, anon, authenticated, service_role;

-- What the report points at, for the report detail. One row per item:
--   message (context message), request_message (context request, only a non-empty message the target sent),
--   bio_romance / bio_friends (context profile, a bio that is shown or hidden), photo (context profile, each active
--   photo in position order). body is the original text for messages and request messages (hidden or not) and the
--   bio shown now (null when hidden); hidden_at is the latest hide.
create function public.admin_get_report_content(p_id uuid)
returns table(
  item           text,
  ref            text,
  photo_position int,
  body           text,
  hidden         boolean,
  hidden_at      timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_me  uuid := private.require_staff('moderator');
  v_rep public.reports;
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select * into v_rep from public.reports r
  where r.id = p_id and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me;
  if not found then
    return;
  end if;
  perform private.audit(v_me, 'view_report_content', 'report', p_id::text, null);
  if v_rep.context = 'message' then
    return query
      select 'message'::text, m.id::text, null::int, coalesce(h.original_body, m.body), h.message_id is not null,
             h.hidden_at
      from public.messages m
      left join private.hidden_messages h on h.message_id = m.id
      where m.id = v_rep.message_id and m.sender_id = v_rep.target_user_id;
  elsif v_rep.context = 'request' then
    return query
      select 'request_message'::text, q.id::text, null::int, q.message, h.request_id is not null, h.hidden_at
      from public.connection_requests q
      left join private.hidden_request_messages h on h.request_id = q.id
      where q.id = v_rep.request_id and q.requester_id = v_rep.target_user_id and q.message is not null;
  else
    return query
      select x.item, null::text, null::int, x.body, x.body is null, x.hidden_at
      from public.profiles p
      cross join lateral (values ('bio_romance'::text, 'romance'::public.discover_mode, p.bio_romance),
                                 ('bio_friends', 'friends', p.bio_friends)) as b(item, mode, bio)
      cross join lateral (select b.item, b.bio as body,
                                 (select max(h.hidden_at) from private.hidden_bios h
                                  where h.user_id = p.user_id and h.mode = b.mode) as hidden_at) x
      where p.user_id = v_rep.target_user_id and (x.body is not null or x.hidden_at is not null)
      union all
      select 'photo', ph.id::text, ph.position::int, null::text, false, null::timestamptz
      from public.profile_photos ph
      where ph.user_id = v_rep.target_user_id and ph.status = 'active'
      order by 1, 3;
  end if;
end $$;

-- Per-request authorization for the report detail's photo route: one active photo of a profile report's target.
create function public.admin_authorize_report_photo(p_id uuid, p_photo uuid)
returns table(photo_id uuid, storage_path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_staff('moderator');
begin
  if p_id is null or p_photo is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not exists (select 1 from public.reports r
                 join public.profile_photos ph on ph.user_id = r.target_user_id
                 where r.id = p_id and r.context = 'profile' and ph.id = p_photo and ph.status = 'active'
                   and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me) then
    return;
  end if;
  perform private.audit(v_me, 'view_report_photo', 'report', p_id::text, jsonb_build_object('photo', p_photo));
  return query
    select ph.id, ph.storage_path from public.profile_photos ph where ph.id = p_photo;
end $$;

-- p_item: message | request_message | bio_romance | bio_friends | photo (p_photo only for photo).
-- not_available: no such report for this moderator, the item does not fit the report's context, or the content is
-- gone. invalid_state: already hidden, or nothing to hide (an empty bio, a removed photo).
create function public.admin_hide_reported_content(p_id uuid, p_item text, p_photo uuid default null)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_staff('moderator');
  v_rep  public.reports;
  v_body text;
  v_mode public.discover_mode;
  v_ref  text;
begin
  if p_id is null or p_item is null
     or p_item not in ('message', 'request_message', 'bio_romance', 'bio_friends', 'photo')
     or (p_item = 'photo') <> (p_photo is not null) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select * into v_rep from public.reports r
  where r.id = p_id and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me;
  if not found or v_rep.target_user_id is null
     -- parenthesized: a bare case would end the if condition at its first then
     or v_rep.context <> (case p_item when 'message' then 'message' when 'request_message' then 'request'
                                      else 'profile' end)::public.report_context then
    return private.deny('not_available');
  end if;

  if p_item = 'message' then
    select m.body into v_body from public.messages m
    where m.id = v_rep.message_id and m.sender_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    if exists (select 1 from private.hidden_messages h where h.message_id = v_rep.message_id) then
      return private.deny('invalid_state');
    end if;
    insert into private.hidden_messages (message_id, original_body, report_id, hidden_by)
    values (v_rep.message_id, v_body, p_id, v_me);
    update public.messages m set body = 'この発言は運営により非表示になりました。' where m.id = v_rep.message_id;
    v_ref := v_rep.message_id::text;

  elsif p_item = 'request_message' then
    select q.message into v_body from public.connection_requests q
    where q.id = v_rep.request_id and q.requester_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    if v_body is null
       or exists (select 1 from private.hidden_request_messages h where h.request_id = v_rep.request_id) then
      return private.deny('invalid_state');
    end if;
    insert into private.hidden_request_messages (request_id, report_id, hidden_by) values (v_rep.request_id, p_id, v_me);
    v_ref := v_rep.request_id::text;

  elsif p_item in ('bio_romance', 'bio_friends') then
    v_mode := case p_item when 'bio_romance' then 'romance' else 'friends' end;
    -- the row lock serializes with update_profile, which writes both bios in one update
    select case v_mode when 'romance' then p.bio_romance else p.bio_friends end into v_body
    from public.profiles p where p.user_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    if v_body is null then
      return private.deny('invalid_state');
    end if;
    insert into private.hidden_bios (user_id, mode, original_text, report_id, hidden_by)
    values (v_rep.target_user_id, v_mode, v_body, p_id, v_me);
    if v_mode = 'romance' then
      update public.profiles p set bio_romance = null where p.user_id = v_rep.target_user_id;
    else
      update public.profiles p set bio_friends = null where p.user_id = v_rep.target_user_id;
    end if;

  else
    -- the owner's profile row first, as remove_photo and reorder_photos lock it, then the photo
    perform 1 from public.profiles p where p.user_id = v_rep.target_user_id for update;
    select ph.status into v_body from public.profile_photos ph
    where ph.id = p_photo and ph.user_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    if v_body <> 'active' then
      return private.deny('invalid_state');
    end if;
    update public.profile_photos ph set status = 'removed' where ph.id = p_photo;
    v_ref := p_photo::text;
  end if;

  perform private.audit(v_me, 'hide_reported_content', 'report', p_id::text,
                        jsonb_build_object('item', p_item, 'ref', v_ref, 'target', v_rep.target_user_id));
  return private.ok(p_id::text);
end $$;

-- Undo for message and request_message only; any moderator may undo a hide through a report on the same content.
create function public.admin_unhide_reported_content(p_id uuid, p_item text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_staff('moderator');
  v_rep    public.reports;
  v_body   text;
  v_hidden private.hidden_messages;
begin
  if p_id is null or p_item is null or p_item not in ('message', 'request_message') then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  select * into v_rep from public.reports r
  where r.id = p_id and r.reporter_id is distinct from v_me and r.target_user_id is distinct from v_me;
  if not found or v_rep.target_user_id is null
     or v_rep.context <> (case p_item when 'message' then 'message' else 'request' end)::public.report_context then
    return private.deny('not_available');
  end if;

  if p_item = 'message' then
    perform 1 from public.messages m
    where m.id = v_rep.message_id and m.sender_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    select * into v_hidden from private.hidden_messages h where h.message_id = v_rep.message_id;
    if not found then
      return private.deny('invalid_state');
    end if;
    update public.messages m set body = v_hidden.original_body where m.id = v_rep.message_id;
    delete from private.hidden_messages h where h.message_id = v_rep.message_id;
    perform private.audit(v_me, 'unhide_reported_content', 'report', p_id::text,
                          jsonb_build_object('item', p_item, 'ref', v_rep.message_id::text, 'target', v_rep.target_user_id,
                                             'hidden_by_report', v_hidden.report_id, 'hidden_by', v_hidden.hidden_by));
  else
    select q.message into v_body from public.connection_requests q
    where q.id = v_rep.request_id and q.requester_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    delete from private.hidden_request_messages h where h.request_id = v_rep.request_id;
    if not found then
      return private.deny('invalid_state');
    end if;
    perform private.audit(v_me, 'unhide_reported_content', 'report', p_id::text,
                          jsonb_build_object('item', p_item, 'ref', v_rep.request_id::text, 'target', v_rep.target_user_id));
  end if;
  return private.ok(p_id::text);
end $$;

-- Order 8 with message null and message_hidden true for a hidden request message (new last column).
drop function public.list_my_requests();
create function public.list_my_requests()
returns table(
  request_id     uuid,
  direction      text,
  mode           public.discover_mode,
  message        text,
  status         text,
  created_at     timestamptz,
  counterpart_id uuid,
  counterpart    public.profile_view,
  message_hidden boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  return query
    select q.id, 'received'::text, q.mode, case when h.request_id is null then q.message end, 'pending'::text,
           q.created_at, q.requester_id, private.profile_view_of(q.requester_id, q.mode), h.request_id is not null
    from public.connection_requests q
    left join private.hidden_request_messages h on h.request_id = q.id
    where q.recipient_id = v_me and q.status = 'pending' and q.expires_at > now()
      and private.can_view_profile(v_me, q.requester_id, q.mode)
    union all
    select q.id, 'sent'::text, q.mode, case when h.request_id is null then q.message end,
           case when q.status = 'pending' and q.expires_at > now() then 'pending' else 'closed' end,
           q.created_at, q.recipient_id,
           case when private.can_view_profile(v_me, q.recipient_id, q.mode)
                then private.profile_view_of(q.recipient_id, q.mode) end,
           h.request_id is not null
    from public.connection_requests q
    left join private.hidden_request_messages h on h.request_id = q.id
    where q.requester_id = v_me
    order by 6 desc, 1;
end $$;

-- Order 8 with a hidden flag (new last column); the stored body of a hidden message is already the placeholder.
drop function public.list_messages(uuid, bigint, int);
create function public.list_messages(p_conversation uuid, p_before bigint default null, p_limit int default 50)
returns table(id bigint, sender_id uuid, body text, created_at timestamptz, hidden boolean)
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
    select m.id, m.sender_id, m.body, m.created_at,
           exists (select 1 from private.hidden_messages h where h.message_id = m.id)
    from public.messages m
    where m.conversation_id = p_conversation and (p_before is null or m.id < p_before)
    order by m.id desc
    limit v_limit;
end $$;

revoke all on function
  public.admin_get_report_content(uuid),
  public.admin_authorize_report_photo(uuid, uuid),
  public.admin_hide_reported_content(uuid, text, uuid),
  public.admin_unhide_reported_content(uuid, text),
  public.list_my_requests(),
  public.list_messages(uuid, bigint, int)
from public, anon, authenticated, service_role;

grant execute on function
  public.admin_get_report_content(uuid),
  public.admin_authorize_report_photo(uuid, uuid),
  public.admin_hide_reported_content(uuid, text, uuid),
  public.admin_unhide_reported_content(uuid, text),
  public.list_my_requests(),
  public.list_messages(uuid, bigint, int)
to authenticated;
