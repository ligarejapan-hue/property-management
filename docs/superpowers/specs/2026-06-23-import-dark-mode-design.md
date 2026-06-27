# 取込(import)画面 ダークモード対応 設計（段階2bの一部）

作成: 2026-06-23 / セッションA / エピック=22H ダークモード段階2b
ベース: `origin/main` `99d4859`（現本番）/ branch `feat/dark-mode-import`

## 背景・目的
ダークモード段階1（土台: next-themes / `.dark` class / `@custom-variant dark`）は本番稼働済み（現本番 `99d4859`）。段階2bは内側の各画面に `dark:` 変種を追加していくだけ（新しい依存・仕組みは不要）。本spec は **取込(import)エリア** を対象とする。配色正本＝`deliverables/22A/22H-dark-mode-phase2-impl-ref.md` の段階2b「import」。

## 対象範囲（3画面・画面ごとに独立PR）
| PR | 画面 | ファイル | 概算行数 |
|---|---|---|---|
| 1 | 取込トップ | `src/app/(dashboard)/import/page.tsx` + `src/components/import/*` + `src/app/(dashboard)/import/owners/page.tsx`(stub) | ~2,700 |
| 2 | 取込ジョブ詳細 | `src/app/(dashboard)/import/jobs/[jobId]/page.tsx` | ~1,800 |
| 3 | 謄本PDF取込 | `src/app/(dashboard)/import/registry-pdf/page.tsx` | ~1,400 |

※行数は概算。正確なファイル/要素列挙は plan で `origin/main` 基準で確定する。各画面は独立ファイル＝相互に非衝突。並行する他セッション（`dark-mode-property-detail-tabs`＝物件詳細タブ、`dark-mode-admin-screens`＝admin）とも別ファイル＝非衝突。

## 方式（配色正本 ref 準拠・独自配色を発明しない）
1. **add-only**: 既存クラスは削除/置換しない。`dark:` 変種を「追加」するのみ。**ライト表示は絶対に変えない**。
2. **マッピング表に従う**: 面(`bg-white→dark:bg-gray-900` 等)/文字/枠線/入力欄/StatusBadge。
3. **低コントラストaccent文字は同PR内で dark化**: アクティブ/選択中タブ（`text-indigo-700→dark:text-indigo-400`、active分岐にも）、暗面に乗る accent リンク/ID/ボタンラベル/バナー見出し。＝@codex P2 往復の主因を先回り。
4. **色ロック分類タグは触らない**: orphan(orange)/address_null(yellow)/duplicate(purple) 等（status-badge.tsx でテスト仕様ロック）。
5. **純装飾の淡accent地は据え置き**（後続 accent-dark 一括バッチ）。判断に迷う地色は触らない（過剰変更回避）。ただし「暗面で読めない文字」は迷わず dark化（可読性最優先）。
6. **挙動・DOM構造・ロジック・データ・PII保護属性（`data-pii-protected` 等）は一切変えない＝クラス文字列のみ**。条件分岐で付くクラスは、その分岐の中で `dark:` も付ける。

## registry-pdf 取込（PR3）の注意
謄本PDF取込画面は謄本（PII）を扱うが、本作業の変更は **クラス文字列のみ**。registry の no-store / generic filename / 色ロック / `data-pii-protected` ラップ等の保護は **一切変更しない**（クラス追加のみ）。

## テスト（source-assertion）
本リポは vitest node 環境（jsdom/RTL 無し）。画面ごとに source-assertion テストを追加:
- 対象ファイルを読み、主要要素に `dark:` 変種が付いていることを文字列 assert。
- 既存 `globals-dark.test.ts` / `shell-dark.test.ts` と同型。
- `not.toContain` の対象語をテスト名・コメントに書かない（source-assertion 自爆回避）。
- 既存テストを弱めない／壊さない。

## 基盤・隔離
- ベース: `origin/main` `99d4859`（local main `530a317` は古いので使わない）。
- worktree: `property-management-worktrees/dark-mode-import` / branch `feat/dark-mode-import`。

## ゲート / Definition of Done（PR毎）
- `npx vitest run`（全 green）/ `npx tsc --noEmit`（0）/ `npx eslint`（変更分 0）/ `npm run build`（OK）。
- 色ロック分類タグ非接触。ライト表示不変（既存クラス削除/置換なし）。
- source-assertion テスト green。
- 投稿前に codex プレレビューで狙い撃ち。@codex 自動レビューは利用上限リセット後にqueue→指摘は自分で対応→自分で再レビュー起動。**マージはユーザー**。

## 非対象（YAGNI）
- import 以外の残ダーク画面（admin残/field-survey/dashboard）＝別タスク（admin は別セッション進行中）。
- accent-dark 一括バッチ（純装飾の淡accent地）＝後続。
- 新依存・新仕組み・挙動変更・無関係なリファクタ＝一切なし。

## 実装順
PR1（取込トップ）→ PR2（取込ジョブ詳細）→ PR3（謄本PDF取込）。各 `origin/main` から独立。
