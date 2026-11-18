// MOBILE-002: the web's on-screen text for onboarding, photos, verification and my page. These live in the web's
// components (not src/lib), which this task may not edit, so they are copied here; tests/messages.test.ts checks
// that every string still appears verbatim in its web source file.
export const UNAVAILABLE = "現在保存できません。時間をおいて再度お試しください。";
export const LOAD_UNAVAILABLE = "現在表示できません。時間をおいて再度お試しください。";
export const SESSION_EXPIRED = "ログインの有効期限が切れました。";

// src/components/onboarding.tsx
export const onboardingText = {
  titles: ["基本情報", "所属", "写真", "目的と自己紹介", "入力内容の確認"],
  saveTitle: "プロフィールの保存",
  genders: { female: "女性", male: "男性", other: "その他" },
  fields: {
    name: "表示名は空白のみを除く1〜20文字で入力してください。",
    gender: "性別を選んでください。",
    birth: "18歳以上となる正しい生年月日を入力してください（1900年1月1日より後）。",
    adult: "18歳以上であることを確認してください。",
    affiliation: "学校・学科・クラスを順に選んでください。",
    purposes: "目的を選び直してください。",
    bio: "自己紹介は500文字以内で入力してください。",
  },
  status: {
    needs_photo: "写真を1枚以上登録してください。",
    needs_details: "入力内容を確認してください。",
    invalid: "入力内容を確認してください。",
    birth_locked: "年齢確認後は生年月日を変更できません。",
    unauthenticated: SESSION_EXPIRED,
    unavailable: UNAVAILABLE,
  },
  genderNote: "性別はプロフィールに公開されます。",
  affiliationNote: "学校はプロフィールに公開されます。学科・クラスの公開は公開範囲設定で選べます（既定は非公開）。",
  photoLater: "写真は、次の保存のあとで登録します。",
  saved: "プロフィールを保存しました。写真を1枚以上登録してください。",
  created: "プロフィールを作成しました。",
  adult: "18歳以上です",
  adultConfirmed: "確認しました",
  adultUnconfirmed: "未確認",
  noBio: "自己紹介なし",
  choose: "選んでください",
  // MOBILE-LIKES-001 (docs/43 §4.4): the optional purposes and the one bio, shared with the profile edit screen.
  purposes: "目的（任意・いくつでも）",
  purposesNote: "プロフィールに表示されます。選ばなくてもかまいません。",
  purposesTerm: "目的",
  noPurposes: "未選択",
  bio: "自己紹介（任意）",
  bioTerm: "自己紹介",
  bioCount: " / 500文字",
} as const;

// src/components/photo-manager.tsx
export const photoMessages = {
  invalid: "JPEG、PNG、WebPの画像を選んでください。",
  too_large: "4MB以下の画像を選んでください。",
  too_many: "写真は6枚までです。",
  rate_limited: "しばらくしてから再度お試しください。",
  last_photo: "最後の1枚は削除できません。",
  unauthenticated: SESSION_EXPIRED,
  unavailable: UNAVAILABLE,
} as const;

// src/components/verification-live.tsx
export const verificationText = {
  kinds: { age: "年齢確認", enrollment: "在学確認" },
  labels: { submitted: "提出済み", in_review: "審査中", approved: "承認", rejected: "却下", withdrawn: "取り下げ", revoked: "取消し", superseded: "無効" },
  errors: {
    invalid: "架空のサンプル資料を1〜3点選んでください。",
    invalid_state: "状態が変わりました。画面を確認してください。",
    unauthenticated: SESSION_EXPIRED,
    unavailable: UNAVAILABLE,
  },
  notice: "開発中のため、実際の資料は扱いません。架空のサンプルだけを選べます。",
  title: "在学・年齢確認",
  needsProfile: "先にプロフィールを作成してください。",
  needsAffiliation: "先に所属を登録してください。",
  verified: "確認済みです。",
  inReview: "審査中のため、取り下げできません。",
  none: "未提出",
} as const;

// src/components/mypage-live.tsx
export const myPageText = {
  affiliation: { confirmed: "確認済み", pending: "審査中", rejected: "確認できませんでした", unconfirmed: "未確認", expired: "期限切れ" },
  suspended: "このアカウントは停止されています。",
  deactivated: "アカウントは休止中です。",
  needsVerification: "確認が済むと、探す・いいね・トークを利用できます。",
} as const;

// MOBILE-003: discovery and chat; MOBILE-LIKES-001: likes replace the requests (docs/43 §4).
// src/app/page.tsx
export const SERVICE_UNAVAILABLE = "現在ご利用いただけません。時間をおいて再度お試しください。";

// src/components/discover-live.tsx
export const discoverText = {
  notEligible: "在学・年齢確認が終わると、プロフィールを探せます。",
  toVerification: "確認へ進む",
  conditions: "検索条件",
  clear: "条件をクリア",
  view: "プロフィールを見る",
  empty: "条件に合うプロフィールはありません",
  fromStart: "最初から見る",
  next: "次のプロフィールを見る",
  age: "歳",
} as const;

// src/components/search-conditions.tsx
export const searchText = {
  back: "一覧へ戻る",
  title: "検索条件",
  age: "年齢",
  min: "下限年齢",
  max: "上限年齢",
  gender: "性別",
  school: "学校",
  ageInvalid: "18〜120の整数を入力してください。",
  ageOrder: "下限は上限以下にしてください。",
  privacy: "学科・クラスでの絞り込みはプライバシー保護のため提供していません。",
  submit: "この条件で探す",
  clear: "条件をクリア",
} as const;

// src/components/profile-detail-live.tsx
export const profileText = {
  back: "一覧へ戻る",
  rows: { bio: "自己紹介", hobbies: "趣味", purposes: "目的" },
} as const;
// src/components/profile-detail.tsx: the one screen for a profile that does not exist or cannot be viewed (P5).
export const PROFILE_UNAVAILABLE = "このプロフィールは表示できません";

// src/components/like-controls.tsx: the like buttons of the detail page and the discovery cards (docs/43 §4.3, Q8).
export const likeText = {
  liked: "いいねしました。", matched: "マッチしました。トークで話せます。", unliked: "いいねを取り消しました。",
  likedMe: "あなたにいいねしています", iLiked: "いいね済み",
  like: "いいね", likeBack: "いいねを返す", unlike: "取り消す", openTalk: "トークを開く",
  // Accessibility labels after the person's name.
  likeLabel: "にいいね", likeBackLabel: "にいいねを返す", unlikeLabel: "へのいいねを取り消す",
} as const;
export const likeMessages = {
  validation: "この相手には、いまいいねできません。", not_available: "この相手には、いまいいねできません。",
  already_connected: "すでにマッチしています。", rate_limited: "今日はこれ以上いいねできません。時間をおいてお試しください。",
  unauthenticated: "ログインし直してください。", unavailable: "現在ご利用いただけません。時間をおいて再度お試しください。",
} as const;

// src/components/likes-view.tsx: the likes page (docs/43 §4.1).
export const likesText = {
  title: "いいね",
  description: "お互いにいいねすると、マッチしてトークで話せます。",
  tabs: ["いいねされた", "いいねした"],
  tabList: "いいねの一覧",
  emptyReceived: "まだいいねはありません。",
  emptySent: "まだいいねしていません。",
  toDiscover: "探す",
  age: "歳",
} as const;
// src/components/likes-live.tsx
export const LIKES_MORE = "さらに表示";

// src/components/talk-list-live.tsx
export const talkListText = {
  title: "トーク",
  empty: "つながりはまだありません。",
  toLikes: "いいねを見る",
  noMessage: "メッセージを送ってみましょう。",
  unread: "未読",
} as const;

// src/components/chat-room-live.tsx
export const chatText = {
  back: "トーク一覧へ戻る",
  missing: "この会話は表示できません",
  check: "新しいメッセージを確認",
  older: "以前のメッセージ",
  label: "メッセージ",
  count: " / 2000文字",
  send: "送信",
  loadFailed: "メッセージを表示できません。",
  olderFailed: "以前のメッセージを表示できません。",
  sent: "メッセージを送信しました。",
  rateLimited: "しばらくしてから再度お試しください。",
  sendFailed: "メッセージを送信できません。",
} as const;

// src/components/hidden-content.tsx (MOD-001): the placeholder for a message a moderator took out of view.
export const HIDDEN_CONTENT_TEXT = "この発言は運営により非表示になりました。";

// src/components/safety-controls-live.tsx
export const safetyMessages = {
  validation: "入力内容を確認してください。", not_available: "この操作は利用できません。",
  rate_limited: "しばらくしてから再度お試しください。", unauthenticated: "ログインし直してください。",
  unavailable: "現在ご利用いただけません。時間をおいて再度お試しください。",
} as const;
export const safetyText = {
  menu: "ブロック・通報",
  block: "ブロック",
  report: "通報",
  reported: "通報を受け付けました。",
  blocked: "ブロックしました。",
  blockTitle: "をブロックしますか",
  counterpart: "相手",
  blockNote: "お互いに表示されなくなり、いいねとつながりは終了します。",
  reason: "通報の理由",
  detail: "詳細（任意）",
  count: " / 1000文字",
  submitReport: "通報する",
  submitBlock: "ブロックする",
  close: "閉じる",
  cancel: "キャンセル",
  back: "一覧へ戻る",
} as const;

// src/components/main-nav.tsx
export const navText = { discover: "探す", likes: "いいね", talk: "トーク", mypage: "マイページ" } as const;

// MOBILE-004: settings and safety.
// src/server/account-rules.ts
export const DELETE_CONFIRMATION = "退会する";
export const PAUSE_NOTE = "休止中は、探す・いいね・トークにあなたが表示されず、あなたも利用できません。";
export const accountMessages = {
  invalid: "確認の言葉が一致しません。",
  invalid_state: "アカウントの状態が変わっています。ページを再読み込みしてください。",
  forbidden: "この操作は利用できません。",
  unauthenticated: "ログインし直してください。",
  unavailable: "現在保存できません。時間をおいて再度お試しください。",
} as const;

// src/components/account-settings.tsx
export const accountText = {
  back: "マイページへ戻る",
  title: "アカウント",
  pause: "休止",
  suspended: "このアカウントは停止されています。",
  deactivated: "休止中です。",
  active: "利用中です。",
  resume: "再開する",
  doPause: "休止する",
  paused: "休止しました。",
  resumed: "再開しました。",
  delete: "退会",
  irreversible: "退会は取り消せません。",
  toDelete: "退会の手続きへ",
  dialogTitle: "退会しますか",
  dialogBody: "退会は取り消せません。つながりは終了し、いいねは消えます。データは",
  privacy: "プライバシーポリシー",
  dialogBodyEnd: "の保存期間に従って削除されます。",
  confirmBefore: "確認のため「",
  confirmAfter: "」と入力してください",
  submit: "退会する",
  cancel: "キャンセル",
  deletedTitle: "退会の手続きが完了しました",
  deletedBody: "ログアウトしました。",
  top: "トップへ",
} as const;

// src/components/logout-button.tsx
export const logoutText = { local: "ログアウト", everywhere: "すべての端末からログアウト" } as const;

// src/components/mypage-live.tsx: the settings entries and the way back from a paused account.
export const settingsLinks = { profile: "プロフィールを編集", privacy: "公開範囲設定", blocks: "ブロック中のユーザー", account: "アカウント", resume: "再開する" } as const;

// src/components/privacy-settings-live.tsx
export const privacyText = {
  back: "マイページへ戻る",
  title: "公開範囲設定",
  lead: "プロフィールを表示する相手を制限します。",
  leadNote: "特定のクラス・学科・学校のユーザーに表示しない設定を選べます。",
  inactive: "無効になった所属の非表示設定は、そのまま保持されます。",
  hideTitle: "身バレ防止設定",
  hideDescription: "特定のつながりのあるユーザーに表示しない設定です。",
  academicTitle: "学業情報の公開設定",
  academicDescription: "プロフィールに表示する学業情報を選びます。",
  rows: {
    hideSameClass: ["同じクラスに表示しない", "同じクラスのユーザーにプロフィールを表示しません。"],
    hideSameDepartment: ["同じ学科に表示しない", "同じ学科のユーザーにプロフィールを表示しません。"],
    hideSameSchool: ["同じ学校に表示しない", "同じ学校のユーザーにプロフィールを表示しません。"],
    showDepartment: ["学科名を公開", "プロフィールに学科名を表示します。"],
    showClass: ["クラス名を公開", "プロフィールにクラス名を表示します。"],
  },
  targetsTitle: "非表示対象の個別指定",
  targetsDescription: "学校・学科・クラスを個別に指定して、表示しないようにします。",
  manage: "非表示対象を管理",
  count: "件指定中",
  limit: "非表示対象は合計50件まで指定できます。",
  selected: "指定中",
  remove: "解除",
  add: "追加",
  save: "保存する",
  saved: "保存しました。",
  dirty: "未保存の変更があります。",
  errors: {
    rate_limited: "しばらくしてから再度お試しください。",
    invalid: "設定を保存できませんでした。選択内容を確認してください。",
    unauthenticated: "ログインし直してください。",
    forbidden: "保存できませんでした。時間をおいてもう一度お試しください。",
    unavailable: "保存できませんでした。時間をおいてもう一度お試しください。",
  },
} as const;
// src/data/demo-privacy.ts
export const hideTargetKindLabel = { school: "学校", department: "学科", class: "クラス" } as const;

// src/components/blocks-settings-live.tsx
export const blocksText = {
  back: "マイページへ戻る",
  title: "ブロック中のユーザー",
  empty: "ブロック中のユーザーはいません。",
  unknown: "表示できないユーザー",
  reports: "通報の履歴",
  noReports: "通報の履歴はありません。",
  labels: { open: "受付済み", triaged: "確認中", actioned: "対応済み", dismissed: "対応なし" },
} as const;
// src/components/safety-controls-live.tsx (unblock)
export const unblockText = {
  open: "ブロックを解除",
  title: "ブロックを解除しますか",
  note: "ブロックを解除しても、消えたいいねや終了したつながりは元に戻りません。",
  done: "ブロックを解除しました。",
} as const;

// MOBILE-LIKES-001: the profile edit screen (src/components/profile-edit.tsx, docs/43 §4.5).
export const profileEditText = {
  back: "マイページへ戻る",
  title: "プロフィールを編集",
  save: "保存する",
  bio: "自己紹介は500文字以内で入力してください。",
  status: {
    ok: "保存しました。", invalid: "入力内容を確認してください。", unauthenticated: "ログインし直してください。",
    unavailable: "現在保存できません。時間をおいて再度お試しください。",
  },
} as const;

// src/app/welcome/page.tsx (docs/43 §7 Q5).
export const WELCOME_LINE = "同じ学生どうしで、つながろう。";
