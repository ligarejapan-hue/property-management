---
name: ui-design
description: UI 実装・見た目の改善タスク用。画面・コンポーネント・レイアウト・余白・配色・ボタン・フォーム・テーブル・モーダル・ナビ・空状態・ローディング・スマホ表示などを作る/直すときに使う。外部デザイン参考サイト（docs/design-references.md）と既存の共通 UI 部品・トーンを前提に、依存追加なしで実装する。使い方の例 `/ui-design 物件一覧のフィルタを見やすく 参考: <URL>`
---

# UI デザイン作業スキル

ユーザーの指示（引数）から「対象画面・対象要素・参考URL（任意）」を読み取り、以下の手順で進める。共通ルールは CLAUDE.md が正で、本スキルはそれを弱めない。

## 1. Explore（必ず最初に）

1. 対象画面のファイルを特定して読む
2. `src/components/ui/` の既存部品を確認し、使えるものを先に使う
   - `button`（primary/secondary/danger・md/sm）、`status-badge`、`modal-shell`、`confirm-dialog`、`page-header`、`back-link`、`filter-panel`、`search-field`、`pagination`、`tabs`
   - 各ファイル冒頭コメントの規約（色・角丸・サイズ・対象外）に従う
3. トーンは `src/app/globals.css`（UIトーン v2「静かな精密さ」、gray→stone 再マップ、`.dark` 対応）に合わせる
4. 参考URLが無い場合は、`docs/design-references.md` §2 の「要素別の参考先」から該当するサイト名を報告に挙げる（ネット取得は不要。名前と観点を示すだけ）

## 2. 実装方針

- 参考サイトは**見た目・構成の参考のみ**。コードはコピーせず、Tailwind v4 + 既存部品で書き直す
- アイコンは `lucide-react`、ダークモードは `dark:` を必ず併記
- 業務システムなので、派手なアニメーション・3D・グラデーション・ガラス表現は入れない。動きを入れる場合は `motion-reduce:` を併記し、操作を遅くしない
- 既存 UI 文言・業務用語は変えない（CLAUDE.md §7）
- `dangerouslySetInnerHTML` を使わない
- PII（所有者名・住所・座標等）の表示範囲・権限表示を変えない
- 最小差分。対象外の画面の見た目を「ついでに」揃えない

## 3. 停止して確認する条件（実装前に止まる）

- 新しい npm 依存が必要（shadcn CLI、motion、anime.js 等を含む）→ CLAUDE.md §18.2
- 21st.dev 等の MCP・API キー・有料プランが必要 → CLAUDE.md §17
- 外部コードを取り込みたい（ライセンス要確認）
- 共通部品（`src/components/ui/*`）自体の見た目変更が必要（全画面に波及するため）
- API / 権限 / DB の変更が必要

## 4. 確認

- 関連テスト（`src/components/ui/__tests__` や対象画面のテスト）→ `npx vitest run` → `npm run build` → `git diff --check`
- 可能なら `/run` で画面を起動し、ライト/ダーク・スマホ幅を目視確認（スクショに本番 PII を含めない）

## 5. 報告

CLAUDE.md §14 の標準報告に加え、次を 1〜3 行で書く:

- 参考にしたサイト・要素・観点（または推奨した参考先）
- 使った既存部品 / 新規に書いた部分
