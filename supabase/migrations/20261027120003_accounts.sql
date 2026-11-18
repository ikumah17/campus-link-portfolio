-- BE-001 order 3: accounts, profiles, affiliation and privacy settings, blocks
-- (docs/04_DATABASE.md §3.3, §3.4, §3.8, §6, §7).

create table public.profiles (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  display_name         text not null check (char_length(display_name) between 1 and 20),
  gender               text not null check (gender in ('female', 'male', 'other')),
  bio_romance          text check (char_length(bio_romance) <= 500),
  bio_friends          text check (char_length(bio_friends) <= 500),
  purpose_romance      text check (char_length(purpose_romance) <= 200),
  purpose_friends      text check (char_length(purpose_friends) <= 200),
  hobbies              text[] not null default '{}' check (private.hobbies_ok(hobbies)),
  account_status       public.account_status not null default 'active',
  profile_completed_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table private.user_private (
  user_id              uuid primary key references public.profiles(user_id) on delete cascade,
  birth_date           date not null check (birth_date > date '1900-01-01'),
  birth_date_locked_at timestamptz
);

create table public.profile_modes (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  mode    public.discover_mode not null,
  primary key (user_id, mode)
);

create table public.profile_photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(user_id) on delete cascade,
  storage_path text not null unique,
  position     smallint not null check (position between 0 and 5),
  status       text not null default 'active' check (status in ('active', 'removed')),
  created_at   timestamptz not null default now(),
  check (storage_path like user_id::text || '/%')
);
create unique index profile_photos_active_position
  on public.profile_photos (user_id, position) where status = 'active';

create table public.account_verifications (
  user_id           uuid primary key references public.profiles(user_id) on delete cascade,
  age_verified_at   timestamptz,
  age_submission_id uuid,             -- FK added in order 4
  age_revoked_at    timestamptz,
  updated_at        timestamptz not null default now()
);

create table public.affiliations (
  user_id                 uuid primary key references public.profiles(user_id) on delete cascade,
  school_id               uuid not null references public.schools(id),
  department_id           uuid not null,
  class_id                uuid not null,
  status                  public.affiliation_status not null default 'unconfirmed',
  confirmed_until         timestamptz,
  confirmed_by_submission uuid,       -- FK added in order 4
  updated_at              timestamptz not null default now(),
  foreign key (school_id, department_id) references public.departments(school_id, id),
  foreign key (department_id, class_id)  references public.classes(department_id, id),
  check ((status = 'confirmed') = (confirmed_until is not null and confirmed_by_submission is not null))
);
create index on public.affiliations (school_id);
create index on public.affiliations (department_id);
create index on public.affiliations (class_id);

create table public.privacy_settings (
  user_id              uuid primary key references public.profiles(user_id) on delete cascade,
  hide_same_class      boolean not null default true,
  hide_same_department boolean not null default false,
  hide_same_school     boolean not null default false,
  show_department      boolean not null default false,
  show_class           boolean not null default false,
  updated_at           timestamptz not null default now()
);

create table public.hidden_affiliations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(user_id) on delete cascade,
  school_id     uuid references public.schools(id),
  department_id uuid references public.departments(id),
  class_id      uuid references public.classes(id),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(school_id, department_id, class_id) = 1)
);
create unique index hidden_affiliations_unique
  on public.hidden_affiliations (user_id, coalesce(school_id, department_id, class_id));

-- r3 (ARCH-R2-02): no FK on blocked_id, so the row does not depend on the target existing
create table public.blocks (
  blocker_id            uuid not null references public.profiles(user_id) on delete cascade,
  blocked_id            uuid not null,
  blocked_name_snapshot text,
  created_at            timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id),
  check (char_length(blocked_name_snapshot) between 1 and 20)
);
create index on public.blocks (blocked_id);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger account_verifications_updated_at before update on public.account_verifications
  for each row execute function private.set_updated_at();
create trigger affiliations_updated_at before update on public.affiliations
  for each row execute function private.set_updated_at();
create trigger privacy_settings_updated_at before update on public.privacy_settings
  for each row execute function private.set_updated_at();

-- §7 account: active <-> deactivated, active/deactivated -> suspended, suspended -> active, any -> deleted (terminal)
create function private.account_status_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.account_status is distinct from old.account_status
     and (old.account_status::text || '>' || new.account_status::text) not in (
       'active>deactivated', 'deactivated>active', 'active>suspended', 'deactivated>suspended',
       'suspended>active', 'active>deleted', 'deactivated>deleted', 'suspended>deleted') then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger profiles_account_status before update on public.profiles
  for each row execute function private.account_status_transition();

-- §7 affiliation: unconfirmed/rejected/expired confirmed -> pending -> confirmed/rejected, pending -> unconfirmed,
-- confirmed -> confirmed (renewal), confirmed -> rejected (revocation), any -> unconfirmed (affiliation change).
-- The school/department/class only change together with a move to unconfirmed.
create function private.affiliation_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'unconfirmed'
     and (new.school_id, new.department_id, new.class_id) is distinct from (old.school_id, old.department_id, old.class_id) then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  if not (
       new.status = 'unconfirmed'
    or (new.status = 'pending' and (old.status in ('unconfirmed', 'rejected')
                                    or (old.status = 'confirmed' and old.confirmed_until <= now())))
    or (new.status = 'confirmed' and old.status in ('pending', 'confirmed'))
    or (new.status = 'rejected' and old.status in ('pending', 'confirmed'))) then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger affiliations_transition before update on public.affiliations
  for each row execute function private.affiliation_transition();

-- §5 account restriction: self-service RPCs need a profile in an allowed status (forbidden before any write)
create function private.require_account(p_user uuid, p_allow_deactivated boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles p
                 where p.user_id = p_user
                   and (p.account_status = 'active'
                        or (p_allow_deactivated and p.account_status = 'deactivated'))) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
end $$;

revoke all on function private.account_status_transition(), private.affiliation_transition(),
  private.require_account(uuid, boolean)
from public, anon, authenticated, service_role;

alter table public.profiles              enable row level security;
alter table private.user_private         enable row level security;
alter table public.profile_modes         enable row level security;
alter table public.profile_photos        enable row level security;
alter table public.account_verifications enable row level security;
alter table public.affiliations          enable row level security;
alter table public.privacy_settings      enable row level security;
alter table public.hidden_affiliations   enable row level security;
alter table public.blocks                enable row level security;

revoke all on table public.profiles, private.user_private, public.profile_modes, public.profile_photos,
  public.account_verifications, public.affiliations, public.privacy_settings,
  public.hidden_affiliations, public.blocks
from public, anon, authenticated, service_role;

-- §6 own-row tables (blocks: no privileges, read only through list_my_blocks)
grant select on table public.profiles, public.profile_modes, public.profile_photos,
  public.account_verifications, public.affiliations, public.privacy_settings,
  public.hidden_affiliations
to authenticated;

create policy profiles_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profile_modes_own on public.profile_modes for select to authenticated
  using (user_id = (select auth.uid()));
create policy profile_photos_own on public.profile_photos for select to authenticated
  using (user_id = (select auth.uid()));
create policy account_verifications_own on public.account_verifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy affiliations_own on public.affiliations for select to authenticated
  using (user_id = (select auth.uid()));
create policy privacy_settings_own on public.privacy_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy hidden_affiliations_own on public.hidden_affiliations for select to authenticated
  using (user_id = (select auth.uid()));
