# 売却DM「DMの種類」PR-S2(発送での組み付け)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 発送(キャンペーン)を作るとき、宛先ごとに「DMの種類」を決め、その種類の手紙とLPを台帳から写して組で付ける。組がずれる経路をすべて塞ぎ、発送の画面から物件単位で種類を変えられるようにする。

**Architecture:** 作成処理は既定の種類が指定されたときだけ新しい道を通る(指定なし=今までの作り方のまま)。新しい道は、所有者→物件をロックした後に物件の値を読み直し、台帳の全行を `FOR SHARE ORDER BY id` で押さえてから種類を決め、共通手順(準備の検査→写す→付けて差し込み検査)で宛先を作る。組を書き換えうる既存の経路は「種類つきの発送」なら 409 で断る。種類を変える操作は新しい route で、同じ共通手順を使い、物件の欄・版番号・編集中の鍵・変更履歴も同時に扱う。

**Tech Stack:** Next.js App Router・Prisma 7(`@/generated/prisma`)・PostgreSQL・zod・vitest・React

**Spec:** `docs/superpowers/specs/2026-09-27-sale-dm-scenarios-design.md`(本 PR = §2.3・§3.3・§3.3.0・§3.3.1・§3.4・§4 の発送側。PR-S1 は反映済み=実績151)

## Global Constraints

- **Prisma の型・値は `@/generated/prisma` から import**(`@prisma/client` は不可)。vitest は型を見ないので、各 Task のコミット前に `npx tsc --noEmit -p .` が必須。
- 「種類つきの発送」= `dm_campaigns.default_scenario_id IS NOT NULL`。判定は 1 関数 `isScenarioCampaign(campaign)` だけで行う。作成時に一度だけ立ち、後から変わらない。
- **既定の種類を送らない作成は、今までとまったく同じ行・同じ応答を作る**(既存テストがそのまま通る)。
- **組の決まり**: 種類つきの発送の宛先は、手紙の型の `scenario_id`=S のとき、LP の型は「その発送で S から写した LP の型」、S に LP の写しが無ければ NULL。単純な `scenario_id` 一致ではない。判定は `isValidScenarioPair` 1 関数。
- **ロックの全体順**: 発送の行 → 手紙の型(id順)→ LPの型(id順)→ 所有者(FOR SHARE・id順)→ 物件(id順)→ 宛先(id順)→ 台帳(`dm_scenarios`)→ 写真(`dm_lp_assets`)。宛先を物件より先に取らない。写す・読むだけの経路の台帳ロックは `FOR SHARE`、台帳の全行を 1 本の問い合わせで `ORDER BY id`。
- **ロック後に読み直す**: 種類の判定・差し込み・担当範囲に使う物件の値(`dmScenarioId`・`introductionRoute`・`address`・`propertyType`・`createdBy`・`assignedTo`)は、物件をロックした後にトランザクション内で読み直した値だけを使う。台帳の一覧もロック後に読んだものだけを使う。
- 「使わない」「削除済み」の種類はどの段でも使わない。既定の種類がロック後に無効なら作らずに 409。物件の欄が指す id が押さえた台帳に無ければ既定に落とさず 409。
- 差し込めない宛先は本文を空のまま下書きで作り、件数を返す(冪等の控え `__result` にも保存)。発送の画面は開くたびに DB から「本文が空の下書き」「LPの無い種類」を数えて表示する。
- 写した型は PATCH 不可(名前・`lpUrl`・設定)。写した型で許すのは今の凍結の決まりの範囲での文面の貼り直しと LP の写真と図の割り付けだけ。種類つきの発送では型の追加・削除・`assign`・宛先1件の `variantId` 変更を 409。
- 「種類を変える」は物件単位・送付済みが1人でもいれば 409・移動元の型を下書きに戻す前に凍結・物件の `dm_scenario_id` も同じトランザクションで書く(`version` を 1 進める・他人の編集中の鍵があれば 423・`ChangeLog` 1 行)・売却DMの書き込み権限+物件の編集権限+発送の持ち主・担当範囲はロック後に再確認。
- 操作の記録(AuditLog)は操作名・id・件数・結果だけ。文面の中身は入れない。
- 各 Task の最後にフルテスト `npx vitest run`(手元の負荷で edit-lock の走査テストが時間切れすることがある=単独で再実行して緑なら可・CI が正)。

## Review Focus

1. 既定の種類を送らない作成(今までの作り方)が1行も変わらない(Task 3)。
2. 相続2件+空き家1件+LPの無い種類が混ざる作成で、各宛先の手紙とLPが同じ種類から来ている/LPの無い種類は NULL(Task 3)。
3. 住所が読めない物件・物件種別が空の物件が混ざっても作成は成功し、その宛先は本文が空で件数に出る(Task 3)。
4. 種類つきの発送で、画面を通らずに `PATCH drafts/[id] {variantId}`・`assign`・型の追加削除・写した型の PATCH(`lpUrl` 含む)を叩いても 409(Task 4)。
5. 共有者のいる物件で「種類を変える」→全員まとめて切り替わる/1人でも送付済みなら 409/開いたままの古い物件画面の保存は 409(版番号)(Task 5)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `src/lib/sale-dm-letter/scenario-campaign.ts` | `isScenarioCampaign`・`isValidScenarioPair`・`expectedLpVariantId`(純関数) |
| `src/lib/sale-dm-letter/scenario-copy.ts` | 共通手順: `checkScenarioReady`・写す列の対応表・`copyScenarioIntoCampaign`・`expandDraftBody`・`lockAllScenariosForShare` |
| `src/lib/validators-sale-dm.ts` | 作成スキーマに `defaultScenarioId` |
| `src/app/api/properties/sale-dm/campaigns/route.ts` | 作成の種類つきの道 |
| `src/app/api/properties/sale-dm/scenarios/options/route.ts` | `ready` を足す |
| 既存の組を書き換える route 7 本 | 種類つきの発送で 409 |
| `src/app/api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario/route.ts` | 種類を変える(新設) |
| `src/lib/api-client.ts` | 型・関数 |
| `src/components/sale-dm/create-campaign-dialog.tsx` | 作成画面(新設) |
| `src/app/(dashboard)/properties/page.tsx` | 確認1回 → 作成画面 |
| `src/components/sale-dm/*`・`src/lib/sale-dm-letter/step-guide.ts`・`[campaignId]/page.tsx` | 種類つきの発送の表示 |

---

### Task 1: 作成スキーマ・選択肢の `ready`・純関数(種類つきの判定と組の決まり)

**Files:**
- Create: `src/lib/sale-dm-letter/scenario-campaign.ts`
- Modify: `src/lib/validators-sale-dm.ts:35-47`(`saleDmCampaignBodySchema`)・`src/app/api/properties/sale-dm/scenarios/options/route.ts`・`src/lib/__tests__/sale-dm-scenarios-route.test.ts`(選択肢のキー集合)
- Test: `src/lib/__tests__/sale-dm-scenario-campaign.test.ts`

**Interfaces:**
- Produces:
```ts
export function isScenarioCampaign(c: { defaultScenarioId: string | null }): boolean;
export type PairVariant = { id: string; scenarioId: string | null };
/** 種類つきの発送で、手紙の型 letter に対して期待される LP の型 id(無ければ null)。 */
export function expectedLpVariantId(letter: PairVariant, lpVariants: PairVariant[]): string | null;
/** 組の決まり(spec §3.3.0)。種類なしの発送では常に true。 */
export function isValidScenarioPair(
  campaign: { defaultScenarioId: string | null },
  letter: PairVariant,
  lpVariantId: string | null,
  lpVariants: PairVariant[],
): boolean;
```
- `saleDmCampaignBodySchema` に `defaultScenarioId: z.string().uuid().transform(s => s.toLowerCase()).nullable().optional()`(null/未指定=種類を使わない)。
- 選択肢の口: 既定の応答の各要素に `ready: boolean`(`letterBodyTemplate` が空でない)を足す。`?includeInactive=1` の応答にも足す。**文面そのものは返さない**(select で `letterBodyTemplate` を読み、`ready` に変換して落とす)。

- [ ] **Step 1: 失敗するテスト**

```ts
import { describe, it, expect } from "vitest";
import { isScenarioCampaign, expectedLpVariantId, isValidScenarioPair } from "@/lib/sale-dm-letter/scenario-campaign";

const SC = { defaultScenarioId: "inh" };
const LEGACY = { defaultScenarioId: null };
const L = (id: string, scenarioId: string | null) => ({ id, scenarioId });

describe("種類つきの発送と組の決まり(spec §3.3.0)", () => {
  it("種類つきかどうかは defaultScenarioId だけで決まる", () => {
    expect(isScenarioCampaign(SC)).toBe(true);
    expect(isScenarioCampaign(LEGACY)).toBe(false);
  });
  it("総当たり: 種類1〜3 × LPあり/なし × 付けたLP", () => {
    const kinds = ["inh", "vac", "area"];
    for (let n = 1; n <= 3; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const scen = kinds.slice(0, n);
        const lps = scen.filter((_, i) => mask & (1 << i)).map((s) => L(`lp-${s}`, s));
        for (const s of scen) {
          const letter = L(`v-${s}`, s);
          const expected = lps.some((l) => l.scenarioId === s) ? `lp-${s}` : null;
          expect(expectedLpVariantId(letter, lps)).toBe(expected);
          for (const candidate of [null, ...lps.map((l) => l.id), "lp-other"]) {
            expect(isValidScenarioPair(SC, letter, candidate, lps), `${s} ${candidate}`).toBe(candidate === expected);
          }
        }
      }
    }
  });
  it("種類なしの発送では何でも通る(今までの作り方)", () => {
    expect(isValidScenarioPair(LEGACY, L("v1", null), "lp-x", [L("lp-x", null)])).toBe(true);
  });
  it("種類つきの発送で、写していない手紙の型(scenarioId=null)は組として不正", () => {
    expect(isValidScenarioPair(SC, L("v1", null), null, [])).toBe(false);
  });
});
```

選択肢の口のテスト(`sale-dm-scenarios-route.test.ts` の既存「中身の列を返さない」テストを更新): 既定モードの各要素のキー集合が `["autoKey","id","name","ready","sortOrder"]`、`letterBodyTemplate: "本文"` の行が `ready:true`、`null` の行が `ready:false`、応答に `letterBodyTemplate` キーが無いこと。`includeInactive=1` も `ready` を含むこと。

作成スキーマのテスト(`src/lib/__tests__/validators-sale-dm*.test.ts` があれば追記、無ければ新規): `defaultScenarioId` 未指定・null・大文字 uuid(小文字化される)・非 uuid(失敗)。

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/sale-dm-scenario-campaign.test.ts`

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/scenario-campaign.ts
/**
 * 「種類つきの発送」と組の決まり(設計 2026-09-27 §3.3.0・§3.4)。純関数・DB を読まない。
 * 種類つき = default_scenario_id が入っている発送(作成時に一度だけ立ち、後から変わらない)。
 * 組の決まり: 手紙の型の scenarioId=S なら、LP は「その発送で S から写した LP の型」、無ければ NULL。
 */
export type PairVariant = { id: string; scenarioId: string | null };

export function isScenarioCampaign(c: { defaultScenarioId: string | null }): boolean {
  return c.defaultScenarioId !== null;
}

export function expectedLpVariantId(letter: PairVariant, lpVariants: PairVariant[]): string | null {
  if (letter.scenarioId === null) return null;
  return lpVariants.find((l) => l.scenarioId === letter.scenarioId)?.id ?? null;
}

export function isValidScenarioPair(
  campaign: { defaultScenarioId: string | null },
  letter: PairVariant,
  lpVariantId: string | null,
  lpVariants: PairVariant[],
): boolean {
  if (!isScenarioCampaign(campaign)) return true;
  if (letter.scenarioId === null) return false;
  return lpVariantId === expectedLpVariantId(letter, lpVariants);
}
```

`validators-sale-dm.ts` の `saleDmCampaignBodySchema` に:
```ts
  defaultScenarioId: z.string().uuid().transform((s) => s.toLowerCase()).nullable().optional(),
```
`options/route.ts` の select に `letterBodyTemplate: true` を足し、`rows.map(({ letterBodyTemplate, ...r }) => ({ ...r, ready: !!letterBodyTemplate?.trim() }))`(`includeInactive` の分岐も同様)。

- [ ] **Step 4: PASS → tsc → フルテスト → コミット** `feat(sale-dm-scenarios): 種類つきの発送の判定・組の決まり・作成スキーマ・選択肢の ready`

---

### Task 2: 共通手順(準備の検査・写す・差し込み・台帳の全行ロック)

**Files:**
- Create: `src/lib/sale-dm-letter/scenario-copy.ts`
- Test: `src/lib/__tests__/sale-dm-scenario-copy.test.ts`

**Interfaces:**
- Consumes: `expandLetterTags(text, {location, propertyType})`・`coarsePropertyLocation(address)`・`propertyTypeLabel(propertyType)`・`hasUnresolvedTag(text)`(`src/lib/sale-dm-letter/tags.ts`)・`validateLetterBody(body)`(`body-validation.ts`)
- Produces:
```ts
export type ScenarioFull = { id: string; name: string; autoKey: string | null; active: boolean; deletedAt: Date | null;
  designTemplate: string | null; tone: string | null; length: string | null; appeal: string | null; strength: string | null;
  extraInstruction: string | null; letterPromptText: string | null; letterBodyTemplate: string | null;
  lpTone: string | null; lpLength: string | null; lpAppeal: string | null; lpStrength: string | null;
  lpPromptText: string | null; lpRawTemplate: string | null; lpHeadline: string | null; lpLead: string | null;
  lpBodyText: string | null; lpFaqJson: unknown };
export type ReadyResult = { ok: true; hasLp: boolean } | { ok: false; reason: "unusable" | "letter_missing" };
export function checkScenarioReady(s: ScenarioFull): ReadyResult;
export const LETTER_COPY_MAP: ReadonlyArray<readonly [keyof ScenarioFull, string]>; // [台帳の列, DmVariant の列]
export const LP_COPY_MAP: ReadonlyArray<readonly [keyof ScenarioFull, string]>;      // [台帳の列, DmLpVariant の列]
export function letterVariantData(campaignId: string, s: ScenarioFull): Record<string, unknown>;
export function lpVariantData(campaignId: string, s: ScenarioFull): Record<string, unknown> | null; // LP 無し=null
export type ExpandResult = { body: string; blank: false } | { body: ""; blank: true };
export function expandDraftBody(template: string, property: { address: string | null; propertyType: string | null }): ExpandResult;
export async function lockAllScenariosForShare(tx: { $queryRaw: (...a: never[]) => Promise<unknown> }): Promise<void>;
export async function loadScenariosForCopy(tx: TxLike): Promise<ScenarioFull[]>; // 全行(削除済み含む)を select
export async function copyScenarioIntoCampaign(tx: TxLike, campaignId: string, s: ScenarioFull):
  Promise<{ letterVariantId: string; lpVariantId: string | null }>;
```
(`TxLike` は `Prisma.TransactionClient`=`import type { Prisma } from "@/generated/prisma"`。)

- [ ] **Step 1: 失敗するテスト**
  - `checkScenarioReady`: 使わない/削除済み→`unusable`・手紙の原文が空→`letter_missing`・手紙ありLP無し→`{ok:true,hasLp:false}`・両方→`hasLp:true`。**手紙の設定(designTemplate/tone/length/appeal/strength)のどれかが空でも `letter_missing`**(写した型の必須列が埋まらないため)。
  - **写す列の全対応**: `ScenarioFull` の手紙・LP の列すべてに既定と違う値を入れ、`letterVariantData`・`lpVariantData` の結果が対応表どおりに全部写ること。さらに「対応表に載っていない手紙・LPの列が `ScenarioFull` に無い」ことを検査する(列の足し忘れ検出):
    ```ts
    const LETTER_COLS = ["designTemplate","tone","length","appeal","strength","extraInstruction","letterPromptText","letterBodyTemplate"];
    const LP_COLS = ["lpTone","lpLength","lpAppeal","lpStrength","lpPromptText","lpRawTemplate","lpHeadline","lpLead","lpBodyText","lpFaqJson"];
    expect(LETTER_COPY_MAP.map(([k]) => k).sort()).toEqual([...LETTER_COLS].sort());
    expect(LP_COPY_MAP.map(([k]) => k).sort()).toEqual([...LP_COLS].sort());
    ```
    `letterVariantData` は `label = s.name`・`scenarioId = s.id`・`lpUrl` を含まない(=NULL)。`lpVariantData` は `lpBodyText` が空なら `null`。
  - `expandDraftBody`: 住所 null → blank / 物件種別 null で `{{物件種別}}` を含む → blank / 両方ある → 差し込まれた本文 / 差し込み後に `validateLetterBody` が不正 → blank。
  - `copyScenarioIntoCampaign`: 既に写しがある(`findFirst({campaignId, scenarioId})` が返す)→ create を呼ばず既存の id を返す / 無い → `dmVariant.create`(letterVariantData)と、LP があれば `dmLpVariant.create`+`dmLpVariantMedia.createMany`(`dmScenarioMedia` の全行を `lpVariantId` 付きで)/ LP 無し → `lpVariantId:null` で LP の create を呼ばない。
  - `lockAllScenariosForShare`: `$queryRaw` の SQL が `FROM dm_scenarios` `ORDER BY id` `FOR SHARE` を含む(WHERE 無し=全行)。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**(要点)

```ts
// src/lib/sale-dm-letter/scenario-copy.ts
/**
 * 作成と「種類を変える」が必ず通る共通手順(設計 2026-09-27 §3.3.0)。
 * 片方だけ守りが漏れないよう、準備の検査・写す・差し込み検査をここに1か所で持つ。
 */
import type { Prisma } from "@/generated/prisma";
import { expandLetterTags, coarsePropertyLocation, propertyTypeLabel, hasUnresolvedTag } from "@/lib/sale-dm-letter/tags";
import { validateLetterBody } from "@/lib/sale-dm-letter/body-validation";
type TxLike = Prisma.TransactionClient;

export const LETTER_COPY_MAP = [
  ["designTemplate", "designTemplate"], ["tone", "tone"], ["length", "length"], ["appeal", "appeal"],
  ["strength", "strength"], ["extraInstruction", "extraInstruction"],
  ["letterPromptText", "promptText"], ["letterBodyTemplate", "bodyTemplate"],
] as const;
export const LP_COPY_MAP = [
  ["lpTone", "tone"], ["lpLength", "length"], ["lpAppeal", "appeal"], ["lpStrength", "strength"],
  ["lpPromptText", "promptText"], ["lpRawTemplate", "rawTemplate"], ["lpHeadline", "headline"],
  ["lpLead", "lead"], ["lpBodyText", "bodyText"], ["lpFaqJson", "faqJson"],
] as const;

export function checkScenarioReady(s: ScenarioFull): ReadyResult {
  if (!s.active || s.deletedAt) return { ok: false, reason: "unusable" };
  const letterOk = !!s.letterBodyTemplate?.trim() && !!s.designTemplate && !!s.tone && !!s.length && !!s.appeal && !!s.strength;
  if (!letterOk) return { ok: false, reason: "letter_missing" };
  return { ok: true, hasLp: !!s.lpBodyText?.trim() && !!s.lpHeadline?.trim() };
}

export function letterVariantData(campaignId: string, s: ScenarioFull) {
  const data: Record<string, unknown> = { campaignId, label: s.name, scenarioId: s.id };
  for (const [from, to] of LETTER_COPY_MAP) data[to] = s[from];
  return data;
}
export function lpVariantData(campaignId: string, s: ScenarioFull) {
  if (!s.lpBodyText?.trim() || !s.lpHeadline?.trim()) return null;
  const data: Record<string, unknown> = { campaignId, label: s.name, scenarioId: s.id };
  for (const [from, to] of LP_COPY_MAP) data[to] = s[from];
  return data;
}

export function expandDraftBody(template: string, p: { address: string | null; propertyType: string | null }): ExpandResult {
  const expanded = expandLetterTags(template, { location: coarsePropertyLocation(p.address), propertyType: propertyTypeLabel(p.propertyType) });
  if (hasUnresolvedTag(expanded) || validateLetterBody(expanded) !== null) return { body: "", blank: true };
  return { body: expanded, blank: false };
}

export async function lockAllScenariosForShare(tx: { $queryRaw: TxLike["$queryRaw"] }) {
  // 候補を先に絞らず全行(数件)を押さえる(spec §3.3 の 2)。読む側どうしは待たない。
  await tx.$queryRaw`SELECT id FROM dm_scenarios ORDER BY id FOR SHARE`;
}

export async function copyScenarioIntoCampaign(tx: TxLike, campaignId: string, s: ScenarioFull) {
  const existing = await tx.dmVariant.findFirst({ where: { campaignId, scenarioId: s.id }, select: { id: true } });
  if (existing) {
    const lp = await tx.dmLpVariant.findFirst({ where: { campaignId, scenarioId: s.id }, select: { id: true } });
    return { letterVariantId: existing.id, lpVariantId: lp?.id ?? null };
  }
  const v = await tx.dmVariant.create({ data: letterVariantData(campaignId, s) as never, select: { id: true } });
  const lpData = lpVariantData(campaignId, s);
  if (!lpData) return { letterVariantId: v.id, lpVariantId: null };
  const lp = await tx.dmLpVariant.create({ data: lpData as never, select: { id: true } });
  const media = await tx.dmScenarioMedia.findMany({ where: { scenarioId: s.id }, orderBy: { sortOrder: "asc" } });
  if (media.length > 0) {
    await tx.dmLpVariantMedia.createMany({ data: media.map((m) => ({
      lpVariantId: lp.id, slot: m.slot, heading: m.heading, assetId: m.assetId, figureKind: m.figureKind, sortOrder: m.sortOrder,
    })) });
  }
  return { letterVariantId: v.id, lpVariantId: lp.id };
}
```
(`loadScenariosForCopy` は `tx.dmScenario.findMany({ select: { ScenarioFull の全列 } })`。`label` の長さ制約が `DmVariant` にあれば名前の上限(40字)内なので問題ないことを確認。写真の割り付けの `assetId` が削除済みの写真を指していても行は写す=公開時は既存の描画が削除済み写真を出さない(`toImage` が deletedAt を見る)。)

- [ ] **Step 4: PASS → tsc → フルテスト → コミット** `feat(sale-dm-scenarios): 共通手順(準備の検査・写す・差し込み・台帳の全行ロック)`

---

### Task 3: 作成処理の種類つきの道

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/route.ts`(:183-197 事前の物件読み・:252-272 claim・:296-422 tx・:435-439 応答・冪等の控え)
- Modify: `src/lib/__tests__/dm-writer-lock-order.test.ts:72-81`(作成の needles)・`src/lib/api-client.ts`(`CreateSaleDmCampaignBody`・戻り型・mock)
- Test: `src/lib/__tests__/sale-dm-campaigns-scenario-route.test.ts`(既存 `sale-dm-campaigns-route.test.ts` のモックを写して新設)

**Interfaces:**
- Consumes: Task 1 `isScenarioCampaign`・Task 2 すべて・PR-S1 `resolveScenario`(`scenario-resolve.ts`)
- Produces: 応答に `blankBodyCount: number`・`lpMissingScenarios: string[]`(種類名)・`scenarioCounts: Record<string, number>`(種類名→宛先数)を追加(種類なしの作成では 0/[]/{})。冪等の控え `__result` にも同じ3つ。エラー: 409 `SCENARIO_UNAVAILABLE`(既定の種類がロック後に無効)・409 `SCENARIO_NOT_READY`(`detail: { names: string[] }`=手紙の文面が未登録の種類名)・409 `PROPERTY_SCENARIO_MISSING`・409 `RECIPIENTS_CHANGED`(担当範囲の再確認で外れた)。

- [ ] **Step 1: 失敗するテスト**(ケース)
  - **既定の種類なし=今までと同じ**: 既存 `sale-dm-campaigns-route.test.ts` は無修正で緑のまま(応答に足した3キーは `toMatchObject` の既存アサーションを壊さない=壊すなら既存テストの期待値に 0/[]/{} を足す)。tx の中で `dm_scenarios` を1度も問い合わせないこと。
  - **混在**: 物件3件(受付帳取込×2・現地調査×1)・既定=相続。台帳: 相続(手紙+LP)・空き家(手紙のみ)。→ `dmVariant.create` 2回(label 相続/空き家・scenarioId 付き)・`dmLpVariant.create` 1回・宛先の `variantId/lpVariantId` が(相続の手紙,相続のLP)×2・(空き家の手紙,null)×1・応答 `lpMissingScenarios:["空き家"]`・`scenarioCounts:{相続:2,空き家:1}`。
  - **順序**: `$queryRaw`/呼び出しの順が 所有者 FOR SHARE → 物件 FOR SHARE → 物件の読み直し(`property.findMany` with `dmScenarioId,introductionRoute,address,propertyType,createdBy,assignedTo`)→ `dm_scenarios ... ORDER BY id FOR SHARE` → 台帳の読み込み。
  - **ロック後の値を使う**: 事前の読み(pre-tx)では introductionRoute=field_survey、tx 内の読み直しで dmScenarioId=相続 → 相続が付く。住所も読み直した値で差し込まれる。
  - **既定の種類がロック後に使わない** → 409 `SCENARIO_UNAVAILABLE`・宛先を1件も作らない・claim は消える(既存の catch)。
  - **手紙が未登録の種類が宛先に出る** → 409 `SCENARIO_NOT_READY`・`names` にその種類名。
  - **物件の欄が指す id が台帳に無い** → 409 `PROPERTY_SCENARIO_MISSING`。
  - **差し込めない宛先**: 住所 null の物件 → その宛先の `body:""`・`blankBodyCount:1`・作成は成功。
  - **field_staff**: tx 内の読み直しで担当外になった物件がある → 409 `RECIPIENTS_CHANGED`。
  - **冪等の再送**: `status≠draft` の既存発送の `filterSnapshot.__result` に3キーがあれば再送の応答に出る。
  - **大文字 uuid** の既定の種類は小文字で保存。
  - 監査: `sale_dm_campaign_create` の detail に `scenarioCount`(使った種類の数)と `blankBodyCount` を足し、`ACTION_EXTRA_KEYS` に登録。

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**
  1. claim の `dmCampaign.create` の data に `defaultScenarioId: body.defaultScenarioId ?? null` を足す(作成時に一度だけ立つ)。
  2. tx の中、既存の `lockOwnersForShare` → `lockPropertiesForShare` → 所有者の再確認 → 除外 の**後**で、`if (isScenarioCampaign({ defaultScenarioId }))` の分岐に入る(種類なしは既存のコードをそのまま通る=`dmVariant.create` "A" 以下を触らない)。分岐の中:
     ```ts
     const fresh = await tx.property.findMany({ where: { id: { in: survivingPropertyIds } },
       select: { id: true, address: true, propertyType: true, dmScenarioId: true, introductionRoute: true, createdBy: true, assignedTo: true } });
     if (isPropertyScopedRole(session.role) && fresh.some((p) => !canAccessPropertyRecord(session, p))) {
       throw new ApiError(409, "対象の物件が変わりました。もう一度お試しください", "RECIPIENTS_CHANGED");
     }
     await lockAllScenariosForShare(tx);
     const scenarios = await loadScenariosForCopy(tx);
     const rows = scenarios.map((s) => ({ id: s.id, name: s.name, autoKey: s.autoKey, active: s.active, deletedAt: s.deletedAt }));
     const def = scenarios.find((s) => s.id === defaultScenarioId);
     if (!def || !def.active || def.deletedAt) throw new ApiError(409, "選んだ既定の種類は使えなくなりました。選び直してください", "SCENARIO_UNAVAILABLE");
     const byProperty = new Map<string, string>();
     for (const p of fresh) {
       const r = resolveScenario({ propertyScenarioId: p.dmScenarioId, introductionRoute: p.introductionRoute, defaultScenarioId, scenarios: rows });
       if (!r.ok) throw new ApiError(409, "物件のDMの種類を確かめてください(使えない種類が指定されています)", "PROPERTY_SCENARIO_MISSING");
       byProperty.set(p.id, r.scenarioId);
     }
     const used = [...new Set(byProperty.values())].map((id) => scenarios.find((s) => s.id === id)!);
     const notReady = used.filter((s) => !checkScenarioReady(s).ok).map((s) => s.name);
     if (notReady.length) throw new ApiError(409, `手紙の文面がまだ登録されていないDMの種類があります: ${notReady.join("、")}`, "SCENARIO_NOT_READY", { names: notReady });
     const pairs = new Map<string, { letterVariantId: string; lpVariantId: string | null; template: string }>();
     for (const s of used) pairs.set(s.id, { ...(await copyScenarioIntoCampaign(tx, campaignId, s)), template: s.letterBodyTemplate! });
     ```
     (`ApiError` に detail を渡す形は既存の `ApiError` の引数を確認して合わせる。第4引数が無ければ `names` をメッセージにだけ入れ、テストはメッセージで見る。)
  3. 宛先作成のループで、種類つきなら `variantId`/`lpVariantId` を `pairs.get(byProperty.get(propertyId))` から、`body` を `expandDraftBody(template, freshById.get(propertyId))` から取り、`blank` を数える。種類なしは今のまま。
  4. `__result` と応答に `blankBodyCount`・`lpMissingScenarios`(`used` のうち LP の写しが無い種類名)・`scenarioCounts` を足す。種類なしでは 0/[]/{}。
  5. `dm-writer-lock-order.test.ts` の作成の needles に、種類つきの分岐の順を検査する describe を足す(`lockPropertiesForShare` < `lockAllScenariosForShare` < `copyScenarioIntoCampaign` < `dmRecipientDraft.create`)。既存の needles は変えない。

- [ ] **Step 4: PASS → tsc → フルテスト → コミット** `feat(sale-dm-scenarios): 発送の作成で宛先ごとに種類の手紙とLPを組で付ける`

---

### Task 4: 組を書き換える既存の経路を塞ぐ

**Files:**
- Modify(各 route の冒頭で発送の `defaultScenarioId` を読み、`isScenarioCampaign` なら 409 `SCENARIO_CAMPAIGN_LOCKED` or `SCENARIO_VARIANT_LOCKED`):
  - `src/app/api/properties/sale-dm/drafts/[id]/route.ts` PATCH(`variantId` 指定時のみ。`campaign:{select:{createdBy:true}}` に `defaultScenarioId:true` を足す)
  - `src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts` POST(全面)
  - `src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts` POST(`findUnique` の select に足す)
  - `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts` POST
  - `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts` PATCH(写した型=`scenarioId` あり)・DELETE(種類つきの発送)
  - `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts` PATCH(写した型)・DELETE(種類つきの発送=宛先を外す付け替えを伴うため)
- Create: `src/lib/sale-dm-letter/scenario-campaign-guard.ts`(`assertNotScenarioCampaign(campaign)`・`assertNotScenarioVariant(variant)` の2関数=メッセージとコードを1か所に)
- Test: `src/lib/__tests__/sale-dm-scenario-pair-guard.test.ts`(route ごとのケース+走査)

**Interfaces:**
- Produces:
```ts
export function assertNotScenarioCampaign(c: { defaultScenarioId: string | null }): void;
// 409 SCENARIO_CAMPAIGN_LOCKED「DMの種類で作った発送では、型の割り当て・追加・削除はできません。宛先の種類は「種類を変える」で切り替えてください」
export function assertNotScenarioVariant(v: { scenarioId: string | null }): void;
// 409 SCENARIO_VARIANT_LOCKED「DMの種類から写した型は変更できません。文面の手直しは貼り直しで行えます」
```

- [ ] **Step 1: 失敗するテスト**
  - 各 route について「種類つきの発送 → 409 のコード・書き込みを1回も呼ばない」「種類なしの発送 → 今までどおり(既存テストが緑)」。
  - `drafts/[id]` PATCH: `{ variantId }` は 409 / `{ body }` や `{ override }` だけなら通る(本文の手直しは許す)。
  - 写した型の PATCH: `{ label }`・`{ lpUrl }`・`{ tone }` いずれも 409(写していない型は種類つきの発送では存在しないはずだが、`scenarioId` の有無だけで判定)。
  - 文面の貼り直し(`template` PUT)・LP の写真と図(`media` PUT)・`apply` は**塞がない**(走査で「これらの route は guard を呼ばない」ことも固定しない=触らない)。
  - **走査**: 組を書き換えうる route の一覧(上の7 route)すべてのソースに `assertNotScenarioCampaign(` か `assertNotScenarioVariant(` が含まれる。`src/app/api/properties/sale-dm` 配下で `variantId:` か `lpVariantId:` を data に書く route を正規表現で拾い、一覧+Task 5 の新 route+作成 route 以外に増えたら落ちる。

- [ ] **Step 2〜4:** 実装(各 route で、既存の発送/型の読み込みの直後・トランザクションの前に guard を呼ぶ。DELETE・PATCH で型をロックしてから読んでいる route は、ロック後の読みの直後に呼ぶ)→ PASS → tsc → フルテスト → コミット `feat(sale-dm-scenarios): 種類つきの発送では型の割り当て・追加・削除・写した型の変更を断る`

---

### Task 5: 「種類を変える」(物件単位)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario/route.ts`
- Modify: `src/lib/edit-lock/__tests__/version-increment-scan.test.ts`(新 route の `property.update*` 行を `VERSIONED` に追加)・`docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md`・`src/lib/__tests__/sale-dm-lock-order-guard.test.ts`(新 describe)・`src/lib/audit-log-detail-safety.ts`
- Test: `src/lib/__tests__/sale-dm-scenario-change-route.test.ts`

**Interfaces:**
- Consumes: Task 1・Task 2・`requireSaleDmWriteAccess`・`assertSaleDmCampaignOwned`・`hasPermission(perms,"property","write")`・`lockPropertyRow`・`assertNotEditLockedByOther(tx,{resourceType:"property",resourceId,userId,screenTokenHash: readScreenTokenHash(request), lockId: readLockId(request)})`・`markVariantsFrozen`・`markLpVariantsFrozen`・`isPropertyScopedRole`・`canAccessPropertyRecord`・`lockScenarioForShare`
- Produces: `POST` body `{ scenarioId: uuid }`(小文字化)→ `{ changedDrafts: number, blankBodyCount: number, lpMissing: boolean }`。監査 `sale_dm_scenario_change`(detail `{ changedDrafts, blankBodyCount }`)。

- [ ] **Step 1: 失敗するテスト**(ケース)
  - 種類なしの発送 → 409 `SCENARIO_CAMPAIGN_REQUIRED`。
  - 他人の発送 → 404(`assertSaleDmCampaignOwned`)。物件の編集権限なし → 403。
  - 物件の宛先が0件 → 404 `NO_RECIPIENTS`。1人でも `sent` → 409 `SCENARIO_CHANGE_SENT`。
  - **順序**: 発送の行 FOR UPDATE → 今の型と移り先の型(既にあれば・id順)FOR UPDATE → 物件 `lockPropertyRow` → 編集中の鍵の判定 → 宛先 FOR UPDATE(id順)→ 担当範囲の再確認(field_staff)→ `lockScenarioForShare(移り先)`→ 有効でなければ 409 `SCENARIO_UNAVAILABLE` → 準備の検査(手紙未登録=409 `SCENARIO_NOT_READY`)→ 移動元の型を凍結(`markVariantsFrozen`/`markLpVariantsFrozen`、確定済みの宛先がいるときのみ)→ 写す(`copyScenarioIntoCampaign`)→ 宛先を全員更新(`variantId`・`lpVariantId`・`body`=差し込み・`status:"draft"`)→ 物件の `dmScenarioId`・`version: {increment:1}`(`updateMany({where:{id, version: 読んだ版}})` で 0 件なら 409 `VERSION_CONFLICT`)→ `changeLog.create`(`fieldName:"dmScenarioId"`・旧→新・`source:"manual"`)。
  - 他人が有効な編集中の鍵を持つ → 423。
  - 共有者2人 → 2人とも切り替わる。
  - 同じ種類への変更 → 何もせず `{changedDrafts:0}`(監査も書かない)。
  - 同時に2件来ても写しが1つ(2件目は `findFirst` で既存を使う=モックで確認)。
  - 差し込めない物件 → `body:""`・`blankBodyCount`。
- **走査**: `version-increment-scan` に新 route の行を登録(失敗メッセージの行番号で)。`sale-dm-lock-order-guard` に新 describe(`dm_campaigns FOR UPDATE` < `dm_variants FOR UPDATE` < `lockPropertyRow(` < `dm_recipient_drafts ... FOR UPDATE` < `lockScenarioForShare(`)。書き込み権限の走査は `requireSaleDmWriteAccess` を使うので例外登録は不要。

- [ ] **Step 2〜4:** 実装 → PASS → tsc → フルテスト(edit-lock の走査含む)→ コミット `feat(sale-dm-scenarios): 発送の画面から物件単位で種類を変える(物件の欄・版番号・履歴も同時に)`

---

### Task 6: 画面(作成画面・種類つきの発送の表示)

**Files:**
- Create: `src/components/sale-dm/create-campaign-dialog.tsx`
- Modify: `src/app/(dashboard)/properties/page.tsx:394-447`(`handleCreateSaleDm`=確認1回 → 作成画面)・`src/lib/api-client.ts`(`SaleDmCampaign.defaultScenarioId`・`SaleDmVariant.scenarioId`・`SaleDmLpVariant.scenarioId`・`changeSaleDmPropertyScenario(campaignId, propertyId, scenarioId)`・`SaleDmScenarioOption.ready`)・`src/components/sale-dm/variant-manager.tsx`・`lp-variant-manager.tsx`・`adjust-panel.tsx`・`recipient-list.tsx`・`src/lib/sale-dm-letter/step-guide.ts`・`src/lib/sale-dm-letter/list-ui.ts`(`buildSaleDmPartialNotice` に blank/LP 無しの文言)・`src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`
- Test: `src/lib/__tests__/sale-dm-scenario-campaign-ui.test.ts`(純関数+走査)

**要件**
1. **作成画面**: 物件一覧の「売却DMを作成」で開く小さな窓。
   - 「DMの種類」の選択: 選択肢の口の有効な種類(名前の後ろに未登録なら「(手紙が未登録)」)+「種類を使わない(今までどおり)」。**初期選択=`ready` の最初の種類、無ければ「種類を使わない」**。
   - 説明文: 「受付帳取込の物件は相続、現地調査の物件は空き家、それ以外はここで選んだ種類になります。物件の『DMの種類』欄で直した物件はそちらが優先です。」(種類を使わないを選んだときは「今までどおり、型Aで作ります」)
   - 「作成」で `createSaleDmCampaign({ ..., defaultScenarioId })`。名前・`options` は今の固定値のまま(種類つきの発送では `options` は使われない)。
   - 409 `SCENARIO_NOT_READY`/`SCENARIO_UNAVAILABLE`/`PROPERTY_SCENARIO_MISSING` はメッセージをそのまま出し、**管理者にだけ**「DMの種類を開く」(`/admin/dm-scenarios`)のリンク(実績144の決まり・`notice-action-links` の走査テストに従う)。
   - 作成後の案内(`buildSaleDmPartialNotice`)に「本文を差し込めなかった宛先 N件(物件の住所・種別を補ってから『差し込み』で入れ直してください)」と「LPが未登録の種類: 空き家(QRは会社のホームページへ転送されます)」を足す。
2. **種類つきの発送の画面**(`campaign.defaultScenarioId` があるとき):
   - 手紙の型・LPの型の一覧から「型を追加」「LP型を追加」「編集」「削除」「均等に割り当て」を出さない(文面の貼り直し・写真と図・プレビューは出す)。型の見出しは「DMの種類: 相続」のように種類名。
   - 宛先一覧に「種類」の列(手紙の型の label)。`adjust-panel` の宛先ごとの「型」選択の代わりに、物件ごとの「種類を変える」選択(選択肢の口・`ready` でない種類は選べない)→ `changeSaleDmPropertyScenario`。確認文「この物件の宛先(N人)の手紙とLPを切り替えます。確定済みの宛先は下書きに戻ります。物件の『DMの種類』欄も変わります。」。409/423 はメッセージをそのまま。
   - 画面上部に、DB から数えた注意: 「本文が空の下書き N件」「LPが未登録の種類: …」(0件なら出さない)。
   - `step-guide.ts`: 種類つきの発送では `add_lp`/`assign` の段を出さない(LP の無い種類があっても「割り当ててください」と案内しない)。
   - 集計の表は今のまま(型の名前=種類名で出る)。「型 空き家」の「型 」を種類つきの発送では付けない。
3. 種類なしの発送の画面は**1か所も変えない**(走査で、`defaultScenarioId` 分岐の外の既存ボタンが残っていることを固定)。

- [ ] **Step 1: 失敗するテスト**: 初期選択の純関数 `pickDefaultScenario(options)`(ready の最初/無ければ null)・`buildSaleDmPartialNotice` の新しい文言・`step-guide` の種類つきの分岐・走査(作成画面が `fetchSaleDmScenarioOptions` だけを使う/管理者だけにリンク/種類つきの分岐でボタンを隠す)。
- [ ] **Step 2〜3:** 実装。
- [ ] **Step 4: 実機確認**(自分の worktree から `npx next dev -p 3018`・`NEXTAUTH_URL=http://localhost:3018`・Playwright・turbopack):
  1. 台帳に相続(手紙+LP)・空き家(手紙のみ)を用意(ローカルDB。PR-S1 の試験データを流用)。
  2. 物件一覧で受付帳取込の物件2件+現地調査の物件1件を選び「売却DMを作成」→ 作成画面の初期選択が「相続」。
  3. 作成 → 案内に「LPが未登録の種類: 空き家」。発送の画面で宛先の種類列が 相続/相続/空き家、型の追加・割り当てボタンが無い。
  4. 相続の宛先のプレビュー/公開ページ(`/t/<token>`・送付前の帯)が相続のLP、空き家の宛先は外部LPへ転送。
  5. 空き家の物件を「種類を変える」で相続に → 宛先が相続の手紙とLPに・物件の「DMの種類」欄が相続・履歴に1行。
  6. 「種類を使わない」で作った発送が今までどおり(型A・割り当てボタンあり)。
- [ ] **Step 5:** フルテスト・tsc・`npm run build` → コミット `feat(sale-dm-scenarios): 作成画面で既定の種類を選ぶ・種類つきの発送の画面`

---

### Task 7: 仕上げ

- [ ] `npx vitest run`(フル)・`npx tsc --noEmit -p .`・`npm run build` が緑。`git diff --stat origin/main` に `Bin` 無し。
- [ ] 設計書 §2.3・§3.3・§3.3.0・§3.3.1・§3.4・§4 の各行に対応する Task があることを1行ずつ確認。
- [ ] PR 本文: 「migration なし」「種類を使わない作成は今までどおり」「実機確認の手順(Task 6 Step 4)」「反映後の実機確認項目の案(152〜)」。
