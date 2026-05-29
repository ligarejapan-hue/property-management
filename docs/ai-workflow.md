# AI開発ツール統合 標準運用フロー

ChatGPT / Claude Code / Codex / GitHub / GitHub Actions / VPS を使って
property-management の開発全体を回すための **運用設計ドキュメント** である。

---

## 0. このドキュメントの位置づけ

- 本書は **AI開発ツール統合の運用設計**であり、property-management アプリ本体の機能docsではない。
- 機能仕様・schema・API・テスト等の本体開発ルールは扱わない。本体ルールは `CLAUDE.md` / `AGENTS.md` を参照する。
- 本書は `CLAUDE.md` の §4 作業フロー・§5 役割分担・§11 Codexレビュー・§13 VPS運用を、運用観点でまとめた索引・補足である。
- **矛盾時は `CLAUDE.md` / `AGENTS.md` を正とする。** 本書はそれを上書きしない。
- VPSパス・systemd名・env配置などの具体値は再掲せず、`CLAUDE.md` §13 を単一の情報源とする。

---

## 1. 社内システム開発とAI開発ツール統合の切り分け

| 区分 | 扱うもの | 成果物の置き場所 |
|------|---------|----------------|
| 社内システム開発（本体） | property-management の機能・bugfix・schema・migration・UI・API・テスト | `src/` `prisma/` 機能docs |
| AI開発ツール統合（運用） | ChatGPT/Claude Code/Codex/GitHub/Actions/VPS をどう連携させて開発を回すか | 本書・`CLAUDE.md`・`AGENTS.md`・各テンプレ・ChatGPT側運用メモ |

**両者が交差する部分**

- `CLAUDE.md` / `AGENTS.md` は本体ルールとAI運用ルールが同居している。
- Issueテンプレ・PRテンプレ・CI・`@claude` は、本体開発の品質ゲートであり同時にAI運用の入口でもある。
- VPS反映手順（`docs/deploy.md`）は本体の運用手順だが、「誰がいつ実行するか」はAI運用ルール側の判断。

**混同しないための注意点**

1. 「機能を作る」依頼と「運用フローを決める」依頼を同じIssue/branchに混ぜない（1タスク1branch）。
2. 運用設計の変更は docs-only/config-only に収まることが多い → build/test不要・diff-checkのみを最初から意識する。
3. 本体コードを触らない運用タスクでは、依頼テンプレで「変更してよい範囲」を明示し、`src/` や `schema.prisma` への波及を防ぐ。

---

## 2. 各ツールの役割分担

| ツール | 役割 | やらないこと |
|--------|------|------------|
| ChatGPT | 要件整理・優先順位・方針レビュー・Claude Code/Codex向け指示文作成・指摘の修正指示化・設計書管理 | 直接のコード実装はしない |
| Claude Code | Explore・Plan・最小差分実装・test/build/diff-check・commit・push・compare URL返却 | main直push・force-push・勝手なmerge・勝手なVPS・PR勝手作成・migration勝手作成 |
| Codex review | PRのバグ回帰/セキュリティ/権限/PII/DB破壊/migration/rollback/storage/GPS確認。Blocker/Important/Nice to have で分類 | 実装者にならない・大規模リファクタ提案しない・好みの指摘を強くしない |
| GitHub PR | 変更の単位・レビュー記録・compareの場・merge判断の器 | （全チェックが埋まるまでmergeしない運用） |
| GitHub Actions / CI | main向けpush/PRで build+test を自動実行（client生成含む）。品質ゲート | デプロイはしない（CIはVPS反映と無関係） |
| VPS | 本番反映先。ユーザー明示時のみ git pull→build→restart（migration時のみ migrate deploy） | 開発中の自動反映・AIの自律ログインはしない |
| 進捗管理チャット | タスク状態・PR/compare URL・VPS反映状況・残課題の記録。外出時の引き継ぎ | 生PII/座標/secretを書かない |

---

## 3. 標準開発フロー

```
[1]  要件提示        ユーザー → ChatGPT     ：やりたいことを自然文で
[2]  要件整理＋指示文 ChatGPT               ：Claude Code指示文（目的/範囲/禁止/報告形式）
[3]  Explore→Plan    Claude Code            ：調査結果＋計画を返す ★ここで停止
[4]  Plan確認        ChatGPT or ユーザー    ：承認 or 修正指示
[5]  approved        ユーザー               ：「Implementしてよい」の明示
[6]  実装一式        Claude Code            ：実装→test→build→diff-check→commit→push→compare URL
[7]  PR作成          ユーザー（原則）       ：PRテンプレに沿って起票
[8]  CI確認          GitHub Actions         ：build+test、green/red
[9]  Codex review    @codex（必要時・手動）  ：§5基準で要否判断
[10] 指摘対応        Codex指摘 → ChatGPT    ：修正指示文を作る → [3]or[6]へ戻る
[11] merge           ユーザー               ：指摘なし＋CI greenが条件
[12] cleanup         標準フロー（§8）       ：remote自動削除 + ローカル整理
[13] VPS反映         ユーザー明示時のみ     ：§7基準。migration/env注意
[14] 進捗報告        ユーザー/ChatGPT       ：進捗管理チャットへ結果記録
```

軽微変更（docs/typo/小設定など低リスク）は [4] Plan を省略し、ユーザー直接approve→[6] でよい
（`CLAUDE.md` §4「軽微変更はユーザー判断で直接Implement可」と整合）。

---

## 4. 停止点（AIが勝手に越えない境界）

- **Plan承認前にImplementしない**（重要/高リスク時は必須。[3]→[5]）。
- **PR作成は原則ユーザー**（gh明示許可時のみAI可。[6]→[7]）。
- **mergeは常にユーザー**（[11]）。
- **VPS反映はユーザー明示時のみ**（[13]）。
- **GitHub settings をAIが勝手に変更しない**（`CLAUDE.md` §6）。

---

## 5. Codex review の判断基準

**運用方針**

- **正式運用（opt-in）**：`.github/workflows/codex-review-auto.yml` が、CI（name: `CI`）成功後に **`needs-codex-review` ラベル付きの非 draft PR にだけ** `@codex review` を自動投稿する。`skip-codex-review` ラベルがあれば投稿しない。CI green 後に **ラベル追加（`needs-codex-review`）・`skip-codex-review` 解除・draft 解除（Ready for review）・reopen** をした場合も、**現在の head SHA に対する CI 成功を確認**してから自動依頼する。
- `github-actions[bot]` の `@codex review` コメントに **Codex が反応することは PR #72 で確認済み**。
- `skip-codex-review` は、自動依頼から**明示的に除外したいPR用**として維持する。
- **default-on + `skip-codex-review`（opt-out）方式は将来候補**であり、**現時点では採用しない**。
- Codex automatic reviews が ON かは未確認であり、**前提にしない**（自前の opt-in workflow を正式運用とする）。
- **opt-in 対象外で必要なPR**では、**ユーザーが手動で `@codex review` を補完的に実行**してよい。
- DB / migration / PII / GPS / AuditLog / 権限 / import / rollback / upload-storage / security 系は **`needs-codex-review` ラベルを付ける運用を推奨**（Codex review 必須級または強く推奨）。
- docs-only / typo / UI文言などは Codex review **不要でもよい**。
- ただし docs でも、**VPS手順・開発フロー・セキュリティ運用に関わるPRでは `needs-codex-review` ラベル付与を推奨**。
- Codex 指摘が出た場合は、**ChatGPT が妥当性を判断し、Claude Code への修正指示に変換**する。

| レベル | 対象（`CLAUDE.md` §11 / `AGENTS.md` 準拠） |
|--------|------|
| 必須級 | DB/schema/migration、権限/role、PII、AuditLog、import、rollback/correction、storage/upload(path traversal)、GPS/location、production data影響、認証バイパス懸念 |
| 推奨 | owner/property重要データ変更、race condition/idempotency/batch、security-sensitiveな分岐 |
| 軽微（不要でも可） | docs/typo、コメント、純粋なUI文言、設定値の表記、影響限定のテスト追加のみ |

**指摘対応フロー**

```
Codex出力 → 分類確認（Blocker / Important / Nice to have）
  Blocker      : merge前に必ず修正。ChatGPTが修正指示文化 → Claude Code修正 → 再push → CI → 再review
  Important    : （P1 / P2 相当）原則 merge 前に対応。見送るなら理由をPR/チャットに記録（ユーザー判断）
  Nice to have : （P3 相当）任意。必要に応じて見送り、または別Issue化も可
```

- 主分類は `AGENTS.md` に合わせ **Blocker / Important / Nice to have** を維持する。P1 / P2 / P3 は補助的な対応付けとして併記したものであり、用語の置き換えではない。
- 修正は新規commit（amendしない）。
- Codexへの返信文案は標準報告に含めない（`AGENTS.md`）。

---

## 6. GitHub Actions / CI の位置づけ

- **CI内容**：`npm ci → prisma generate → npm run build → npm test(vitest)`（main向けpush/PR）。
- **ローカルtest/buildとの関係**：ローカルは一次検証（速い・即修正）、CIは最終ゲート（クリーン環境での再現確認）。
  ローカルgreenでもCI redはあり得るため、merge条件はCI green。
- **CI green / red の意味**：green は「クリーン環境でbuild+testが通る」保証。機能の正しさ（UI挙動）は別途要確認。
- **CI failure時**：ログ確認 → 推測修正しない → 原因不明は未確認事項として報告（`CLAUDE.md` §6/§12）。
- **スマホ確認時の注意**：green/redバッジだけで判断せず、どのテストが落ちたか中身を確認する。red時の再実装はPCで行う。

---

## 7. VPS反映フロー

| 状況 | 判断 |
|------|------|
| 反映してよい | ユーザーが明示指示した時のみ。CI green＋merge済み＋（必要なら）Codex Blocker解消済み |
| 反映してはいけない | 明示指示がない、CI red、未merge、Blocker未解消、ユーザー不在でスマホのみ |
| migrationあり | 反映時のみ `prisma migrate deploy` / `prisma generate`。事前 pg_dump、後方互換・ロールバック手順を確認 |
| env変更あり | サーバ上の app.env（git管理外）を手動更新。secretはチャット/ログに出さない。反映後 restart |
| rollback / 障害時 | `docs/deploy.md` のロールバック手順。安全側設計を優先 |

- **具体値（VPSパス・systemd名・env配置・実行ユーザー等）は `CLAUDE.md` §13 を正とする。** 本書には再掲しない。
- 手順詳細は `docs/deploy.md` を参照する。

**スマホからVPS操作を避けるべき理由**

- 誤操作の取り返しがつきにくい（restart失敗・migrate deployの不可逆性）。
- env/secretを小画面で扱うと漏洩・誤記リスクがある。
- 障害時の切り分けがしづらい。VPSは「PCで・ユーザー明示で・手順書を見ながら」が原則。

---

## 8. cleanup方針

**merge後cleanupは標準フローとして毎回実施する。**

- ユーザーが「merge完了」と伝えたら、ChatGPTは原則 cleanup 指示を作成する。
- GitHub の **Automatically delete head branches は ON 済み**。PR merge後、GitHub上の remote head branch は自動削除される前提とする。
- ローカルbranch は merge後 cleanup で Claude Code が整理する。

**worktree の扱い**

- worktree は、以下をすべて満たす場合のみ cleanup 対象にする。
  - merge済みPRに紐づいている
  - 対象branchが明確である
  - `git status` が clean である
- **不明なworktree・未merge作業・差分ありworktree は削除しない。**

**禁止事項（cleanupに含めない）**

- stash は自動削除しない。`stash apply` / `pop` / `drop` は禁止。
- `force push` / `git reset` / `git clean` / VPS操作 / env変更は cleanup に含めない。

---

## 9. スマホ・外出時運用

| 区分 | 内容 |
|------|------|
| スマホでできる | Issue起票（テンプレ利用）、`@claude`/`@codex`コメント、PR/diff/compare閲覧、CI結果(green/red)確認、**`needs-codex-review` ラベル付与**、**CI green 後の自動 `@codex review` 依頼・Codex review 結果の確認**、進捗チャット報告 |
| やってよい軽作業 | docs/typo/文言修正の `@claude` 依頼、Plan内容の承認/差し戻し、Codex指摘の確認 |
| merge判断 | **CI green ＋ Codex review 結果確認 ＋ 差分を十分に精査できる場合のみ**スマホで確定してよい。スマホ画面で差分確認が不十分なら、**merge 判断は帰宅後PCへ回す** |
| 避けること | 差分を精査できないままの merge 確定、VPS操作全般、migration含むPRのmerge、env変更を伴う反映、複雑な conflict 対応、複数並列タスクの起動 |
| 帰宅後PCでやる | 差分の精読、本体コードレビュー、migration/env絡みのmerge、VPS反映、ビルド再現確認、cleanup |

`@claude` / `@codex` を使う時の注意

1. 作業前に `CLAUDE.md` / `AGENTS.md` 参照前提を必ず添える。
2. `@claude` はpush可能だが merge/VPS はしない前提を明記する。
3. CI red のまま放置merge依頼をしない。
4. Claude Code への指示は短くても、次は**省略しない**：
   - 変更してよい範囲
   - 変更してはいけない範囲
   - 禁止事項
   - `.claude/settings.local.json` を触らないこと
   - VPS反映の有無

---

## 10. テンプレート集

PR本文は既存の `.github/PULL_REQUEST_TEMPLATE.md` を使う（本書では再定義しない）。

**使い分け**：各テンプレは長文版（標準・PC向け）。スマホからは「スマホ短縮版テンプレ」を使ってよい。
ただし短縮版でも、**変更してよい範囲／変更してはいけない範囲／禁止事項／`.claude/settings.local.json` を触らないこと／VPS反映の有無**は省略しない。指示が曖昧な場合、Claude Code は Plan で停止する。

### Claude Code Plan依頼テンプレート

```
目的：
対象範囲（ファイル/機能/API）：
変更してよい範囲：
変更してはいけない範囲：
今回やること：Explore→Plan のみ。実装しない。
Planで返すこと：①新規/編集ファイル ②変更しない範囲 ③migration有無 ④リスク ⑤確認事項
禁止：実装/branch/commit/push/PR/VPS/main直push
```

### Claude Code 実装依頼テンプレート（approved後）

```
承認済みPlan：（リンク or 要約）
実装範囲：最小差分のみ。スコープ拡大禁止
実施：実装→関連test→npm run build→git diff --check→commit→push
report：CLAUDE.md §14 標準報告フォーマット＋compare URL
禁止：PR作成（ユーザー側）/merge/VPS/force-push/migration勝手作成
```

### Codex指摘対応テンプレート（ChatGPTが作る修正指示）

```
対象PR：#  /  Codex指摘分類：Blocker/Important/Nice to have
指摘要点：
修正方針（最小差分）：
やること：修正→新規commit（amend禁止）→push→CI再確認→再review依頼
触らない範囲：
```

### merge後cleanupテンプレート

```
前提：対象PRはmerge済み。remote head branchはGitHub設定で自動削除済み想定
対象：merge済みローカルbranch名（明示）
やること：
  - 指定ローカルbranchの整理
  - worktreeは「merge済み・branch明確・git status clean」の場合のみ整理
確認：git status --short で意図しない差分なしを報告
禁止：未merge/差分あり/不明worktreeの削除、stash apply/pop/drop、force push、git reset、git clean、VPS、env変更
```

### VPS反映依頼テンプレート（ユーザー明示時のみ）

```
反映対象：main の commit hash
migration：あり/なし（ありなら deploy 必要）
env変更：あり/なし（あれば app.env 更新内容）
手順：docs/deploy.md に従う。具体値は CLAUDE.md §13 を正とする
事前：pg_dump（migrationあり時）
報告：反映結果/サービスactive確認/残課題。secret・座標・PIIは出さない
```

### 進捗管理チャット報告テンプレート

```
完了Phase / タスク名：
状態：Plan待ち/実装中/PR作成済み/CI green/Codex待ち/merge済み/cleanup済み/VPS反映済み
PR番号 / compare URL：
branch：
merge commit hash：
変更ファイル：
実装内容：
CI結果：green/red（redなら原因）
Codex review結果：未/指摘なし/Blocker有(対応中)/対応済み
cleanup結果：未/完了（削除branch・worktree）
VPS反映要否：不要/必要（明示時のみ・反映済みなら hash）
残課題：
次にやること：
```

### 緊急停止・確認のみテンプレート

```
モード：確認のみ（read-only） / 即時停止（いずれか明示）
許可：git status --short / git show / git log 等の確認コマンドと、その報告のみ
禁止：編集 / staging / commit / push / PR作成 / merge / VPS操作 /
      reset / clean / stash apply・pop・drop / .claude/settings.local.json 変更
即時停止の場合：現在の状態・実行予定だった操作・停止理由を報告し、承認まで進めない（§4 停止点・§11#8）
返すもの：確認結果と、次アクションの可否
```

### スマホ短縮版テンプレート

```
（スマホから短く出す用。詳細は §10 の各長文テンプレに従う）
タスク：（1行）
モード：Plan のみ / 実装 / 確認のみ / cleanup（いずれか明示）
触ってよい範囲：
触ってはいけない範囲：
禁止：main直push / force-push / merge / VPS / .claude/settings.local.json 変更
VPS反映：なし（短縮版は原則なし。必要時は「VPS反映依頼テンプレート」を使う）
※ 指示が曖昧なら Claude Code は Plan で停止する
```

---

## 11. トラブル時の復旧ルール

**共通原則**

- 推測で修正しない。原因が不明なときは安全側で止める。
- 対象（PR番号・branch・ファイル）を明示する。
- 不明点は報告して停止する（承認・指示なく先へ進めない）。
- `git reset` / `git clean` / `force push` / `stash apply`・`pop`・`drop` / VPS操作 / env変更 には踏み込まない。
- 既存の正を参照する：CI失敗・推測禁止は `CLAUDE.md` §6、VPS は `CLAUDE.md` §13 と `docs/deploy.md`、cleanup は本書 §8。

| 症状 | 一次対応 | 担当 | やってはいけないこと |
|------|---------|------|------------------|
| 1. CI failed | Actions ログで失敗ジョブ/テストを特定し報告。修正は最小差分で新規 commit → 再 push → CI 再確認 | Claude Code（修正）/ ChatGPT（指示）/ ユーザー（判断） | 推測修正・main 直 push・CI red のまま merge |
| 2. Codex 指摘あり | 分類（Blocker / Important(P1·P2) / Nice to have(P3)）を確認し §5 の対応フローへ。Blocker・P1・P2 は原則 merge 前に対応 | ChatGPT（妥当性判断・指示）→ Claude Code（修正） | commit の amend・Blocker 未解消での merge |
| 3. PR conflict | main を最新化し PR branch で内容を確認して解決 → CI 再 green 確認。複雑なものは帰宅後PCで精査 | ユーザー / Claude Code（指示時） | force push・スマホでの複雑 conflict 即解決・reset / clean |
| 4. 自動 `@codex review` が動かない | workflow ログで PR特定 / CI success / label / draft / dedup を切り分け。当面は手動 `@codex review` で補完 | ユーザー（確認）/ ChatGPT（切り分け） | workflow の推測改変・repository settings の勝手な変更 |
| 5. `needs-codex-review` 付与漏れ | ラベルを付与すれば CI green 後でも §5 の状態変更トリガーで再判定される。緊急時は手動 `@codex review` | ユーザー | 必須級変更を無確認で merge |
| 6. merge後 cleanup 失敗 | 本書 §8 の安全範囲のみ再試行。未 merge / 差分あり / 不明 worktree は削除しない。判断不能は報告して停止 | Claude Code（指示時）/ ユーザー | reset / clean / stash / force・未 merge branch 削除 |
| 7. VPS反映失敗 | `docs/deploy.md` のロールバック/手順を正として対応（ユーザー明示時のみ）。ログ確認 → 安全側 | ユーザー | AI 自律 VPS ログイン・推測での migrate/restart・secret/env 露出 |
| 8. Claude Code が禁止操作をしそう | 直ちに停止し、該当操作と理由を報告して指示を仰ぐ（停止点は §4） | Claude Code（停止）/ ユーザー（判断） | 承認前の実行・スコープ拡大 |
| 9. `.claude/settings.local.json` が混入しそう | 原則「最初から stage しない」（`git add` は対象ファイルを明示）。万一 stage された場合も**対象を明示して unstage のみ**。ファイル自体は編集しない | Claude Code | settings.local.json の編集・`git reset`/`clean`・全体 `add` |

---

## 12. 未確認事項

- Codex automatic reviews が ON かは未確認。ただし現在は**自前の GitHub Actions opt-in 運用を正式運用とする**ため、Codex automatic reviews は**前提にしない**。
- （`github-actions[bot]` の `@codex review` コメントに Codex が反応すること、および opt-in workflow の基本動作は **PR #72 で確認済み**のため未確認事項から外した。詳細は §5 参照。）
- （default-on + `skip-codex-review`（opt-out）方式は将来候補であり、現時点では採用しない。）
- （GitHub の Automatically delete head branches は ON 済みのため未確認事項に含めない。）
- （`docs/deploy.md` の PM2 / Node版数の矛盾は PR #69 で整理済みのため未確認事項から外した。）
