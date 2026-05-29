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
[12] cleanup         標準フロー（§9）       ：remote自動削除 + ローカル整理
[13] VPS反映         ユーザー明示時のみ     ：§8基準。migration/env注意
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

- **目標運用**：`PR作成 → CI green → GitHub Actions が自動で `@codex review` コメントを投稿 → Codex review 開始` の方式とする。
- **初期版（実装済み・検証中）**：`.github/workflows/codex-review-auto.yml` が、CI（name: `CI`）成功後に **`needs-codex-review` ラベル付きの非 draft PR にだけ** `@codex review` を自動投稿する（opt-in）。`skip-codex-review` ラベルがあれば投稿しない。CI green 後に **ラベル追加（`needs-codex-review`）・`skip-codex-review` 解除・draft 解除（Ready for review）・reopen** をした場合も、**現在の head SHA に対する CI 成功を確認**してから自動依頼する。`github-actions[bot]` のコメントに **Codex が反応するかを、この初期版で検証**する段階である。
- 反応が確認できたら、**default-on + `skip-codex-review`（opt-out）方式へ拡張**する。
- Codex automatic reviews が ON かは引き続き未確認であり、**前提にしない**。
- **暫定運用**：上記の対象外（ラベル未付与など）で必要なPRでは、**ユーザーが手動で `@codex review` を実行**する。
- DB / migration / PII / GPS / AuditLog / 権限 / import / rollback / upload-storage / security 系は Codex review **必須級または強く推奨**。
- docs-only / typo / UI文言などは Codex review **不要でもよい**。
- ただし docs でも、**VPS手順・開発フロー・セキュリティ運用に関わる変更は Codex review 推奨**。
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
| スマホでできる | Issue起票（テンプレ利用）、`@claude`/`@codex`コメント、PR/diff/compare閲覧、CI結果(green/red)確認、進捗チャット報告 |
| やってよい軽作業 | docs/typo/文言修正の `@claude` 依頼、Plan内容の承認/差し戻し、Codex指摘の確認 |
| 避けること | merge最終確定（差分を精査できない時）、VPS操作全般、migration含むPRのmerge、env変更を伴う反映、複数並列タスクの起動 |
| 帰宅後PCでやる | 差分の精読、本体コードレビュー、migration/env絡みのmerge、VPS反映、ビルド再現確認、cleanup |

`@claude` / `@codex` を使う時の注意

1. 作業前に `CLAUDE.md` / `AGENTS.md` 参照前提を必ず添える。
2. `@claude` はpush可能だが merge/VPS はしない前提を明記する。
3. スマホ起票でも「禁止事項」「変更してよい範囲」を省略しない。
4. CI red のまま放置merge依頼をしない。

---

## 10. テンプレート集

PR本文は既存の `.github/PULL_REQUEST_TEMPLATE.md` を使う（本書では再定義しない）。

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
タスク：
状態：Plan待ち/実装中/PR作成済み/CI green/Codex待ち/merge済み/cleanup済み/VPS反映済み
PR・compare URL：
CI：green/red（redなら原因）
Codex：未/指摘なし/Blocker有(対応中)
VPS：未反映/反映済み(hash)
残課題・次アクション：
```

---

## 11. 未確認事項

- **`github-actions[bot]` が投稿した `@codex review` コメントに Codex が反応するかは未確認**。これを検証するため、初期版の自動投稿 workflow（`.github/workflows/codex-review-auto.yml`）は **opt-in（`needs-codex-review` ラベル）** に限定している（§5 参照）。
- Codex automatic reviews が ON かは未確認であり、**前提にしない**。
- 反応未確認の段階では、対象外の必要なPRは **手動 `@codex review` を併用**する。
- （default-on + `skip-codex-review` への拡張は、bot コメントへの反応確認後に行う。）
- （GitHub の Automatically delete head branches は ON 済みのため未確認事項に含めない。）
- （`docs/deploy.md` の PM2 / Node版数の矛盾は PR #69 で整理済みのため未確認事項から外した。）
