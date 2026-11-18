-- DB-LIKES-001 order 34: likes instead of connection requests, one mode, optional purposes (docs/43 §1-§3).
-- Decided by the user on 2026-11-17 (docs/05): two people who like each other match and can talk; the romance and
-- friends modes become one; a profile has an optional set of purposes and one bio.
--   likes:     public.likes (liker_id, liked_id, created_at), RLS on and no grant to any role, read only through
--              list_my_likes and get_like_state, which check private.pair_visible on every row (as blocks).
--   match:     like_user creates the connection and its conversation in the same transaction as the second like,
--              under the pair's exclusive advisory lock and read committed (it refuses any other isolation, as
--              lock_staff_roles does). Of two concurrent likes of one pair the second waits for the first to commit,
--              then its statements read the first like and make the match; one_active_connection_per_pair stays the
--              last guard. The match deletes both likes. like_user is the only path that creates a connection now.
--   requests:  send/respond/cancel_connection_request, list_my_requests and set_modes are dropped (PostgREST answers
--              404 PGRST202, no write). connection_requests and its history stay for audit and request reports;
--              pending rows are closed here (expired when past expires_at, else invalidated, as account deletion
--              does) and connection_requests_frozen (status <> 'pending') then refuses every new row, while
--              request_transition already refuses any change of a closed one.
--   modes:     public.profile_modes and the profiles columns bio_romance, bio_friends, purpose_romance and
--              purpose_friends are dropped; enum discover_mode stays frozen for the history columns
--              (connection_requests.mode, connections.mode, private.hidden_bios.mode). connections.mode,
--              connections.origin_request_id and hidden_bios.mode become nullable; a match has neither.
--   bio:       profiles.bio (500 chars) is filled from the friends bio first, then the romance bio, ignoring empty
--              strings; a hidden bio is already null, so a hidden text never returns. The other text is discarded.
--   purposes:  profiles.purposes text[] from the fixed codes friends, partner, hobby, study, talk (no duplicates, may
--              be empty), checked by private.purposes_ok and stored in that order by update_profile.
--   judgment:  is_eligible no longer needs a mode; can_view_profile(uuid, uuid, discover_mode) is dropped and its
--              callers use pair_visible; can_see_identity becomes pair_visible. Only the "same mode" condition goes:
--              eligibility, blocks and hides (both ways) stay on every path. A completed profile always had a mode
--              (complete_profile required one, set_modes refused none), checked below before anything changes.
--   rate:      'like' allows 100 attempts a day (likes and unlikes, refused ones included). 'request' stays defined.
--   reports:   submit_report refuses new 'request' reports (validation); a 'profile' report is related when the pair
--              has a like either way, besides the request history, a connection or pair_visible. Old request reports
--              stay readable by staff. The bio items of admin_get_report_content / admin_hide_reported_content are
--              one 'bio' (hidden_bios.mode null for new hides).
--   block / deletion: block_user and request_account_deletion delete the pair's / the user's likes in both
--              directions under the pair locks, instead of closing requests.
-- Data guards (the migration stops before any change): no non-empty purpose_romance/purpose_friends (no screen ever
-- wrote one) and no completed profile without a mode (it would become eligible).
-- Deleted data: profile_modes rows, the romance bio of anyone who had both bios, the closed requests' pending state.
-- No `notify pgrst`, as HOSTED-019 (order 33): PostgREST reloads its schema cache from the DDL event triggers.

-- §3.3 data conditions, before any change
do $$
begin
  if exists (select 1 from public.profiles p
             where nullif(p.purpose_romance, '') is not null or nullif(p.purpose_friends, '') is not null) then
    raise exception 'order 34: a non-empty purpose_romance or purpose_friends exists';
  end if;
  if exists (select 1 from public.profiles p
             where p.profile_completed_at is not null
               and not exists (select 1 from public.profile_modes m where m.user_id = p.user_id)) then
    raise exception 'order 34: a completed profile without a mode exists';
  end if;
end $$;

-- (1) close pending requests: past expires_at as expired at expires_at, the rest as invalidated now (request_transition
-- allows expired only after expires_at)
update public.connection_requests q set status = 'expired', closed_at = q.expires_at
where q.status = 'pending' and q.expires_at <= now();
update public.connection_requests q set status = 'invalidated', closed_at = now()
where q.status = 'pending';

-- (2) frozen: the default status is 'pending', so no new row can be inserted
alter table public.connection_requests add constraint connection_requests_frozen check (status <> 'pending');

-- (3) a match has no request and no mode; existing rows keep both
alter table public.connections alter column origin_request_id drop not null;
alter table public.connections alter column mode drop not null;
alter table public.connections add constraint connections_origin_check
  check ((origin_request_id is null) = (mode is null));

-- (4) one bio and the purposes
create function private.purposes_ok(p_purposes text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    cardinality(p_purposes) <= 5
    and not exists (select 1 from unnest(p_purposes) x
                    where x is null or x not in ('friends', 'partner', 'hobby', 'study', 'talk'))
    and (select count(distinct x) from unnest(p_purposes) x) = cardinality(p_purposes),
    false)
$$;

create function private.purposes_sorted(p_purposes text[]) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(x order by array_position(array['friends', 'partner', 'hobby', 'study', 'talk'], x)), '{}')
  from unnest(p_purposes) x
$$;

alter table public.profiles add column bio text check (char_length(bio) <= 500);
alter table public.profiles add column purposes text[] not null default '{}' check (private.purposes_ok(purposes));
update public.profiles p set bio = coalesce(nullif(p.bio_friends, ''), nullif(p.bio_romance, ''))
where coalesce(nullif(p.bio_friends, ''), nullif(p.bio_romance, '')) is not null;

-- (5) a new hide of the one bio has no mode; old rows keep theirs
alter table private.hidden_bios alter column mode drop not null;

-- (6) likes
create table public.likes (
  liker_id   uuid not null references public.profiles(user_id) on delete cascade,
  liked_id   uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (liker_id, liked_id),
  check (liker_id <> liked_id)
);
create index on public.likes (liked_id, created_at desc);
create index on public.likes (liker_id, created_at desc);

alter table public.likes enable row level security;
revoke all on table public.likes from public, anon, authenticated, service_role;

-- (7) P4 values are provisional (docs/03_ARCHITECTURE.md §12 P4); every earlier action keeps its value.
-- 'request' stays so that no caller can fall into the else branch while old events age out.
create or replace function private.rate_policy(p_action text, out max_count int, out window_length interval)
language plpgsql immutable set search_path = '' as $$
begin
  case p_action
    when 'request'   then max_count := 20;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'like'      then max_count := 100;  window_length := interval '1 day';    -- likes and unlikes, rejected ones included
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

-- (8) drop what depends on modes, requests or the old profile_view; the type goes last
drop function public.send_connection_request(uuid, public.discover_mode, text);
drop function public.respond_connection_request(uuid, boolean);
drop function public.cancel_connection_request(uuid);
drop function public.list_my_requests();
drop function public.set_modes(public.discover_mode[]);
drop function public.discover_profiles(public.discover_mode, int, int, text[], uuid[], uuid, int);
drop function public.get_profile(uuid, public.discover_mode);
drop function public.update_profile(text, text, text, text, text, text, text[]);
drop function public.my_account();
drop function private.profile_view_of(uuid, public.discover_mode);
drop function private.can_view_profile(uuid, uuid, public.discover_mode);
drop function private.expire_stale_requests(uuid, uuid);
drop function private.request_retry_wait();
drop type public.profile_view;

-- (9) judgment functions without modes
create or replace function private.is_eligible(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join private.user_private u         on u.user_id = p.user_id
    join public.account_verifications v on v.user_id = p.user_id
    join public.affiliations a          on a.user_id = p.user_id
    where p.user_id = p_user
      and p.account_status = 'active'
      and p.profile_completed_at is not null
      and v.age_verified_at is not null
      and v.age_revoked_at is null
      and private.adult_from(u.birth_date) <= private.today_jst()
      and a.status = 'confirmed'
      and a.confirmed_until > now()
      and exists (select 1 from public.profile_photos ph where ph.user_id = p.user_id and ph.status = 'active')
  ), false)
$$;

-- identity (name, photos) is shown exactly to the people who can see the profile
create or replace function private.can_see_identity(p_viewer uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.pair_visible(p_viewer, p_target), false)
$$;

-- §5.1 the only shape another person's profile is returned in
create type public.profile_view as (
  user_id         uuid,
  display_name    text,
  age             int,
  gender          text,
  school_name     text,
  department_name text,
  class_name      text,
  bio             text,
  purposes        text[],
  hobbies         text[],
  photo_ids       uuid[]
);

-- builds the view without any authorization; callers check pair_visible first
create function private.profile_view_of(p_target uuid) returns public.profile_view
language sql stable security definer set search_path = '' as $$
  select p.user_id,
         p.display_name,
         private.age_years(u.birth_date, private.today_jst()),
         p.gender,
         s.name,
         case when coalesce(ps.show_department, false) then d.name end,
         case when coalesce(ps.show_class, false) then c.name end,
         p.bio,
         p.purposes,
         p.hobbies,
         coalesce((select array_agg(ph.id order by ph.position)
                   from public.profile_photos ph
                   where ph.user_id = p.user_id and ph.status = 'active'), '{}')
  from public.profiles p
  join private.user_private u     on u.user_id = p.user_id
  join public.affiliations a      on a.user_id = p.user_id
  join public.schools s           on s.id = a.school_id
  join public.departments d       on d.id = a.department_id
  join public.classes c           on c.id = a.class_id
  left join public.privacy_settings ps on ps.user_id = p.user_id
  where p.user_id = p_target
$$;

-- §5.1 browsing: excludes connected people and people the caller liked; people who liked the caller stay
create function public.discover_profiles(
  p_min_age    int    default null,
  p_max_age    int    default null,
  p_genders    text[] default null,
  p_school_ids uuid[] default null,
  p_after      uuid   default null,
  p_limit      int    default 20)
returns setof public.profile_view
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_user();
  v_today date := private.today_jst();
  v_limit int  := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if (p_min_age is not null and p_min_age not between 18 and 120)
     or (p_max_age is not null and p_max_age not between 18 and 120)
     or (p_min_age is not null and p_max_age is not null and p_min_age > p_max_age)
     or (p_genders is not null and (cardinality(p_genders) = 0
         or exists (select 1 from unnest(p_genders) g where g is null or g not in ('female', 'male', 'other'))))
     or (p_school_ids is not null and (cardinality(p_school_ids) not between 1 and 50
         or array_position(p_school_ids, null) is not null)) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;

  return query
    with picked as (
      select t.user_id
      from public.profiles t
      join private.user_private u on u.user_id = t.user_id
      join public.affiliations a  on a.user_id = t.user_id
      where t.user_id <> v_me
        and (p_after is null or t.user_id > p_after)
        and (p_genders is null or t.gender = any (p_genders))
        and (p_school_ids is null or a.school_id = any (p_school_ids))
        and (p_min_age is null or private.age_years(u.birth_date, v_today) >= p_min_age)
        and (p_max_age is null or private.age_years(u.birth_date, v_today) <= p_max_age)
        and not private.has_active_connection(v_me, t.user_id)
        and not exists (select 1 from public.likes l where l.liker_id = v_me and l.liked_id = t.user_id)
        and private.pair_visible(v_me, t.user_id)
      order by t.user_id
      limit v_limit)
    select v.*
    from picked k
    cross join lateral private.profile_view_of(k.user_id) v
    order by v.user_id;
end $$;

create function public.get_profile(p_target uuid)
returns setof public.profile_view
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_target is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if private.pair_visible(v_me, p_target) then
    return next private.profile_view_of(p_target);
  end if;
  return;
end $$;

-- §2.4 one row only when the pair is visible; liked_me is the fact the received list already shows the caller
create function public.get_like_state(p_target uuid)
returns table(i_liked boolean, liked_me boolean, conversation_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  if p_target is null or p_target = v_me then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not private.pair_visible(v_me, p_target) then
    return;
  end if;
  return query
    select exists (select 1 from public.likes l where l.liker_id = v_me and l.liked_id = p_target),
           exists (select 1 from public.likes l where l.liker_id = p_target and l.liked_id = v_me),
           (select c.id
            from public.connections k
            join public.conversations c on c.connection_id = k.id
            where k.ended_at is null and k.user_low = least(v_me, p_target) and k.user_high = greatest(v_me, p_target)
              and private.can_access_conversation(v_me, c.id));
end $$;

-- §2.5 like; the second like of a pair makes the match (ref = the new conversation id)
create function public.like_user(p_target uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := private.require_user();
  v_allowed boolean;
  v_conn    uuid;
  v_conv    uuid;
begin
  if p_target is null or p_target = v_me then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  -- §5 account restriction on the actor (deactivated, suspended, deleted, no profile: forbidden before any write)
  perform private.require_account(v_me, false);
  -- the match relies on the statements after the pair lock reading the latest commits (read committed), as
  -- lock_staff_roles does
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  -- (1) every attempt is recorded under the user x action lock, whatever the target
  perform private.lock_rate(v_me, 'like');
  v_allowed := private.rate_ok(v_me, 'like');
  perform private.rate_record(v_me, 'like');
  if not v_allowed then
    return private.deny('rate_limited');
  end if;
  -- (2) the pair's exclusive lock: a concurrent like of the other direction waits here for this commit
  perform private.lock_pair(v_me, p_target, false);
  -- (3) not visible, missing, blocked either way, ineligible or hidden: one indistinguishable answer
  if not private.pair_visible(v_me, p_target) then
    return private.deny('not_available');
  end if;
  -- (4)
  if private.has_active_connection(v_me, p_target) then
    return private.deny('already_connected');
  end if;
  -- (5) idempotent: a second like keeps the row (created_at included)
  insert into public.likes (liker_id, liked_id) values (v_me, p_target)
  on conflict (liker_id, liked_id) do nothing;
  -- (6) without the other like this is only a like
  if not exists (select 1 from public.likes l where l.liker_id = p_target and l.liked_id = v_me) then
    return private.ok(null);
  end if;
  -- (7) the match: both likes go, the connection and its conversation come in this transaction
  delete from public.likes l
  where (l.liker_id = v_me and l.liked_id = p_target) or (l.liker_id = p_target and l.liked_id = v_me);
  insert into public.connections (user_low, user_high, origin_request_id, mode)
  values (least(v_me, p_target), greatest(v_me, p_target), null, null)
  returning id into v_conn;
  insert into public.conversations (connection_id) values (v_conn) returning id into v_conv;
  return private.ok(v_conv::text);
end $$;

-- §2.6 take one's own like back; ok whether or not a row existed, so the answer says nothing about the other person
create function public.unlike_user(p_target uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := private.require_user();
  v_allowed boolean;
begin
  if p_target is null or p_target = v_me then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, false);
  perform private.lock_rate(v_me, 'like');
  v_allowed := private.rate_ok(v_me, 'like');
  perform private.rate_record(v_me, 'like');
  if not v_allowed then
    return private.deny('rate_limited');
  end if;
  perform private.lock_pair(v_me, p_target, false);
  delete from public.likes l where l.liker_id = v_me and l.liked_id = p_target;
  return private.ok(null);
end $$;

-- §2.7 sent: people the caller liked; received: people who liked the caller. Only visible, not connected people,
-- newest first, keyset pages by (liked_at, counterpart_id).
create function public.list_my_likes(
  p_direction text,
  p_before_at timestamptz default null,
  p_before_id uuid        default null,
  p_limit     int         default 50)
returns table(counterpart_id uuid, liked_at timestamptz, counterpart public.profile_view)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_me    uuid := private.require_user();
  v_limit int  := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if p_direction is null or p_direction not in ('sent', 'received')
     or (p_before_at is null) <> (p_before_id is null) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if p_direction = 'sent' then
    return query
      select l.liked_id, l.created_at, private.profile_view_of(l.liked_id)
      from public.likes l
      where l.liker_id = v_me
        and (p_before_at is null or (l.created_at, l.liked_id) < (p_before_at, p_before_id))
        and private.pair_visible(v_me, l.liked_id)
        and not private.has_active_connection(v_me, l.liked_id)
      order by l.created_at desc, l.liked_id desc
      limit v_limit;
  else
    return query
      select l.liker_id, l.created_at, private.profile_view_of(l.liker_id)
      from public.likes l
      where l.liked_id = v_me
        and (p_before_at is null or (l.created_at, l.liker_id) < (p_before_at, p_before_id))
        and private.pair_visible(v_me, l.liker_id)
        and not private.has_active_connection(v_me, l.liker_id)
      order by l.created_at desc, l.liker_id desc
      limit v_limit;
  end if;
end $$;

-- §5.2 own profile: one bio (an empty string is stored as no bio) and the purposes in their fixed order
create function public.update_profile(
  p_display_name text,
  p_gender       text,
  p_bio          text,
  p_purposes     text[],
  p_hobbies      text[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_display_name is null or char_length(p_display_name) not between 1 and 20 or btrim(p_display_name) = ''
     or p_gender is null or p_gender not in ('female', 'male', 'other')
     or char_length(p_bio) > 500
     or p_purposes is null or not private.purposes_ok(p_purposes)
     or p_hobbies is null or not private.hobbies_ok(p_hobbies) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  update public.profiles p
  set display_name = p_display_name, gender = p_gender, bio = nullif(p_bio, ''),
      purposes = private.purposes_sorted(p_purposes), hobbies = p_hobbies
  where p.user_id = v_me;
  return private.ok(null);
end $$;

create or replace function public.complete_profile()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  perform private.require_account(v_me, true);
  if exists (select 1 from public.profiles p where p.user_id = v_me and p.profile_completed_at is not null) then
    return private.ok(null);
  end if;
  if not exists (select 1 from public.affiliations a where a.user_id = v_me)
     or not exists (select 1 from private.user_private u where u.user_id = v_me)
     or not exists (select 1 from public.profile_photos ph where ph.user_id = v_me and ph.status = 'active') then
    return private.deny('invalid_state');
  end if;
  update public.profiles p set profile_completed_at = now() where p.user_id = v_me;
  return private.ok(null);
end $$;

-- Order 18 without has_mode. The function is stable, so the deleted check and the row query see the same snapshot.
create function public.my_account()
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
  eligible              boolean,
  birth_date            date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.session_uid_any_status();
begin
  if v_me is null then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if exists (select 1 from public.profiles p where p.user_id = v_me and p.account_status = 'deleted') then
    return query
      select v_me, true, 'deleted'::public.account_status, false, false, false,
             null::public.affiliation_status, false, false, false, null::date;
    return;
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
           private.is_eligible(v_me),
           u.birth_date
    from (select 1) one
    left join public.profiles p              on p.user_id = v_me
    left join private.user_private u         on u.user_id = v_me
    left join public.account_verifications v on v.user_id = v_me
    left join public.affiliations a          on a.user_id = v_me;
end $$;

-- Order 9 with the pair's likes deleted both ways instead of closing requests; unblocking never restores them.
create or replace function public.block_user(p_target uuid)
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

  delete from public.likes l
  where (l.liker_id = v_me and l.liked_id = p_target) or (l.liker_id = p_target and l.liked_id = v_me);
  update public.connections k set ended_at = now(), ended_reason = 'blocked'
  where k.ended_at is null and k.user_low = least(v_me, p_target) and k.user_high = greatest(v_me, p_target);
  return private.ok(null);
end $$;

-- any -> deleted (terminal, §7). Eligibility ends at once; active connections end and the user's likes go both ways.
-- The pair locks are taken in the other person's id order, over active connections and likes either way.
create or replace function public.request_account_deletion()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_status public.account_status;
  r        record;
begin
  select p.account_status into v_status from public.profiles p where p.user_id = v_me;
  if not found or v_status = 'deleted' then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  for r in
    select distinct o.other
    from (select case when k.user_low = v_me then k.user_high else k.user_low end as other
          from public.connections k
          where k.ended_at is null and v_me in (k.user_low, k.user_high)
          union
          select case when l.liker_id = v_me then l.liked_id else l.liker_id end
          from public.likes l
          where v_me in (l.liker_id, l.liked_id)) o
    order by o.other
  loop
    perform private.lock_pair(v_me, r.other, false);
  end loop;
  update public.profiles p set account_status = 'deleted' where p.user_id = v_me and p.account_status <> 'deleted';
  if not found then
    return private.deny('invalid_state');
  end if;
  delete from public.likes l where v_me in (l.liker_id, l.liked_id);
  update public.connections k set ended_at = now(), ended_reason = 'account_deleted'
  where k.ended_at is null and v_me in (k.user_low, k.user_high);
  return private.ok(null);
end $$;

-- Order 9 without new 'request' reports (validation); a 'profile' report is also related through a like either way.
create or replace function public.submit_report(
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
     or p_context = 'request'
     or (p_context = 'profile' and (p_request_id is not null or p_message_id is not null))
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
  else
    v_related := exists (select 1 from public.connection_requests q
                         where least(q.requester_id, q.recipient_id) = least(v_me, p_target)
                           and greatest(q.requester_id, q.recipient_id) = greatest(v_me, p_target))
              or exists (select 1 from public.likes l
                         where (l.liker_id = v_me and l.liked_id = p_target)
                            or (l.liker_id = p_target and l.liked_id = v_me))
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

-- Order 33 with one 'bio' item for a profile report: the bio shown now (null when hidden) and the latest hide of any of
-- the target's bios (old rows keep their mode). The message and request_message items are unchanged.
create or replace function public.admin_get_report_content(p_id uuid)
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
      cross join lateral (select 'bio'::text as item, p.bio as body,
                                 (select max(h.hidden_at) from private.hidden_bios h
                                  where h.user_id = p.user_id) as hidden_at) x
      where p.user_id = v_rep.target_user_id and (x.body is not null or x.hidden_at is not null)
      union all
      select 'photo', ph.id::text, ph.position::int, null::text, false, null::timestamptz
      from public.profile_photos ph
      where ph.user_id = v_rep.target_user_id and ph.status = 'active'
      order by 1, 3;
  end if;
end $$;

-- p_item: message | request_message | bio | photo (p_photo only for photo); the former bio_romance and bio_friends
-- are validation. not_available / invalid_state as in order 33.
create or replace function public.admin_hide_reported_content(p_id uuid, p_item text, p_photo uuid default null)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_staff('moderator');
  v_rep  public.reports;
  v_body text;
  v_ref  text;
begin
  if p_id is null or p_item is null
     or p_item not in ('message', 'request_message', 'bio', 'photo')
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

  elsif p_item = 'bio' then
    -- the row lock serializes with update_profile, which writes the bio in one update
    select p.bio into v_body
    from public.profiles p where p.user_id = v_rep.target_user_id
    for update;
    if not found then
      return private.deny('not_available');
    end if;
    if v_body is null then
      return private.deny('invalid_state');
    end if;
    insert into private.hidden_bios (user_id, mode, original_text, report_id, hidden_by)
    values (v_rep.target_user_id, null, v_body, p_id, v_me);
    update public.profiles p set bio = null where p.user_id = v_rep.target_user_id;

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

-- (10) the mode table and columns; every function reading them was recreated above
drop table public.profile_modes;
alter table public.profiles
  drop column bio_romance,
  drop column bio_friends,
  drop column purpose_romance,
  drop column purpose_friends;

-- (11) grants. create or replace keeps the existing grants; restate them so this file alone shows the intended surface.
revoke all on function
  private.purposes_ok(text[]), private.purposes_sorted(text[]), private.rate_policy(text),
  private.is_eligible(uuid), private.can_see_identity(uuid, uuid), private.profile_view_of(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.discover_profiles(int, int, text[], uuid[], uuid, int),
  public.get_profile(uuid),
  public.get_like_state(uuid),
  public.like_user(uuid),
  public.unlike_user(uuid),
  public.list_my_likes(text, timestamptz, uuid, int),
  public.update_profile(text, text, text, text[], text[]),
  public.complete_profile(),
  public.my_account(),
  public.block_user(uuid),
  public.request_account_deletion(),
  public.submit_report(uuid, public.report_context, public.report_reason, text, uuid, bigint),
  public.admin_get_report_content(uuid),
  public.admin_hide_reported_content(uuid, text, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.discover_profiles(int, int, text[], uuid[], uuid, int),
  public.get_profile(uuid),
  public.get_like_state(uuid),
  public.like_user(uuid),
  public.unlike_user(uuid),
  public.list_my_likes(text, timestamptz, uuid, int),
  public.update_profile(text, text, text, text[], text[]),
  public.complete_profile(),
  public.my_account(),
  public.block_user(uuid),
  public.request_account_deletion(),
  public.submit_report(uuid, public.report_context, public.report_reason, text, uuid, bigint),
  public.admin_get_report_content(uuid),
  public.admin_hide_reported_content(uuid, text, uuid)
to authenticated;
