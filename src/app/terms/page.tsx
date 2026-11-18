import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { pageTitle } from "@/components/ui-tokens";

export default function Page() {
  return <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto min-h-screen w-full max-w-[720px] break-words px-4 pb-20 pt-10 text-ink sm:px-8">
    <h1 className={pageTitle}>利用規約（草案）</h1>
    <p className="mt-5 leading-7">この文書は公開前の草案です。正式な公開までに内容を確認し、改定します。</p>
    <p className="mt-2 text-sm text-muted">最終更新：2026年11月9日</p>
      <section className="mt-8" aria-labelledby="terms-1">
        <h2 id="terms-1" className="text-lg font-medium">第1条 対象</h2>
        <p className="mt-3 leading-8">18歳以上で、在籍する対象校の在学確認を受けた学生だけが利用できます。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-2">
        <h2 id="terms-2" className="text-lg font-medium">第2条 アカウント</h2>
        <p className="mt-3 leading-8">アカウントは本人だけが使用し、登録情報は正確に入力・更新してください。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-3">
        <h2 id="terms-3" className="text-lg font-medium">第3条 年齢確認・在学確認</h2>
        <p className="mt-3 leading-8">確認が済むまで一部の機能は使えません。期限や登録内容の変更などにより、確認が取り消されることがあります。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-4">
        <h2 id="terms-4" className="text-lg font-medium">第4条 禁止事項</h2>
        <p className="mt-3 leading-8">なりすまし、18歳未満の利用、嫌がらせ、性的な勧誘、金銭の要求や勧誘、営利目的の利用、個人情報の無断公開、不正アクセス、法令違反を禁止します。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-5">
        <h2 id="terms-5" className="text-lg font-medium">第5条 ブロック・通報</h2>
        <p className="mt-3 leading-8">利用者はブロックと通報ができます。運営は通報を確認し、利用停止を含む対応をとることがあります。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-6">
        <h2 id="terms-6" className="text-lg font-medium">第6条 利用停止・退会</h2>
        <p className="mt-3 leading-8">運営は規約違反のアカウントを停止できます。利用者はいつでも退会を申し出ることができます。退会後のデータの扱いはプライバシーポリシーに記載します。</p>
      </section>
      <section className="mt-8" aria-labelledby="terms-7">
        <h2 id="terms-7" className="text-lg font-medium">第7条 免責・規約の変更・準拠法</h2>
        <p className="mt-3 leading-8">つながりの成立や利用者間のやり取りの結果を保証するものではありません。運営の責任は法令に従って判断されます。規約を変更する場合は変更内容と適用時期を案内します。準拠法は日本法です。</p>
      </section>
    <p className="mt-10 leading-7">運営者の名称・連絡先は正式公開時に記載します。</p>
  </main>;
}
