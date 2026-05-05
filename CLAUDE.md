@AGENTS.md

<!-- BEGIN:claude-code-rules -->
# Claude Code 運用ルール

## ブランチ・PR
- main へ直接 push しない
- 1タスク1ブランチ、作業単位で PR を作成する
- 大規模リファクタ・無関係な整理を同一 PR に混入しない

## 実装方針
- 最小差分で実装する。既存ロジック・型・API を破壊しない
- 不明点は推測しない。既存 DB / API / 型 / ロジックを確認してから実装する
- 追加エラーハンドリング・バリデーション・抽象化は要求されていない限り行わない
- コメントは WHY が非自明な場合のみ。WHAT の説明コメントは書かない

## ワークフロー
- **Explore → Plan → Implement** を分けて進める
- 重要タスクでは Plan 提示後に停止し、承認を待ってから Implement に進む
- DB schema 変更 / migration は明示指示がある場合のみ実行する

## ビルド・テスト
- 実装後は必ず `npm run build` と `npx vitest run` を実行する
- ビルド・テストが通らない状態で commit / push しない

## VPS
- VPS 反映はユーザーの明示指示がある場合のみ実行する
- repo: `/opt/property-management`
- systemd service: `property-management`（pm2 は使わない）
- app env: `/etc/property-management/app.env`
- build / test は `www-data` で実行する
- npm cache: `/var/www/.npm`
- VPS コマンドは `/var/www/property-management` 前提にしない

## 出力制約
- コード全文の出力禁止。差分・要点・対象箇所のみを提示する
- 調査範囲を必要最小限に絞り、重複説明・長文引用・全体再読込を避ける

## 完了報告形式
1. 対応目的
2. 変更ファイル一覧
3. 変更内容
4. migration 有無
5. テスト結果
6. commit hash
7. push 結果
8. VPS 反映状況

## 実装済み（再実装しない）
- `/uploads` 404 修正済み
- property photo drag-and-drop upload 実装済み
- CSV rollback Phase 1 実装済み
- audit log UI Phase 1 補完済み
- property list search/filter finishing 実装済み
- Storage Phase 1 実装済み
- Import UX / owner_csv linkage visibility 修正済み
- 受付帳 CSV フィルタ / 列扱い / 表記改善済み
- 所有者 CSV フィールド対応済み
<!-- END:claude-code-rules -->
