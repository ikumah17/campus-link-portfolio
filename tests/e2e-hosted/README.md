# Hosted dev E2E

Run `npm run test:e2e:hosted` from the repository root. This is an explicitly
opted-in suite for the free `campus-link-dev` project only. It does not run in
`npm test` or the demo `npm run test:e2e`. Run the demo and hosted browser suites
sequentially because each builds the application with its own backend setting.
Chrome and the existing project dependencies must already be installed.

SEC-010: the chat test (group 4) also checks after sign-in that `document.cookie` has no `sb-` cookie and that the `sb-` auth cookie is `httpOnly`; Realtime gets its token from `GET /api/realtime-token`.

The default command runs the existing 11 tests without NT-19 or NT-21. To include the two
Realtime revocation cases as well, run `npm run test:e2e:hosted:nt21`, which sets
`CAMPUS_E2E_NT21=1` for that process. The `realtime-revocation` project is only
selected with that exact environment value.

Run `npm run test:e2e:hosted:nt19` to include group 11 (`CAMPUS_E2E_NT19=1`).
It depends on roles, adds three fresh run users (subject U, reviewer/admin X,
admin Y), and uses only each actor's own Auth JWT for app RPCs. Group 11b adds
three more, so with setup's two and the likes group's two the run creates ten
run users, the cap in `lifecycle.ts` (`MAX_RUN_USERS`). The server key
is still limited to the existing exact-user setup and cleanup. Run-user TOTP
secrets and session tokens live in Node memory only; the existing e2e-admin
factor must already be configured. No new package or hosted schema change is
needed. The default command does not select group 11.

MOD-001 adds the reported-content hide and undo as group 20:
`npm run test:e2e:hosted:hide-content` sets `CAMPUS_E2E_HIDE_CONTENT=1` and
runs the default groups with `20-hide-content.hosted.ts` inserted right after
chat (group 4), while A and B still share the run room; it extends only the
default groups and is refused together with the other single-flow variables.
A sends B a run-owned message, B reports it, e2e-admin hides it from the report
detail, and both participants then see only the placeholder, in the room and in
B's direct PostgREST read of `public.messages` with B's own JWT. The hide is then
undone, so the later groups see the room as before; the report stays as a normal
audit row. e2e-admin needs the moderator role (as group 6 already does), and the
hosted project needs migration order 33 (`20261117120033_hide_reported_content.sql`,
applied by the coordinator in HOSTED-019); the default command does not select
group 20. The group checks only message hiding and its undo; bio, photo and
request-message hiding are not run on hosted.

HOSTED-RET-001 proves the retention sweep's `--apply` in two separate
invocations. `CAMPUS_E2E_RETENTION=prepare|verify` (any other value is refused)
selects only `12-retention.hosted.ts`; the default projects are not run.
`npm run test:e2e:hosted:retention:prepare` onboards U (`users[0]`) and K
(`users[1]`) with one photo each. The app has no account-deletion screen, so U
calls the app RPC `request_account_deletion` with its own JWT; `my_account` must
then say `deleted` for U and `active` for K. Teardown keeps the ledger (with the
passwords blanked) for the coordinator, who backdates U's `deleted_at` by SQL;
the suite never runs SQL. `npm run test:e2e:hosted:retention:verify` reuses that
exact ledger (no cleanup, no new users). It runs `scripts/maintenance/retention.mjs`
as a child process that reads `.env.local` itself, first as a dry run that must
list exactly U and U's photos (no documents, no skipped reviewers, not
truncated); anything else fails before `--apply`. It then marks the ledger
`applying` and runs `--apply --confirm exampleprojectrefabc` exactly once. While
the ledger says `applying`, every cleanup refuses: a partial apply is the
coordinator's to resolve (the script continues from what is left). Read-back
with the server key requires U's Auth user 404 and no objects under its photo
folder, K's Auth user and photo names unchanged, and e2e-admin still an active
admin at aal2. A second dry run must list nothing; only then teardown deletes K
and the run's leftovers. A failed verify keeps the ledger. Evidence keeps counts
and statuses only.

HOSTED-E2E-005 checks the visibility rules on hosted in its own invocation:
`npm run test:e2e:hosted:visibility` sets `CAMPUS_E2E_VISIBILITY=1` and selects
only `14-visibility.hosted.ts` (never with the account or retention variables).
It uses five fictional run users made through the app flows: V, S (same class),
D (same school, other department), O (other school) and U (same class, age
approved but enrollment never submitted, so its affiliation stays
`unconfirmed`). The existing affiliation master is used; no rows are added.
Each check compares every ordered pair on the discover list, the detail page
and the photo route from the viewer's own browser session against the local
oracle (`tests/db/oracle.ts`) evaluated over the state the file set. The cases
are the defaults, same class/department/school on and off, one specified
school/department/class each added and removed, department/class disclosure,
U isolated as unconfirmed, and `/search` by school (the only search filter).
A disagreement is a soft failure listed under `findings`; expectations are
never changed to match hosted. Evidence keeps role letters, counts and
pass/fail only, and teardown deletes all five users.

A11Y-002 runs axe on the screens that exist only against hosted Supabase:
`npm run test:e2e:hosted:a11y` sets `CAMPUS_E2E_A11Y=1` and selects only
`15-a11y.hosted.ts` (never with the account, retention or visibility variables).
The rule tags and the serious/critical threshold are those of `tests/a11y.spec.ts`;
each state is checked at 390 and 1280 px. The two run users onboard and submit the
synthetic documents; e2e-admin's MFA challenge form is checked before the code is
entered, then e2e-admin claims and approves only those four submissions (the
detail page is checked for each kind, with and without a rejection reason), opens
the run's own report (decision controls, then the suspension dialog, cancelled),
and on the staff screen grants run user A the reviewer role, checks the removal
dialog and removes it. B sends A one message and A's room is checked before and
after filling the composer. A's `/settings/account` is checked with the deletion
confirmation open; it is cancelled, never confirmed. The MFA enrolment form is not
reachable while e2e-admin has a verified factor and is reported as such.
`.e2e-hosted/evidence.json` key `a11y` keeps only screen, width, state, node counts
by impact and rule ids; no DOM text, names, ids or screenshots. Teardown deletes
both users; the fictional report and role history stay as normal audit rows.

TEST-009 adds `/admin/accounts` to the same invocation, on e2e-admin's existing
session (no extra sign-in). Right after the report step, run user B is suspended
from the run's own report, the list is checked with B's row (found by the run
state's display name, never printed) and with B's 「停止を解除」 dialog open, and B
is reactivated there; if the list is then empty, its empty state is checked too,
otherwise evidence records `emptyState: "skipped (other rows)"` and no other row
is read. A `finally` block reactivates B from the report if it is still suspended,
so the later chat and MFA steps see an active B.

TEST-010 fills the remaining live-screen gaps in the same invocation, on the
same run users and e2e-admin's one session: A's `/onboarding` profile step, the
Discover verification gate, `/verification` before and after submitting, the
`/admin` dashboard, the review queue (and its empty state when no other
submission is queued; otherwise it is listed under `unreachable`), and
`/admin/affiliations` read-only. e2e-admin rejects A's first submission once with
the first listed reason; A's `/verification` is checked after the rejection,
A resubmits that kind, and e2e-admin approves it, so both users end verified as
before. Discover with B listed, Discover with no results (`min=120`), `/search`,
B's profile detail with the report dialog, the like button and the liked state,
`/admin/reports`, B's empty `/likes` (both tabs) and `/talk` before A's like,
A's sent like, B's received like and the match, A's talk list with the room, A's `/mypage`, `/settings/privacy` and `/settings/blocks`
(no blocks) are checked too. This adds one UI sign-in for A (the
post-rejection `/verification`) and none for B or e2e-admin.

TEST-011 adds three states to the same invocation, with no extra e2e-admin
sign-in. On `/admin/staff`, before the reviewer grant, e2e-admin submits two
grants that are refused and write nothing: a run-tagged `example.invalid`
address with no account (「該当するアカウントがありません。」) and run user B,
who has no TOTP factor yet (order 20, `mfa_required`). Each error state is
checked, and after a reload the staff list must have the same number of rows and
no row for B. Last, after every step that needs A and B connected, A blocks B
from their room, `/settings/blocks` is checked with B's entry and with the unblock
dialog open, and A unblocks B there (a `finally` block unblocks if a step fails).
This adds one UI sign-in for A.

TEST-006 adds the SEC-005 `/auth/confirmed` interstitial to the same invocation.
Run user A's one-time magic-link tokens come from the admin API's
`POST /auth/v1/admin/generate_link` (server key, `confirmTokenHash` in
`lifecycle.ts`), which sends no email and uses no email quota. Only the
`hashed_token` is used, on the app's own `/auth/confirm?token_hash=…&type=email`;
the returned `action_link` is never opened. The page follows each link with a
normal browser navigation: since FIX-001 the route's 307 carries a relative
`Location`, so the browser stays on the suite's `127.0.0.1` with the cookie the
route just set (evidence `relativeLocation: true`, `sameHost: true`), and the
proxy answers an anonymous `/mypage` with a relative `/login?next=…`
(`proxyRelativeLogin`). Each step runs in a fresh browser
context: the first link with `next=/mypage` shows the heading and A's address
(checked against the run state), is checked by axe and continues to `/mypage`; a
second link with an external `next` lands without any `next`, its 「続ける」
points to `/onboarding`, and 「自分のアカウントではありません」 goes to `/login`
and leaves no session; `/auth/confirmed` without a session goes to `/login` and
shows no address; the first link opened again goes to `/login?error=confirm`.
Every step replaces Playwright errors with fixed messages, so the token, the
confirm URL and the address never reach the reporter, and trace and screenshots
stay off. Evidence key `confirmedInterstitial` keeps booleans and the used link's
landing path and error code only.

HOSTED-E2E-006 checks the admin dashboard and the affiliation master on hosted:
`npm run test:e2e:hosted:admin-affiliations` sets `CAMPUS_E2E_ADMIN_AFFILIATIONS=1`
and selects only `16-admin-affiliations.hosted.ts` (never with the other
invocation variables). e2e-admin at aal1 is sent to the MFA challenge for every
admin page and `admin_list_affiliations` refuses its token; at aal2 the dashboard
opens each of its four entries. Run user 0 has no staff role: at aal1 it is sent
to the MFA screen, and after enrolling its own TOTP factor `/admin/affiliations`
answers 404 and the database refuses its reads and the three upsert RPCs (six
writes at each level, master compared before and after). Through the screen
e2e-admin adds one school, department and class named
「E2E学校 <runId>（架空）」 and so on, renames the class and reads them back with its
own aal2 JWT; run user 1's onboarding offers them. e2e-admin then disables all
three (the screen never deletes; they stay as inactive rows), and neither run
user 1 nor a fresh run user 2 is offered them. Every row without the run id must
be unchanged. `.e2e-hosted/affiliations.json` keeps only the run id until the rows
are inactive: an interrupted run's rows are disabled first by the next run, and an
`afterAll` disables them on failure. Evidence key `adminAffiliations` keeps counts,
pass/fail and the run-tagged fictional names only; teardown deletes the users.

TEST-013 checks the HTTP shape of refusals on hosted PostgREST:
`npm run test:e2e:hosted:postgrest` sets `CAMPUS_E2E_POSTGREST=1` and selects
only `17-postgrest-shapes.hosted.ts` (never with the other invocation
variables), with no browser and no app server. Run user A has no profile and run
user B only the profile its own `start_onboarding` makes; each signs in with its
own password, and anon sends the publishable key only. Every RPC is called once
per actor with random ids or invalid arguments. Outcome refusals
(`not_available`, `invalid_state`) must be HTTP 200 `{ok:false, code, ref:null}`
with the same status, content type, header names (date, request ids and the
gateway's size-dependent framing `content-length`/`content-encoding`/
`transfer-encoding`/`vary` excluded; framing is recorded per reply), keys and
value types, differing only in `code`; `outcome_code` has
no `forbidden`, which is always the P0001 exception. P0001 `validation` from eight
calls must be identical, `forbidden` (no profile, no staff role) identical among
itself and equal to `validation` except for `message`, and anon identical for
every RPC once the called function's name is masked in the message. The OpenAPI
root's status and whether it lists RPC paths, and whether an unknown RPC's
`hint` names a real function, are recorded, not asserted. The likes RPCs
(`like_user`, `unlike_user`, `list_my_likes`, `get_like_state`) are in each
group, and the request and mode RPCs that order 34 dropped
(`send_connection_request`, `respond_connection_request`,
`cancel_connection_request`, `list_my_requests`, `set_modes`) must answer B
with 404 `PGRST202`. Evidence key
`postgrestShapes` keeps RPC names, actor letters, statuses, codes and header
names only. TEST-015 adds `rate_limited`: a fresh run user C, created in its own
test so A's and B's limits stay untouched, calls `reserve_mfa_attempt` (10 per
user per 10 minutes) with its own JWT until the first `rate_limited` (expected
on call 11, failing if none by call 12); that reply must match the run's
`not_available` reply by the same outcome comparison, apart from `code`. Evidence
key `postgrestRateLimited` keeps the call count, statuses, header names and keys.
Teardown deletes all three users; C's `rate_limit_events` rows stay under the
deleted id, as other groups' rows do, until the 7-day purge.

TEST-014 checks that Storage refuses direct access to both buckets (NT-20):
`npm run test:e2e:hosted:storage` sets `CAMPUS_E2E_STORAGE=1` and selects only
`18-storage-denials.hosted.ts` (never with the other invocation variables), with
no browser and no app server. Run user U (`users[0]`) owns the fixtures and V
(`users[1]`) is another user; each signs in with its own password, and anon sends
the publishable key only. The server key puts one fictional WebP (random bytes in
an extra chunk) in each bucket at U's folder and is used otherwise only for the
read-back and cleanup. Every name a probe could create is saved in the ledger
first. U, V and anon each try 18 operations per bucket on plain `/storage/v1/*`:
download (plain, authenticated and public routes), info, single signed URL (60 s
and one year), bulk signed URL, list, image render, upload, signed upload URL,
overwrite (`PUT` and `x-upsert`), delete, bulk delete, move, copy and a TUS
create. Every reply must be non-2xx, except that list, bulk sign and bulk delete
answer 2xx through RLS filtering and pass only when they name, sign or delete
nothing; no reply may carry the fixture bytes or a signed URL. The server-key
read-back then requires both fixtures with the same size, etag and bytes and no
other object under U or V. Cleanup (in the file's `afterAll`, and again in global
setup/teardown while the ledger has `storage`) deletes exactly the recorded names
and requires every run folder in both buckets to be empty before the users are
deleted. Evidence keys `storageDenials`, `storageReadBack` and `storageCleanup`
keep bucket and actor labels, operations, statuses and codes only. S3-compatible
access needs separate dashboard keys and is not tried.

TEST-016 checks order 29 (SEC-013) on hosted: a staff role acts only while the
account has no verified factor created after the grant. `npm run
test:e2e:hosted:staff-totp` sets `CAMPUS_E2E_STAFF_TOTP=1` and selects only
`19-staff-totp.hosted.ts` (never with the other invocation variables). Run user
A (`users[0]`) enrolls its own TOTP on `/admin/mfa`, and e2e-admin (its existing
factor, never enrolled, removed or replaced here) grants A reviewer on
`/admin/staff`, finding A's row by its 「担当 #」 label. A at aal2 then sees only
the 学生認証審査 entry on `/admin`, `my_staff_roles` is `reviewer` and
`admin_list_submissions` answers rows. A then gets a second verified factor
through its own Auth session: first the way `Session.signIn(i, true)` does it,
enrolling at aal1 right after the password grant (hosted Auth answers 403
`insufficient_aal` while a verified factor exists, so that helper cannot add a
second factor), then with A's own aal2 session. After a fresh aal2 sign-in with
the grant-time factor, the RPC is `forbidden`, `my_staff_roles` is empty, and
`/admin` is the not-found page both in the browser session that saw the
dashboard and after a fresh `/admin/mfa` sign-in. e2e-admin revokes and grants
reviewer again on the screen, and A acts again with either factor. The last test
revokes A's role on the screen and requires e2e-admin's own `my_staff_roles` to
be admin, moderator and reviewer at the start and the end; `afterAll` revokes a
left-over role with e2e-admin's own session. Every RPC uses the actor's own
token; the server key is used only by the usual setup and teardown. Keys and
codes stay in Node memory. Evidence key `staffTotpBinding` keeps answers,
statuses and counts only.

MOBILE-API-001 checks the iOS app's Bearer-only JSON routes on hosted:
`npm run test:e2e:hosted:mobile` sets `CAMPUS_E2E_MOBILE=1` and selects only
`21-mobile-api.hosted.ts` (never with the other invocation variables). It uses
the app server but no browser: every request is plain HTTP with no cookie, as
the app sends it. Run users A (`users[0]`) and B (`users[1]`) sign in through
`POST /api/mobile/auth/signin`; each answer must be 200 with the session only in
the JSON body (no `Set-Cookie`, `no-store`, the JSON CSP, no CORS header), and
the returned token must be a session of exactly that user (`/auth/v1/user`). A
wrong password for A must answer 401 `failed` no sooner than 1500 ms; invalid
input must answer 400 on sign-in and sign-up and a form body 415, before any
reservation. Sign-up is never submitted with valid input, so no account is made
and no email is sent. A then calls `start_onboarding` with its own token (the
RPC the app calls directly), uploads one generated PNG through
`POST /api/mobile/photos` (refused 401 without a token and with a cookie alone),
finds its id in `profile_photos` with its own token, and loads it through
`GET /api/mobile/photos/[id]` (WebP, `private, max-age=120`, a `Vary` that
names `Authorization` and not `Cookie`). The same photo is 401 without a token, 404 for B, and
404 on the web's `/media/photos/[id]` with A's Bearer token (the web path reads
only its cookie). B's `DELETE` is refused (503) and the photo still loads; A's
`DELETE` answers ok, the photo is then 404, and the server-key read-back finds
no object in A's folder. Tokens stay in Node memory and never reach an assertion
message. Evidence key `mobileApi` keeps statuses and header values only;
teardown deletes both users. Sign-ins through these routes pass through the app,
so they count against `signin` like the login form: A has two attempts in this
invocation (one of them the wrong password) and B one, with no UI sign-in and no
`e2e-admin` sign-in.

NT-19 makes 20 rounds each of decision versus affiliation change, reviewer
revoke versus claim, reviewer revoke versus decision, X/Y cross-revokes with
e2e-admin as a protected third admin, and the real two-admin boundary race.
Every RPC request uses a separate TCP/TLS connection (`https.request` with
`agent:false`); both race promises start together and both settle before any
recovery. Evidence keeps request start/sent/finish timestamps and overlap,
without headers, bodies, session credentials or socket payloads. Different
local ports and overlapping sent-to-response windows are asserted. This proves
overlapping client requests, not exact lock acquisition timestamps inside
PostgreSQL. Serial order is inferred from the RPC outcomes and then checked
against the persisted submission/affiliation/staff state. Order counts and
missing reviewer-race orders are recorded honestly; missing an order is not
represented as coverage of that order.

SEC-003 (order 20) grants a staff role only to an account with a verified TOTP
factor. In the roles group, e2e-admin first tries to grant run user A the
reviewer role on `/admin/staff` while A has no factor: with order 20 the screen
says 「二段階認証（TOTP）を登録済みのアカウントにだけ役割を付けられます。」 and A is not
listed. A then enrolls and verifies its own TOTP through Auth with its own
password session (the key stays in Node memory) before the usual grant and
revoke. NT-19 X and Y (and R1/R2 in 11b) enroll their own TOTP before any grant;
U never enrolls and is in the role ledger only for the same marker grant through
`admin_grant_role_by_email`, which must answer `mfa_required` with no role.
Until HOSTED-008 applies order 20 to hosted, the marker grant succeeds: the test
revokes it at once and skips the refusal step with an "Order 20 ... HOSTED-008"
message (a Playwright skip in roles, a skip annotation and evidence key
`nt19-grant-without-totp` in NT-19). Evidence key `rolesWithoutTotp` says pass or
skipped. Any other answer fails.

SEC-004 (order 21) makes every photo upload reserve one slot through
`reserve_photo_upload` (10 per user per 10 minutes) before the server decodes
the image. Each hosted flow uploads one photo per fresh user, far under the
limit, so no flow needs to wait. The app fails closed: until HOSTED-009 applies
order 21 to hosted the RPC does not exist there, every upload answers
「現在保存できません。時間をおいて再度お試しください。」 and onboarding (and every group
after it) fails. Apply order 21 before running this suite against the new app.

SEC-006 (order 22) makes every sign-in through the app's login form reserve one
attempt through `service_reserve_signin` (10 per typed address per 15 minutes,
successful sign-ins included) before Auth is called, and every TOTP code entered
on `/admin/mfa` reserve one through `reserve_mfa_attempt` (10 per user per 10
minutes) before Auth verifies it. The app fails closed: until HOSTED-010 applies
order 22 to hosted the RPCs do not exist there, every UI sign-in answers
「現在ご利用いただけません。時間をおいて再度お試しください。」 and the first group
fails. Apply order 22 before running this suite against the new app. Direct Auth
API sign-ins and factor verifications (`Session.signIn`, `publicFetch`, the
retention and NT-19 helpers) do not pass through the app and are not counted.
Counts per invocation (run users are fresh per invocation; `e2e-admin` is shared):

| Invocation | Most UI sign-ins for one run user | `e2e-admin` sign-ins / TOTP codes | Other UI TOTP codes |
|---|---|---|---|
| default (groups 1-8, anonymous) | 8 (A), 7 (B) | 4 / 4 | 0 |
| default with NT-21 | 8 (A), 6 (A of the NT-21 block case, B of the ineligibility case) | 7 / 7 | 0 |
| NT-19 additions | 0 | 0 / 0 | 0 |
| retention prepare / verify | 1 / 0 | 0 / 0 | 0 |
| account | 5 (A, two of them the deleted-account form check) | 0 / 0 | 0 |
| visibility | 3 (each of five) | 1 / 1 | 0 |
| a11y | 6 (A) | 1 / 1 | 1 (B's wrong code) |
| admin-affiliations | 2 (B) | 2 / 1 | 1 (A's enrolment) |
| mobile | 0 (2 for A and 1 for B through `/api/mobile/auth/signin`) | 0 / 0 | 0 |

Every invocation stays under both limits. The `e2e-admin` address and its TOTP
codes count across invocations, so after a default run with NT-21 wait 15
minutes before the next invocation that signs `e2e-admin` in.

ADMIN-006 (order 23) adds `/admin/accounts`, the admins' list of suspended
accounts. The moderation group probes `admin_list_suspended_accounts` with
e2e-admin's own aal2 JWT from the session it already has (no extra sign-in or
TOTP code, so the counts above are unchanged). When the function answers rows,
B is checked on `/admin/accounts` while suspended (name, short id, a recorded
suspension) and reactivated from there instead of from the report; B must then
leave the list. While hosted lacks order 23 the probe answers `PGRST202`, that
step is reported as skipped and B is reactivated from the report as before. Any
other probe answer fails the group. Evidence key `moderation` records
`reactivatedFrom` (`accounts` or `report`) and the step's pass or skip.

SEC-008 (order 24) replaces `service_reserve_signin(p_email)` with
`service_reserve_signin(p_email, p_ip default null)`, which also counts 30
sign-in attempts per client IP per 15 minutes (an IPv6 /64 counts as one IP).
The app passes the IP only when it runs on Vercel (`VERCEL=1`), from
`x-real-ip`; this suite's local server has no `VERCEL`, so it passes none and
only the per-address counts above apply. The app always sends both arguments,
so it fails closed: until HOSTED-012 applies order 24 to hosted the two-argument
form does not exist there, every UI sign-in answers
「現在ご利用いただけません。時間をおいて再度お試しください。」 and the first group
fails, as before HOSTED-010. Apply order 24 before running this suite against
the new app.

SEC-012 (order 25) adds `service_reserve_signup(p_email, p_ip default null)`:
every sign-up through the app's `/signup` form reserves one attempt (5 per
typed address per hour, and on Vercel 10 per client IP per hour, every attempt
counted) before Auth is called, with counters separate from sign-in's. The app
fails closed: until HOSTED-013 applies order 25 to hosted the RPC does not
exist there and every UI sign-up answers
「現在ご利用いただけません。時間をおいて再度お試しください。」. This suite never
submits the sign-up form: it creates its users through the Auth admin API
(`POST /auth/v1/admin/users` in `lifecycle.ts`), which does not pass through the
app, so its counts above are unchanged and it does not depend on order 25.

Decision-first may leave an approved historical submission, but changing its
affiliation must clear the current approval. Change-first must supersede the
submission and refuse the stale decision. Reviewer revocation must release a
claim atomically; a decision committed first may remain historical. A new claim
or decision attempted after the revoke response must be forbidden and leave
the read-back state unchanged. All checks use app read RPCs (`my_account`,
`admin_list_submissions`, `admin_get_submission`, `admin_list_staff`), never
privileged table reads or SQL.

The last-admin boundary has explicit coordinator authorization (reply
`msg_7cdd47846078`, HOSTED-E2E-003): with only e2e-admin and X, race X revoking
e2e-admin against e2e-admin revoking X. Exactly one succeeds, the other is
forbidden (`P0001`), and exactly one active admin remains. If X wins, its aal2
session immediately re-grants admin to e2e-admin, verifies the restoration,
then e2e-admin removes X before the next round. The legitimate temporary removal
of e2e-admin is authorized only inside this guarded race. A serial self-revoke
with e2e-admin as the sole admin must separately return HTTP 200 with outcome
`invalid_state`; this explicitly exercises the last-admin count guard. The
sentinel race alone does not exercise that count guard. The baseline must have
only e2e-admin as admin; an unrelated admin fails the prerequisite and is never
modified to manufacture the boundary.

A double successful boundary revoke is a real `last-admin invariant broken`
finding and stops the suite, with recovery through X attempted if possible.
Any other failure also tries in-memory surviving-session restoration. Before
any Storage/Auth deletion, global teardown authenticates e2e-admin at aal2,
verifies its active admin role, authenticates each exact run identity before
revoking its ledger-owned reviewer/admin
roles, and verifies removal and e2e-admin again. Failure retains all users,
objects and the ledger with `e2e-admin admin not restored`; never delete X when
it may be the sole recovery admin. The coordinator then restores with
`scripts/e2e-hosted/bootstrap.sql`; the suite never executes that SQL. A subsequent
run retries this exact ledger's guarded cleanup. Abrupt process termination can
leave recovery to the coordinator; it cannot guarantee in-memory restoration.

Group 11b (HOSTED-E2E-004, same `concurrency` project) adds three more run
users (subject U, reviewers R1 and R2, reviewer role only, no admin changes) to
the same role ledger, and races `admin_revoke_verification` 20 rounds each:
R1's revoke of U's approved S1 against U's class change; R2's revoke of S1
against R1's approval of U's claimed renewal S2 (the contract accepts a renewal
while S1 is current); and R1 against R2 revoking S1. Each round must equal one
serial order: exactly one of revoke/approve, or of the two revokes, succeeds and
the other returns HTTP 200 `invalid_state`. Read-back uses `admin_list_submissions`
and `my_account`; a later probe revoke proves S1 is never current afterwards and
S2 is current exactly when its approval won. `private.audit_log` has no app read
path, so "each successful write once" is asserted as one version increment per
success (audit is written in the same transaction). The revoke RPC is allowlisted
only for submissions a run session created in the same process.

NT-21 requires the coordinator to temporarily grant `INSERT on public.messages`
and `USAGE on sequence public.messages_id_seq` to `service_role`, only on the
free `campus-link-dev` project. The coordinator owns opening, recording and
revoking both grants after the run. They are test producer prerequisites,
not part of the app schema or migrations. The suite never changes grants;
HTTP 403 / code 42501 fails with a missing-coordinator-grant message, never a skip.

Prerequisites are the coordinator's bootstrap and migrations, `.env.local` with
the dev URL, publishable key and server key, and the ignored
`.e2e-hosted.local.json` containing the fictional administrator credentials.
The first MFA run enrolls through the app and adds only `adminTotpSecret` to
that local file. Later sessions reuse it and wait for a fresh TOTP window.

Projects have explicit dependencies and a single worker, without retries:
onboarding → verification → discover → privacy → moderation → chat → roles →
block. The chat group matches A and B through likes: A likes B on B's detail
page, B likes back from `/likes` "いいねされた", and "トークを開く" names the
room. The likes group (`22-likes.hosted.ts`, HOSTED-E2E-LIKES) depends only on
verification and makes two fresh users C and D eligible through the app: C
likes D and takes it back (both lists on both sides, `get_like_state` with each
user's JWT), then C and D call `like_user` at the same time on separate TCP
connections (exactly one `ok(null)` and one `ok(conversation id)`, one room
both open from the talk list, no likes left), and D's block in the room ends the
match (room closed for both, no like state, a new like `not_available`).
Realtime-revocation also depends on roles, as a separate group using
fresh pairs, so the old block group's result cannot hide its evidence (or the
reverse). A single worker still runs all tests sequentially. Anonymous refusal
tests run independently. Privacy and moderation run
before chat because Discover intentionally excludes an active connection; this
keeps both disappearance and reappearance assertions meaningful.

Setup creates two confirmed fictional users with a unique run prefix. The
opt-in revocation group adds three fresh participants for block/control and three
for ineligibility/control; with the likes group's C and D that is ten in total,
the run-user cap. It never reuses the original chat/block pair.
It persists each planned UUID before creation, so a lost API success response
still leaves an exact identity for cleanup.
The ignored `.e2e-hosted/run.json` is an ownership ledger and contains their
temporary passwords. Global teardown verifies each user's exact email before
deletion, removes only flat photo objects under that user's directory, verifies
empty storage and a missing Auth user, and removes the ledger. Failed cleanup
keeps the ledger and fails the run; the next invocation first retries that exact
ledger's cleanup. It never searches for, or deletes, users by a broad prefix.
Abrupt process/OS termination cannot guarantee teardown; preserve that ledger.

No traces, videos, screenshots, automatic failure DOM snapshots, or server
output are recorded. Credential locator errors are replaced at the boundary.
Do not enable those diagnostics for this suite: MFA enrollment displays its key.
`.e2e-hosted/evidence.json` contains only the current run's non-secret flow
results, observed Realtime delays, and verified cleanup counts. Normal app audit
rows (fictional reports and staff-role history) may remain after Auth deletion;
this suite has no authority to delete audit history or execute SQL.
Messages require no extra deletion: the existing migration 3/6 foreign keys
cascade Auth user → profile → connection → conversation → messages, as well as
profile → sender messages. This is a schema-based cleanup guarantee; the suite
does not claim to have queried deleted message rows with a privileged SELECT.

The original Realtime assertions observe a confirmed Phoenix subscription and an INSERT
frame followed by the screen update, without a document navigation. After a
block, both composers disappear; no post-block INSERT is manufactured to bypass
that UI. Both rooms must establish a working stream and A must receive B's last
pre-block INSERT. Realtime system and join errors fail the group, including
authentication, authorization, operational and unknown errors; none is skipped.
Diagnostics retain only finite classification labels, never provider text.

Group 10 attempts server-key POSTs to `/rest/v1/messages` only for exact rooms
formed through a like match by this run's new users. The server key
stays inside Node helpers. It must get HTTP 201 for both probe and control;
denied table/sequence grants fail the flow with status/code evidence. It never
grants permissions, calls a substitute RPC, executes SQL or skips a refusal.
The config conditionally lists this dependent project for the NT-21 opt-in.

Each case first drains ordinary messages in both directions, then requires
35 seconds without a received INSERT on A's original channel. Wire observation
checks the room-specific join acknowledgement, ready event, current socket
`isClosed()`, unchanged socket generation/join count/leave count, and no document
navigation throughout. It also requires a matching heartbeat reply on A's
original socket during the window (the installed client sends every 25 seconds).
Payloads and tokens are never retained. A block control
uses the same A in a separate browser page subscribed to an unblocked A–C room.
The ineligibility case requires neither A nor B to receive the A–B INSERT, with
both original channels still joined and answering heartbeats. Its control uses
the same B in a separate browser page subscribed to an eligible B–D room;
D is fresh and eligible, and both control directions are proven live first.
Evidence records
before/after per-room counts, channel/socket states, actual observation duration,
INSERT HTTP results, and control delay. A received event remains a failing
`NT-21 delivery leak`, including if the app subsequently removes the channel.

Ineligibility first tries Auth Admin `email_confirm:false`, then GET verifies
whether confirmation really cleared. If the API refuses or leaves it confirmed,
the explicit fallback suspends only A via B's exact run-marked app report.
`private.pair_visible` requires both participants to be eligible: suspension of A
also removes B's access to A–B, hence the two no-delivery assertions and separate
B–D control. This proves pair eligibility revocation for the exercised condition,
without claiming email-confirmation or other session-only cases were exercised.
A's page receives no manual reload/refresh/token replacement. Evidence counts
browser token-refresh requests and channel token updates made by the client.

TEST-007 adds the talk list subscription to both cases, with no extra users or
`e2e-admin` sign-ins (NT-21 still creates six run users). Before the preflight,
the observed user (A in the block case, B in the ineligibility case) opens
`/talk` in another page, whose single unfiltered `realtime:talk-list` channel
must be joined and ready. The probe counts, per socket, received
`postgres_changes` INSERT frames on that topic by `record.conversation_id`, and
keeps only this run's room ids (other ids are a bare count). Both rooms' two
preflight INSERTs must first reach the list. The same server inserts then
follow: the revoked A–B INSERT must not reach the list in the same 35-second
window, while the later control INSERT (A–C or B–D) must reach the same list
socket, which stays joined on its original socket without rejoin or navigation
and answers a heartbeat. `router.refresh()` RSC requests for `/talk` are
recorded only as secondary evidence (`listRefreshes`). Evidence keys are
`talkListRevocationBlock` and `talkListRevocationIneligible`; a received
revoked-room frame is `NT-21 talk list delivery leak`.

If INSERT or a prerequisite is refused, `observedWindowMs: 0` and a null control
delay mean the requested delivery test could not be performed, not a pass.
Email delivery, NT-19 orders not observed in a successful opt-in run, CDN/shared-cache behavior and any NT-21
conditions not exercised successfully still require separate verification.

TEST-017: every `page.request`/`context.request` call goes through `appGet`
(`request.ts`). A failed call is rethrown as `GET <path> failed: <class>` (path
without the query; class such as `ECONNRESET` or `timeout`), because Playwright's
own error carries the call log with the `sb-` auth cookie. `request.test.tsx`
proves that a cookie, JWT or `refresh_token` in the original error never reaches
the rethrown one. For diagnosis only, `CAMPUS_E2E_SERVER_LOG=<file>` makes
`server.mjs` append the build and server output with timestamps to that file,
and preload `server-log.cjs` into `next start` to log incoming request and
outgoing fetch timings (method and path only, no query, header or body) and
event-loop stalls. The file must be outside the repository or under the ignored
`.e2e-hosted/` (for example `.e2e-hosted/server.log`); anything else is refused.
Unset, the server output stays ignored. Never commit or paste the file.
