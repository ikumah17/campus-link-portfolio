// Permission allowlists from docs/04_DATABASE.md §1, §4, §5, §6 (written independently of the migrations).
// A new table, function or grant that is not listed here makes the catalog tests fail.

export const PUBLIC_TABLES = [
  "account_verifications", "affiliations", "blocks", "classes", "connection_requests", "connections",
  "conversation_reads", "conversations", "departments", "hidden_affiliations", "likes", "messages", "privacy_settings",
  "profile_photos", "profiles", "reports", "schools", "verification_submissions",
].sort();

export const PRIVATE_TABLES = [
  "app_settings", "audit_log", "hidden_bios", "hidden_messages", "hidden_request_messages", "rate_limit_events", "report_actions", "report_evidence", "staff_roles", "user_private",
].sort();

/** authenticated: table-level SELECT only */
export const AUTHENTICATED_SELECT_TABLES = [
  "account_verifications", "affiliations", "classes", "conversation_reads", "departments", "hidden_affiliations",
  "messages", "privacy_settings", "profile_photos", "profiles", "schools",
].sort();

/** authenticated: the only column-level grant (§3.5) */
export const VERIFICATION_SUBMISSION_COLUMNS = [
  "created_at", "decided_at", "decision_reason", "id", "kind", "status", "user_id", "valid_until",
].sort();

/** state-changing public RPCs: return public.rpc_outcome (§5, NT-27) */
export const STATE_CHANGING_RPCS = [
  "start_onboarding", "update_birth_date", "update_profile", "set_affiliation", "complete_profile",
  "remove_photo", "reorder_photos", "reserve_photo_upload", "reserve_mfa_attempt", "submit_verification", "withdraw_verification", "update_privacy_settings",
  "deactivate_account", "reactivate_account", "request_account_deletion",
  "like_user", "unlike_user", "end_connection",
  "send_message", "mark_read", "block_user", "unblock_user", "submit_report",
  "admin_claim_submission", "admin_release_submission", "admin_decide_submission", "admin_revoke_verification",
  "admin_set_account_status", "admin_upsert_school", "admin_upsert_department", "admin_upsert_class",
  "admin_update_report", "admin_grant_role", "admin_revoke_role", "admin_grant_role_by_email",
  "admin_hide_reported_content", "admin_unhide_reported_content",
].sort();

/** read RPCs (rows; 0 rows for a not_available read) */
export const READ_RPCS = [
  "discover_profiles", "get_profile", "authorize_photo_delivery", "my_account", "list_my_likes", "get_like_state",
  "list_my_conversations", "list_messages", "list_my_blocks", "my_reports",
  "admin_list_submissions", "admin_get_submission", "admin_authorize_document_view", "admin_list_reports",
  "admin_get_report", "admin_list_affiliations", "admin_list_staff", "my_staff_roles",
  "admin_list_suspended_accounts", "admin_get_report_content", "admin_authorize_report_photo",
].sort();

/** service_role only (E-1); service_reserve_signin takes (p_email, p_ip default null) since order 24 (SEC-008), and
 * service_reserve_signup the same since order 25 (SEC-012) */
export const SERVICE_RPCS = ["service_register_photo", "service_reserve_signin", "service_reserve_signup"];

/** service_role only, not rpc_outcome (RETENTION-001): the retention sweep's candidate list and rate-limit purge */
export const SERVICE_MAINTENANCE_RPCS = ["service_purge_rate_limits", "service_retention_candidates"];

/** VERIFY-004: revoke only by submission; the former (uuid, verification_kind, text) overload is gone. */
export const REVOKE_VERIFICATION_ARGUMENTS = ["uuid", "text"];

/** private functions authenticated may execute: RLS/storage self-checks only (rls_own_uid: own-row policies, ACCOUNT-003) */
export const AUTHENTICATED_PRIVATE_FUNCTIONS = ["rls_conversation_member", "rls_document_upload_allowed", "rls_own_uid"].sort();
