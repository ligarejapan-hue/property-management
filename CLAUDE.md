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
- import / export
- rollback
- correction
- owner / property の重要データ変更
- storage / upload / file access
- GPS / location / tracking / field survey
- security-sensitive な変更
- race condition / idempotency / batch processing
- production data に影響し得る変更
- VPS / deployment
- GitHub Actions / 開発運用フロー
- DM出力（宛名・送付対象データ）
- 謄本PDF / 謄本自動取得

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
- 既に本番運用上必要なサービスでも、課金条件・自動実行条件を変更する場合は事前に報告する。

### Claude GitHub Code Review / `@claude review` は原則禁止

- Claude GitHub Code Review / `@claude review` は usage based billing のため **原則禁止**とする。
- 標準開発フロー・PRレビュー・自動化・workflow・bot 連携には**組み込まない**。
- Claude GitHub Code Review / `@claude review` を**利用する提案も標準では行わない**。
- 例外は、ユーザーが **対象PR・目的・想定費用・課金トリガー・代替案** を確認したうえで、その都度明示的に「このPRで使う」と指示した場合のみ。
- 標準レビューは既存の **Codex review opt-in** 運用（`docs/ai-workflow.md` §5）を使う。

## 18. Claude Code コマンド実行 / worktree / commit ルール

- 本章は §3（worktree）・§4（作業フロー）・§6（GitHub操作）・§9（migration）・§10（build/test/diff）・§13（VPS）・§17（従量課金）を、コマンド実行・並列作業・commit の観点で具体化したものである。
- 目的は、毎回の許可確認で止まらないようにしつつ、危険操作だけは必ず事前確認させ、並列 worktree 作業を安全にすることにある。
- 矛盾する場合は各章の本文を正とする。本章は既存ルールを弱めない。

### 18.1 事前確認なしで実行してよい安全コマンド

対象worktree内であれば、以下は毎回の許可確認なしで実行してよい。

読み取り・確認:

- `pwd` / `ls` / `dir`
- `git status --short`
- `git branch --show-current` / `git branch -vv`
- `git log --oneline -n 5`
- `git diff` / `git diff --check`
- `git show`（必要な対象 commit / file に絞って実行する）
- `git worktree list`
- `rg` / `cat` / `sed` / `head` / `tail`

検証（コードを変更するタスクで必要な場合）:

- `npx vitest run`
- `npm run build`
- `npx prisma generate`

依存復元:

- `npm ci --no-audit --no-fund` — ただし以下を**すべて**満たす場合のみ許可:
  - 対象worktree内で実行する
  - 依存追加・依存更新を目的にしない
  - package.json / package-lock.json を変更しない
  - node_modules を commit 対象にしない
  - docs-only 作業では原則実行しない
  - npm ci 後に package.json / package-lock.json に差分が出た場合は停止して報告する

docs-only 作業では、`npm ci` / `npx prisma generate` / `npm run build` / `npx vitest run` は原則不要（§10 と整合）。docs-only では `git diff --check` と `git status --short` を必須とし、build/test 等を省略した場合は省略理由を報告する。

### 18.2 必ず事前確認を取る操作

以下は安全コマンドに含めず、必ずユーザー確認を取る。

Git履歴・削除系:

- `git reset` / `git clean` / `git rebase`
- `git push --force`
- `git stash apply` / `git stash pop` / `git stash drop`
- branch削除 / worktree削除 / remote branch削除

補足:

- ユーザーが「merge後cleanup」を明示した場合に限り、その対象PRに紐づく merged local branch / worktree の安全削除のみ実行してよい。cleanup時も main に取り込まれていることを ancestry 等で確認してから削除する。
- 未merge branch、対象不明branch、remote branch削除は必ず事前確認を取る。

DB / schema（詳細は §9）:

- `prisma migrate dev` / `prisma migrate deploy` / `prisma db push`
- `schema.prisma` 変更 / migration作成

環境・本番（詳細は §13）:

- VPS操作 / `systemctl` / nginx変更 / env変更 / GitHub Settings変更 / secrets変更

外部・課金（詳細は §17。**このルールは弱めない**）:

- 外部API接続 / OCR導入 / Playwright導入 / 謄本自動取得の実アクセス
- paid service / usage credits / API課金が発生し得る操作
- Claude GitHub Code Review / `@claude review` は §17 のとおり**原則禁止**（標準フローでは使用しない）。

依存関係変更:

- `npm install <package>` / `npm update`
- package.json変更 / package-lock.json変更

### 18.3 worktree 並列作業ルール

§3（並列作業 / worktree 運用）を前提に、次を守る。

- 1 worktree = 1 Claude Code セッション。
- 1 task = 1 branch = 1 worktree。
- 同じ worktree を複数セッションで同時に触らない。
- 同じファイルを触る実装タスクは同時並列にしない。
- main worktree では原則として実装しない（実装は作業用 branch / worktree で行う）。
- 既存 worktree に未コミット差分がある場合は、停止して報告する。
- 作業前後に `git status --short` を確認する。
- merge後cleanup（§18.2 補足）以外で branch / worktree を削除しない。
- remote branch は手動削除せず、GitHub の auto delete + `git fetch --prune` に任せる。

### 18.4 commit / push ルール

§4・§10・§14 の作業フローに加え、次を守る。

- 実装タスクは、対象テスト / `npx vitest run` / `npm run build` / `git diff --check` が green の場合のみ commit / push する。
- docs-only は `git diff --check` と `git status --short` が問題なければ commit / push してよい（build/test は §10 のとおり省略可。省略理由を報告する）。
- commit 対象は対象タスクの変更ファイルに限定する（`git add` は対象ファイルを明示し、全体 add をしない）。
- `.claude/settings.local.json` は絶対に commit しない。
- node_modules / generated files は commit しない（`git status --short` で混入がないことを確認する）。
- package.json / package-lock.json / schema.prisma / prisma/migrations の差分は、ユーザーが明示承認した依存追加・schema変更・migration作成タスクで、かつ対象タスクに含まれる場合のみ commit してよい（§18.2 / §9 参照。commit する場合は必ず報告する）。
- それ以外の意図しない / 対象外の package差分・migration差分は commit せず、停止して報告する。
- merge は常にユーザー側で行う（§6）。

## 19. 高リスク領域の共通ルール

- Codex review 必須または強く推奨の対象は §11 を参照する（本章追加に合わせ、§11 に import/export・VPS/deployment・GitHub Actions/開発運用・DM出力・謄本PDF/謄本自動取得 を追記済み）。
- 以下は領域横断の共通禁止・必須確認とする（§7・§8・§17 を具体化し、弱めない）:
  - AuditLog に、所有者名 / 住所 / PDF本文 / rawText / fileUrl全文 / token / apiKey / secret / env値 / GPS座標 を増やさない（§8 を具体化）。
  - PII を扱う CSV は、CSV formula injection 対策（先頭の `=` `+` `-` `@` 等の無害化）を必ず行う。
  - 権限は UI だけでなく **API 側で必ず確認する**（§7 を具体化）。
  - `owner:read` は表示可否であり、export 権限の代替にしない。
  - `csv_export` / `csv_export_personal` が必要な出力では、両方の権限を確認する。
  - paid service / usage credits / API課金 が発生し得る機能は、§17 のとおり事前承認なしに有効化・利用しない。
  - Claude GitHub Code Review / `@claude review` は §17 のとおり原則禁止（標準フローで使用しない）。

## 20. 謄本PDF系タスク共通ルール

- `registry-pdf/route.ts` を触るタスクは同時並列にしない。
- A-2b / A-2c / A-2d など謄本PDF系は、順次 merge 後に次へ進める。
- PDF本文 / rawText / 所有者名 / 住所を AuditLog に追加しない（§8・§19）。
- Attachment 保存では fileUrl 全文を AuditLog に入れない。
- text 貼り付けモードでは PDF が無いため Attachment を作成しない。
- Mode B 所有者反映 / Attachment 保存 / field_staff スコープ / rollback 拡張は混ぜず、別PRにする。
- 外部サービス連携 / OCR / 謄本自動取得の実アクセスは、別途明示承認があるまで禁止（§17・§18.2）。
- schema / migration が必要になりそうなら、実装前に停止して報告する（§9）。

## 21. DM出力系タスク共通ルール

- 初版は CSV のみを基本とする。
- `dmStatus = send` のみ出力する。`no_send` は除外、`hold` は初版では含めない。
- owner ごと複数行を基本とする。
- 権限は `csv_export` + `csv_export_personal` + `owner:read` を確認する（§19）。
- AuditLog には件数・条件・executor のみ記録し、CSV内容 / 所有者名 / 住所は残さない（§8・§19）。
- 出力 CSV は UTF-8 BOM 付きとする。
- CSV formula injection 対策を必ず行う（§19）。
- `dm_export` など新権限が必要と判断した場合は、実装前に停止して報告する。

## 22. 短縮プロンプト運用ルール

- 今後のユーザー指示では、共通ルールを毎回長く書かない。Claude Code は本 CLAUDE.md（特に §1〜§21）の共通ルールを常に前提として作業する。
- ユーザーからは、原則として次のタスク固有情報だけを受け取れば作業できるものとする:
  - タスク名
  - 対象 branch / worktree
  - 実装範囲
  - 今回やらないこと
  - 停止条件
  - 必要テスト
  - 報告項目
- 短縮プロンプト例:
  > 「A-2b Attachment(type=registry) 保存を実装してください。共通ルールは CLAUDE.md に従ってください。今回やることは PDF アップロード時の Attachment 作成のみ。Mode B 所有者反映、rollback 拡張、OCR、外部連携、schema/migration はしない。」
- 指示が曖昧・共通ルールと矛盾する場合は、推測せず Plan 段階で停止して報告する（§2・§4）。

## 23. Claude Code / Agent の実行報告・ツール呼び出しの真正性ルール

- 本章は §10（build/test/diff-check 報告）・§13（VPS）・§14（報告フォーマット）・§18（コマンド実行）を、実行の真正性と報告証跡の観点で補強する。既存ルールを弱めない。
- 目的は、疑似的なツール呼び出し・疑似コマンドが応答本文に出る事故や、実行していない処理を実行済みと誤報告する事故を防ぐことにある。
- 通常の Claude Code / Agent によるツール実行そのものは禁止しない。実行は許可したうえで、実行証跡（実際の結果）を伴う報告を必須とする。

### 23.1 疑似ツール呼び出し・疑似コマンドの禁止

- 疑似的なツール呼び出し・疑似コマンドを応答本文に出力しない。ツールは実際のツール呼び出し機構でのみ実行する。
- 禁止する記述の例:
  - `call <invoke ...>` 形式
  - `<invoke name="Bash">...</invoke>`
  - `<invoke name="Read">...</invoke>`
  - `<invoke name="Edit">...</invoke>`
  - `<invoke name="Write">...</invoke>`
  - その他、実際には実行されていないツール呼び出し風・コマンド実行風の記述
  - ファイル編集内容だけを本文に出して、実際に書き込んだかのように見せる記述
- Bash だけでなく、Read / Edit / Write / Glob / Grep など、すべてのツール・ファイル操作が対象である。
- 応答本文に書いただけで実際のツール呼び出しが行われていないものは、すべて「未実行・無効」として扱う。

### 23.2 実行証跡を伴う報告

- 実行結果（ツールの戻り）がないのに「実行した」「成功した」と報告しない。
- コマンド本文・手順だけを提示して成功扱いにしない。
- ファイル編集内容だけを提示して、実際に書き込んだかのように報告しない。
- コマンドを実行した場合は、次を報告する:
  - 実際の stdout / stderr の要点
  - exit code
  - 成功 / 失敗 / 未実行 のいずれかの判定
- ファイル編集を行った場合は、次を報告する:
  - 実際の変更ファイル
  - 変更概要
  - `git diff` / `git status` に基づく確認結果
- SSH / VPS 作業（§13）では特に、実行証跡（実際の出力・状態確認結果）なしに成功扱いにしない。

### 23.3 失敗・未実行時の停止と引き継ぎ

- 失敗または未実行が判明した場合は、次工程へ進まず停止して報告する。
- 疑似ツール呼び出し・疑似コマンドが応答本文に出た場合は、その操作を「未実行・無効」として扱い、停止して報告する。
- 同一セッション内で疑似ツール呼び出し・疑似コマンドの漏れが繰り返された場合は、そのセッションを停止し、現在の状態を明示したうえで新セッションへ引き継ぐ。
<!-- END:claude-code-rules -->
