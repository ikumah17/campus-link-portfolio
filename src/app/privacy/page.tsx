import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle } from "@/components/ui-tokens";

export default function Page() {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto min-h-screen w-full max-w-[720px] break-words px-4 pb-20 pt-10 text-ink sm:px-8">
    <h1 className={pageTitle}>プライバシーポリシー（草案）</h1>
    <p className="mt-5 leading-7">この文書は公開前の草案です。正式な公開までに内容を確認し、改定します。</p>
    <p className="mt-2 text-sm text-muted">最終更新：2026年11月9日</p>
      <section className="mt-8" aria-labelledby="privacy-1">
        <h2 id="privacy-1" className="text-lg font-medium">第1条 取得する情報</h2>
        <p className="mt-3 leading-8">メールアドレス、生年月日、性別、表示名・自己紹介・趣味、学校・学科・クラス、写真、年齢確認・在学確認の資料と結果、つながりとメッセージ、ブロック・通報の内容、公開範囲の設定、操作の記録（監査ログ・レート制限の記録）を扱います。デモでは架空データを表示し、実際の登録・本人確認は行いません。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-2">
        <h2 id="privacy-2" className="text-lg font-medium">第2条 利用目的</h2>
        <p className="mt-3 leading-8">本人確認・年齢と在学の確認、マッチングとチャットの提供、安全対策（ブロック・通報・不正防止）、問い合わせ対応のために利用します。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-3">
        <h2 id="privacy-3" className="text-lg font-medium">第3条 公開範囲</h2>
        <p className="mt-3 leading-8">生年月日・メールは他の利用者に表示しません。学校はプロフィールを閲覧できる利用者に表示します。学科・クラスは本人の設定で非表示にできます。写真やメッセージなどは機能ごとの閲覧権限に従って表示します。確認資料は他の利用者に公開しません。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-4">
        <h2 id="privacy-4" className="text-lg font-medium">第4条 第三者提供</h2>
        <p className="mt-3 leading-8">法令に基づく場合を除き行いません。前条の利用者向け表示と次条のサービス提供に必要な委託は、それぞれ記載の範囲で行います。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-5">
        <h2 id="privacy-5" className="text-lg font-medium">第5条 委託先</h2>
        <p className="mt-3 leading-8">データの保存にSupabase（データベース・認証・ストレージ）を使用します。公開時のホスティング事業者は正式公開時に記載します。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-6">
        <h2 id="privacy-6" className="text-lg font-medium">第6条 保存期間</h2>
        <p className="mt-3 leading-8">保存期間は未確定の案です。確認資料の画像は審査の決定から30日後に削除し、判定結果のメタデータは保持する案です。退会後は直ちに非表示・資格喪失とし、30日後にアカウントを削除する案です。通報・証拠・監査の記録は退会後も一定期間保持しますが、期間は正式公開までに確定します。レート制限の記録は7日より古いものを削除する案です。削除運用は正式公開までに確認します。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-7">
        <h2 id="privacy-7" className="text-lg font-medium">第7条 開示・訂正・削除の請求</h2>
        <p className="mt-3 leading-8">自身の情報の開示・訂正・削除は、正式公開時に記載する連絡先に申し出てください。本人確認のうえ、法令や記録の保存の必要性を踏まえて対応します。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-8">
        <h2 id="privacy-8" className="text-lg font-medium">第8条 安全管理</h2>
        <p className="mt-3 leading-8">閲覧権限の制限、非公開ストレージ、管理操作の監査などにより情報を管理します。受信した情報の画面撮影などを完全に防ぐことはできません。</p>
      </section>
      <section className="mt-8" aria-labelledby="privacy-9">
        <h2 id="privacy-9" className="text-lg font-medium">第9条 改定</h2>
        <p className="mt-3 leading-8">内容を変更する場合は、このページで変更内容と適用時期を案内します。</p>
      </section>
    <p className="mt-10 leading-7">運営者の名称・連絡先は正式公開時に記載します。</p>
  </main>;
}
