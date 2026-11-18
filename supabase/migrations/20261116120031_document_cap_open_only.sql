-- RETENTION-006 order 31: the document upload cap counts only unnamed and open-submission objects
-- (SECREVIEW-003 P-4, docs/04_DATABASE.md §9, §11). Order 28 counted every object in the caller's folder of
-- verification-documents, including the documents of decided submissions, which stay 30 days after the decision;
-- a user rejected a few times (up to 4 objects each) could then be refused a resubmission for up to 30 days.
-- Count rule: an object in the caller's folder counts unless one of the caller's own upload-mode submissions with
-- status approved, rejected or revoked names it and no submitted or in_review submission (of anyone) names it.
-- So unnamed objects and objects of open submissions count, an object named by both a decided and an open
-- submission counts (order 27 refuses shared refs, but the rule does not rely on that), and objects named only by
-- withdrawn or superseded submissions still count: no retention kind sweeps those, so they must stay under the cap.
-- The limit stays 16, checked before the new row is stored (best effort under concurrent inserts).
-- Storage bound per user: an uncounted object is exactly a ref the document kind sweeps 30 days after its decision
-- (or the account kind with the account); unnamed objects are swept after 24 hours (orphan_document); an open
-- submission holds at most 4 refs and a user has at most one open submission per kind
-- (one_open_submission_per_kind); every other object counts. So a user keeps at most 16 counted objects plus at
-- most 4 per staff decision of the last 30 days.
-- Unchanged from order 28: the path rule, the folder check, upload mode, the signature, security definer,
-- search_path = '', stable and the grants; service_retention_candidates, submit_verification and the policy
-- verification_documents_insert itself.

create or replace function private.rls_document_upload_allowed(p_object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.uid is not null
     and split_part(p_object_name, '/', 1) = s.uid::text
     and p_object_name ~ ('^' || s.uid::text || '/[A-Za-z0-9_-]{1,64}(/[A-Za-z0-9_-]{1,64})*\.webp$')
     and (select c.value = 'upload' from private.app_settings c
          where c.key = 'verification_intake')
     and (select count(*) from (select 1 from storage.objects so
                                where so.bucket_id = 'verification-documents'
                                  and so.name like s.uid::text || '/%'
                                  -- a decided upload's document is swept 30 days after the decision, unless still open
                                  and not (exists (select 1 from public.verification_submissions d
                                                   where d.user_id = s.uid and d.intake_mode = 'upload'
                                                     and d.status in ('approved', 'rejected', 'revoked')
                                                     and so.name = any (d.document_refs))
                                           and not exists (select 1 from public.verification_submissions o
                                                           where o.status in ('submitted', 'in_review')
                                                             and so.name = any (o.document_refs)))
                                limit 16) n) < 16, false)
  from (select private.session_uid() as uid) s
$$;

revoke all on function private.rls_document_upload_allowed(text) from public, anon, authenticated, service_role;
grant execute on function private.rls_document_upload_allowed(text) to authenticated;
