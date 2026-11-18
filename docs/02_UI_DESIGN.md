# Campus Link - UI Design v1.1

2026-11-17 の本人の決定（順34）: モードは1つ、申請はいいねに替わった。モード切替と申請の画面はもうない。

## Design Concept

Apple-inspired Premium Minimalism.

高級感、上品さ、洗練、清潔感、直感的な操作性。

## Colors

- Background: #FFFFFF
- Primary Text: #000000
- Secondary Text: #6E6E73
- Borders: #E5E5E5
- Primary Button: #000000
- Primary Button Text: #FFFFFF

原則として白・黒・グレーのみ使用する。

## Design Principles

1. 余白を広く取る
2. 文字情報を必要最小限にする
3. 写真を主役にする
4. 情報の階層を明確にする
5. 直感的に操作できる
6. 派手な装飾を使用しない
7. 画面間のデザインを統一する

## Liquid Glass

半透明ガラス表現を使用可能な場所:

- 下部ナビゲーション
- ~~モード切替~~（2026-11-17まで。モードは1つになり、切替えはない）
- いいね一覧のタブ（いいねされた／いいねした）
- 一部のモーダル
- フローティング操作部品

全面へのガラス表現は禁止。
可読性とアクセシビリティを優先する。

## Prohibited Styles

- 絵文字
- 顔文字
- カラフルな装飾
- 派手なグラデーション
- AI生成テンプレート風の装飾
- 不必要なアイコン
- 過剰なアニメーション

操作に必要なアイコンはシンプルなモノクロにする。

## Reference Screens

1. Discover Screen
2. Profile Detail Screen
3. Privacy Settings Screen

参考画像のうち、恋愛・友達の切替えのタブは使わない（2026-11-17まで）。

## Main Screens（2026-11-17 から）

- **探す（`/`）:** 1つの一覧。条件は年齢・性別・学校。カードに目的を小さな灰色の文字で出し（空なら出さない）、「いいね」のボタンを置く。いいねした人とマッチした人は出ない。
- **プロフィールの詳細（`/profiles/[id]`）:** 自己紹介・趣味・目的。状態に合わせて「いいね」／「いいね済み」と「取り消す」／「あなたにいいねしています」と「いいねを返す」／「トークを開く」のどれかを出す。
- **いいね（`/likes`）:** 見出し「いいね」、タブ「いいねされた」（既定）と「いいねした」。各行は探すと同じ限られたカードで、「いいねを返す」か「取り消す」のボタンと、通報・ブロックを置く。古い `/requests` は `/likes` へ転送する。
- **プロフィールの編集（`/mypage/profile`）:** 自己紹介（1つ、500文字）と目的（任意、5つのチェックボックス）だけを変える。
- **オンボーディング:** モードの段に替えて「目的（任意・いくつでも）」と「自己紹介（任意）」。
- 下のナビの「申請」は「いいね」になった（2026-11-17まで「申請」）。
- いいねの印も線だけの灰色の形にし、絵文字や色付きにしない。
- 通話のボタンはどこにも置かない。

Reference image directory:
design/ui-reference/

UIの実装時は参考画像を確認すること。

参考画像の学校名はダミーであり、
実装では麻生専門学校グループの対象校に変更すること。

## UI Implementation

- Mobile First
- Responsive Design
- Consistent Typography
- Consistent Spacing
- Consistent Components
- Accessible Controls
- Minimal Visual Noise

UIの変更時は参考画像との整合性を確認する。
