-- BE-001 order 4: age and enrollment verification (docs/04_DATABASE.md §3.5, §6, §7).

create table public.verification_submissions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(user_id) on delete cascade,
  kind                 public.verification_kind not null,
  status               public.verification_status not null default 'submitted',
  intake_mode          text not null check (intake_mode in ('synthetic', 'upload')),
  document_refs        text[] not null check (cardinality(document_refs) between 1 and 4),
  affiliation_snapshot jsonb,
  reviewer_id          uuid references auth.users(id),
  claimed_at           timestamptz,
  decided_at           timestamptz,
  decision_reason      text check (char_length(decision_reason) <= 64),
  valid_until          timestamptz,
  version              int not null default 0,
  created_at           timestamptz not null default now(),
  check ((kind = 'enrollment') = (affiliation_snapshot is not null)),
  check (case status
    when 'submitted'  then reviewer_id is null and claimed_at is null and decided_at is null
    when 'in_review'  then reviewer_id is not null and claimed_at is not null and decided_at is null
    when 'approved'   then reviewer_id is not null and decided_at is not null
    when 'rejected'   then reviewer_id is not null and decided_at is not null
    when 'revoked'    then reviewer_id is not null and decided_at is not null
    when 'withdrawn'  then reviewer_id is null and claimed_at is null and decided_at is not null
    when 'superseded' then reviewer_id is null and claimed_at is null and decided_at is not null
                           and kind = 'enrollment' and decision_reason = 'affiliation_changed'
    else false end)
);
create unique index one_open_submission_per_kind
  on public.verification_submissions (user_id, kind) where status in ('submitted', 'in_review');

alter table public.account_verifications
  add constraint account_verifications_age_submission_fk
  foreign key (age_submission_id) references public.verification_submissions(id);
alter table public.affiliations
  add constraint affiliations_confirmed_by_submission_fk
  foreign key (confirmed_by_submission) references public.verification_submissions(id);

-- §7: only the listed transitions, each with version + 1; identity and evidence columns never change
create function private.verification_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.version is distinct from old.version + 1
     or (new.id, new.user_id, new.kind, new.intake_mode, new.document_refs, new.affiliation_snapshot, new.created_at)
        is distinct from (old.id, old.user_id, old.kind, old.intake_mode, old.document_refs, old.affiliation_snapshot, old.created_at)
     or (old.status::text || '>' || new.status::text) not in (
       'submitted>in_review', 'in_review>submitted', 'in_review>approved', 'in_review>rejected',
       'submitted>withdrawn', 'submitted>superseded', 'in_review>superseded', 'approved>revoked') then
    raise exception using errcode = 'P0001', message = 'transition_denied';
  end if;
  return new;
end $$;
create trigger verification_submissions_transition before update on public.verification_submissions
  for each row execute function private.verification_transition();

revoke all on function private.verification_transition() from public, anon, authenticated, service_role;

alter table public.verification_submissions enable row level security;
revoke all on table public.verification_submissions from public, anon, authenticated, service_role;
-- column-level only: reviewer, claim, version, document and snapshot columns stay hidden even from the owner
grant select (id, user_id, kind, status, created_at, decided_at, decision_reason, valid_until)
  on public.verification_submissions to authenticated;
create policy verification_submissions_own on public.verification_submissions for select to authenticated
  using (user_id = (select auth.uid()));
