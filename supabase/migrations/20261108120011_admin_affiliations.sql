-- ADMIN-003: docs/04_DATABASE.md §5 admin_list_affiliations.
create function public.admin_list_affiliations()
returns table(level text, id uuid, parent_id uuid, name text, is_active boolean, sort_order int, academic_year smallint)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff('admin');
  return query
  select r.level, r.id, r.parent_id, r.name, r.is_active, r.sort_order, r.academic_year
  from (
    select 'school'::text as level, s.id, null::uuid as parent_id, s.name, s.is_active, s.sort_order, null::smallint as academic_year, 1 as rank
    from public.schools s
    union all
    select 'department'::text, d.id, d.school_id, d.name, d.is_active, d.sort_order, null::smallint, 2
    from public.departments d
    union all
    select 'class'::text, c.id, c.department_id, c.name, c.is_active, 0, c.academic_year, 3
    from public.classes c
  ) r
  order by r.rank, r.sort_order, r.name, r.academic_year nulls first, r.id;
end;
$$;
revoke all on function public.admin_list_affiliations() from public, anon, authenticated, service_role;
grant execute on function public.admin_list_affiliations() to authenticated;
