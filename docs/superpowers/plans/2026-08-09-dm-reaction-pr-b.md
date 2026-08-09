# DM送付管理 PR-B(反響の記録) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 送付記録(PropertyDmLog)に反響4種(no_response/replied/refused/undeliverable)を記録できるようにし、売却DMの反響(LPアクセス・返戻)を自動同期する。拒否・宛先不明は所有者横断の除外材料になる(PR-Cの再送候補の土台)。

**Architecture:** 正本=設計書 `docs/superpowers/specs/2026-08-08-dm-sending-management-design.md` §3(@codex 53巡クリーン・発注者承認済み)。migration-B(additive・列追加のみ)。反響の優先規則とブリッジ同期は共通ヘルパー1本に集約し、outcome route と公開LP追跡(recordTrackingHit)の両方から呼ぶ。terminal(refused/undeliverable)を書く全writerはOwner先頭FOR UPDATE(PR-Aの locks.ts を再利用)。

**Tech Stack:** PR-Aで導入済みの `src/lib/dm-batch/locks.ts`(lockOwnersForUpdate等)・`eligibility.ts`(検査(2)の追加先)・`dm-method-labels.ts` を再利用。

## Global Constraints

- PR順序 A→B→C→D。本計画はPR-B。再送候補述語(検査(5))はPR-C。
- 反響allowlist=TEXT+アプリ側(enum新設禁止)。`no_response / replied / refused / undeliverable`。terminal=`refused|undeliverable`。
- 反響優先規則(設計§3): **同期undeliverable ≧ 手動terminal > 手動replied > 同期replied > no_response**。手動値を同期が上書きするときのみ `manual_reaction_shadow`(JSONB全量=status/reactedAt/note)へ退避、訂正の戻しで復元(source=manual)・shadowなければno_response。ブリッジ行への手動保存は値を問わず保存直後に共通ヘルパーで再導出。
- terminal を書く全writerは対象所有者集合(代表+連関全員)を安定id順に FOR UPDATE してから親行→子行(R47)。非terminal(replied/no_response・LP追跡)はOwnerロック不要(ホットパス維持)・ただし親の物件行ロック規約には従う(R50)。
- 1タスク=TDD。「緑」前にフル `npx vitest run`。全ゲート=tsc/vitest/eslint/build。提出前に全変更ファイルのNULバイトスキャン(既知の罠)。
- 監査detailにPIIなし・新actionは `ACTION_EXTRA_KEYS` 登録必須。コミット末尾はco-author+セッション行。

---

### Task 1: migration-B(反響列+shadow+索引)

**Files:**
- Modify: `prisma/schema.prisma`(PropertyDmLog)
- Create: `prisma/migrations/20260809090000_add_dm_reaction_columns/migration.sql`
- Test: `src/lib/__tests__/dm-reaction-migration-source.test.ts`

**Interfaces:**
- Produces: `PropertyDmLog.reactionStatus String @default("no_response")` / `reactedAt DateTime?` / `reactionNote String?` / `reactionSource String?`("manual"|"sale_dm_sync") / `manualReactionShadow Json?` + `@@index([reactionStatus])`

- [ ] **Step 1: 配線テスト(RED)** — SQLが additive のみ(`DROP`/`CREATE TYPE`なし)・`reaction_status TEXT NOT NULL DEFAULT 'no_response'`・`manual_reaction_shadow JSONB`・`CREATE INDEX "property_dm_logs_reaction_status_idx"` を正規表現でピン(PR-Aの dm-batch-migration-source.test.ts と同型)。
- [ ] **Step 2: schema.prisma へ5列+索引を追加**(コメント: 反響4種はTEXT+allowlist・shadowは手動値の全量退避=R44)。
- [ ] **Step 3: migration.sql 手書き**(先頭に業務意図コメント。列追加5+索引1のみ):

```sql
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_status" TEXT NOT NULL DEFAULT 'no_response';
ALTER TABLE "property_dm_logs" ADD COLUMN "reacted_at" TIMESTAMP(3);
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_note" TEXT;
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_source" TEXT;
ALTER TABLE "property_dm_logs" ADD COLUMN "manual_reaction_shadow" JSONB;
CREATE INDEX "property_dm_logs_reaction_status_idx" ON "property_dm_logs"("reaction_status");
```

- [ ] **Step 4: `npx prisma generate` → テストPASS → tsc → フルvitest → Commit** `feat(dm): 反響列の追加(migration-B)`

---

### Task 2: 反響の中核lib(allowlist・優先規則・shadow)

**Files:**
- Create: `src/lib/dm-reaction/core.ts`
- Test: `src/lib/dm-reaction/__tests__/core.test.ts`

**Interfaces(Produces):**

```ts
export const REACTION_STATUSES = ["no_response", "replied", "refused", "undeliverable"] as const;
export type ReactionStatus = (typeof REACTION_STATUSES)[number];
export const TERMINAL_REACTIONS: ReadonlySet<string>; // refused|undeliverable
export const REACTION_LABELS: Readonly<Record<ReactionStatus, string>>;
  // no_response:"反応なし" replied:"連絡あり" refused:"拒否" undeliverable:"宛先不明"
export function isTerminalReaction(status: string | null | undefined): boolean;

export interface ReactionFields {
  reactionStatus: string; reactedAt: Date | null; reactionNote: string | null;
  reactionSource: string | null; manualReactionShadow: unknown;
}
/** 同期イベント(replied|undeliverable|none)を現在値に適用した次状態を返す純関数。
 *  優先規則(§3)+shadowライフサイクル(手動上書き時のみ退避・訂正戻しで復元・消費)を実装。 */
export function applySyncReaction(
  current: ReactionFields,
  sync: { kind: "replied" | "undeliverable" | "cleared"; at: Date },
): ReactionFields;
/** 手動保存を適用(常に受理・source="manual"・shadowクリア)。 */
export function applyManualReaction(
  current: ReactionFields,
  manual: { status: ReactionStatus; reactedAt: Date | null; note: string | null },
): ReactionFields;
```

- [ ] **Step 1: RED** — テスト観点: (a)同期undeliverableは手動repliedを上書きし**shadowへ全量退避** (b)訂正(cleared)でshadow復元(source=manual)・shadow消費 (c)shadowなしのclearedはno_response (d)手動terminalは同期repliedに勝つ=同期repliedが手動refusedを上書きしない (e)手動保存は常に受理されshadowクリア (f)同期undeliverable≧手動terminal=同期undeliverableは手動refusedも上書き(退避あり)。
- [ ] **Step 2: 実装 → GREEN → Commit** `feat(dm): 反響の優先規則とshadowライフサイクル(純関数)`

---

### Task 3: 手動反響PATCH(+dmUndeliverableAt連動)

**Files:**
- Create: `src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`(`dm_reaction_update: new Set(["logId","status","reactedAt"])`)
- Test: `src/lib/__tests__/dm-reaction-patch-route.test.ts`

**要点(設計§3):**
- `PATCH` body=`{ status, reactedAt?: "YYYY-MM-DD", note?: string(max500) }`(zodでallowlist・実在日は `isRealCalendarDate` 再利用)。
- ゲート: property:write + `assertPropertyRecordAccess` + tx冒頭 `lockPropertyRecordForWrite`。**terminal を書くときは先に対象所有者集合(log.ownerId+logOwners全員)を `lockOwnersForUpdate`(Owner→親→子=R47)**。
- 適用は `applyManualReaction`。**ブリッジ行(draftId非null)は保存直後に同一txで `syncSaleDmReaction`(Task 4)を呼び再導出**(手動no_responseで消しても draft側に証拠があれば戻る=R32/R40)。draft_id=null の旧sale_dm行は「propertyId+JST送付日の保守的フォールバック」を再適用(Task 6の照合ヘルパーを共用)。
- **undeliverable連動**(汎用側に複製): 手動undeliverable→`property.dmStatus="no_send"+dmUndeliverableAt=now`(親行ロック保持中)。undeliverableから他状態へ訂正→残数(undeliverableな汎用ログ+returned_undeliverableなsentドラフト)ゼロなら `dmUndeliverableAt=null`(dmStatusは人が戻す=既存clear-dm-undeliverableと同方針)。
- 監査 `dm_reaction_update`{logId,status,reactedAt}(note非掲載)。

- [ ] **Step 1: RED**(403 fail-closed/422 allowlist外・実在しない日付/terminalのOwnerロック順(SQL捕捉)/undeliverable連動と訂正解除/ブリッジ行の即時再導出呼び出し/監査キーsanitize素通り)
- [ ] **Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 反響の手動記録(4種・宛先不明の物件連動つき)`

---

### Task 4: 売却DM同期ヘルパー(outcome route+LP追跡の両輪)

**Files:**
- Create: `src/lib/dm-reaction/sync.ts`
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts`
- Modify: `src/lib/sale-dm-letter/tracking-record.ts` と `src/app/t/[token]/route.ts`
- Test: `src/lib/dm-reaction/__tests__/sync.test.ts` + 既存 outcome/tracking テスト更新

**Interfaces(Produces):**

```ts
/** draft の現在値からブリッジ行(draft_id一致の全ログ)へ反響を同期する。
 *  tx 内から呼ぶ。呼び出し元が親の物件行ロックを取得済みであること(規約コメントで明記)。
 *  terminal(undeliverable)を書き込む場合は内部で lockOwnersForUpdate(対象ログの
 *  代表+連関全員)を先に取る(R47)。derive: returned_undeliverable→undeliverable /
 *  outcome=inquiry(LP・電話)→replied / どちらでもない→cleared。 */
export async function syncSaleDmReaction(tx: TxLike, draftId: string): Promise<void>;
```

- **outcome route**: 既存txの draft 更新後(既に親行FOR UPDATEを取る分岐あり。取らない分岐にも `lockPropertyRow` を追加してから)`syncSaleDmReaction(tx, id)` を呼ぶ。
- **recordTrackingHit**: 現在は素の `prisma` 直書き。`$transaction` 化し `lockPropertyRow(tx, draft.propertyId)`→draft更新→`syncSaleDmReaction`(repliedのみ=Ownerロック不要のホットパス)。/t/ route の best-effort try/catch は維持(追跡失敗でもLPへは飛ばす)。
- ⚠Ownerロック順: sync内でterminalを書くときは「Owner→(親=取得済み)→子」の順が崩れる(親を先に取ってしまっている)…設計R47の順序は Owner→親→子。**outcome route側で returned_undeliverable を書く分岐に入る前に、draftの所有者集合を lockOwnersForUpdate してから親行を取る**構成に改める(mark-sentと同じ「先読み→Owner→親→子」の型)。tracking(非terminal)は親→子のままでよい。

- [ ] **Step 1: RED**(sync純化部分はcoreで担保済み。ここは配線: outcomeのundeliverable→ブリッジ行がundeliverableになりshadow退避/訂正→復元/trackingヒット→replied/draft_idなし=何もしない/ロック順序SQL捕捉)
- [ ] **Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 売却DM反響の自動同期(返戻・LPアクセス→送付記録へ)`

---

### Task 5: DL資格検査(2)の有効化+個別取消の再計算

**Files:**
- Modify: `src/lib/dm-batch/eligibility.ts`(+呼び出し元2route)
- Modify: `src/app/api/properties/[id]/dm-logs/[logId]/route.ts`(DELETE)
- Test: `eligibility.test.ts` 拡張+`dm-batch-csv-route.test.ts` 拡張+`dm-log-record-route.test.ts` 拡張

**要点:**
- `checkBatchEligibility(items, properties, session, terminalOwnerIds: Set<string>)` に第4引数を追加(設計§2.1(2))。item の group owner が1人でも terminalOwnerIds に含まれれば `terminalReactionCount`++ → 両GET経路で409(再出力案内)。csv route側で `propertyDmLog.findMany({ where: { reactionStatus: { in: ["refused","undeliverable"] }, OR: [{ ownerId: { in: allOwnerIds } }, { logOwners: { some: { ownerId: { in: allOwnerIds } } } }] }, select: { ownerId: true, logOwners: { select: { ownerId: true } } } })` から集合を構築(Owner FOR SHARE保持中=R47の直列化が効く)。
- 個別取消DELETE: PR-Aで予告済みの再計算を実装(undeliverable反響付き行の削除時、親行ロック保持のまま残数→ゼロなら `dmUndeliverableAt=null`)。

- [ ] **Step 1: RED → Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 拒否・宛先不明の宛先を控えDLで検出(検査(2))+取消時の再計算`

---

### Task 6: 照合(reconciliation)スクリプト+旧行フォールバック

**Files:**
- Create: `src/lib/dm-reaction/reconcile.ts`(コア・テスト可能)
- Create: `scripts/reconcile-sale-dm-reactions.mjs`(実行ラッパ・DB接続はapp.env前提)
- Test: `src/lib/dm-reaction/__tests__/reconcile.test.ts`

**要点(設計§3・冪等・稼働後に実行):**
- 全 method="sale_dm" 行を対象: draft_id あり→`syncSaleDmReaction` 同等の導出で更新。draft_id なし→propertyId+**JST暦日**(sentAt(UTC00:00=JST暦日) vs draft.sentAt+9hの暦日)で対応付け、一意なら `draft_id` を書き込んで永続化(R16)+同期。曖昧(同日複数)は「反響あり側に倒す」=該当draftsにinquiry/returned_undeliverableが1つでもあれば保守的に付与(格下げなし=R4)。
- `reconcileSaleDmReactions(prisma, { dryRun })` は件数レポート(matched/linked/ambiguousConservative/skipped)を返す。深夜境界(JST 0-9時確定)のテストを含める(R37)。
- 手動PATCH(Task 3)の旧行フォールバックはこのコアの単一行版を共用。
- runbook: 本番反映後に `node scripts/reconcile-sale-dm-reactions.mjs`(root・app.env source済みで)を1回実行(冪等なので再実行可)。vps-deploy-notes へ記録。

- [ ] **Step 1: RED → Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 旧sale_dm行の反響照合(冪等・JST暦日対応付け)`

---

### Task 7: 孤児記録の管理(admin専用)

**Files:**
- Create: `src/app/api/admin/orphan-dm-logs/route.ts`(GET 検索)
- Create: `src/app/api/admin/orphan-dm-logs/[logId]/route.ts`(PATCH 反響訂正/DELETE 取消)
- Create: `src/app/(dashboard)/admin/orphan-dm-logs/page.tsx`(小さな管理ページ)
- Test: `src/lib/__tests__/orphan-dm-logs-route.test.ts`+UI配線テスト

**要点(設計§2.4・R51):**
- 対象=`propertyId: null` の行のみ(それ以外404)。admin のみ(session.role==="admin"・既存admin routeの慣例をgrepで確認して同型に)。
- GET: 所有者名で検索(owner join・owner:read+表示レベルでマスク=既存一覧APIの慣例)・ページング。
- PATCH: Task 3 と同じ検証+`applyManualReaction`。terminal を書くときは Owner 先頭 FOR UPDATE(親行ロックは親が無いので無し)。物件連動なし(物件が無い)。監査は `dm_reaction_update`+detail `orphan:true`("orphan" を ACTION_EXTRA_KEYS に追記)。
- DELETE: 監査 `dm_sent_record_delete`+`orphan:true`。batchId/sale_dm 由来でも孤児は削除可(復元経路が他に無いため。設計の「訂正経路を必ず用意」が優先)。
- サイドバー/管理メニューへの導線は既存 admin ページ群の配置に合わせて1リンク追加。

- [ ] **Step 1: RED → Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 物件削除で孤児化した送付記録の訂正・取消(admin)`

---

### Task 8: UI(送付履歴に反響列+編集)

**Files:**
- Modify: `src/app/api/properties/[id]/dm-logs/route.ts`(GETに反響4項目を追加・noteと同様reactionNoteはowner_noteレベルでマスク)
- Modify: `src/components/properties/dm-logs-view.tsx`
- Modify: `src/lib/dm-method-labels.ts`(REACTION_LABELS再export or 参照)
- Test: 既存2テスト拡張+UI配線テスト

**要点:**
- 履歴テーブルに「反響」列(ラベル+色: 連絡あり=緑/拒否・宛先不明=赤/反応なし=灰)。write権限があれば行から反響編集(セレクト+日付+メモのインライン小フォーム→ Task 3のPATCH)。ブリッジ行(sale_dm)も編集可(同期と優先規則はサーバが解決)。
- 「宛先不明にすると送付先から外れます」等の平易な説明文。

- [ ] **Step 1: RED → Step 2: 実装 → GREEN → フルvitest → Commit** `feat(dm): 送付履歴の反響表示と入力`

---

### Task 9: 横断テスト+全ゲート+提出

- [ ] ロック順序の横断ソーステスト拡張(`dm-writer-lock-order.test.ts`): 反響PATCH(terminal時Owner→親→子)・outcome同期(Owner→親→子)・orphan PATCH(Owner先頭)。
- [ ] NULバイトスキャン(全変更ファイル)・`git diff --stat` の Bin 確認。
- [ ] tsc / フルvitest / eslint(変更ファイル・ベースライン比較) / build。
- [ ] 提出前レビュー(feature-dev:code-reviewer): ホットスポット=(a)優先規則とshadowの正しさ (b)terminal Owner ロック順 (c)undeliverable連動の複製と既存clear経路の整合 (d)照合の冪等性とJST境界 (e)orphan管理の認可 (f)監査キー。
- [ ] PR作成(平易な日本語・migration明記)→`@codex review`→codex-triageで収束→**マージはユーザー**。

## Self-Review(執筆時実施済み)
- 設計§3全要素との突き合わせ: 4種+extensible=Task1-2 / 手動PATCH+連動=Task3 / 同期ヘルパー両輪+ロック=Task4 / 検査(2)+個別取消再計算=Task5 / 照合+旧行フォールバック=Task6 / orphan管理=Task7 / 表示=Task8 / 監査(dm_reaction_update+orphan)=Task3・7。
- PR-C持ち越し: 検査(5)候補述語・resendFilterApplied設定・候補一覧UI・COOLDOWN_DAYS env。
