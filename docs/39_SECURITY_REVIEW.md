# アプリ全体のセキュリティ点検

全体の受入のための、アプリ全体を一度に見る点検。各タスクはそれぞれ審査を受けているが、タスクの境界をまたぐ問題（確認を飛ばす経路、拒否の不揃い、cache、CSP、秘密情報、回数制限、入力の長さ）を見るのが目的。対象は `main`（`2e63e43`）のコードで、文書ではなくコードを読んだ。hostedには何もしていない。

## 結果のまとめ

| 重大度 | 件数 | 項目 |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 3（うち修正済み3） | M-1 認証の回数制限がサーバーのIPで数えられる（**修正済み**、SEC-006・HOSTED-010、SEC-008・HOSTED-012、SEC-012・HOSTED-013）、M-2 写真の登録に回数制限がない（**修正済み**、SEC-004-r2・HOSTED-009、SEC-011）、M-3 TOTP未登録の担当者は最初に登録した人がaal2になる（**修正済み**、SEC-003・HOSTED-008） |
| low | 6（うち修正済み5、一部修正1） | L-1 画像の拡張子で終わる入れ子のパスがproxyを通らない（**修正済み**）、L-2 確認リンクによるログインCSRF（**修正済み**、SEC-005）、L-3 Server Actionの本文上限9 MBが全actionに効く（**修正済み**、SEC-007・SEC-015・SEC-016）、L-4 セッションcookieがJavaScriptから読める（**修正済み**、SEC-010）、L-5 ログアウトはこの端末だけ（**修正済み**、SEC-005）、L-6 HSTSとCSPの報告先がない（**一部修正**、DEPLOY-001・SEC-009） |
| **SECREVIEW-002**（`eab088b..HEAD`、下の節） | | |
| critical | 0 | なし |
| high | 0 | なし |
| medium | 1（未修正） | N-1 アプリの認証の回数制限は、Supabase Authを直接呼べば通らない |
| low | 5（うち修正済み5） | N-2 写真の本文は利用者ごとの制限より前に全部読まれ、復号の枠の拒否は予約を使わない（**修正済み**、FIX-002・SEC-015）、N-3 役割を持つ人のTOTPは付与のときだけ確かめる（**修正済み**、SEC-013・HOSTED-016）、N-4 「すべての端末からログアウト」の失敗が成功と同じに見える（**修正済み**、FIX-002）、N-5 削除した写真のobjectの削除に失敗すると保持期限でも消えない（**修正済み**、RETENTION-005・HOSTED-016）、N-6 パスの規則に合わない確認資料のobjectは保持期限で消えない（取込みが `upload` のときだけ）（**修正済み**、RETENTION-005・HOSTED-016） |
| **SECREVIEW-003**（`49255e4..HEAD`、下の節） | | |
| critical | 0 | なし |
| high | 0 | なし |
| medium | 0 | なし |
| low | 4（うち修正済み3、対応済み1） | P-1 写真の本文の枠4つは、遅く送る4つのアカウントで埋め続けられる（**修正済み**、FIX-009）、P-2 働くadminが0人になる経路が、Authの要素の書込みに残る（**対応済み**、FIX-010の手順・STAFF-001・HOSTED-022）、P-3 `bootstrap.sql` の付け直しは、その時にある確認済みのTOTPを信じる（**修正済み**、FIX-010）、P-4 確認資料の16個の上限は、判定の後30日残る資料も数える（取込みが `upload` のときだけ）（**修正済み**、RETENTION-006・HOSTED-018） |

critical・highはないため、migration（順20）は追加していない。修正はL-1だけ（1行と試験）。

## 1. 認証とセッション

**読んだファイル：** `src/proxy.ts`、`src/lib/supabase/config.ts`・`server.ts`・`browser.ts`、`src/lib/safe-next.ts`、`src/server/auth-actions.ts`、`src/app/auth/confirm/route.ts`、`src/server/mfa-actions.ts`、`src/server/admin-gate.ts`、`src/server/profile-gate.ts`、`src/app/login/page.tsx`、`src/app/signup/page.tsx`、`src/components/auth-form.tsx`。

**確認したこと：**

- proxyは署名を確かめる `getClaims()` だけで通す（`src/proxy.ts:46`）。`getSession()` の中身で認可する箇所はない（`src/lib/supabase/server.ts:23-24` の注記、`grep getSession` でも使用なし）。公開のパスは `/welcome`・`/login`・`/signup`・`/auth/*`・`/settings/account/deleted`・`/media/*` だけ（`src/proxy.ts:48`）。`/media/*` は写真のroute自身が `getUser()` で確かめる（§4）。
- 設定が不正なら `supabasePublicConfig()` が投げて閉じる（`src/lib/supabase/config.ts:19-30`、`src/proxy.ts:11`）。公開キーは `sb_publishable_` か `role=anon` のJWTだけ受け付ける。
- 登録は既存のアドレスでも同じ `sent` を返す（`src/server/auth-actions.ts:40`、`tests/auth-actions.test.tsx`「returns byte-identical sent states …」）。ログインの失敗と退会済みは同じ `failed` で、開始から1500 ms以上後に返す（`src/server/auth-actions.ts:52-57,81`）。残る時間差は  に記録済み。
- メール確認のrouteは `code` か、`type` が `email`/`signup` の `token_hash` だけを受け、退会済みならセッションを消して同じ失敗にする（`src/app/auth/confirm/route.ts:14-29`）。応答は `no-store`（同:36）。
- MFA：管理のRPCはDBで `aal2` と役割を確かめる（`supabase/migrations/20261027120005_staff_audit.sql:95-98`、`private.require_staff`）。画面の門 `requireAdminSession` は表示の振り分けだけ（`src/server/admin-gate.ts:87-96`）。TOTPの確認は6桁の数字だけ受け付ける（`src/server/mfa-actions.ts:43`）。
- 開いたリダイレクト：`safeNextPath` は512文字以下、`/` で始まり `//` でない、バックスラッシュ・制御文字・空白なしを、復号の前と後で確かめる（`src/lib/safe-next.ts:2-11`）。使う所はログイン（`src/server/auth-actions.ts:83`）、確認route（`src/app/auth/confirm/route.ts:35`）、proxyの `next`（`src/proxy.ts:52`）。管理の行き先は `adminNextPath` がさらに復号・正規化して `/admin` の下に限り、`/admin/mfa` を除く（`src/server/admin-gate.ts:65-85`）。どの行き先も同じoriginに解決される。試験：`tests/safe-next.test.tsx`、`tests/admin-gate.test.tsx`「admin destinations」、`tests/auth-confirm.test.tsx`、`tests/proxy.test.tsx`。

**指摘：**

- **M-1（medium）認証の回数制限がサーバーのIPで数えられる。** 登録・ログイン・メール確認・TOTPの確認は、どれもNext.jsのサーバーからSupabase Authを呼ぶ（`src/server/auth-actions.ts:36,67`、`src/app/auth/confirm/route.ts:17-19`、`src/server/mfa-actions.ts:55`）。SupabaseのAuthの回数制限は要求元のIPで数えるため、要求元はサーバー（ホスティングによっては少数の共有IP）になり、利用者や攻撃者ごとの制限にならない。アプリの側には回数制限がない（DBの `private.rate_policy` は申請・通報・メッセージ・ブロック・非表示設定だけ、`supabase/migrations/20261027120005_staff_audit.sql:55-66`）。
  - 失敗の場面：本番で1人が自動でログインを試し続けると、共有のIPの枠を使い切り、全利用者のログインが `rate_limited` になる。逆に枠が広ければ、1つのアカウントへのパスワードの総当たり（aal1のセッションがあればTOTPの総当たり）が、その枠の速さまでできる。
  - 対応案（このタスクでは行わない）：アプリ側でアカウント（メールアドレスの正規化）と接続元ごとの回数制限を置く。SupabaseにクライアントのIPを渡す方法があるかを調べる。hostedのAuthの回数制限の設定値は未確認。
  - 一部修正（2026-11-12）：SEC-006（`b136e03`）のmigration 順22（`supabase/migrations/20261111120022_auth_rate_limit.sql`）で、`rate_policy` に `signin`（入力したアドレスごとに10件/15分）と `mfa`（利用者ごとに10件/10分）を加えた。ログインは、入力の検証の後、Authを呼ぶ前に `service_reserve_signin`（service_roleだけ、`src/server/auth-rate.ts`）で予約し、`ok` 以外ではAuthを呼ばない（`src/server/auth-actions.ts:65-68`）。鍵はDBだけが読めるpepperと正規化したアドレスのsha256で、存在しないアドレスと実在のアカウントは同じ答えになる。TOTPの確認は、`challengeAndVerify` の前に `reserve_mfa_attempt`（authenticatedだけ）で予約する（`src/server/mfa-actions.ts:56-59`）。どちらも成功を含むすべての試行を数える。hostedへはHOSTED-010で適用（`docs/safety/HOSTED-010-execution-20261112.json`）。試験：`tests/auth-rate.test.tsx`、`tests/auth-actions.test.tsx`。
  - 修正（2026-11-15）：SEC-008（`2fb7e6d`）のmigration 順24（`supabase/migrations/20261115120024_signin_ip_limit.sql`）で、`rate_policy` に `signin_ip`（IPのキーごとに30件/15分、成功も数える）を加えた。キーは順22のpepperで `'ip:' || 正規化したIP` をハッシュしたもの（IPv4はそのまま、IPv4を写したIPv6はIPv4、ほかのIPv6は/64）で、IPをそのまま保存しない。`service_reserve_signin(p_email, p_ip default null)` の1つにまとめ（順22の1引数の形は削除）、アドレス→IPの順にロックし、両方とも通るときだけ両方を記録する（service_roleだけ）。アプリは `VERCEL=1` のときだけ `x-real-ip` を読み（`x-forwarded-for` は読まない）、IPとして読めないときやVercelの外ではIPを渡さず、アドレスごとの制限だけになる（`src/server/auth-rate.ts:22-36`、出典：vercel.com/docs/headers/request-headers）。IPはログに出さない。hostedへはHOSTED-012で適用（`docs/safety/HOSTED-012-execution-20261115.json`）。試験：`tests/auth-rate.test.tsx`。hostedの通し試験はローカルのサーバーで動くためIPを渡していない。Vercelの上では、アプリのログインがIPをRPCに渡した（DEPLOY-002、`signin_ip` 0→1、`docs/safety/DEPLOY-002-vercel-smoke-20261115.json`）。拒否そのものと、Vercelでの登録は試していない。
  - 登録の修正（2026-11-15）：SEC-012（`9321da1`）のmigration 順25（`supabase/migrations/20261115120025_signup_rate_limit.sql`）で、`rate_policy` に `signup`（入力したアドレスの鍵ごとに5件/1時間）と `signup_ip`（IPの鍵ごとに10件/1時間）を加えた。どちらもすべての試行を数える。鍵はログインのもの（順22・24）をそのまま使い、数は別。`service_reserve_signup(p_email, p_ip default null)`（service_roleだけ）はアドレス→IPの順にロックし、両方を記録するか何もしない。`signUpAction` は入力の検証の後、Authを呼ぶ前に予約し（`src/server/auth-actions.ts:36-38`）、`rate_limited` 以外の失敗はすべて `unavailable` でAuthを呼ばない。IPはログインと同じ `trustedClientIp()`（Vercelのときだけ、`src/server/auth-rate.ts`）。既存のアドレスへの `sent` は変わらない。hostedへはHOSTED-013で適用（`docs/safety/HOSTED-013-execution-20261115.json`、架空の `example.invalid` のアドレスでRPCを1回呼んで `ok`）。試験：`tests/auth-actions.test.tsx`、`tests/auth-rate.test.tsx`、`tests/db/signup-rate-limit.test.ts`。hostedの通し試験は登録の画面を使わない（利用者はAuthのadmin APIで作る）ので、登録の経路はRPCの確認と単体試験だけで示している。
  - 残るもの（受け入れたリスク）：誰でも1つのアドレスを15分ずつロックできる（上限に達したアドレスは、本人も15分ログインできない）。登録も同じく、1つのアドレスの登録を1時間止められる。確認リンクはアプリでは制限していない：アプリに確認メールの再送の流れはなく、メールの送信はSupabaseの制限だけ。

- **M-3（medium）TOTP未登録の担当者は、最初にTOTPを登録した人がaal2になる。** 役割の付与（`admin_grant_role_by_email`、`supabase/migrations/20261109120014_staff_management.sql:17-41`）は、相手がTOTPを登録済みかを見ない。TOTPの登録（`startTotpEnrollment`、`src/server/mfa-actions.ts:17-39`）はaal1のセッションでできる。
  - 失敗の場面：管理者がXに `reviewer` を付ける。XはまだTOTPを登録していない。Xのパスワードを盗んだ人がログインし、`/admin/mfa` で自分の認証アプリにTOTPを登録すると、aal2になって審査の資料・生年月日を見られる。Xが後で登録しようとしても `already_enrolled` になる。
  - 対応案：運用で「TOTPを登録してから役割を付ける」を手順にする（に追記の候補）。DBで、確認済みのTOTPがない相手への付与を拒む（追加のmigrationが要る）。
  - 修正（2026-11-11）：SEC-003（`dd48bcd`）のmigration 順20（`supabase/migrations/20261111120020_grant_requires_totp.sql`）で、`admin_grant_role` は確認済みのTOTPがない相手を `mfa_required` で拒み、役割の行も監査の行も書かない。メールでの付与も `admin_grant_role` を通るので同じ拒否になる。hostedへはHOSTED-008で適用（`docs/safety/HOSTED-008-execution-20261111.json`。適用前にTOTPのない有効な役割は0件）。試験：`tests/db/grant-requires-totp.test.ts`、`tests/e2e-hosted/8-roles.hosted.ts`。

- **L-2（low）確認リンクによるログインCSRF。** `/auth/confirm` の `token_hash` の経路は、リンクを開いた人に、そのリンクの持ち主のセッションを作る（`src/app/auth/confirm/route.ts:17-19`）。攻撃者が自分の登録確認のリンクを人に開かせると、その人は攻撃者のアカウントでログインした状態になり、気づかずに写真やプロフィールを入れるおそれがある。`code` の経路はPKCEのcookieが要るので起きない。Supabaseの通常の作りで、影響は小さい。対応案：確認後の画面にログイン中のアドレスを出す、またはPKCEの経路だけにする。
  - 修正（2026-11-12）：SEC-005（`2e6bf75`）で、`/auth/confirm` は成功しても（`token_hash` と `code` の両方）アプリへ直接入らず `/auth/confirmed` へ転送し、`next` は `safeNextPath` で確かめたものだけを渡す（`src/app/auth/confirm/route.ts:35-40`）。`/auth/confirmed` はログイン中のアドレスを出し、「続ける」と「自分のアカウントではありません」（この端末のセッションを終えて `/login` へ）を置く。使えるセッション・アカウントがなければ何も出さず `/login` へ転送する（`src/app/auth/confirmed/page.tsx:17-44`）。試験：`tests/auth-confirm.test.tsx`、`tests/auth-confirmed-page.test.tsx`。この画面はhostedではまだ試していない。

- **L-4（low）セッションcookieがJavaScriptから読める。** `@supabase/ssr` の既定は `httpOnly: false`（`node_modules/@supabase/ssr/dist/main/utils/constants.js`）。ブラウザのRealtime購読（`src/components/chat-room-live.tsx`、`src/components/talk-list-realtime.tsx`）がこれを使う。XSSがあればトークンを持ち出せる。nonceと `'strict-dynamic'` のCSP、Reactの通常描画（`dangerouslySetInnerHTML` は使用なし）で緩和されている。多層防御の項目。
  - 修正（2026-11-15）：SEC-010（`5e679ad`）で、cookieを書く2つのclient（`createServerSupabase` とproxy）が `src/lib/supabase/cookie-options.ts` の `sessionCookieOptions()`（`httpOnly: true`、`secure` はVercelのときだけ、ほかはライブラリの既定）を使う。古いcookieは次の更新でHttpOnlyに書き直される。ブラウザのRealtimeは `GET /api/realtime-token`（`src/app/api/realtime-token/route.ts`）からトークンを得る：デモは404、`Sec-Fetch-Site` が同じoriginでなければ403、`getClaims()` の後に同じ利用者のセッションだけを読み、答えはアクセストークンと期限だけ、ほかは401、すべて `no-store`、proxyの後ろ。ブラウザのclientはcookieを読まない `accessToken` のcallback（`src/lib/supabase/browser.ts`）を使う。試験：hostedの通し試験でログインの後に `document.cookie` に `sb-` がなく、authのcookieがすべてhttpOnly（run `07bedb2ea811`）。
  - 残るもの：XSSがあれば、ブラウザは `/api/realtime-token` からアクセストークンを得られる（トークンの期限1回分だけ有効）。refresh tokenはブラウザに渡らない。

- **L-5（low）ログアウトはこの端末だけ。** `signOutAction` は `scope: "local"`（`src/server/auth-actions.ts:102`）。ほかの端末のセッションは期限まで残る。「すべての端末からログアウト」はない（退会では `global`、`src/server/account-actions.ts:36`）。
  - 修正（2026-11-12）：SEC-005（`2e6bf75`）で、`signOutEverywhereAction`（`scope: "global"`、`src/server/auth-actions.ts:119-121`）と、マイページのログアウトの下の「すべての端末からログアウト」（`src/components/logout-button.tsx:16-21`、`src/components/mypage-live.tsx:31`）を加えた。通常のログアウトは `local` のまま。試験：`tests/auth-actions.test.tsx`。

## 2. 認可（route handlerとServer Action）

**読んだファイル：** `src/server/*-actions.ts` の全部（auth・account・admin-affiliation・admin-report・admin-staff・admin-verification・chat・mfa・onboarding・photo・privacy・request・safety・verification）、`src/server/rpc.ts`、`src/server/chat-data.ts`、`src/server/discover-data.ts`、`src/server/safety-data.ts`、`src/server/admin-reports.ts`、`src/server/admin-staff.ts`、`src/server/my-photos.ts`、route handlerの3つ（`src/app/admin/documents/[submissionId]/[n]/route.ts`、`src/app/media/photos/[photoId]/route.ts`、`src/app/auth/confirm/route.ts`）、`src/app/**/page.tsx`。

**確認したこと：**

- すべてのactionは利用者のcookieのセッションのクライアント（`createServerSupabase`）でRPCを呼び、判断はDBが行う。RPC名は `RPC_NAMES` の一覧の外を投げて拒む（`src/server/rpc.ts:4-18,36`）。DBの文言はactionの外に出ず、固定のコードに直す（同:29-33）。
- クライアントから来たIDを信用しない：会話は `list_my_conversations` の自分の一覧から探す（`src/server/chat-actions.ts:16`、`src/server/safety-actions.ts:16`）。ブロックの解除はIDではなく自分の一覧の行のSHA-256の鍵で選ぶ（`src/server/safety-actions.ts:19`）。役割を外す相手も一覧の鍵で選ぶ（`src/server/admin-staff-actions.ts:27-31`）。通報の対象のメッセージは、その会話の `list_messages` に相手のメッセージとしてあるかを確かめる（`src/server/safety-actions.ts:28-30`）。写真の登録の `p_user` は自分の `my_account` の `user_id`（`src/server/photo-actions.ts:21-28,50`）。
- DBの側：公開の関数はすべてsecurity definerで、呼んだ人の識別は `private.session_uid()`（`auth.uid()`、匿名と停止・退会を除く、`supabase/migrations/20261027120001_foundation.sql:86-93`、`20261110120017_deleted_account.sql:19-25`）から取り、引数からは取らない（引数の利用者IDは操作の相手で、service role専用の `service_register_photo` だけが例外）。管理の関数（migrationでの定義20個、置き換えられた旧 `admin_revoke_verification` を除くと19個）はすべて `private.require_staff` を通る（各 `create function public.admin_*` の本体にあることを確かめた）。
- service roleのキーは、サーバー専用の3つのモジュール（`src/server/storage/document-read.ts`、`photo-ingest.ts`、`photo-read.ts`）だけが読む。`README.md` の記述と一致し、`tests/service-key-scope.test.tsx` がこれ以外の読み手、署名URL・公開URLの使用を拒む。どのモジュールもbucketやパスを要求から受けず、認可RPCの戻り値だけを使う（`document-read.ts:7,29-32`、`photo-read.ts:30-33`）。`service_register_photo` はパスの先頭が `p_user` であることと、アカウントの状態をDBで確かめる（`supabase/migrations/20261027120007_visibility.sql:465-472`）。
- ページの門 `profileGate` は `my_account` を読み、退会済みを `unavailable` にする（`src/server/profile-gate.ts:5-19`）。管理の画面7つはすべて `requireAdminSession` を通る。

**指摘：** なし。保守scriptとhostedの試験の準備もservice roleを使うが、アプリの外で、ここでは読んでいない（下の「点検しなかったこと」）。

## 3. DB（migration 順1〜19）

**読んだファイル：** `supabase/migrations/` の19本（特に `…001_foundation`、`…003_accounts`、`…005_staff_audit`、`…007_visibility`、`…010_admin`、`…014_staff_management`、`…015_storage`、`…017_deleted_account`、`…019_my_staff_roles`）、`tests/db/catalog.test.ts`、`tests/db/allowlist.ts`、`tests/db/storage.test.ts`、`tests/db/limits.test.ts`。

**確認したこと（証拠は試験）：**

- `search_path`：publicとprivateの関数はすべて `search_path = ''`（`tests/db/catalog.test.ts`「every public/private function pins search_path to ''」）。publicの関数はすべてsecurity definer（同「public functions are exactly the designed RPCs, all SECURITY DEFINER」）。
- RLS：publicとprivateの表は設計どおりの集合で、すべてRLSが有効（同「public and private tables are exactly the designed set, all with RLS」）。直接のSELECTは12の表の本人の行だけ（`20261027120003_accounts.sql:186-199`、退会済みは `private.rls_own_uid()` でnull、`20261110120017_deleted_account.sql:28-39`）と、`messages` の会話の参加者（`20261027120007_visibility.sql:122-123`）、有効な所属マスタ。書込みの権限はどの表にもない（同「authenticated has SELECT on the allowlist only, no write privilege anywhere」）。
- grant：anonとPUBLICは何も実行できず、authenticatedとservice_roleは許可の一覧のとおり（同「PUBLIC and anon execute nothing …」）。`verification_submissions` は8列だけ（同「exposes exactly the 8 designed columns」）。一覧からずれると落ちること自体も試験している（同「report a stray grant, a new public function and a table without RLS」）。
- Storage：2つのbucketは非公開・WebPだけ・大きさの上限つき。利用者が入れられるのは、取込みが `upload` のときの自分のパスの資料だけ（`20261109120015_storage.sql:3-11`、`tests/db/storage.test.ts`）。
- 回数制限：申請・通報は拒否も含めて数え、相手によらず同じ答え（`tests/db/limits.test.ts`「NT-25 rate limits」）。
- hostedのPostgRESTの応答の形（2026-11-15、TEST-013 `0a9d340`）：拒否の理由で、HTTPの状態・header名・鍵・型は変わらない（outcomeは200で `code` だけ、P0001は400で `message` だけ、anonは401・`42501`）。記録したこと：存在しないRPCの名前を呼ぶと、PostgRESTの `PGRST202` の `hint` が近い本物の関数名を示す（anonにも）。関数名は秘密ではなく、anonはどの関数も実行できない（`42501`）ため、指摘にはしない。anonの `GET /rest/v1/`（OpenAPI）は401で、関数の一覧は出ない。
- hostedのStorage（2026-11-15、TEST-014 `0c36abb`）：2つのbucketで、持ち主・ほかの利用者・anonの108件の操作（取得・署名・変換・アップロード・上書き・削除・移動・複製・TUS）がすべて断られ、service roleで読んだfixtureは変わらなかった。一覧・一括署名・一括削除は200で空の結果。S3互換は確かめていない。

**試験が確かめていないこと：**

- catalogの試験はPGlite（`tests/db/harness.ts`、`shim.sql`）で動く。hostedのPostgresにSupabaseが既定で付ける権限・拡張・`auth`/`storage`/`realtime` のschemaは見ていない。`storage.objects` の試験は試験用の代わりの表（`tests/db/storage.test.ts`「test-only stand-in」）。
- 表（`relkind` r/p）と関数だけを見る。viewはmigrationにない（`create view` の使用なし）が、試験は将来のviewを拾わない。
- Realtimeの配信範囲はRLSに任せており、hostedでの確認の範囲は hosted の試験（NT-21）で確かめた。

**指摘：**

- **M-2（medium）写真の登録に回数制限がない。** `uploadPhoto` は8 MBまでのファイルを受け、自分のアカウントを確かめた後、sharpで復号・縮小（最大4000万画素）し、Storageに書いてからDBに登録する（`src/server/photo-actions.ts:35-61`、`src/server/storage/photo-image.ts:28`）。6枚を超えると登録で断られ、書いたobjectを消す。DBの `rate_policy` に写真の項目はない。
  - 失敗の場面：ログインした1人が同時にいくつもアップロードを繰り返すと、サーバーのCPUとメモリ（sharpの復号）とStorageの書込み・削除を使い続け、ほかの利用者の応答が遅くなる。
  - 対応案：写真の項目を `rate_policy` に加え、復号の前に数える（追加のmigrationが要る）。またはサーバーで同時に復号する数を制限する。
  - 修正（2026-11-11）：SEC-004-r2（`e5bc492`、内容は `13b0b53` と同じ）のmigration 順21（`supabase/migrations/20261111120021_photo_rate_limit.sql`）で、`rate_policy` に `photo`（利用者ごとに10件/10分）を加え、`reserve_photo_upload()` が本人とアカウントを確かめ、上限内なら1行を記録して `ok`、超えていれば記録せず `rate_limited` を返す。`uploadPhoto` は本人の確認の後、ファイルを読む・復号する前に予約し、`ok` 以外では復号しない（`src/server/photo-actions.ts:40-44`）。hostedへはHOSTED-009で適用（`docs/safety/HOSTED-009-execution-20261111.json`）。
  - 同時の復号の上限（2026-11-15）：SEC-011（`0068104`）で、`src/server/decode-slots.ts` がプロセスごとに同時の復号を2件まで、ほかに4件まで到着順に待たせ（待ちは10秒まで）、待ちきれない・満員は `rate_limited`（既存の429と再試行の文）。`uploadPhoto` はアカウントの確認の後、`reserve_photo_upload` の前に枠を取るので、忙しいときは予約を使わない。枠は復号が終わった直後に `finally` で返す（成功・失敗・予約の拒否のどれでも、Storageへの書込みの前、`src/server/photo-upload.ts:40-56`）。返すのは1回だけで、次の待ちにそのまま渡し、時間切れの待ちは列から外れる。試験：`tests/decode-slots.test.tsx`。
  - 残るもの：この上限はメモリの中・プロセスごとで、インスタンスをまたいでは制限しない。

## 4. 個人情報

**読んだファイル：** `src/server/discover-data.ts`、`src/server/chat-data.ts`、`src/server/mypage-data.ts`、`src/server/account-data.ts`、`src/server/verification-data.ts`、`src/server/admin-verifications.ts`、`src/server/admin-reports.ts`、`src/server/admin-staff.ts`、2つのroute handler、`supabase/migrations/20261027120007_visibility.sql`（`profile_view`）、`20261027120010_admin.sql`。

**確認したこと：**

- ほかの人のプロフィールは `public.profile_view` の形だけで返り、生年月日ではなく年齢、学科・クラスは本人が公開したときだけ（`20261027120007_visibility.sql:126-150`）。サーバーはさらに形を検査する（`src/server/discover-data.ts:10-15`）。
- 生年月日・資料の参照は、担当の審査者の `admin_get_submission` だけが返し、監査の行を残す（`20261027120010_admin.sql:83-117`）。資料のrouteは要求ごとに `admin_authorize_document_view` を呼び（監査あり）、`no-store`・`nosniff`・`CORP same-origin` で返す（`src/app/admin/documents/[submissionId]/[n]/route.ts:25-39`、`tests/document-route.test.tsx`）。利用者が出せる資料の参照は自分のパスのものだけ（`20261027120007_visibility.sql:505-507`）。
- 写真は要求ごとに `authorize_photo_delivery` で許可を確かめ、拒否・存在しない・削除済みは同じ404（`no-store`）。許可されたときは `private, max-age=120` と `Vary: Cookie`（`src/app/media/photos/[photoId]/route.ts:20-38`、`tests/photo-route.test.tsx`）。閲覧できなくなった後もブラウザのcacheに最大120秒残る点は設計の残余リスク（[03_ARCHITECTURE](03_ARCHITECTURE.md) R2）。
- 通報の本文・監査の行：通報の対象は管理画面でSHA-256の頭8桁の表示（`src/server/admin-reports.ts:17`）。監査の行（`private.audit_log`）はアプリから読めない（catalogの試験）。
- ページのcache：ルートのlayoutが `connection()` を待つので、すべてのページが要求ごとに作られる（`src/app/layout.tsx:26`）。HTMLの応答が `private` と `no-store` を持つことを、このタスクで試験にした（`tests/secreview.spec.ts`「private, no-store page response on …」、9ページ）。共有cacheの実際の挙動は  のとおり未検証。
- ログと誤りの文言：`src/` に `console.*` の出力はない。actionとrouteは決まったコードか同じ404だけを返し、DBやAuthの文言を出さない（`src/server/rpc.ts:29-33`、各actionの `catch`）。存在の推測は、拒否・存在しないを同じ `not_available`/404にそろえることで防いでいる。
- 登録されなかった写真のobject（2026-11-15）：保持期限の削除が、どの `profile_photos` の行も指さない24時間以上前の `profile-photos` のobjectも消す（RETENTION-003 `d526b43`、順26 `supabase/migrations/20261115120026_orphan_photo_retention.sql`、`scripts/maintenance/retention.mjs`。`--apply` のときだけ、dry runは件数だけ。HOSTED-014で適用、hostedの対象は0で `--apply` は未実行）。`verification-documents` の同じobjectも、順27（RETENTION-004 `c98cf95`、`supabase/migrations/20261115120027_orphan_document_retention.sql`）で、どの提出も名前を持たない24時間以上前のものを同じスクリプトが消す（`--apply` のときだけ）。あわせてアップロードの方式の `submit_verification` は、12時間未満でまだどの提出も名前を持たないobjectだけを受け付けるので、一覧に出たobjectが後から提出に使われることはない（[04_DATABASE](04_DATABASE.md) §5.2・§11）。HOSTED-015で適用（`docs/safety/HOSTED-015-execution-20261115.json`）、hostedの対象は0で `--apply` は未実行。取込みの方式は `synthetic` のままなので、提出の確認はPGliteの試験でだけ通している。

**指摘：** なし（新しいもの）。

## 5. Web（ヘッダー、CSRF、アップロード、回数・長さ）

**読んだファイル：** `next.config.ts`、`src/lib/csp.ts`、`src/proxy.ts`、`src/app/layout.tsx`、`tests/security-headers.spec.ts`、`tests/csp.spec.ts`、`tests/csp.test.tsx`、`tests/proxy.test.tsx`、入力検査（`src/lib/onboarding-validation.ts`、`src/lib/chat-gateway.ts`、`src/lib/auth-validation.ts`）。

**確認したこと：**

- CSP（SEC-002）：要求ごとの128ビットのnonce、`script-src 'self' 'nonce-…' 'strict-dynamic'`、本番の `style-src` もnonce、`img-src 'self' data:`、`connect-src` は自分とSupabaseのURLだけ、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`、`frame-ancestors 'none'`（`src/lib/csp.ts:7-29`）。要求に付いて来た `x-nonce`・CSPのヘッダーは置き換える（`tests/proxy.test.tsx`「replaces untrusted nonce/CSP request headers …」）。nonceのない差し込みscriptは止まる（`tests/csp.spec.ts`「blocks an injected inline script without a nonce」）。
- そのほかのヘッダー（SEC-001）：`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy`、`Permissions-Policy`、`COOP same-origin`、`X-Powered-By` なし（`next.config.ts:15-29`、`tests/security-headers.spec.ts`）。
- CSRF：状態を変えるのはServer Actionと、2026-11-15からは写真の `POST /api/photos`（SEC-007、自分で同じoriginを確かめる。L-3）だけで、ほかのroute handlerはGETか保存しないCSPの報告の `POST /api/csp-report` で、メール確認の他は状態を変えない。Next.jsはServer ActionのOriginとHostを比べ、`next.config.ts` に `allowedOrigins` の追加はない。セッションのcookieは `SameSite=Lax`。
- アップロード：写真は8 MB以下、JPEG・PNG・WebPだけ、アニメーションは拒否、メタデータを捨ててWebPに作り直す（`src/server/photo-actions.ts:34-35`、`src/server/storage/photo-image.ts`、`tests/photo-image.test.tsx`）。bucketもWebPだけ・2 MB以下（§3）。実資料のアップロードの画面はない。
- 長さ：表示名20、自己紹介500、目的200、申請のメッセージ200、チャット2000、通報の詳細1000、運営のメモ1000、パスワード8〜72（UTF-8で72バイト以下）、メール254。アプリとDBの両方で確かめている（`src/lib/*-validation.ts`、`src/server/*-actions.ts`、migrationの `char_length` の検査）。非表示の指定は合わせて50件まで（`src/server/privacy-actions.ts:17`）。
- 回数制限：申請20/日、通報10/日、メッセージ30/分、ブロック20/日（合計500）、非表示設定20/日（`20261027120005_staff_audit.sql:55-69`）、写真10/10分（順21、`20261111120021_photo_rate_limit.sql:24`）、ログイン10/15分（アドレスごと）・TOTP10/10分（利用者ごと）（順22、`20261111120022_auth_rate_limit.sql:28-29`）、ログインのIPごと30/15分（順24、Vercelのときだけ、M-1）、登録5/1時間（アドレスごと）・登録のIPごと10/1時間（順25、IPはVercelのときだけ、`20261115120025_signup_rate_limit.sql`、M-1）。写真の同時の復号はプロセスごとに2件・待ち4件（SEC-011、M-2）。確認リンクの制限はアプリにない（M-1）。

**指摘：**

- **L-1（low、修正済み）画像の拡張子で終わる入れ子のパスがproxyを通らない。** proxyのmatcherは `.*\.(svg|png|…)$` で終わるパスをすべて除いていたため、`/talk/x.png` や `/profiles/a.svg` のようなページのパスは、CSPのヘッダーもセッションの更新もログインへの転送もないまま描画されていた。ページ自身がIDを検査し、DBが認可するので、情報は漏れない（多層防御の欠け）。
  - 修正：除くのを最上位のファイル（`/demo-profile-1.svg` など `public/` のもの）だけにした（`src/proxy.ts:66`、`[^/]+\.(…)$`）。
  - 試験：`tests/proxy-matcher.test.tsx`（Nextの資産と最上位の画像は今までどおり除き、入れ子のパスは通す）、`tests/secreview.spec.ts`「nonce CSP on the image-like page path …」（ビルドしたアプリでCSPが付く）と「top-level public image is served without the page CSP」。

- **L-3（low、修正済み）Server Actionの本文の上限9 MBが全actionに効く。** `bodySizeLimit: "9mb"`（`next.config.ts:14`）は写真のためだが、Next.jsの設定は全actionに共通で、ログインしていない人もどのactionにも9 MBまでの本文を送れる。本文はactionの検査の前に読まれる。対応案：写真の登録を専用のroute handlerに移し、actionの上限を既定に戻す。
  - 修正（2026-11-15）：SEC-007（`bb74609`）で、写真の登録は `POST /api/photos`（`src/app/api/photos/route.ts`）に移り、`next.config.ts` の `bodySizeLimit: "9mb"` を削除して、Server Actionの本文の上限は既定に戻った。routeはOriginのhostと `Host` が同じでなければ403（`X-Forwarded-Host` は読まない、Originがない・`null`・`Sec-Fetch-Site` が別のサイトも403）、multipartだけ（415）、`Content-Length` が必須（411）、本文は8 MiB＋64 KiBまでを数えながら読み、超えたら413、すべて `no-store`。処理は `src/server/photo-upload.ts` に移した。
  - 残るもの：Nextのproxyは、routeに渡す前に既定の10 MBまで本文を読む（フレームワークの動き）。
  - 残りの修正（2026-11-16）：SEC-015（`ccd3619`）で、proxyのmatcherから `/api/photos` だけを外した（`src/proxy.ts`）。Next 16.4.3はproxyが動く道でだけ本文を写すため、写真の本文はrouteの前にためられない。routeは本文を読む前に、別のoriginを403、セッションなし・更新できない古いセッションを401で断り、どの答えも `no-store` と `default-src 'none'; frame-ancestors 'none'` のCSP（`src/app/api/photos/route.ts`、hosted run `24cfc4ef06c2` 11件PASS）。SEC-016（`4c01dae`）で、`experimental.proxyClientMaxBodySize` を1 MiB＋256 KiBにし（`next.config.ts`）、proxyを通るほかの道の本文の写しはこの大きさまで。超えた本文は切られ、切られたServer Actionの本文はNextが1 MiBの上限で断る（手動の確認では500 `Body exceeded 1 MB limit`）。matcherの点は `[.]` と書く（`favicon.ico` の点がどの文字にも合っていた）。hosted run `5f1db2e704bb` 11件PASS。どちらもArgon Medium PASS。

- **L-6（low）HSTSとCSPの報告先がない。** `Strict-Transport-Security` はホスティングで付ける前提で、今は付けない（`tests/security-headers.spec.ts` が「ない」ことを確かめる）。CSPの違反の報告先（`report-to`）もない。公開前にホスティングで設定する項目。
  - 一部修正（2026-11-12）：
    - HSTS：保護つきのVercelの配置（DEPLOY-001）で、Vercelが `*.vercel.app` に `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` を付けることを確かめた（`docs/safety/DEPLOY-001-execution-20261112.json` `signed_in_check.headers`）。アプリ自身は今も付けない。
    - CSPの報告：SEC-009（`97189ab`）で、CSPの末尾に `report-uri /api/csp-report; report-to csp-endpoint` と `Reporting-Endpoints` のheaderを加え、報告は自前のroute `/api/csp-report`（`src/app/api/csp-report/route.ts`）に届く。POSTだけ、本文は16 KBまで、報告ごとに `console.warn` 1行、保存しない、いつも204。試験：`tests/csp-report.test.tsx`、`tests/csp.spec.ts`。
    - 残るもの：独自ドメインを使うときは、そのドメインのHSTSを別に確かめる・設定する必要がある（今は独自ドメインなし）。

## 6. 秘密情報と設定

**読んだファイル：** `.gitignore`、`next.config.ts`、`src/lib/supabase/config.ts`、`src/lib/backend.ts`、`src/server/storage/*.ts`、`tests/client-bundle.spec.ts`、`tests/service-key-scope.test.tsx`、`tests/supabase-config.test.tsx`。

**確認したこと：**

- `.env` と `.env.*` はGitの対象外（`.gitignore`）。リポジトリに `.env` のファイルはない（`git ls-files`）。中身は読んでいない。
- `src/` で読む環境変数は5つ：`CAMPUS_LINK_BACKEND`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（ブラウザに出る公開の値で、形を検査）、`CAMPUS_LINK_SITE_URL`（サーバーだけ、形を検査、`src/server/auth-actions.ts:11-23`）、`SUPABASE_SERVICE_ROLE_KEY`（§2の3つのモジュールだけ、形を検査、表示しない）。
- `src/server/` のファイルは、画面と共有する定数だけの `account-rules.ts` を除いて `import "server-only"` を持ち、クライアントのコードから取り込むとビルドが失敗する。本番のブラウザ向けの成果物にservice roleのキーの形がないことを `tests/client-bundle.spec.ts`（NT-23）が確かめる。クライアントのコンポーネントがRPCや表を直接呼ぶ所はなく、ブラウザのSupabaseクライアントはRealtimeの購読だけに使う。

**指摘：** なし（cookieはL-4、SEC-010で修正済み）。

## 点検しなかったこと

- hostedの設定：Authの回数制限、JWTの有効期間、セッションの期限、refresh tokenの再使用の検出、Site URLとredirectの許可一覧の実際の値。bucketとRLSのhostedでの状態は通し試験の範囲だけ。
- 依存パッケージの既知の脆弱性（`npm audit` は外部に問い合わせるため実行していない）。Next.jsのServer ActionのOrigin確認など、フレームワークの内部の実装。
- `scripts/maintenance/retention.mjs` とhostedの試験の準備（`tests/e2e-hosted/`）でのservice roleの扱い。
- 本番のホスティング・CDNのヘッダーとcache、HTTPS。
- 実資料のアップロードの経路（画面がない）と、法令に適合する年齢確認。
- 侵入試験、ファジング、負荷試験。

## 試験

- `npm run typecheck`、`npm test`、`npm run test:e2e`（デモ）。DBは変えていないので、hostedの試験は実行していない。
- 追加した試験：`tests/proxy-matcher.test.tsx`（2件）、`tests/secreview.spec.ts`（12件）。

## SECREVIEW-002（2026-11-15、eab088b..HEAD の差分）

SECREVIEW-001（`eab088b`）の後に変わったコード（`git diff eab088b HEAD -- src supabase/migrations scripts/maintenance next.config.ts`、39ファイル・約1,480行）と、そのコードが呼ぶものを読んだ。各タスクはそれぞれ審査を受けているので、ここではタスクの境界をまたぐ問題を探した。コードは変えていない。hostedには何もしていない。これは公開の準備ができたことを示すものではない。

### 読んだファイル

- **route・page：** `src/proxy.ts`、`src/app/api/photos/route.ts`、`src/app/api/realtime-token/route.ts`、`src/app/api/csp-report/route.ts`、`src/app/auth/confirm/route.ts`、`src/app/auth/confirmed/page.tsx`、`src/app/admin/accounts/page.tsx`。
- **lib：** `src/lib/csp.ts`、`src/lib/supabase/cookie-options.ts`・`server.ts`・`browser.ts`。
- **server：** `src/server/auth-rate.ts`、`auth-actions.ts`、`mfa-actions.ts`、`decode-slots.ts`、`photo-upload.ts`、`photo-actions.ts`、`admin-account-actions.ts`、`admin-accounts.ts`、`admin-staff-actions.ts`、`request-actions.ts`、`rpc.ts`、`storage/photo-ingest.ts`（パスの形）。
- **component：** `src/components/admin-accounts-live.tsx`、`admin-live.tsx`、`admin-staff-live.tsx`、`logout-button.tsx`、`mypage-live.tsx`、`onboarding.tsx`、`photo-manager.tsx`。
- **migration：** 順20〜27の8本の全文。呼ばれる既存の関数（`private.require_user`・`lock_rate`：`20261027120001_foundation.sql:95-110`、`private.require_account`：`20261027120003_accounts.sql:150-159`、`private.rate_ok`・`rate_record`・`require_staff`・`rls_document_upload_allowed`：`20261027120005_staff_audit.sql:76-111`、`remove_photo`・`reorder_photos`：`20261027120007_visibility.sql:408-454`、Storageのpolicy：`20261109120015_storage.sql:1-11`）。
- **保守script：** `scripts/maintenance/retention.mjs` の全文。
- **試験と依存：** `tests/db/allowlist.ts`、`tests/service-key-scope.test.tsx`、`tests/db/orphan-document-retention.test.ts:120-150`、`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3427-3457`（`signOut` の動き）。

### 確認したこと

**1. タスクをまたぐ迂回**

- 新しい公開のRPCは、どれもsecurity definerで `search_path = ''`（順20 `:16`、順21 `:34`、順22 `:61,84`、順23 `:9`、順24 `:74`、順25 `:44`、順26 `:22`、順27 `:107,178`）。privateの補助（`signin_rate_key`・`signin_ip_rate_key`）は呼び手の権限で動き、どのroleにも実行権がない（順22 `:55`、順24 `:64`）。これは既存の `lock_rate` と同じ形。
- grantは、どれも一度すべてのroleから外してから、必要なroleにだけ付けている。
  - 利用者が呼ぶもの（authenticatedだけ）：`admin_grant_role`（順20 `:38-39`）、`reserve_photo_upload`（順21 `:47-48`）、`reserve_mfa_attempt`（順22 `:96-97`）、`admin_list_suspended_accounts`（順23 `:28-29`）、`submit_verification`（順27 `:243-244`）。
  - service_roleだけ：`service_reserve_signin`（順24 `:104-105`）、`service_reserve_signup`（順25 `:74-75`）、`service_retention_candidates`（順27 `:169-170`）。
  - 試験の許可の一覧も同じ（`tests/db/allowlist.ts:28,43,48,51`）。
- 誰が呼んだかは、どれも `private.require_user`・`require_staff` から取り、引数からは取らない。管理の関数は `require_staff` を通り、aal2と役割を求める（順20 `:17`、順23 `:11`、`20261027120005_staff_audit.sql:95-98`）。
- ロックは既存の順番（rate → staff_roles → verification、`20261027120001_foundation.sql:105`）を守る。
  - 順21・22は rate だけを取る。
  - 順24・25は、アドレスの鍵を先、IPの鍵を後に取る（順24 `:87-90`、順25 `:57-60`）。
  - 順20・23は staff_roles だけを取る。
  - 順27は、入力の確認の後に verification を取る（`:202`）。
- service roleのキーを読むのは4つのモジュールだけ。差分で加わったのは `src/server/auth-rate.ts:41-45` で、`tests/service-key-scope.test.tsx:6` の一覧に入っている。
  - `auth-rate.ts` が受け取るのは、入力したアドレスとVercelのIPだけ。それを決まったRPC 2つに渡すだけで、結果は `ok`・`rate_limited`・`unavailable` の3つにしかならない（`:38-53`）。
  - 写真のservice roleの経路（`storePhoto`・`registerPhoto`）が使う `userId` は、同じ要求の `my_account` の答えだけ（`src/server/photo-upload.ts:37-39,59-62`）。
- `/admin/accounts` は `requireAdminSession` を通る（`src/app/admin/accounts/page.tsx:11`）。解除は既存の `admin_set_account_status` だけを通る（`src/server/admin-account-actions.ts:17-22`）。一覧のRPCは自分の行を返さず、一覧を見るたびに監査の行を書く（順23 `:13,24`）。
- `/api/photos` と `/api/realtime-token` は、proxyの公開のパスに入っていない。セッションがなければ、本文を読む前に `/login` へ転送される（`src/proxy.ts:52-53`）。新しく公開のパスに入ったのは `/api/csp-report` の1つだけで、パスが完全に一致するときだけ公開になる（同 `:52`）。

**2. 回数制限と鍵**

- どれも、予約はAuthを呼ぶ前にあり、`ok` でなければAuthを呼ばない。
  - ログイン：予約が `src/server/auth-actions.ts:72-74`、Authの呼出しが `:78`。
  - 登録：予約が `:36-38`、Authの呼出しが `:42`。
  - TOTP：予約が `src/server/mfa-actions.ts:57-58`、Authの呼出しが `:59`。
  - 写真：予約が `src/server/photo-upload.ts:46-49`、復号が `:51`。
- アプリの中で `signInWithPassword`・`signUp`・`challengeAndVerify` を呼ぶのは、上のそれぞれ1か所だけ（`grep`）。アプリの別の経路から迂回する方法はない。アプリの外からの迂回はN-1。
- IPを読むのは `VERCEL=1` のときだけで、`x-real-ip` を読む。`x-forwarded-for` は読まない（`src/server/auth-rate.ts:25-35`）。IPとして読めない値は渡さない。DBでも、1つのホストのアドレスでなければ `validation` で何も数えない（順24 `:39-62`）。
- アドレスとIPの両方を確かめ、記録は両方とも残すか、両方とも残さない（順24 `:91-100`、順25 `:61-70`）。

**3. セッションとトークン**

- cookieを書くclientは2つで、どちらも `sessionCookieOptions()`（`httpOnly: true`）を使う（`src/lib/supabase/server.ts:11`、`src/proxy.ts:30`、`src/lib/supabase/cookie-options.ts:6-8`）。ブラウザのclientはcookieを使わず、`accessToken` のcallbackだけを持つ（`src/lib/supabase/browser.ts:50`）。
- `/api/realtime-token` の確かめ方（`src/app/api/realtime-token/route.ts:13-29`）：
  - `Sec-Fetch-Site` が同じoriginでなければ403。
  - `getClaims()` の `sub` と、セッションの利用者が同じときだけ答える。
  - 答えはアクセストークンと期限だけで、`no-store`。
  - ブラウザ側は、期限の60秒前まで同じトークンを使い、取りに行く要求は1つにまとめる（`src/lib/supabase/browser.ts:29-42`）。要求は `cache: "no-store"`（同 `:16`）。
- ログアウトの `local`・`global` の使い分けは設計どおり（`src/server/auth-actions.ts:120-131`）。`global` の失敗の扱いはN-4。
- `/auth/confirm` は、成功しても `/auth/confirmed` へ送る。`next` は `safeNextPath` を通したものだけを渡す（`src/app/auth/confirm/route.ts:36-41`）。`/auth/confirmed` は、使えるアカウントのときだけアドレスを出す。`next` をもう一度 `safeNextPath` で確かめ、なければ `/onboarding` にする（`src/app/auth/confirmed/page.tsx:17-35`）。

**4. アップロード**

- 本文を読む前に次を確かめる（`src/app/api/photos/route.ts:59-67`）：
  - 同じorigin（`Origin` と `Host`。`X-Forwarded-Host` は読まない）。
  - multipartであること。
  - `Content-Length` が10桁以下の数字であること。
- 本文は数えながら読み、上限を超えたら読むのをやめる（同 `:35-57`）。
- 復号の枠は2件で、ほかに4件まで待てる（10秒まで）。返すのは1回だけで、時間切れの待ちは列から外れる（`src/server/decode-slots.ts:24-37,49-55`）。枠は `finally` で、Storageに書く前に返す（`src/server/photo-upload.ts:55-57`）。
- 失敗したときの後始末（`src/server/photo-upload.ts:58-73`）：
  - 登録に失敗したら、objectを消す。
  - `storePhoto` が書いた後に投げたとき（応答が失われたときなど）と、後始末の削除に失敗したときは、どの行も指さないobjectが残る。これは順26（順27 `:138-143`）の `orphan_photo` が24時間後に消す。
  - 例外は `removePhoto` の後始末の失敗で、N-5に書いた。

**5. 保持期限（順26・27、`retention.mjs`）**

- 一覧に出るのは、パスの先頭のフォルダがその行の `user_id` と同じで、パスの規則に合い、objectが今あるものだけ（順27 `:161-165`）。scriptも同じ規則で確かめ、外れた行が1つでもあれば止まる（`scripts/maintenance/retention.mjs:72-82`）。
- `orphan_photo` は、どの `profile_photos` の行にも名前のないものだけ（順27 `:143`）。`orphan_document` は、どの提出（どの状態・どの取込みの方式でも）にも名前のないものだけ（同 `:151`）。
- 提出に使えるのは12時間未満のobjectだけで、一覧に出るのは24時間以上のものだけ。そのため、一覧に出たobjectが後から提出に使われることはない（同 `:193-198`）。どの提出も名前を持たないことは、ロックの後にもう一度確かめる（同 `:202-207`）。
- 途中で止まっても続きからやり直せる。
  - 一覧に出るのは、objectが残っているものだけ。
  - 次の一覧の件数が前より減らなければ止まる（`retention.mjs:202`）。
  - Storageの削除の答えに名前のないものがあれば止まる（同 `:245-247`）。
  - アカウントを消すのは、objectを消した後。
- 新しく加わったorphanの2種類は、dry runでもapplyでも件数だけを出し、パスも利用者IDも出さない（`retention.mjs:225-227`）。
  - 既存の行（RETENTION-001）は、期限の来た提出のIDと利用者のIDを出す（同 `:205,222,224`）。どちらも名前やアドレスではないuuidで、出力を見るのはservice roleのキーを持つ運用者。この差分では変わっていないので、指摘にはしない。

**6. CSPとヘッダー**

- nonceは要求ごとに作る（`src/lib/csp.ts:7-10`）。CSPと `Reporting-Endpoints` は、次のすべてに付く：
  - proxyを通る応答（`src/proxy.ts:15-24`）。
  - cookieを更新した応答（同 `:43`）。
  - `/login` への転送（同 `:60-62`）。
  - proxyを通らないのは、最上位の画像とNextの資産だけ（同 `:73`）。
- `/api/csp-report` の動き（`src/app/api/csp-report/route.ts`）：
  - 16 KiBまでしか読まない（`:12-36`）。
  - 保存しない。
  - 応答は、どの本文でも204で、本文なし（`:107`）。
  - ログに出すのは、指令の名前、止めたもののorigin（またはscheme）、文書のパス（200文字まで）、disposition だけ（`:41-79`）。
- `no-store` が付くもの：`/api/photos`（`route.ts:15-18`）、`/api/realtime-token`（`:8-10`）、`/api/csp-report`（`:8-9`）、`/auth/confirm`（`:41`）。

**7. ログと誤りの文言**

- 差分で加わった `console.*` は、`/api/csp-report` の `console.warn` 1つだけ（`src/app/api/csp-report/route.ts:73`。`grep console.` で `src/` にほかはない）。
  - 文書のパスには、`/talk/<id>` のようなページのIDが入りうる。
  - ただし、そのページへの要求そのものはホスティングの要求のログにも残り、報告の行には利用者もIPも入らない。そのため指摘にはしない。
- 新しいactionとrouteが返すのは決まった状態のコードだけで、DBやAuthの文言は返さない（`src/server/rpc.ts:30-34`）。
  - `mfa_required` は管理者の付与の画面にだけ出る（`src/server/admin-staff-actions.ts:13`）。利用者の申請では `unavailable` に直す（`src/server/request-actions.ts:13`）。
  - 登録は、既存のアドレスでも同じ `sent` を返す（`src/server/auth-actions.ts:46`）。

### 指摘

- **N-1（medium）アプリの認証の回数制限は、Supabase Authを直接呼べば通らない。**
  - アプリの回数制限は、アプリのサーバーを通る経路でしか数えない。対象は `signin`・`signin_ip`・`signup`・`signup_ip`・`mfa` で、アプリの側で予約を呼ぶのは次の3か所だけ。
    - `src/server/auth-actions.ts:36,72`
    - `src/server/mfa-actions.ts:57`
  - 一方、AuthのURLと公開キーはブラウザのコードに入っている（`src/lib/supabase/browser.ts:49-50`、CSPの `connect-src` にもSupabaseのoriginがある `src/lib/csp.ts:14-18`）。これはサーバーがAuthを呼ぶときと同じキーである（`src/lib/supabase/server.ts:8-10`）。
  - 失敗の場面：
    - (a) 攻撃者が公開キーを `apikey` に付けて、`POST https://<ref>.supabase.co/auth/v1/token?grant_type=password` を多くのIPから送り、1つのアドレスのパスワードを試し続ける。`service_reserve_signin` は呼ばれないので、アドレスごとの15分に10回の制限は効かない。効くのは、Supabaseの要求元IPごとの制限だけになる。
    - (b) `POST /auth/v1/signup` を、違うアドレスで繰り返す。確認メールが送られ、プロジェクトのメールの送信の枠を使い切り、本当の登録が `rate_limited` になる。これは順25が防ごうとしたこと（`supabase/migrations/20261115120025_signup_rate_limit.sql:2-4`）である。
    - (c) 盗んだパスワードでAuthから直接aal1のセッションを得て、`/auth/v1/factors/{id}/challenge` と `/verify` でTOTPを総当たりする。`reserve_mfa_attempt` は呼ばれない。
  - 対応案（行っていない）：
    - SupabaseのAuthのCAPTCHA（登録・ログインでAuth自身が確かめるので、直接の呼出しにも効く）を使えるか確かめる。費用がかからないことを先に確かめる。
    - hostedのAuthのIPごとの回数制限（ログイン・登録・確認・MFA）の値を確かめて決め、 に残るリスクとして書く。
    - アプリ側の制限は、アプリの経路の多層防御として残す。
  - hostedのAuthの制限の値は、2026-11-16に読んだ（下の「未確認」U-2）。

- **N-2（low、修正済み）写真の本文は利用者ごとの制限より前に全部読まれ、復号の枠の拒否は予約を使わない。**
  - `POST /api/photos` は、本文（8 MiB＋64 KiBまで）を全部メモリに読み、`formData()` に解く（`src/app/api/photos/route.ts:69-71`）。その後で初めて、アカウントの確認と復号の枠を取る（`src/server/photo-upload.ts:38-42`）。
  - 枠が取れないときの `rate_limited` は、`reserve_photo_upload` の前に返る。そのため、利用者ごとの10分に10回の数に入らない（同 `:40-42`、SEC-011の設計）。
  - 同時に読める本文の数には、利用者ごとにもプロセスごとにも上限がない（proxyも、routeに渡す前に本文を読む。SECREVIEW-001 L-3の残るもの）。
  - 失敗の場面：ログインした1人が、8 MiBのmultipartを同時に数百件送り、それを繰り返す。どの要求も本文とその解析で約16 MiB以上を持つ。2件を除けば枠の拒否で終わり、予約は使われない。そのため利用者ごとの制限に届かないまま、インスタンスのメモリを使い続けられ、ほかの利用者の応答が遅れたり落ちたりする。
  - 対応案（行っていない）：
    - 本文を読む前に、アカウントの確認と、利用者ごとの同時の上限（たとえば1件）または枠を取る。
    - または、本文を読む前に予約し、枠の拒否でも数える（忙しいときに予約を使う、という今の決めごとの見直しになる）。
  - 修正（2026-11-16）：FIX-002（`0b55684`）で、`POST /api/photos` は本文を1バイトも読む前に、アカウントの確認、利用者ごとのアップロードのlock（同じ利用者の2件目は `rate_limited`）、プロセスごとに4つの本文の枠（待ちなし）を取る。どの拒否もすぐに答え、予約を使わない。本文は30秒以内に読み終わらなければ取り消して `invalid`（`src/app/api/photos/route.ts`、`src/server/photo-upload.ts`、`tests/photo-upload-route.test.tsx`）。
  - 残るもの：lockと枠はメモリの中・プロセスごとで、インスタンスをまたいでは制限しない。proxyはrouteの前に本文を読みうる（SECREVIEW-001 L-3の残るもの）。
  - proxyの修正（2026-11-16）：SEC-015（`ccd3619`）で `/api/photos` はproxyの外になり、Nextはこの本文をrouteの前に写さない（上のL-3の残りの修正）。lockと枠がプロセスごとであることは変わらない。

- **N-3（low、修正済み）役割を持つ人のTOTPは、付与のときだけ確かめる。**
  - 順20は、付与のときに、確認済みのTOTPがあるかを見る（`supabase/migrations/20261111120020_grant_requires_totp.sql:28-31`）。一方、管理のRPCが見るのは、aal2と役割の行だけ（`20261027120005_staff_audit.sql:95-98`）。
  - 確認済みのTOTPがなければ、aal1のセッションでTOTPを登録できる（`src/server/mfa-actions.ts:26-31`）。そのため順20 `:9-10` の注記「TOTPのない役割の持ち主は操作できない」は、TOTPを登録し直せば成り立たない。
  - 失敗の場面：審査者Xが認証アプリをなくし、運用者がSupabaseのダッシュボードでXのTOTPを消す（または、Xがaal2でAuthの `unenroll` を呼ぶ）。役割の行は残る。Xのパスワードを知る人がログインし、`/admin/mfa` で自分のTOTPを登録すると、aal2になって審査の資料と生年月日を見られる（SECREVIEW-001 M-3と同じ結果）。
  - 対応案（行っていない）：
    - `private.require_staff` でも、確認済みのTOTPがあるかを確かめる。
    - または、役割を持つ人がTOTPを登録するのを拒み、運用者が役割を外してから登録し直す手順にする。
    -  に「TOTPを消す前に役割を外す」を書く。
  - 修正（2026-11-16）：SEC-013（`242834c`、migration 順29）で、新しい `private.staff_role_effective` が、取り消されていない行があり、行の `granted_at` 以前に作られた確認済みのTOTPがあり、`granted_at` より後に作られた確認済みの要素がないときだけ真になり、`private.require_staff`（すべての管理RPC）と `my_staff_roles` がこれを使う。TOTPを消して登録し直した人の役割は働かない（`tests/db/staff-totp-binding.test.ts`）。hostedにはHOSTED-016で適用した（`docs/safety/HOSTED-016-execution-20261116.json`）。運用の手順（TOTPを消す前に役割を外す、置き換えた後は外して付与し直す、唯一のadminの役割が働かなくなったときの運用者の付け直し）は  §2。
  - 注記（端のこと、直していない）：`admin_revoke_role` の最後のadminの規則は、取り消されていないadminの行の数で数え、その役割が働いているかを見ない（`20261027120010_admin.sql:509-511`）。働かないadminの行がほかに残っていると取消しが通り、働くadminが0人になりうる。adminの役割を外す前に確かめる（§2）。
    - 修正（2026-11-16）：SEC-014（`184a5a9`、migration 順30）で、最後のadminの規則は、対象者以外の利用者の取り消されていない働いているadminの行（`private.staff_role_effective`）で数え、なければ同じ `invalid_state` で拒む。同じ排他のlockの下で、最初の書込みより前に確かめる（`tests/db/last-admin-acting.test.ts`）。hostedにはHOSTED-017で適用した（`docs/safety/HOSTED-017-execution-20261116.json`、`admin_revoke_role` の本体が順30と同じ）。拒否はPGliteの試験でだけ確かめている。
  - 背景（観測、2026-11-16）：TEST-016（`00f4560`、run `0c0391e5f237`）で、確認済みの要素がある利用者がaal1で要素を登録しようとすると、hostedのAuthは `insufficient_aal`（403）で拒んだ。上の失敗の場面（TOTPを消した後の登録し直し）は、確認済みの要素がない場合のことで、この観測で変わらない。付与の後にaal2で要素を加えた役割が働かないことは、TEST-016がhostedで確かめた。

- **N-4（low、修正済み）「すべての端末からログアウト」の失敗が、成功と同じに見える。**
  - `signOutAndLeave` は `signOut({ scope })` の答えを見ないで、いつも転送する（`src/server/auth-actions.ts:109-117`）。
  - auth-jsは、取り消しのAPIが失敗すると、投げずに `{ error }` を返す。そのうえで、この端末のセッションだけは消す（`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3439-3449`）。
  - 失敗の場面：利用者が、ほかの端末のセッションが盗まれたと思って「すべての端末からログアウト」を押す。そのときAuthが5xxを返すか、通信が切れる。この端末はログアウトして `/welcome` に移り、成功のときと見分けがつかない。盗まれたセッション（refresh token）は、期限まで使える。
  - 対応案（行っていない）：`global` のときは `error` を見る。失敗なら転送せずに失敗の状態を返し、もう一度押してもらう（この端末のセッションはもう消えているので、ログインからやり直してもらう案内にする）。
  - 修正（2026-11-16）：FIX-002（`0b55684`）で、`signOutAndLeave` は `signOut` の `error` を見て、`global` で `error` が返るか例外のときは `/login?error=signout` へ送る。`/login` は決まった文（ほかの端末のログアウトを確かめられなかったので、ログインしてもう一度押す）を `role="alert"` で出す。Authの失敗の内容は出さず、ログにも書かない。`local` は同じ（`src/server/auth-actions.ts`、`src/app/login/page.tsx`、`tests/auth-actions.test.tsx`、`tests/login-page.test.tsx`）。

- **N-5（low、修正済み）削除した写真のobjectの削除に失敗すると、保持期限でも消えない。**
  - `removePhoto` は、行を `status = 'removed'` にした後、objectの削除を1回だけ試し、失敗は無視する（`src/server/photo-actions.ts:21,27-30`、`20261027120007_visibility.sql:429`）。
  - 行は残ってパスを指し続ける。一方、順26・27の `orphan_photo` は、状態を問わず、どの行も名前を持たないobjectだけを一覧に出す（`supabase/migrations/20261115120027_orphan_document_retention.sql:143`）。
  - ほかに、`removed` の写真のobjectを一覧に出す種類はない（`account` は退会から30日後だけ、同 `:120-122`）。
  - 失敗の場面：利用者が写真を消したとき、Storageの削除が通信の失敗で通らない。配信は止まる（`photo_delivery_allowed` は `active` だけ）。しかし、利用者が消したつもりの写真のobjectは、アカウントが退会して30日経つまで残る（[04_DATABASE](04_DATABASE.md) の `remove_photo` の行は「E-1が後で消す」としている）。
  - 対応案（行っていない）：保持期限の一覧に `removed_photo`（`status = 'removed'` の行のうち、objectが残るもの）を加える。または、objectを消せたときに行も消す。
  - 修正（2026-11-16）：RETENTION-005（`256dd10`、migration 順28）で、`orphan_photo` は `active` の行が名前を持たないobjectも出す（`removed` の行だけが名前を持つものを含む。保持期限の来た退会アカウントの行が名前を持つものは `account` だけが出す）。種類の名前は同じなので `retention.mjs` は変えていない（`tests/db/removed-photo-retention.test.ts`）。hostedにはHOSTED-016で適用し、dry runは対象0（`--apply` は未実行）。

- **N-6（low、取込みが `upload` のときだけ、修正済み）パスの規則に合わない確認資料のobjectは、保持期限で消えない。**
  - 利用者が確認資料のbucketに書けるかどうかは、パスの先頭のフォルダが本人であることと、取込みが `upload` であることだけで決まる（`20261027120005_staff_audit.sql:104-111`、`20261109120015_storage.sql:9-11`）。
  - 一方、次の3つはどれもパスの規則（`^<uid>/[A-Za-z0-9_-]{1,64}(/…)*\.webp$`）に合う名前しか扱わない。
    - 提出（`supabase/migrations/20261115120027_orphan_document_retention.sql:193-198`）。
    - `orphan_document` の一覧（同 `:161-165`。合わない名前を一覧に出さないことは `tests/db/orphan-document-retention.test.ts:125-149` が確かめている）。
    - `account` の一覧（提出が名前を持つものだけ、同 `:124-127`）。
  - 失敗の場面：取込みを `upload` にした後、利用者が `<自分のuid>/scan.v2.webp` や、65文字の名前のWebPを置く。どの提出にも使えず、24時間後の一覧にも、退会の後の一覧にも出ないので、資料の画像が期限なく残る。置ける数にも制限がない。
  - 今は取込みが `synthetic` で、policyが書込みを拒むため起きない。
  - 対応案（行っていない）：書込みのpolicyに、提出と同じパスの規則を加える。または、本人のフォルダにある規則外の名前も24時間後に一覧に出す。あわせて、書込みの数の上限を設ける。
  - 修正（2026-11-16）：RETENTION-005（`256dd10`、migration 順28）で、`private.rls_document_upload_allowed` は、提出と同じパスの規則に合う名前と、本人のフォルダに16個未満のobject（新しい行の前に数える、同時の書込みでは最善の努力）を求める（`tests/db/removed-photo-retention.test.ts`）。hostedにはHOSTED-016で適用した。取込みは `synthetic` のままなので、規則の働きはPGliteの試験でだけ確かめている。

### 未確認

指摘にはしていない。それぞれ、何を確かめれば決まるかを書く。

- **U-1 Vercelは、利用者が付けた `x-real-ip` を必ず上書きするか。**（解決、2026-11-17。下の「確かめた」）
  - **確かめた（2026-11-17、司令塔、本人がOrcaのブラウザでVercelにログインし直した後）**：保護つきの配置の `/login` から、存在しない架空のアドレスと誤ったパスワードで、`X-Real-IP`・`X-Forwarded-For` に `203.0.113.7` と `198.51.100.9`（文書用の範囲）を付けたログインを1回ずつ送った（どちらも失敗、セッションなし）。読むだけのSQLで、直前の30分の `signin_ip` は0件→2件、鍵は1つで2件、偽の2つのIPの鍵の件数は0。Vercelは利用者が付けた値を使わず、実際の接続元で数えた。U-1は解決。
  - アプリは、Vercelの資料を根拠に `x-real-ip` を信頼している（`src/server/auth-rate.ts:22-24`）。偽の値を付けた要求での動きは試していない。
  - 確かめ方：保護つきのVercelの配置に、偽の `x-real-ip` を付けたログインを2回送る。`signin_ip` の鍵が実際の接続元のものになり、偽の値ごとに数が分かれないことを確かめる。
  - Vercelの前に別のCDN（独自ドメインのproxy）を置くと、全員が同じIPに見えて、IPごとの制限を全員で分け合うことになる。この形の配置はまだない。
- **U-2 hostedのSupabase Authの回数制限の値（2026-11-16に読んだ、下）。** 対象は、ログイン・登録・確認・メールの送信・MFAの検証のIPごとの値で、N-1の重さを決める。SECREVIEW-001でも未確認。確かめ方：ダッシュボードのAuthのRate Limitsの値を記録する。
  - **読んだ値（2026-11-16、司令塔、ダッシュボードのAuth > Rate Limitsを読むだけ、何も保存していない）**：ログインと登録は接続元IPごとに5分で30回、確認（OTP・マジックリンク）はIPごとに5分で30回、セッションの更新はIPごとに5分で150回、匿名のサインインはIPごとに1時間で30回（変えられない）、メールの送信はプロジェクト全体で1時間に2通（組込みのSMTP、変えられない）、同じ利用者へのメールの最短の間隔60秒（custom SMTPのときだけ）。MFAの検証の値はこのページにない。「IP address forwarding」は**切ってある**（使うには秘密のAPIキーが要る）。
  - N-1への意味：Authを直接呼ぶ攻撃は、呼び出し元のIPごとに5分で30回までしか止まらない（多くのIPを使えば止まらない）。
  - 別の意味：アプリのサーバー（Vercel）からのログイン・登録は、Authからはサーバーの出口のIPに見える。一般公開で利用者が増えると、5分で30回の制限を利用者全員で分け合うおそれがある。
- **U-3 Storageの規則外の名前。** 規則外の名前（`.` を含む・65文字）のWebPを、hostedのStorageが受け付けるか（N-6の前提。PGliteの代わりの表でしか試していない）。確かめ方：試験の間だけ取込みを `upload` にして、合成の画像で書き込んでみる。
  - 順28（RETENTION-005）から、資料の書込みのpolicyが規則外の名前を断るので、新しいアップロードについてはこの問いは意味を持たない（N-6の修正）。取込みは今まで `synthetic` のままで、policyを通ったアップロードはない。

### 点検しなかったこと

- hostedの設定と挙動。U-1〜U-3と、SECREVIEW-001の「点検しなかったこと」のとおり。
- 差分の外のコード。ただし、差分が呼ぶ関数とpolicyは上の「読んだファイル」のとおり読んだ。
- `tests/e2e-hosted/` の準備でのservice roleの扱い。
- Next.jsのproxyやServer Actionの内部、依存パッケージの既知の脆弱性。
- 負荷試験と侵入試験。N-2のメモリの量は、コードから見積もったもの。

### 試験

- コードを変えていないので、新しい試験はない。疑いを確かめるために、既存の試験を流した：`npx vitest run tests/photo-upload-route.test.tsx tests/decode-slots.test.tsx tests/auth-actions.test.tsx tests/auth-rate.test.tsx tests/csp-report.test.tsx tests/service-key-scope.test.tsx tests/session-cookies.test.tsx` → 7ファイル・247件PASS。

## SECREVIEW-003（2026-11-16、49255e4..HEAD の差分）

SECREVIEW-002（`49255e4`）の後に変わったコード（`git diff 49255e4 HEAD -- src supabase/migrations scripts/maintenance scripts/e2e-hosted next.config.ts`、13ファイル・427行の追加と38行の削除）と、そのコードが呼ぶものを読んだ。対象はRETENTION-005（順28）、FIX-002、SEC-013（順29）、SEC-014（順30）、FIX-003、SEC-015・SEC-016と `scripts/e2e-hosted/bootstrap.sql`。各タスクはそれぞれ審査を受けているので、ここではタスクをまたぐ問題と、N-2〜N-6の修正がそれぞれの失敗の場面を閉じているかを見た。コードは変えていない。hostedには何もしていない。これは公開の準備ができたことを示すものではない。

### 読んだファイル

- **差分の全文：** `next.config.ts`、`src/proxy.ts`、`src/app/api/photos/route.ts`、`src/app/login/page.tsx`、`src/components/auth-form.tsx`、`src/lib/auth-validation.ts`、`src/server/auth-actions.ts`、`src/server/photo-upload.ts`、`scripts/maintenance/retention.mjs`、`scripts/e2e-hosted/bootstrap.sql`、migration 順28〜30（`20261116120028_removed_photo_retention.sql`・`20261116120029_staff_totp_binding.sql`・`20261116120030_last_admin_acting.sql`）。
- **差分が呼ぶもの：** `src/server/decode-slots.ts`、`src/server/rpc.ts`、`src/server/admin-gate.ts`、`src/server/mfa-actions.ts`、`src/lib/supabase/server.ts`、`src/server/storage/document-read.ts`、`src/app/admin/documents/[submissionId]/[n]/route.ts`。
- **既存のmigration：** `20261027120001_foundation.sql:95-121`（`require_user`・`lock_staff_roles`）、`20261027120005_staff_audit.sql:3-11,89-111`（`staff_roles`・旧 `require_staff`・旧 `rls_document_upload_allowed`）、`20261027120007_visibility.sql:408-485`（`remove_photo`・`reorder_photos`・`service_register_photo`）、`20261027120010_admin.sql:120-124,480-520`、`20261109120014_staff_management.sql:1-30`（`admin_list_staff`）、`20261109120015_storage.sql`、`20261115120027_orphan_document_retention.sql:100-140`（`submit_verification`）。`staff_roles` を読むすべての場所を `grep` した。
- **依存：** `node_modules/next/dist/server/body-streams.js:52-117`、`node_modules/next/dist/server/lib/router-utils/resolve-routes.js:124-127`、`node_modules/next/dist/server/route-modules/app-route/module.js:285`、`node_modules/next/dist/shared/lib/router/utils/middleware-route-matcher.js:15`（Next 16.4.3）、`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3427-3458`。

### 確認したこと

**1. N-2〜N-6の修正**

- **N-2（FIX-002・SEC-015）：** 閉じている。
  - 本文を読む前に、アカウント（`src/app/api/photos/route.ts:93-94`）、利用者ごとのlock（`:95-96`）、本文の枠（`:98-99`）を取る。どの拒否も予約を使わずにすぐ答える。
  - `/api/photos` はproxyの外にある（`src/proxy.ts:77`）。Nextが本文を写すのはproxyが走るときだけ（`body-streams.js:80-91` の `cloneBodyStream` はproxyのときだけ呼ばれ、`finalize` は写したときだけ本文を差し替える `:67-75`）。
  - 別の経路：proxyを通るPOST（Server Action）は、誰でも（未ログインでも）1件あたり1.25 MiBまでメモリに写される。同時の数に上限はない（`next.config.ts:18`、`body-streams.js:93-110`）。前の10 MiBより小さく、Server Actionの既定の上限（1 MB、`next.config.ts` に `serverActions.bodySizeLimit` はない）を少し超える量で、一般のNodeのサーバーと同じ程度なので、指摘にはしない（SECREVIEW-001 L-3の残るもの）。遅く送る本文で枠を埋める経路はP-1。
- **N-3（SEC-013、順29）：** 閉じている。
  - `private.require_staff` と `my_staff_roles` は `private.staff_role_effective` を使う（順29 `:38-41,55`）。管理のRPCは、どれも `require_staff` を通る（`grep`）。確認資料の配信も `admin_authorize_document_view`（`20261027120010_admin.sql:124`、`require_staff('reviewer')`）を通る（`src/app/admin/documents/[submissionId]/[n]/route.ts:25`）。
  - `staff_roles` を読むほかの場所は、付与の重複の確認（`20261111120020_grant_requires_totp.sql:25`）、取消し（順30 `:24,28-30`）、一覧（`20261109120014_staff_management.sql:10`）だけで、どれも権限を与えない。アプリの中にも、`staff_role_effective` を通らずに担当者の権限を決める場所はない（`src/server/admin-gate.ts:50-63` は画面の出し分けだけ、`:94`）。
  - 注記（指摘にはしない）：述語は要素の `created_at` で比べる（順29 `:26,28`）。付与の前に未確認で作られ、付与の後に確認された要素は役割を止めない。ただし、アプリでは起きない。
    - 登録の始めに未確認の要素をすべて消す（`src/server/mfa-actions.ts:27-30`）。
    - 確認は「確認済み、なければ一番新しい未確認」の要素で行う（`:52-54`）。そのため、他人が途中で未確認の要素を足すと、本人の確認が失敗する。やり直すと、その要素は消える。
    - 確認済みの要素があるときは、aal1では要素を足せない（TEST-016の観測、上のN-3）。
- **N-4（FIX-002）：** アプリの側は閉じている。`signOut` の `error`（`src/server/auth-actions.ts:115-116`）と例外（`:117-120`）のどちらでも、`global` なら `/login?error=signout` へ送る（`:123`）。auth-jsが401・403・404を成功として返す経路は未確認のQ-1。
- **N-5（RETENTION-005、順28）：** 閉じている。`orphan_photo` は、`active` の行も、保持期限の来た退会アカウントの行も名前を持たないobjectを出す（順28 `:73-78`）。
  - 別の経路はない。写真の行の状態を変えるのは `remove_photo` と `reorder_photos` だけ（`20261027120007_visibility.sql:429,450-453`）。登録の失敗で残るobjectは、どの行も名前を持たないので前から一覧に出る（`src/server/photo-upload.ts:107-109`）。
- **N-6（RETENTION-005、順28）：** 閉じている。資料の書込みには、提出と同じパスの規則（順28 `:113`、`20261115120027_orphan_document_retention.sql:118`、`src/server/storage/document-read.ts:7` と同じ形）と、フォルダごとに16個未満であることを求める（順28 `:116-119`）。
  - 別の経路はない。Storageのpolicyはinsertだけで、update・deleteのpolicyはない（`20261109120015_storage.sql:9-11`）。そのため、上書きと名前の変更は断られる。
  - `like` の型（`s.uid::text || '/%'`、`:118`）は、uuidの文字に `_`・`%` がないので、本人のフォルダだけに当たる。
  - 上限が正しい利用者を止める場面はP-4。

**2. 担当者の認可（順29・30）**

- **ロックの順番：** 担当者の経路は `lock_staff_roles` の勧告的ロック（`20261027120001_foundation.sql:112-121`）を取った後に、`auth.mfa_factors` を普通の `select` で読むだけで、行のロックを取らない（順29 `:24-28`）。Authが `auth.mfa_factors` に書くときは勧告的ロックを取らない。そのため、互いを待つ形はなく、deadlockは起きない。そのかわり、Authの書込みはstaffのロックと直列にならない（P-2の(b)）。
- **3つの判定の関係：**
  - `my_staff_roles`（働く役割だけ、順29 `:55`）と、管理のRPC（`require_staff`、`:38-41`）は同じ述語を使い、一致する。
  - adminの入口（`requireAdminSession`、`src/server/admin-gate.ts:87-95`）は、aal2と退会していないことだけを見て画面を選ぶ。権限はDBで決まる。
  - `admin_list_staff` は、働かない行も含めて取り消されていない行をすべて出す（`20261109120014_staff_management.sql:12`）。働いているかどうかの印はない。これは設計どおりで（順29 `:11-12`、取り消せるようにするため）、権限は与えない。ただし、P-2の対応案に関わる。
- **最後のadmin：** アプリの呼出しだけでは、働くadminは0人にならない。
  - 取消しは排他のロックの下で、最初の書込みの前に、対象者以外の働くadminを数える（順30 `:17,27-32`）。
  - 2人が同時に自分を外すと、ロックで順番に並び、2人目は拒まれる。
  - アプリで要素を足せるのは確認済みのTOTPがないときだけで（`src/server/mfa-actions.ts:26`）、確認済みの要素を消す操作はない（`:27-30` は未確認だけ）。
  - Authの書込みが残る経路はP-2。
- **付け直し（`bootstrap.sql`）：**
  - 触るのは、アドレスが完全に一致する確認済みのアカウント（`scripts/e2e-hosted/bootstrap.sql:61`）だけで、そのアドレスのアカウントが1つのとき（`:63`）、確認済みのTOTPがあるとき（`:64-65`）、働かない取り消されていない行（`:69-72`）に限る。
  - 取消しと付与は同じ排他のロックの下（`:68`）、同じtransactionで行う。主キー（`user_id, role, granted_at`、`20261027120005_staff_audit.sql:9`）の新しい行の `granted_at` は `now()` で、前の行より後なので重ならない。
  - アドレスが本当の人のものだった場合：`.invalid` は使われないと決まっているドメイン（RFC 6761）で、メールを受け取れない。そのため、Authのメールの確認が有効なら、登録しても `email_confirmed_at` が付かず、2つのblock（`:39,61`）のどちらにも当たらない。
  - 付け直しの対象が、その時にある要素であることはP-3。

**3. アップロード**

- **proxyの外で失ったもの：**
  - ヘッダー：`next.config.ts:20-36` のヘッダー（`X-Frame-Options`・`nosniff` など）は、proxyに関係なくすべてのパスに付く。CSPと `no-store` は、routeがすべての答えに付ける（`route.ts:25-28`）。`Reporting-Endpoints` は、JSONの答えには要らない。
  - セッションの更新：`createServerSupabase` が更新したcookieを書き（`src/lib/supabase/server.ts:14-19`）、Nextがroute handlerの答えにそれを足す（`app-route/module.js:285`）。更新できないセッションは `my_account` で401になる（`src/server/rpc.ts:31`）。
  - 転送：`/login` への転送が、本文を読まない401に変わった。
  - 未ログインの要求は、`my_account` を1回呼ぶ（`route.ts:93`）。これは公開キーでPostgRESTを直接呼ぶのと同じ重さなので、指摘にはしない。
  - matcherは大文字と小文字を区別する（`middleware-route-matcher.js:15`、`new RegExp` にflagがない）。そのため、`/API/photos` と `/api/photos/` は、proxyを通る（1.25 MiBまで）。
- **lockと枠を返すこと：**
  - lockは、取った後のすべての道で `finally` によって返す（`route.ts:97,113-115`）。
  - 本文の枠は、本文を読み終えて解いた後か、どの失敗でも `finally` で返す（`:101-111`）。
  - どちらも、返すのは1回だけ（`src/server/photo-upload.ts:55-60`、`src/server/decode-slots.ts:24-28`）。
  - `uploadPhoto` の中の例外は、すべて `unavailable` になる（`photo-upload.ts:111-113`）。
- **30秒の期限：**
  - 期限は、本文の読込み全体で1つ（`route.ts:20,54`）。期限が来ると読込みを取り消して `invalid` を返し（`:61-64`）、timerは `finally` で消す（`:73-75`）。残った読込みの拒否は捨てる（`:59`）。
  - 期限の後の解析・復号・Storageの書込みには期限がない。ただし、lockは利用者ごとなので、止まるのはその利用者だけ。
  - 期限が来るまで枠を持ち続けられることはP-1。
- **`proxyClientMaxBodySize`（1,310,720）：**
  - proxyを通る本文のPOSTは、Server Action（既定1 MB）と `/api/csp-report`（16 KiBまで読む）だけ。ほかのroute handler（`/api/realtime-token`・`/auth/confirm`・`/admin/documents/…`・`/media/photos/…`）はGETだけ。
  - 上限を超えた本文は、途中で切られてpageに渡る（`body-streams.js:98-104`）。ただし、proxyは本文を読まないので、切られることで通る確認はない。切られるのは送った人自身の要求だけ。
  - 超えたときにNextが出す `console.warn` には、要求のURLが入る（`body-streams.js:101-102`）。これはNextのもので、誰でも起こせる。この差分で上限が下がったので、起こしやすくはなった。ただし、本文を持つPOSTのURLに秘密は入らないので、指摘にはしない。

**4. 保持期限（順28、FIX-003）**

- **`orphan_photo` と有効な写真：** `orphan_photo` は `active` の写真を出さない（順28 `:75-78`）。
  - `removed` は行にとって最後の状態。
    - `remove_photo` と `reorder_photos` の1つ目の文は、`active` を `removed` にするだけ（`20261027120007_visibility.sql:429,450`）。
    - 2つ目の文が `active` に戻すのは、最初に確かめた本人の `active` の集合と同じidだけ（`:444-446,451-453`、同じtransactionの中）。
  - 新しい行は、どの行も名前を持たないパスだけに作られる（`:475`）。パスは毎回新しいuuid（`src/server/photo-upload.ts:95-96`）。
  - そのため、一覧と削除の間に、出たパスを `active` の行が指すようになることはない。
- **`account` と重ならない：** 保持期限の来た退会アカウントの行が名前を持つobjectは、`orphan_photo` に出ない（順28 `:78`）。`account` の種類は、objectが今あるものだけを出す（`:100`）。そのため、30日の間に `orphan_photo` で消えた写真は、後で `account` に出ない。
- **パスの規則：** 一覧の最後の絞り込み（順28 `:98-100`）と、scriptの確かめ（`scripts/maintenance/retention.mjs:73-87`）は、前と同じ。
- **60秒の余裕（`retention.mjs:22,180`）：**
  - 年齢の条件は、どれも `<= p_now - interval` の形（順28 `:46,64,73,85`）。率の記録の削除も、`p_now` から7日より前だけで、同じく `p_now > now()` を拒む（`20261109120016_retention.sql:89-92`）。そのため、`p_now` を早めると一覧も削除も減るだけで、増えることはない。
  - 提出に使える12時間と、一覧に出る24時間の間は広がるだけ。
  - 60秒より進んだ時計は、前と同じく `validation` で止まる（順28 `:40-42`）。
  - 1回の実行の一覧と削除は、同じ1つの値を使う（`retention.mjs:180,205,263`）。

**5. ログアウトの誤りの表示**

- 送り先は決まった文字列（`src/server/auth-actions.ts:123`）。`error` は `"signout"` と完全に一致するときだけ真になる（`src/app/login/page.tsx:9`、配列や別の値は偽）。出る文は決まった1つ（`src/lib/auth-validation.ts:13`、`src/components/auth-form.tsx:43`）。
- 引数の値は画面に出ず、どこへも転送しない。そのため、open redirectにも、文の差し込みにも使えない。`next` は前と同じく `safeNextPath` を通る（`auth-form.tsx:24,45`）。
- 他人が `/login?error=signout` を開かせると決まった文が出るが、前からある `error=confirm` と同じ程度で、指摘にはしない。

**6. ログと誤り**

- 差分で、`src/`・`scripts/maintenance/`・`scripts/e2e-hosted/` に新しい `console.*` はない（`grep`）。`retention.mjs` の出力の行は変わっていない（`log` に渡すのは件数と、前からあるuuidだけ）。
- `bootstrap.sql` の結果は、役割の名前と働いているかの真偽だけで、IDもアドレスも出さない（`:84-88`）。付け直しの監査の行は利用者のIDを持つが、`private.audit_log` の中だけ（`:76,78`）。
- `/api/photos` の答えは、決まった状態のコードだけ（`route.ts:26`）。`unauthenticated` と `unavailable` の違いは、呼んだ本人のセッションのことだけ。`rate_limited` は、本人の別のアップロードか、プロセスの混み具合を表すだけで、ほかの利用者のことはわからない。
- ログアウトは、Authの失敗の内容を出さず、ログにも書かない（`auth-actions.ts:121-123`）。

### 指摘

- **P-1（low、修正済み）写真の本文の枠4つは、遅く送る4つのアカウントで埋め続けられる。**
  - 本文の枠は、プロセスごとに4つで、待ちの列はない（`src/server/photo-upload.ts:45-46`）。1つの要求は、本文を読む間（最長30秒、`src/app/api/photos/route.ts:20,54`）、枠を持つ（`:98-111`）。
  - 枠の拒否も、期限切れも、`reserve_photo_upload`（`photo-upload.ts:83`、本文の後）を使わない。そのため、利用者ごとの10分に10回の制限は効かない。期限が来た後、同じ利用者がすぐに次の要求を送れる（lockは `route.ts:113-115` で返る）。
  - 失敗の場面：ログインできるアカウントを4つ持つ人が、それぞれ `Content-Length: 8388608` の正しいmultipartの見出しで `POST /api/photos` を送り、本文を少しずつ送る。30秒で切られたら、すぐに送り直す。その間、そのプロセスに来るほかのすべての利用者のアップロードは、`photoBodySlots.acquire()` が `null` を返して429（`rate_limited`、`route.ts:98-99`）になる。
  - 影響は写真のアップロードだけで、プロセスごと。アカウントを4つ得るには、登録の回数制限と対象校のメールの確認が要る。
  - 対応案（行っていない）：
    - 期限切れと枠の拒否を、利用者ごとの数（たとえば `reserve_photo_upload` か別のaction）に入れる。
    - または、本文の速さに下限を設ける（たとえば最初の1 MiBを5秒以内）。
    - または、期限切れの後は、その利用者を一定の時間だけ断る。
  - 修正（2026-11-18）：FIX-009（`1f3ec6a`、Hydrogen High PASS）で、`boundedBody` に進みの期限を足した（5秒ごとに64 KiB以上、届かなければ `slow`）。期限切れ・遅すぎ・途中の切断のあと、その利用者は60秒、本文を読む前に `rate_limited`（プロセスごと、メモリの中、10000件まで）。Webとアプリの写真の両方（`photo-route-core.ts`）。
  - 残るもの：通信が途中で切れた正直な利用者も60秒待つ。冷却はプロセスごとで、インスタンスをまたがない。

- **P-2（low、対応済み）働くadminが0人になる経路が、Authの要素の書込みに残る。**
  - SEC-014（順30 `:27-32`）が守るのは、役割の取消しだけ。順29の述語は、付与の後に作られた確認済みの要素が1つでもあると、役割を止める（`supabase/migrations/20261116120029_staff_totp_binding.sql:27-28`）。
  - Authへの要素の書込みは、アプリを通らない。
    - Authを直接呼ぶ道は、N-1と同じく公開キーで開いている。アクセストークンは `/api/realtime-token` で本人のJavaScriptに渡る。
    - aal2なら、要素を足せる（TEST-016の観測、上のN-3）。
    - Authの書込みは、staffのロックと直列にならない（上の2.）。
  - 失敗の場面：
    - (a) ただ1人の働くadminが、aal2のセッションでAuthの `POST /auth/v1/factors` を直接呼び、2つ目のTOTPを登録して確認する（新しい認証アプリを足すつもりで）。すると、その人の役割は働かなくなり、すべての管理RPCが `forbidden` になる。アプリで直す道はなく、運用者のSQL（§2）が要る。
    - (b) 働くadminがAとBの2人いる。Aが自分のadminを外すのと同じ時に、運用者がBのTOTPをダッシュボードで消す。Aの取消しの確認（順30 `:28-30`）は、Bの要素が消える前の値を読んで通る。その結果、働くadminが0人になる。
  - アプリの呼出しだけでは起きない（上の2.）。
  - 対応案（行っていない）：
    -  §2に「役割を持つ人は要素を足さない。足すなら、先に別のadminが役割を外し、足した後に付け直す」と「adminのTOTPを消す前に、ほかに働くadminがいることを確かめる」を書く。
    - `admin_list_staff` に、行が働いているかを返す列を足す。そうすれば、adminが働かない行に気づける。
    - DBで防ぐには `auth.mfa_factors` のtriggerが要る。ただし、Authの表に手を入れることになるので勧めない。
  - 一部の対応（2026-11-18）：FIX-010（`4fff6fc`、Hydrogen High PASS）で、 §2に手順16〜18を足した（役割を持つ間は要素を足さない、adminのTOTPを消す前にほかに働くadminがいることを確かめる、要素を変えたら10分以内に `bootstrap.sql` を流して `reanchor` を読む）。続けてSTAFF-001（`1a8a44c`、migration 順35、Hydrogen High PASS）で `admin_list_staff` が役割ごとに働いているか（`acting`）を返し、管理の画面は働かない役割に「無効（要素の変更後）」、働く管理者がいないときは案内を出す。hostedへはHOSTED-022で適用した。
  - 残るもの：Authへの要素の書込み自体は止めない（`auth.mfa_factors` のtriggerは勧めない）。adminが気づいて運用の手順で付け直す。

- **P-3（low、修正済み）`bootstrap.sql` の付け直しは、その時にある確認済みのTOTPを信じる。**
  - 付け直しは、試験のadminに確認済みのTOTPが1つでもあれば（`scripts/e2e-hosted/bootstrap.sql:64-65`）、働かない行を外して付け直す（`:69-79`）。新しい行の `granted_at` は、その時にあるすべての要素の後になる（`:77`）。
  - そのため、その要素を誰が登録したかを確かめない。これはN-3の失敗の場面を、試験のadminについて開き直す。
  - 失敗の場面：
    1. 試験のadminのTOTPが消される（新しい環境での作り直しや、E2Eの秘密をなくしたとき）。
    2. 試験のadminのパスワード（E2Eのためにローカルのenvファイルにある）を知る人が、先に `/admin/mfa` で自分のTOTPを登録する。
    3. 運用者が、ファイルの手順（`:10`「TOTPを登録した後にもう一度流す」、`:1`「何度流しても安全」）どおりに流す。
    4. その人の要素に、admin・moderator・reviewerの3つの役割が付く。結果の行は `admin=true,…` で、成功と見分けがつかない（`:86`）。
  - hostedのdevの、架空のアカウントのこと。資料は合成のものだけ。ただし、adminとして、ほかの利用者の生年月日や役割の付与にも届く。
  - 対応案（行っていない）：
    - 付け直す要素を運用者が名前で決める。たとえば、E2Eの準備が登録した要素のidか `created_at` を渡し、それと一致するときだけ付け直す。
    - または、確認済みの要素がちょうど1つで、それが直前（たとえば10分以内）に作られたときだけ付け直し、その `created_at` を結果に出して運用者が確かめる。
  - 修正（2026-11-18）：FIX-010（`4fff6fc`、Hydrogen High PASS）で、2つ目の案にした。試験のadminの確認済みの要素がちょうど1つのTOTPで、トランザクションの開始から10分以内に作られたときだけ付け直す。結果の行に `factor_created_at`（idなし）と `reanchor`（done・none_needed・no_factor・several_factors・factor_too_old・no_account・several_accounts）を出す（`tests/db/bootstrap-reanchor.test.ts`）。hostedではまだ新しいファイルを流していない（今の古いTOTPでは `factor_too_old` になり、役割は働いたまま）。

- **P-4（low、取込みが `upload` のときだけ）確認資料の16個の上限は、判定の後30日残る資料も数える。**
  - 上限は、本人のフォルダにあるすべてのobjectを、年齢を問わずに数える（`supabase/migrations/20261116120028_removed_photo_retention.sql:116-119`）。
  - 一方、次のobjectは残り続け、利用者は自分で消せない（deleteのpolicyはない、`20261109120015_storage.sql:9-11`）。
    - 判定の済んだ提出の資料は、判定から30日残る（同 `:60-65`）。1回の提出は4つまで資料を持てる（`20261027120004_verification.sql:9`）。
    - 提出に使われなかったobjectは、24時間経った後、運用者が保持期限のscriptを流すまで残る（同 `:85`、`retention.mjs` は手で流す）。
  - 失敗の場面：本当の学生が、4つの資料で4回提出し、4回とも却下される（写りが悪いなど）。フォルダに16個が残る。5回目の資料の書込みは、最後の判定から30日経ち、運用者がscriptを流すまで、StorageのRLSの拒否で失敗する。画面に出るのは一般的な失敗で、理由はわからない。
  - 今は取込みが `synthetic` で、policyが書込みを拒むため起きない。
  - 対応案（行っていない）：上限を、最近のobjectだけで数える（たとえば `so.created_at > now() - interval '24 hours'`）。
    - 提出に使えるのは12時間未満のobjectだけ（`20261115120027_orphan_document_retention.sql:118-121`）なので、正しい利用者は止まらない。
    - 増える量は1日に16個までに抑えられる。
    - あわせて、上限による拒否をアプリで決まった文にする。
  - 修正（2026-11-16）：RETENTION-006（`4953ebd`、migration 順31）で、上限は、本人の `upload` の方式の承認・拒否・取消しの提出が名前を持ち、開いている提出（`submitted`・`in_review`）が名前を持たないobjectを数えない（上の対応案とは別の方法。数えないobjectは、保持期限の `document` の種類が決定から30日後に消すもの、`tests/db/document-cap-open-only.test.ts`）。パスの規則・フォルダの確認・上限16は同じ。上限による拒否の文は変えていない。
  - 修正の途中で見つかった穴（2026-11-16）：取下げ（`withdrawn`）と置換え（`superseded`）の提出は `decided_at` を持つのに、保持期限の `document` の種類が出さず、その資料は退会から30日後まで残った（取込みが `upload` のときだけ、順28より前からある）。RETENTION-007（`e2135ec`、順32）で、`document` の種類と上限の「決定済み」にこの2つの状態を加えた（どちらも順4の遷移triggerで終端、`tests/db/withdrawn-superseded-documents.test.ts`）。上の件数には数えていない。
  - hostedには順31・32をHOSTED-018で適用した（`docs/safety/HOSTED-018-execution-20261116.json`、2つの関数の本体がPGliteの順31・32と同じ、保持期限のdry runはどの種類も対象0、`--apply` は未実行）。取込みは `synthetic` のままなので、働きはPGliteの試験でだけ確かめている。

### 未確認

指摘にはしていない。それぞれ、何を確かめれば決まるかを書く。

- **Q-1 「すべての端末からログアウト」で、Authが401・403・404を返したとき。**
  - auth-jsは、取消しのAPIの401・403・404を `{ error: null }` として返す（`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3440-3446`）。そのため、アプリはそれを成功として `/welcome` へ送る（`src/server/auth-actions.ts:115-116,123`）。
  - 疑い：Authは、JWTのセッションがもう無いときに403（`session_not_found`）を返すかもしれない。そうなら、次が起きうる。
    1. 盗んだセッションを持つ人が、`scope: "others"` で本人のセッションだけを取り消す。
    2. 本人の古いアクセストークンの期限が来る前（`getClaims` は署名だけを確かめる）に、本人が「すべての端末からログアウト」を押す。
    3. 取消しは403で何もしないのに、成功と同じに見え、盗んだ人のセッションが残る。
  - 確かめ方：devで試験の利用者のセッションをA・Bの2つ作る。Bから `signOut({ scope: "others" })` を呼び、Aのアクセストークンの期限の前に、Aで「すべての端末からログアウト」を押す。そのときの `/auth/v1/logout` の状態のコードと、Bのrefreshがまだ通るかを記録する。
- **Q-2 Vercelでのproxyの外しかたと本文の上限。**
  - 上の確かめは `next start`（Node）のNextのコードでのこと。Vercelでは、proxyの配置の仕方と、関数の要求の本文の上限（プラットフォームの上限）が違いうる。そこで次が同じになるかは試していない。
    - `/api/photos` がproxyを通らないこと。
    - `proxyClientMaxBodySize` が効くこと。
    - 8 MiBの本文が `/api/photos` に届くこと。
  - 確かめ方：保護つきのVercelの配置で、次を送り、それぞれの状態のコードと関数のログを記録する。
    - 2 MiBのServer ActionのPOST。
    - 8 MiBの合成画像の `/api/photos`。
    - 未ログインの8 MiBの `/api/photos`。

### 司令塔の判断（2026-11-16）

- P-1：受け入れる（1アカウント1枠、30秒、プロセスごとの限界はSEC-011と同じ）。公開前に配置の側の時間と同時実行の上限を決める。
- P-2：アプリからは止められない。運用で働く管理者を2人以上にし、管理者は自分の要素を変えない（§2）。
- P-3：架空のテストの管理者とdev projectだけの道具として受け入れる。本番のprojectでは実行しない（§2）。
- P-4：取込みを `upload` にする前の条件にする。その後、RETENTION-006・RETENTION-007で修正し、HOSTED-018で適用した（条件は解決済み）。
- Q-1：auth-jsは `signOut` の前に期限切れのaccess tokenを更新するので、401はこのセッションが取り消し済みのときにほぼ限られる。未確認のまま。
- Q-2：確かめた（2026-11-17）。保護つきの配置で、ログインしていない1 KBの `POST /api/photos` はrouteの401 JSON（`no-store`、`default-src 'none'`）で、proxyの転送ではない。2 MBの `POST /mypage` はproxyが転送した。あわせて、5 MBの `POST /api/photos` はVercelが関数の前に `413 FUNCTION_PAYLOAD_TOO_LARGE`（文字だけ）で断った（Vercelの本文の上限は約4.5 MB）。アプリの上限8 MiBより小さいので、FIX-004で写真の上限を4 MiBにし、413を `too_large` として扱う。

### 点検しなかったこと

- hostedの設定と挙動。Q-1・Q-2と、SECREVIEW-002のU-1〜U-3のとおり。
- 差分の外のコード。ただし、差分が呼ぶ関数とpolicyは、上の「読んだファイル」のとおり読んだ。
- `scripts/db/HOSTED-016/` などの、hostedに当てるための束ね（`bootstrap.sql` の付け直しのblockを埋め込むもの）。
- `tests/e2e-hosted/` の準備でのservice roleの扱い。
- Next.jsとSupabaseのライブラリの、上に挙げた行の外の内部と、既知の脆弱性。
- 負荷試験と侵入試験。P-1の影響は、コードから見積もったもの。

### 試験

- コードを変えていないので、新しい試験はない。疑いを確かめるために、既存の試験を流した：`npx vitest run tests/photo-upload-route.test.tsx tests/photo-route-proxy.test.tsx tests/proxy-matcher.test.tsx tests/proxy.test.tsx tests/decode-slots.test.tsx tests/auth-actions.test.tsx tests/login-page.test.tsx tests/retention-script.test.tsx tests/db/staff-totp-binding.test.ts tests/db/last-admin-acting.test.ts tests/db/removed-photo-retention.test.ts tests/db/orphan-document-retention.test.ts` → 12ファイル・331件PASS。
