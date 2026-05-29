@AGENTS.md

<!-- BEGIN:claude-code-rules -->
# CLAUDE.md

## 1. この文書の目的

- ChatGPT / Claude Code / Codex / GitHub Actions / Issue / PR で共通参照する AI運用ルールである
- 古いチャットや古い保存メモリと矛盾する場合は、恒久ルールとして整理された最新の CLAUDE.md を優先する
- ただし、ユーザーの明示指示がある場合はその指示を優先する

## 2. 共通運用ルール

- main 直push禁止
- 1タスク1branch
- 1ブランチに複数の大きな目的を混ぜない
- 推測禁止
- 不明点は推測で埋めず、前提・未確認事項として報告する
- 最小差分で対応する
- 大規模リファクタ禁止
- 既存仕様・既存UI・既存API・既存テストを優先する
- 勝手にスコープ拡大しない
- 長いコード全文を出さず、差分・要点中心に報告する
- VPS反映はユーザーが明示した場合のみ
- VPS反映が明示されていない場合、VPSログイン・git pull・build・restart・migrate deploy などを行わない

## 3. 並列作業 / worktree 運用

- 複数タスクを並行する場合は、1タスク1branchに加えて、作業ディレクトリまたは git worktree を分離する
- 複数の Claude Code セッションで同じ workdir を同時に編集しない
- Claude Code は勝手に `git switch` / `git checkout` で作業ブランチを切り替えない
- 作業完了後は `git status --short` を確認し、意図しない差分がないことを報告する
- 無制限の並列実行は禁止
- 並列作業は原則 2〜3本までを目安にし、リソース不足や作業衝突がある場合は停止して報告する
- worktree / branch / stash / cleanup / 削除操作は、対象を明示して慎重に行う
- 不要な cleanup や branch 削除、stash 操作はユーザーの明示指示がある場合のみ行う

## 4. Claude Code の作業フロー

原則:

1. Explore
2. Plan
3. ユーザーまたはChatGPT確認
4. approved Implement
5. test / build / diff-check
6. commit
7. push
8. compare URL を返す

補足:

- 実装前に既存実装を確認する
- 既存の類似実装・API・テスト・権限・AuditLog パターンを優先する
- 不明点を勝手に決めない
- 実装が必要最小限を超えそうな場合は、まず計画として報告する
- 高リスク変更では ChatGPTレビュー推奨
- 軽微変更ではユーザー判断で直接 Implement 可
- DB / migration / PII / 権限 / GPS / AuditLog 系は ChatGPT確認推奨
- ユーザーが明確に実装を依頼した場合は、その範囲内で実装する

## 5. ChatGPT / Claude Code / Codex の役割

ChatGPT:

- 要件整理
- 優先順位付け
- 実装方針レビュー
- 高リスク変更前の事前確認
- Claude Code への指示文作成
- 実装結果の妥当性確認

Claude Code:

- 具体的な実装
- 既存実装の確認
- 必要最小限の差分作成
- test / build / diff-check
- commit
- push
- compare URL の返却

Codex:

- PRレビュー
- バグ回帰、セキュリティ、権限、DB破壊、PII、AuditLog、migration、rollback、storage、GPS/location などのリスク確認

## 6. gh CLI / GitHub 操作ルール

- gh CLI が使える環境では利用してよい
- ただし gh CLI 必須の運用にはしない
- PR作成は原則ユーザー側
- ただし、ユーザーが明示許可した場合は gh CLI / GitHub API を使って PR作成してよい
- merge は常にユーザー側
- Claude Code は branch push と compare URL を返す
- Claude Code は勝手に merge / force-push / GitHub認証変更 / GitHub設定変更をしない
- CI が失敗した場合は、ログを確認し、推測で修正しない
- CI失敗の原因が不明な場合は、不明点として報告する

## 7. 実装ルール

- 既存仕様を壊さない
- 既存UI文言・業務用語を尊重する
- DB / schema / migration は必要な場合のみ変更する
- migration がある場合は報告に必ず明記する
- permission / role / auth の既存設計を確認してから変更する
- import / rollback / correction / owner / property / storage / upload / GPS / location privacy に関わる変更は特に慎重に扱う
- console.log 等に PII、住所、所有者名、緯度経度、API key、raw response、env値を出さない
- エラー表示に生の個人情報や緯度経度を出さない
- dangerouslySetInnerHTML は原則使用しない
- セキュリティ・権限・PII に関わる変更では、既存テストまたは追加テストを優先する

## 8. PII / AuditLog ルール

PII:

- 所有者名、住所、電話番号、メールアドレス、法人番号、緯度経度、写真位置情報、rawData、raw response は慎重に扱う
- UI、ログ、console、AuditLog、エラー文に不用意に出さない
- 必要な画面にのみ、権限に応じて表示する

AuditLog:

- AuditLog は操作事実、対象ID、件数、処理結果、権限上必要な最小情報を中心に記録する
- 生の個人情報を記録しない
- rawData / raw response / 大量の緯度経度 / API key / token / env値 を記録しない
- location / GPS / tracking 系では、監査ログに大量の座標を保存しない
- 監査に必要な場合も、sessionId / count / action / result など最小限にする

## 9. migration 運用

- migration は必要な場合のみ作成する
- schema 変更がない作業では migration を作らない
- migration がある PR は報告に明記する
- migration がある PR は Codex review 推奨
- VPS反映時は、migration がある場合のみ prisma migrate deploy / prisma generate を行う
- 開発中に勝手に production DB を変更しない
- rollback や data correction を伴う場合は、必ず安全側の設計にする

## 10. build / test / diff-check 運用

通常の実装後:

- 関連テストを実行
- 可能な限り全体テストを実行
- npm run build を実行
- git diff --check を実行

docs-only の場合:

- build/test は原則不要
- git diff --check は実行する
- 実行しない確認がある場合は理由を明記する

報告時:

- 実施したコマンド
- 成功/失敗
- 失敗した場合の原因
- 未実施の場合の理由

を簡潔に書く

## 11. Codex review 推奨条件

以下の変更は Codex review 推奨:

- DB / schema / migration
- 権限 / role / permission
- PII
- AuditLog
- import
- rollback
- correction
- owner / property の重要データ変更
- storage / upload / file access
- GPS / location / tracking / field survey
- security-sensitive な変更
- race condition / idempotency / batch processing
- production data に影響し得る変更

注意:

- Codexへの返信文案は標準報告に含めない
- Codex review が必要な理由だけ簡潔に報告する

## 12. Issue / PR / GitHub Actions での参照方針

- CLAUDE.md を AI 運用ルールの基準文書として扱う
- GitHub Actions / @claude で動く場合も、作業前に CLAUDE.md と AGENTS.md を確認してから作業する
- Issue / PR / GitHub Actions でも、このルールと矛盾しない前提で作業する
- GitHub Actions / CI が失敗した場合は、ログを確認し、推測で修正しない
- CI失敗の原因が不明な場合は、不明点として報告する
- main への直接 push、force push、勝手な merge は禁止

## 13. VPS / production ルール

- VPS反映はユーザーの明示指示がある場合のみ
- 明示指示がない限り、VPSへログインしない
- 明示指示がない限り、production の git pull / npm ci / build / restart / migrate deploy を行わない
- VPSパスは /opt/property-management
- systemd service は property-management
- env は /etc/property-management/app.env
- npm cache は /var/www/.npm
- pm2 は使わない
- build/test は原則 www-data
- VPS反映時は HOME=/var/www と npm_config_cache=/var/www/.npm を使う
- migration がある場合のみ prisma migrate deploy / prisma generate を行う
- ドキュメント更新のみの PR は VPS反映不要

## 14. 実装後の報告フォーマット

標準報告フォーマット:

1. 変更ファイル一覧
2. 変更内容
3. 削除・整理した古い運用、または影響範囲
4. 実施した確認
5. テスト結果 / build結果 / diff-check結果
6. migration 有無
7. Codex review 推奨有無と理由
8. commit hash
9. push結果
10. compare URL
11. 注意点・未対応

docs-only 作業の最低限報告フォーマット:

1. 変更ファイル一覧
2. 変更内容
3. 削除・整理した古い運用
4. 実施した確認
5. commit hash
6. push結果
7. compare URL
8. 注意点・未対応

## 15. 実装済み（再実装しない）

- `/uploads` 404 修正済み
- property photo drag-and-drop upload 実装済み
- CSV rollback Phase 1 実装済み
- audit log UI Phase 1 補完済み
- property list search/filter finishing 実装済み
- Storage Phase 1 実装済み
- Import UX / owner_csv linkage visibility 修正済み
- 受付帳 CSV フィルタ / 列扱い / 表記改善済み
- 所有者 CSV フィールド対応済み

## 16. 関連ドキュメント（AI開発ツール統合フロー）

- AI開発ツール（ChatGPT / Claude Code / Codex / GitHub / GitHub Actions / VPS）を使った標準開発フローは `docs/ai-workflow.md` を参照する
- このdocsは §4 作業フロー、§5 役割分担、§11 Codexレビュー、§13 VPS運用を運用観点で補足する索引である
- 矛盾時は CLAUDE.md / AGENTS.md を正とし、`docs/ai-workflow.md` はそれを補足する

## 17. 従量課金サービスの事前報告・承認ルール

- Claude Code / Codex / GitHub Actions / 外部API / クラウド機能 / review bot / usage credits など、従量課金・API課金・usage based billing・有料review・有料runner 等が発生し得るサービスや機能を、利用・追加・有効化・自動化・設定変更する場合は、実行前に必ずユーザーへ報告する。
- 報告には次を含める：
  - どのサービスを使うのか
  - 従量課金が発生し得る理由
  - 何をトリガーに課金されるのか
  - 想定される費用（不明な場合は「不明」と明記）
  - 無料または低コストの代替案
  - 実行してよいかの明示確認
- ユーザーの明示承認なしに、従量課金サービスを有効化・利用・自動化しない。
- 特に Claude GitHub Code Review / `@claude review` は usage based billing のため、標準フローには組み込まない。
- 標準レビューは既存の Codex review opt-in 運用（`docs/ai-workflow.md` §5）を使う。
- 既に本番運用上必要なサービスでも、課金条件・自動実行条件を変更する場合は事前に報告する。
<!-- END:claude-code-rules -->
