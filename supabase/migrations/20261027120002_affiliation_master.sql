-- BE-001 order 2: affiliation master (docs/04_DATABASE.md §3.2, §6). Admin-managed, no physical delete.

create table public.schools (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(name) between 1 and 80),
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id),
  name       text not null check (char_length(name) between 1 and 80),
  is_active  boolean not null default true,
  sort_order int not null default 0,
  unique (school_id, name),
  unique (school_id, id)
);

create table public.classes (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  name          text not null check (char_length(name) between 1 and 40),
  academic_year smallint,
  is_active     boolean not null default true,
  unique nulls not distinct (department_id, name, academic_year),
  unique (department_id, id)
);

alter table public.schools     enable row level security;
alter table public.departments enable row level security;
alter table public.classes     enable row level security;

revoke all on table public.schools, public.departments, public.classes
  from public, anon, authenticated, service_role;
grant select on table public.schools, public.departments, public.classes to authenticated;

create policy schools_active on public.schools for select to authenticated using (is_active);
create policy departments_active on public.departments for select to authenticated using (is_active);
create policy classes_active on public.classes for select to authenticated using (is_active);
