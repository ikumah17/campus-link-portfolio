-- STORAGE-001: docs/04_DATABASE.md §9, §12 order 15.
-- Private WebP buckets; users may only insert verification documents when enabled.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('profile-photos', 'profile-photos', false, 2097152, '{image/webp}'),
  ('verification-documents', 'verification-documents', false, 5242880, '{image/webp}')
on conflict (id) do nothing;

create policy verification_documents_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'verification-documents' and private.rls_document_upload_allowed(name));
