# UIデザイン参考リソース集（開発時の参照用）

## 0. このドキュメントの位置づけ

- UI 実装・改善タスクで、ChatGPT / Claude Code に「参考にするデザイン」を渡すための外部リソース一覧である
- 運用ルール（依存追加・外部サービス・課金・PII 等）は CLAUDE.md / AGENTS.md を正とし、本書はそれを弱めない
- 各サイトの内容・料金・ライセンスは本書作成時点で未検証である。利用時に各サイトで確認すること（CLAUDE.md §2 推測禁止）

## 1. 利用時の共通ルール

| 使い方 | 可否 | 根拠 |
| --- | --- | --- |
| サイトを見て、レイアウト・余白・配色・文言の参考にする | 可 | — |
| 参考URL・スクリーンショットをタスク指示に添えて、既存コンポーネントで再現させる | 可（推奨） | §2 最小差分 |
| コードをコピーして `src/components/ui/` 等に取り込む | ライセンス確認後のみ | 各サイトのライセンス要確認 |
| `npm install` / `npx shadcn add` 等で新しい依存を追加する | **事前承認必須** | CLAUDE.md §18.2 |
| MCP サーバー・API キー・有料プラン・usage credits を使う | **事前承認必須** | CLAUDE.md §17 |
| 本番データ（所有者名・住所・座標等）入りの画面キャプチャを外部サービスへ送る | **禁止** | CLAUDE.md §8 |

補足:

- 本システムは社内業務システムであり、既存 UI トーン「静かな精密さ」（`src/app/globals.css`、stone 系ニュートラル）を優先する。派手なアニメーション・3D・グラデーションはそのまま持ち込まない
- 既存の共通 UI（`src/components/ui/` の `button` / `modal-shell` / `page-header` / `filter-panel` / `pagination` 等）を先に使う。新規コンポーネントは既存で表現できない場合のみ
- スタックは Next.js 16 / React 19 / Tailwind CSS v4 / lucide-react / next-themes（ダークモード `.dark`）。Tailwind v3 前提や framer-motion 前提のコードは、そのまま動かない可能性がある
- 取り込むコードに `dangerouslySetInnerHTML` や生 HTML 文字列がある場合は JSX に書き換える（CLAUDE.md §7）
- アニメーションを入れる場合は `prefers-reduced-motion` を尊重し、業務操作（一覧・フォーム・保存）を遅くしない

## 2. リソース一覧（本システムでの使いどころ順）

### 要素別の参考先（迷ったらここ）

| 作りたいもの | まず見る | 次に見る |
| --- | --- | --- |
| テーブル・一覧・ページネーション | Component Gallery | shadcn/ui |
| フォーム・入力・バリデーション表示 | shadcn/ui | CTA Gallery |
| モーダル・確認ダイアログ | shadcn/ui | Component Gallery |
| タブ・フィルタ・検索 | Component Gallery | shadcn/ui |
| ナビ・サイドバー・ヘッダー | Navbar Gallery | Minimal Gallery |
| 空状態・エラー表示 | 404s | Component Gallery |
| ローディング | Circle Loaders | MicroKit UI |
| スマホ画面（現地調査等） | AppShot Gallery | Component Gallery |
| 地図のマーカー・ポップアップ | mapcn（見た目のみ） | — |
| 配色・文字組み | Refero Styles | Minimal Gallery |
| 小さな動き（ホバー・トグル） | MicroKit UI | Motion Primitives（見た目のみ） |

### A. 業務画面で参照しやすい（インスピレーション・パターン集）

| # | リソース | URL | 使いどころ |
| --- | --- | --- | --- |
| 5 | Component Gallery | https://component.gallery | 同じ要素（タブ、テーブル、ページネーション等）を各デザインシステムがどう解決しているか比較 |
| 15 | shadcn/ui | https://ui.shadcn.com | フォーム・ダイアログ・テーブル等の標準的な構成の参考。**CLI 導入は依存追加を伴うため事前承認** |
| 4 | Refero Styles | https://styles.refero.design | タイポグラフィ・配色の実例 |
| 2 | Minimal Gallery | https://minimal.gallery | ミニマルで高品質なサイトの参考 |
| 3 | Kage | https://kage.design | 実 UI をプロンプトへ落とし込む参考 |
| 11 | DESIGNmd | https://designmd.ai | エージェントが読める Markdown 形式のデザイン指示の書き方の参考 |
| 6 | AppShot Gallery | https://appshot.gallery | 現地調査などスマホ画面の参考 |
| 7 | Navbar Gallery | https://navbar.gallery | ナビゲーション |
| 8 | Footer Design | https://footer.design | フッター |
| 9 | CTA Gallery | https://cta.gallery | フォーム・ボタン・ポップアップ |
| 10 | 404s | https://404s.design | エラーページ |
| 21 | mapcn | https://mapcn.dev | 地図のマーカー・ポップアップ表現の参考。本システムは `@vis.gl/react-google-maps` を使用中のため、見た目の参考に留める。位置情報の扱いは CLAUDE.md §7・§8 |

### B. コンポーネント・アニメーション集（取り込む場合はライセンス確認＋依存確認）

| # | リソース | URL | 備考 |
| --- | --- | --- | --- |
| 16 | Aceternity UI | https://ui.aceternity.com | アニメーション付き React/Tailwind。業務画面では控えめに |
| 17 | Magic UI | https://magicui.design | 同上 |
| 18 | Motion Primitives | https://motion-primitives.com | 同上（motion 系ライブラリ依存の可能性あり） |
| 19 | Uiverse | https://uiverse.io | HTML/CSS 部品。JSX＋Tailwind へ書き換えて使う |
| 20 | UIAble | https://uiable.com | 要確認 |
| 22 | MicroKit UI | https://microkit.co | マイクロインタラクション |
| 14 | Kinetics | https://kinetics.colorion.co | モーション効果（React コード・プロンプト付き） |
| 23 | Liquid Glass | https://glass.samasante.com | ガラス表現。業務画面では原則不採用 |
| 24 | CSS Text Effects | https://text-effects.colorion.co | 同上 |
| 25 | Circle Loaders | https://circleloaders.dominikakissi.com | ローディング表示の参考 |
| 26 | Gradient Buttons | https://gradientbuttons.colorion.co | 既存トーンと合わない場合が多い |
| 29 | Anime.js | https://animejs.com | JS アニメーションライブラリ。**導入は依存追加のため事前承認**（元メモは URL 途中で切れていたため要確認） |

### C. 素材

| # | リソース | URL | 備考 |
| --- | --- | --- | --- |
| 27 | Kitbitz | https://kitbitz.art | 手描きイラスト。ライセンス・商用可否要確認 |
| 28 | 3Dicons | https://3dicons.co | 3D アイコン。アイコンは原則 lucide-react を継続 |

### D. プロンプト・外部連携系（利用前に §17 確認）

| # | リソース | URL | 備考 |
| --- | --- | --- | --- |
| 1 | scrolltide.co | https://scrolltide.co | 3D・スクロール駆動サイト向けビルドプロンプト。本システムの業務画面には基本不向き |
| 12 | VibePrompt | https://vibeprompts.dev | ダッシュボード向けプロンプトの参考 |
| 13 | 21st.dev | https://21st.dev | MCP 経由のコンポーネントレジストリ。**MCP 追加・API キー・課金の有無を確認し、事前承認を得てから**利用 |

## 3. Claude Code での使い方

### 最短（推奨）: `/ui-design` スキル

```
/ui-design 物件一覧のフィルタを見やすくしたい
/ui-design 所有者詳細のモーダル 参考: <参考ページのURL>
```

- 対象と（あれば）参考URLを書くだけでよい。既存部品の確認・トーン合わせ・停止条件・報告は `.claude/skills/ui-design/SKILL.md` に定義済み
- 見た目が変わる作業では、実装前に必ず HTML のイメージ（今/案、PC/スマホ、ライト/ダーク）が送られてくる。承認するまでコードは変更されない
- 参考URLが無い場合は、§2「要素別の参考先」から候補を挙げて進める
- 通常の依頼文に「UI」「見た目」「画面」等が含まれる場合も自動で使われることがある

### スキルを使わない場合のテンプレート

```
<タスク名> の UI を改善してください。共通ルールは CLAUDE.md に従ってください。
参考: <URL>（<どの要素の、何を参考にするか：例 フィルタパネルの折りたたみ方>）
方針: 既存の src/components/ui と既存トーン（globals.css）で再現する。見た目の参考のみでコードはコピーしない。
今回やらないこと: 新規依存追加、MCP 追加、既存 API / 権限 / DB の変更。
依存追加やライセンス確認が必要と判断した場合は、実装前に停止して報告。
```

## 4. 未確認事項

- 各サイトの料金体系・ライセンス・商用利用可否
- 21st.dev MCP の認証方式・課金条件
- #29 Anime.js は元メモが途中で切れており、意図したリソースか未確認
