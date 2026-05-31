<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:claude-dev-rules-pointer -->
# 開発ルールの参照先（詳細は CLAUDE.md）

- このリポジトリの AI 開発・並列作業（worktree）・コマンド実行許可・commit/push の詳細ルールは **CLAUDE.md** を参照する（ここには重複記載しない）。
- Claude GitHub Code Review / `@claude review` は使用禁止（CLAUDE.md §17）。
- PII / AuditLog / 権限 / import・export / upload・storage / GitHub Actions / DM出力 / 謄本PDF に関わる変更は Codex review 推奨（CLAUDE.md §11・§19）。
- paid service / usage credits / API課金 が発生し得る機能の有効化・利用は事前承認必須（CLAUDE.md §17）。
<!-- END:claude-dev-rules-pointer -->

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
- PII / GPS / 位置情報 / raw response / API key / token / env 値が UI・console・ログ・AuditLog・エラー文に漏洩していないか
- AuditLog に生の個人情報・大量の緯度経度・rawData・認証情報（API key / token / env）を記録していないか

## migration がある場合
- 後方互換性の確認
- 本番反映手順（ダウンタイム有無・ロールバック手順）の確認

## テスト
- テスト不足があれば具体的に指摘する（どのケースが抜けているか）

## トークン効率（条件付き）
現在は Max を通常運用とする。Pro モードはユーザーが明示した場合のみ適用する。
いずれのモードでも完了報告の項目は CLAUDE.md の標準報告形式に従う。

共通（モード問わず）:
- 広範囲探索を避け、対象ファイルを絞る
- コード全文を出さず、差分・要点のみ報告する
- テストログ全文を出さない。失敗時のみ末尾 20 行以内を出す
- 既知の前提を長文で繰り返さない
- 不要なリファクタをしない
- 精度・安全性・レビュー品質は落とさない

Pro 利用中（ユーザーが Pro モードを明示した場合のみ適用）:
- Explore 不要な小修正は最小パッチモードで実行する
- 完了報告は要点を簡潔にまとめる（報告項目の詳細は CLAUDE.md の標準報告形式に従う）
- 「出力の精度を落とさずにトークン消費を半減させる方法でこのセッションは任務を実行する」を最優先とする

Max 利用中（既定）:
- 通常運用。トークン削減を最優先にしない
- 必要な検証・レビュー観点は省略しない

## しないこと
- main へ直接 push しない
- 大規模リファクタを提案しない
- 好みの問題・軽微な表現差異を強く指摘しない

## レビュー結果の分類
- **Blocker** — マージ前に必ず修正が必要
- **Important** — 強く修正を推奨するが、判断はレビュイーに委ねる
- **Nice to have** — 任意の改善提案
<!-- END:codex-review-rules -->
