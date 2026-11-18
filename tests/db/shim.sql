-- BE-001 test-only Supabase compatibility shim (docs/04_DATABASE.md §13.1).
-- Never part of supabase/migrations. Mirrors the pieces of Supabase the design
-- relies on: the API roles, auth.users with the columns the session check reads,
-- auth.uid()/auth.jwt() reading request.jwt.claims, and Supabase's default
-- grants on new public objects (so a missing revoke in a migration is caught by
-- the catalog tests).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;

create table auth.users (
  id                 uuid primary key,
  email              text unique,
  email_confirmed_at timestamptz,
  is_anonymous       boolean not null default false,
  created_at         timestamptz not null default now()
);

-- SEC-003: the columns of Supabase's auth.mfa_factors that admin_grant_role reads (order 20), with Supabase's types.
-- SEC-013: created_at, which private.staff_role_effective compares with granted_at (order 29).
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.mfa_factors (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  factor_type auth.factor_type not null,
  status      auth.factor_status not null,
  created_at  timestamptz not null default now()
);

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- Supabase defaults: every new public table/function/sequence created by postgres
-- is granted to the API roles. Migrations must revoke what they do not allow.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Supabase creates this publication; local test compatibility only.
create publication supabase_realtime;

-- STORAGE-001 test-only Storage stand-in, never shipped as a migration.
-- Models SQL metadata/RLS only, not the Storage API, S3/TUS, transforms or CDN.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to authenticated;
