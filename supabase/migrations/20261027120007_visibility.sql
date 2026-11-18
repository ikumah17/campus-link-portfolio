-- BE-001 order 7: judgment functions, messages policy, browsing RPCs, onboarding and own-data RPCs
-- (docs/04_DATABASE.md §4, §5.1, §5.2, §6; docs/03_ARCHITECTURE.md §5, §6).

-- §4 judgment functions: the single set every path uses (P3)
create function private.is_eligible(p_user uuid) returns boolean
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
      and exists (select 1 from public.profile_modes m where m.user_id = p.user_id)
  ), false)
$$;

-- whether owner's settings exclude other; not evaluable (missing affiliation) means excluded
create function private.hides(p_owner uuid, p_other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (coalesce(s.hide_same_class, true)       and ao.class_id      = ax.class_id)
        or (coalesce(s.hide_same_department, false) and ao.department_id = ax.department_id)
        or (coalesce(s.hide_same_school, false)     and ao.school_id     = ax.school_id)
        or exists (select 1 from public.hidden_affiliations h
                   where h.user_id = p_owner
                     and (h.school_id = ax.school_id or h.department_id = ax.department_id or h.class_id = ax.class_id))
    from public.affiliations ao
    join public.affiliations ax on ax.user_id = p_other
    left join public.privacy_settings s on s.user_id = p_owner
    where ao.user_id = p_owner
  ), true)
$$;

-- symmetric by definition
create function private.pair_visible(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
       p_a <> p_b
   and private.is_eligible(p_a)
   and private.is_eligible(p_b)
   and not exists (select 1 from public.blocks b
                   where (b.blocker_id = p_a and b.blocked_id = p_b)
                      or (b.blocker_id = p_b and b.blocked_id = p_a))
   and not private.hides(p_a, p_b)
   and not private.hides(p_b, p_a), false)
$$;

create function private.can_view_profile(p_viewer uuid, p_target uuid, p_mode public.discover_mode) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
       private.pair_visible(p_viewer, p_target)
   and exists (select 1 from public.profile_modes m where m.user_id = p_viewer and m.mode = p_mode)
   and exists (select 1 from public.profile_modes m where m.user_id = p_target and m.mode = p_mode), false)
$$;

create function private.has_active_connection(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.connections k
                 where k.ended_at is null and k.user_low = least(p_a, p_b) and k.user_high = greatest(p_a, p_b))
$$;

create function private.can_access_conversation(p_user uuid, p_conversation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversations c
    join public.connections k on k.id = c.connection_id
    where c.id = p_conversation and k.ended_at is null
      and p_user in (k.user_low, k.user_high)
      and private.pair_visible(k.user_low, k.user_high))
$$;

-- identity (name, photos) is shown only to people who appear in a list, detail or chat of the viewer
create function private.can_see_identity(p_viewer uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
       private.pair_visible(p_viewer, p_target)
   and (exists (select 1 from public.profile_modes a
                join public.profile_modes b on b.mode = a.mode
                where a.user_id = p_viewer and b.user_id = p_target)
        or private.has_active_connection(p_viewer, p_target)), false)
$$;

create function private.can_view_photo(p_viewer uuid, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_viewer = p_owner, false) or private.can_see_identity(p_viewer, p_owner)
$$;

create function private.photo_delivery_allowed(p_viewer uuid, p_photo uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profile_photos ph
    where ph.id = p_photo and ph.status = 'active'
      and private.can_view_photo(p_viewer, ph.user_id))
$$;

-- §4 RLS self-check for messages and Realtime: the caller comes from session_uid (r4)
create function private.rls_conversation_member(p_conversation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.uid is not null and private.can_access_conversation(s.uid, p_conversation), false)
  from (select private.session_uid() as uid) s
$$;

revoke all on function
  private.is_eligible(uuid), private.hides(uuid, uuid), private.pair_visible(uuid, uuid),
  private.can_view_profile(uuid, uuid, public.discover_mode), private.has_active_connection(uuid, uuid),
  private.can_access_conversation(uuid, uuid), private.can_see_identity(uuid, uuid),
  private.can_view_photo(uuid, uuid), private.photo_delivery_allowed(uuid, uuid),
  private.rls_conversation_member(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.rls_conversation_member(uuid) to authenticated;

grant select on table public.messages to authenticated;
create policy messages_member on public.messages for select to authenticated
  using (private.rls_conversation_member(conversation_id));

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
  purpose         text,
  hobbies         text[],
  photo_ids       uuid[]
);

-- builds the view without any authorization; callers check can_view_profile/can_see_identity first
create function private.profile_view_of(p_target uuid, p_mode public.discover_mode) returns public.profile_view
language sql stable security definer set search_path = '' as $$
  select p.user_id,
         p.display_name,
         private.age_years(u.birth_date, private.today_jst()),
         p.gender,
         s.name,
         case when coalesce(ps.show_department, false) then d.name end,
         case when coalesce(ps.show_class, false) then c.name end,
         case p_mode when 'romance' then p.bio_romance else p.bio_friends end,
         case p_mode when 'romance' then p.purpose_romance else p.purpose_friends end,
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
revoke all on function private.profile_view_of(uuid, public.discover_mode)
from public, anon, authenticated, service_role;

-- §5.1 browsing
create function public.discover_profiles(
  p_mode       public.discover_mode,
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
  if p_mode is null
     or (p_min_age is not null and p_min_age not between 18 and 120)
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
        and not exists (select 1 from public.connection_requests r
                        where r.status = 'pending' and r.expires_at > now()
                          and least(r.requester_id, r.recipient_id) = least(v_me, t.user_id)
                          and greatest(r.requester_id, r.recipient_id) = greatest(v_me, t.user_id))
        and private.can_view_profile(v_me, t.user_id, p_mode)
      order by t.user_id
      limit v_limit)
    select v.*
    from picked k
    cross join lateral private.profile_view_of(k.user_id, p_mode) v
    order by v.user_id;
end $$;

create function public.get_profile(p_target uuid, p_mode public.discover_mode)
returns setof public.profile_view
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_target is null or p_mode is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if private.can_view_profile(v_me, p_target, p_mode) then
    return next private.profile_view_of(p_target, p_mode);
  end if;
  return;
end $$;

-- r3 (ARCH-R2-01): per-request photo authorization for the same-origin delivery route (E-3)
create function public.authorize_photo_delivery(p_photo_ids uuid[])
returns table(photo_id uuid, storage_path text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
  if p_photo_ids is null or cardinality(p_photo_ids) not between 1 and 60
     or array_position(p_photo_ids, null) is not null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  return query
    select ph.id, ph.storage_path
    from public.profile_photos ph
    where ph.id = any (p_photo_ids)
      and private.photo_delivery_allowed(v_me, ph.id)
    order by ph.id;
end $$;

-- §5.2 onboarding and own data
create function public.start_onboarding(p_display_name text, p_gender text, p_birth_date date, p_adult_declared boolean)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_display_name is null or char_length(p_display_name) not between 1 and 20 or btrim(p_display_name) = ''
     or p_gender is null or p_gender not in ('female', 'male', 'other')
     or p_birth_date is null or p_birth_date <= date '1900-01-01'
     or p_adult_declared is distinct from true
     or private.adult_from(p_birth_date) > private.today_jst() then
    raise exception using errcode = 'P0001', message = 'validation';   -- an under-18 birth date is never stored
  end if;
  if exists (select 1 from public.profiles p where p.user_id = v_me) then
    return private.deny('invalid_state');
  end if;
  insert into public.profiles (user_id, display_name, gender) values (v_me, p_display_name, p_gender);
  insert into private.user_private (user_id, birth_date) values (v_me, p_birth_date);
  insert into public.privacy_settings (user_id) values (v_me);
  insert into public.account_verifications (user_id) values (v_me);
  return private.ok(v_me::text);
end $$;

create function public.update_birth_date(p_birth_date date)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_birth_date is null or p_birth_date <= date '1900-01-01'
     or private.adult_from(p_birth_date) > private.today_jst() then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  -- the condition is re-checked on the latest row, so an age approval committed meanwhile wins
  update private.user_private u set birth_date = p_birth_date
  where u.user_id = v_me and u.birth_date_locked_at is null;
  if not found then
    return private.deny('invalid_state');
  end if;
  return private.ok(null);
end $$;

create function public.update_profile(
  p_display_name    text,
  p_gender          text,
  p_bio_romance     text,
  p_bio_friends     text,
  p_purpose_romance text,
  p_purpose_friends text,
  p_hobbies         text[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_display_name is null or char_length(p_display_name) not between 1 and 20 or btrim(p_display_name) = ''
     or p_gender is null or p_gender not in ('female', 'male', 'other')
     or char_length(p_bio_romance) > 500 or char_length(p_bio_friends) > 500
     or char_length(p_purpose_romance) > 200 or char_length(p_purpose_friends) > 200
     or p_hobbies is null or not private.hobbies_ok(p_hobbies) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  update public.profiles p
  set display_name = p_display_name, gender = p_gender,
      bio_romance = p_bio_romance, bio_friends = p_bio_friends,
      purpose_romance = p_purpose_romance, purpose_friends = p_purpose_friends,
      hobbies = p_hobbies
  where p.user_id = v_me;
  return private.ok(null);
end $$;

create function public.set_modes(p_modes public.discover_mode[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_modes is null or cardinality(p_modes) = 0 or array_position(p_modes, null) is not null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  delete from public.profile_modes m where m.user_id = v_me and not (m.mode = any (p_modes));
  insert into public.profile_modes (user_id, mode)
  select distinct v_me, x from unnest(p_modes) x
  on conflict do nothing;
  return private.ok(null);
end $$;

-- r3 (ARCH-R2-03): an affiliation change supersedes open enrollment submissions, in review ones included
create function public.set_affiliation(p_school uuid, p_department uuid, p_class uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_user();
  v_cur public.affiliations;
  r     record;
begin
  if p_school is null or p_department is null or p_class is null
     or not exists (select 1
                    from public.classes c
                    join public.departments d on d.id = c.department_id
                    join public.schools s     on s.id = d.school_id
                    where c.id = p_class and d.id = p_department and s.id = p_school
                      and c.is_active and d.is_active and s.is_active) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform private.lock_verification_subject(v_me);

  select * into v_cur from public.affiliations a where a.user_id = v_me;
  if found and v_cur.school_id = p_school and v_cur.department_id = p_department and v_cur.class_id = p_class then
    return private.ok(null);
  end if;

  insert into public.affiliations as a (user_id, school_id, department_id, class_id, status)
  values (v_me, p_school, p_department, p_class, 'unconfirmed')
  on conflict (user_id) do update
    set school_id = excluded.school_id, department_id = excluded.department_id, class_id = excluded.class_id,
        status = 'unconfirmed', confirmed_until = null, confirmed_by_submission = null;

  for r in
    select s.id, s.reviewer_id
    from public.verification_submissions s
    where s.user_id = v_me and s.kind = 'enrollment' and s.status in ('submitted', 'in_review')
    order by s.id
  loop
    update public.verification_submissions s
    set status = 'superseded', decided_at = now(), decision_reason = 'affiliation_changed',
        reviewer_id = null, claimed_at = null, version = s.version + 1
    where s.id = r.id;
    perform private.audit(v_me, 'verification_superseded', 'verification_submission', r.id::text,
                          jsonb_build_object('previous_reviewer', r.reviewer_id));
  end loop;
  return private.ok(null);
end $$;

create function public.complete_profile()
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
     or not exists (select 1 from public.profile_photos ph where ph.user_id = v_me and ph.status = 'active')
     or not exists (select 1 from public.profile_modes m where m.user_id = v_me) then
    return private.deny('invalid_state');
  end if;
  update public.profiles p set profile_completed_at = now() where p.user_id = v_me;
  return private.ok(null);
end $$;

create function public.remove_photo(p_photo uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_status text;
begin
  if p_photo is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform 1 from public.profiles p where p.user_id = v_me for update;   -- serializes the owner's photo changes
  select ph.status into v_status from public.profile_photos ph where ph.id = p_photo and ph.user_id = v_me;
  if not found then
    return private.deny('not_available');
  end if;
  if v_status <> 'active'
     or (exists (select 1 from public.profiles p where p.user_id = v_me and p.profile_completed_at is not null)
         and (select count(*) from public.profile_photos ph where ph.user_id = v_me and ph.status = 'active') <= 1) then
    return private.deny('invalid_state');
  end if;
  update public.profile_photos ph set status = 'removed' where ph.id = p_photo;
  return private.ok(p_photo::text);
end $$;

create function public.reorder_photos(p_ids uuid[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_user();
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 6 or array_position(p_ids, null) is not null
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform 1 from public.profiles p where p.user_id = v_me for update;
  if (select coalesce(array_agg(ph.id order by ph.id), '{}') from public.profile_photos ph
      where ph.user_id = v_me and ph.status = 'active')
     <> (select array_agg(x order by x) from unnest(p_ids) x) then
    return private.deny('invalid_state');
  end if;
  -- two statements so the partial unique index (user_id, position) never sees two active photos on one position
  update public.profile_photos ph set status = 'removed' where ph.user_id = v_me and ph.status = 'active';
  update public.profile_photos ph set status = 'active', position = (o.ord - 1)::smallint
  from unnest(p_ids) with ordinality as o(id, ord)
  where ph.id = o.id;
  return private.ok(null);
end $$;

-- E-1 only (service_role). p_user comes from the same request's my_account(); path is '{p_user}/{photo_id}.webp'
create function public.service_register_photo(p_user uuid, p_path text)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_pos int;
begin
  if p_user is null or p_path is null
     or p_path !~ ('^' || p_user::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$') then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  if not private.auth_account_ok(p_user) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  perform private.require_account(p_user, true);
  v_id := substring(p_path from '/([0-9a-f-]{36})\.webp$')::uuid;
  perform 1 from public.profiles p where p.user_id = p_user for update;
  if exists (select 1 from public.profile_photos ph where ph.id = v_id or ph.storage_path = p_path) then
    return private.deny('invalid_state');
  end if;
  select min(g.pos) into v_pos
  from generate_series(0, 5) as g(pos)
  where not exists (select 1 from public.profile_photos ph
                    where ph.user_id = p_user and ph.status = 'active' and ph.position = g.pos);
  if v_pos is null then
    return private.deny('invalid_state');
  end if;
  insert into public.profile_photos (id, user_id, storage_path, position) values (v_id, p_user, p_path, v_pos);
  return private.ok(v_id::text);
end $$;

create function public.submit_verification(p_kind public.verification_kind, p_document_refs text[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_intake text;
  v_aff    public.affiliations;
  v_id     uuid;
begin
  select c.value into v_intake from private.app_settings c where c.key = 'verification_intake';
  if p_kind is null or p_document_refs is null
     or cardinality(p_document_refs) not between 1 and 4
     or array_position(p_document_refs, null) is not null
     or (select count(distinct x) from unnest(p_document_refs) x) <> cardinality(p_document_refs)
     or v_intake is null or v_intake not in ('synthetic', 'upload')
     or (v_intake = 'synthetic'
         and exists (select 1 from unnest(p_document_refs) x where x !~ '^synthetic:sample-[1-3]$'))
     or (v_intake = 'upload'
         and exists (select 1 from unnest(p_document_refs) x
                     where x !~ ('^' || v_me::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$'))) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform private.lock_verification_subject(v_me);

  if exists (select 1 from public.verification_submissions s
             where s.user_id = v_me and s.kind = p_kind and s.status in ('submitted', 'in_review')) then
    return private.deny('invalid_state');
  end if;

  if p_kind = 'age' then
    if exists (select 1 from public.account_verifications v
               where v.user_id = v_me and v.age_verified_at is not null and v.age_revoked_at is null) then
      return private.deny('invalid_state');
    end if;
    insert into public.verification_submissions (user_id, kind, intake_mode, document_refs)
    values (v_me, 'age', v_intake, p_document_refs)
    returning id into v_id;
    return private.ok(v_id::text);
  end if;

  select * into v_aff from public.affiliations a where a.user_id = v_me;
  if not found then
    return private.deny('invalid_state');
  end if;
  -- a renewal inside the validity keeps 'confirmed' until the decision; otherwise the affiliation waits as pending
  if v_aff.status in ('unconfirmed', 'rejected') or (v_aff.status = 'confirmed' and v_aff.confirmed_until <= now()) then
    update public.affiliations a
    set status = 'pending', confirmed_until = null, confirmed_by_submission = null
    where a.user_id = v_me;
  end if;
  insert into public.verification_submissions (user_id, kind, intake_mode, document_refs, affiliation_snapshot)
  values (v_me, 'enrollment', v_intake, p_document_refs,
          jsonb_build_object('school_id', v_aff.school_id, 'department_id', v_aff.department_id,
                             'class_id', v_aff.class_id))
  returning id into v_id;
  return private.ok(v_id::text);
end $$;

create function public.withdraw_verification(p_id uuid)
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me  uuid := private.require_user();
  v_sub public.verification_submissions;
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform private.lock_verification_subject(v_me);
  select * into v_sub from public.verification_submissions s where s.id = p_id and s.user_id = v_me;
  if not found then
    return private.deny('not_available');
  end if;
  if v_sub.status <> 'submitted' then
    return private.deny('invalid_state');
  end if;
  update public.verification_submissions s
  set status = 'withdrawn', decided_at = now(), version = s.version + 1
  where s.id = p_id;
  if v_sub.kind = 'enrollment' then
    update public.affiliations a set status = 'unconfirmed' where a.user_id = v_me and a.status = 'pending';
  end if;
  return private.ok(p_id::text);
end $$;

create function public.update_privacy_settings(
  p_hide_same_class       boolean,
  p_hide_same_department  boolean,
  p_hide_same_school      boolean,
  p_show_department       boolean,
  p_show_class            boolean,
  p_hidden_school_ids     uuid[],
  p_hidden_department_ids uuid[],
  p_hidden_class_ids      uuid[])
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid   := private.require_user();
  v_schools uuid[] := array(select distinct x from unnest(coalesce(p_hidden_school_ids, '{}')) x);
  v_depts   uuid[] := array(select distinct x from unnest(coalesce(p_hidden_department_ids, '{}')) x);
  v_classes uuid[] := array(select distinct x from unnest(coalesce(p_hidden_class_ids, '{}')) x);
begin
  if p_hide_same_class is null or p_hide_same_department is null or p_hide_same_school is null
     or p_show_department is null or p_show_class is null
     or array_position(v_schools, null) is not null or array_position(v_depts, null) is not null
     or array_position(v_classes, null) is not null
     or cardinality(v_schools) + cardinality(v_depts) + cardinality(v_classes) > 50
     or (select count(*) from public.schools s where s.id = any (v_schools)) <> cardinality(v_schools)
     or (select count(*) from public.departments d where d.id = any (v_depts)) <> cardinality(v_depts)
     or (select count(*) from public.classes c where c.id = any (v_classes)) <> cardinality(v_classes) then
    raise exception using errcode = 'P0001', message = 'validation';
  end if;
  perform private.require_account(v_me, true);
  perform private.lock_rate(v_me, 'privacy');
  if not private.rate_ok(v_me, 'privacy') then
    return private.deny('rate_limited');
  end if;
  perform private.rate_record(v_me, 'privacy');

  insert into public.privacy_settings as s
    (user_id, hide_same_class, hide_same_department, hide_same_school, show_department, show_class)
  values (v_me, p_hide_same_class, p_hide_same_department, p_hide_same_school, p_show_department, p_show_class)
  on conflict (user_id) do update
    set hide_same_class = excluded.hide_same_class, hide_same_department = excluded.hide_same_department,
        hide_same_school = excluded.hide_same_school, show_department = excluded.show_department,
        show_class = excluded.show_class;
  delete from public.hidden_affiliations h where h.user_id = v_me;
  insert into public.hidden_affiliations (user_id, school_id) select v_me, x from unnest(v_schools) x;
  insert into public.hidden_affiliations (user_id, department_id) select v_me, x from unnest(v_depts) x;
  insert into public.hidden_affiliations (user_id, class_id) select v_me, x from unnest(v_classes) x;
  return private.ok(null);
end $$;

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
  has_mode              boolean,
  eligible              boolean,
  birth_date            date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_me uuid := private.require_user();
begin
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
           exists (select 1 from public.profile_modes m where m.user_id = v_me),
           private.is_eligible(v_me),
           u.birth_date
    from (select 1) one
    left join public.profiles p              on p.user_id = v_me
    left join private.user_private u         on u.user_id = v_me
    left join public.account_verifications v on v.user_id = v_me
    left join public.affiliations a          on a.user_id = v_me;
end $$;

create function public.deactivate_account()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_status public.account_status;
begin
  select p.account_status into v_status from public.profiles p where p.user_id = v_me;
  if not found or v_status in ('suspended', 'deleted') then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  update public.profiles p set account_status = 'deactivated'
  where p.user_id = v_me and p.account_status = 'active';
  if not found then
    return private.deny('invalid_state');
  end if;
  return private.ok(null);
end $$;

create function public.reactivate_account()
returns public.rpc_outcome
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_user();
  v_status public.account_status;
begin
  select p.account_status into v_status from public.profiles p where p.user_id = v_me;
  if not found or v_status in ('suspended', 'deleted') then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  update public.profiles p set account_status = 'active'
  where p.user_id = v_me and p.account_status = 'deactivated';
  if not found then
    return private.deny('invalid_state');
  end if;
  return private.ok(null);
end $$;

-- any -> deleted (terminal, §7). Eligibility ends at once; active connections end and pending requests close.
create function public.request_account_deletion()
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
          select case when q.requester_id = v_me then q.recipient_id else q.requester_id end
          from public.connection_requests q
          where q.status = 'pending' and v_me in (q.requester_id, q.recipient_id)) o
    order by o.other
  loop
    perform private.lock_pair(v_me, r.other, false);
  end loop;
  update public.profiles p set account_status = 'deleted' where p.user_id = v_me and p.account_status <> 'deleted';
  if not found then
    return private.deny('invalid_state');
  end if;
  update public.connection_requests q set status = 'expired', closed_at = q.expires_at
  where q.status = 'pending' and q.expires_at <= now() and v_me in (q.requester_id, q.recipient_id);
  update public.connection_requests q set status = 'invalidated', closed_at = now()
  where q.status = 'pending' and v_me in (q.requester_id, q.recipient_id);
  update public.connections k set ended_at = now(), ended_reason = 'account_deleted'
  where k.ended_at is null and v_me in (k.user_low, k.user_high);
  return private.ok(null);
end $$;

revoke all on function
  public.discover_profiles(public.discover_mode, int, int, text[], uuid[], uuid, int),
  public.get_profile(uuid, public.discover_mode),
  public.authorize_photo_delivery(uuid[]),
  public.start_onboarding(text, text, date, boolean),
  public.update_birth_date(date),
  public.update_profile(text, text, text, text, text, text, text[]),
  public.set_modes(public.discover_mode[]),
  public.set_affiliation(uuid, uuid, uuid),
  public.complete_profile(),
  public.remove_photo(uuid),
  public.reorder_photos(uuid[]),
  public.service_register_photo(uuid, text),
  public.submit_verification(public.verification_kind, text[]),
  public.withdraw_verification(uuid),
  public.update_privacy_settings(boolean, boolean, boolean, boolean, boolean, uuid[], uuid[], uuid[]),
  public.my_account(),
  public.deactivate_account(),
  public.reactivate_account(),
  public.request_account_deletion()
from public, anon, authenticated, service_role;

grant execute on function
  public.discover_profiles(public.discover_mode, int, int, text[], uuid[], uuid, int),
  public.get_profile(uuid, public.discover_mode),
  public.authorize_photo_delivery(uuid[]),
  public.start_onboarding(text, text, date, boolean),
  public.update_birth_date(date),
  public.update_profile(text, text, text, text, text, text, text[]),
  public.set_modes(public.discover_mode[]),
  public.set_affiliation(uuid, uuid, uuid),
  public.complete_profile(),
  public.remove_photo(uuid),
  public.reorder_photos(uuid[]),
  public.submit_verification(public.verification_kind, text[]),
  public.withdraw_verification(uuid),
  public.update_privacy_settings(boolean, boolean, boolean, boolean, boolean, uuid[], uuid[], uuid[]),
  public.my_account(),
  public.deactivate_account(),
  public.reactivate_account(),
  public.request_account_deletion()
to authenticated;
grant execute on function public.service_register_photo(uuid, text) to service_role;
