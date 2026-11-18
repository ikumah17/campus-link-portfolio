-- BE-001 order 5: staff roles, audit, rate limits, settings (docs/04_DATABASE.md §3.9, §4, §5, §8).

create table private.staff_roles (
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.staff_role not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, role, granted_at)
);
create unique index staff_roles_active on private.staff_roles (user_id, role) where revoked_at is null;

-- append-only: row UPDATE/DELETE and statement TRUNCATE are always rejected (owner path too)
create table private.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   text,
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create trigger audit_log_no_update_delete before update or delete on private.audit_log
  for each row execute function private.deny_audit_change();
create trigger audit_log_no_truncate before truncate on private.audit_log
  for each statement execute function private.deny_audit_change();

create table private.rate_limit_events (
  user_id    uuid not null,
  action     text not null,
  created_at timestamptz not null default now()
);
create index on private.rate_limit_events (user_id, action, created_at);

create table private.app_settings (key text primary key, value text not null);
insert into private.app_settings values ('verification_intake', 'synthetic');

alter table private.staff_roles       enable row level security;
alter table private.audit_log         enable row level security;
alter table private.rate_limit_events enable row level security;
alter table private.app_settings      enable row level security;
revoke all on table private.staff_roles, private.audit_log, private.rate_limit_events, private.app_settings
  from public, anon, authenticated, service_role;
revoke all on sequence private.audit_log_id_seq from public, anon, authenticated, service_role;

-- audit: one row per successful management operation; never C3 values (birth dates, document content)
create function private.audit(p_actor uuid, p_action text, p_target_type text, p_target_id text, p_detail jsonb)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into private.audit_log (actor_id, action, target_type, target_id, detail)
  values (p_actor, p_action, p_target_type, p_target_id, coalesce(p_detail, '{}'::jsonb))
$$;

-- P4 values are provisional (docs/03_ARCHITECTURE.md §12 P4); this is the single place to change them.
create function private.rate_policy(p_action text, out max_count int, out window_length interval)
language plpgsql immutable set search_path = '' as $$
begin
  case p_action
    when 'request' then max_count := 20;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'report'  then max_count := 10;   window_length := interval '1 day';    -- attempts, rejected ones included
    when 'message' then max_count := 30;   window_length := interval '1 minute';
    when 'block'   then max_count := 20;   window_length := interval '1 day';
    when 'privacy' then max_count := 20;   window_length := interval '1 day';
    else raise exception 'unknown rate action %', p_action;
  end case;
end $$;

create function private.block_total_limit() returns int
language sql immutable set search_path = '' as $$ select 500 $$;

-- re-request wait after a non-accepted end; the end point depends on closed_at only (P4, provisional)
create function private.request_retry_wait() returns interval
language sql immutable set search_path = '' as $$ select interval '14 days' $$;

-- callers hold private.lock_rate(user, action) before counting and recording
create function private.rate_ok(p_user uuid, p_action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select count(e.user_id) < max(pol.max_count)
  from private.rate_policy(p_action) pol
  left join private.rate_limit_events e
    on e.user_id = p_user and e.action = p_action and e.created_at > now() - pol.window_length
$$;

create function private.rate_record(p_user uuid, p_action text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into private.rate_limit_events (user_id, action) values (p_user, p_action)
$$;

-- §4 role check (r4, ARCH-R3-FINAL-02): volatile so the statement after the lock reads the latest role rows
create function private.require_staff(p_role public.staff_role, p_exclusive boolean default false) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.require_user();
begin
  perform private.lock_staff_roles(p_exclusive);
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
     or not exists (select 1 from private.staff_roles r
                    where r.user_id = v_uid and r.role = p_role and r.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  return v_uid;
end $$;

-- §4 storage self-check for the owner's verification document upload (policy applied in BE-002)
create function private.rls_document_upload_allowed(p_object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.uid is not null
     and split_part(p_object_name, '/', 1) = s.uid::text
     and (select c.value = 'upload' from private.app_settings c
          where c.key = 'verification_intake'), false)
  from (select private.session_uid() as uid) s
$$;

revoke all on function
  private.audit(uuid, text, text, text, jsonb), private.rate_policy(text), private.block_total_limit(),
  private.request_retry_wait(), private.rate_ok(uuid, text), private.rate_record(uuid, text),
  private.require_staff(public.staff_role, boolean), private.rls_document_upload_allowed(text)
from public, anon, authenticated, service_role;
grant execute on function private.rls_document_upload_allowed(text) to authenticated;
