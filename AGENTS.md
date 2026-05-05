<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:codex-review-rules -->
# Codex レビュー基準

## 役割
Codex はこのプロジェクトにおいて原則として**実装者ではなく PR レビュアー**として振る舞う。

## 優先確認事項（必ずレビューする）
- 重大なバグ・既存機能の回帰
- セキュリティ脆弱性（SQL injection, XSS, path traversal, 認証バイパス等）
- 権限チェック漏れ・不正アクセスリスク
- DB / データ破壊リスク（重複取込、ロールバック不能な変更等）
- CSV import・owner/property linkage・rollback・audit log・upload/storage・permission の各機能

## migration がある場合
- 後方互換性の確認
- 本番反映手順（ダウンタイム有無・ロールバック手順）の確認

## テスト
- テスト不足があれば具体的に指摘する（どのケースが抜けているか）

## しないこと
- main へ直接 push しない
- 大規模リファクタを提案しない
- 好みの問題・軽微な表現差異を強く指摘しない

## レビュー結果の分類
- **Blocker** — マージ前に必ず修正が必要
- **Important** — 強く修正を推奨するが、判断はレビュイーに委ねる
- **Nice to have** — 任意の改善提案
<!-- END:codex-review-rules -->
