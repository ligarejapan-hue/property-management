# 取引・帳票 第2段階 段C(準備チェックリスト)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 書類確認書の項目に「使う書類」(両方/書類確認書だけ/準備チェックリストだけ)を足し、同じ項目から「準備チェックリスト(土地建物用/マンション用)」を発行できるようにする。

**Architecture:**
- 項目は「取引の設定」の書類確認書の項目と同じ1つの表のまま使い、項目に任意の `use` を足す。`use` が無い保存済みの項目は「両方」として読む。表は変えず、JSON の中の値が1つ増えるだけ。
- 項目の取り出し(`itemsFor`・`checklistItemsOf`)に「どの書類のためか」を渡す。書類確認書と、そこから作る初期値(契約のご案内の持ち物・取引完了確認書の引き渡し書類)は、「準備チェックリストだけ」の項目を使わない。
- 準備チェックリストは、組み立て1つと一覧表の1行で足す。種類(土地建物用/マンション用)は物件の元の種別から決める。決まらなければ、発行のときに選ぶ。

**Tech Stack:** Next.js 16 / React 19 / zod 4.6 / vitest(env=node)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§2 の 4・5、§4.4、§6、§7 の 3つ目)

## Global Constraints

- 表・列は足さない(migration なし)。新しい依存も足さない。
- 保存済みの項目(`use` が無い)は「両方」として読む。保存し直さなくても今までどおり動く。
- 並び: 契約前(契約時の「事前に手配・確認するもの」)→ 契約日(契約時の「持参するもの」「受け取るもの」)→ 決済前(決済時の「事前に…」)→ 決済日(決済時の「持参するもの」「受け取るもの」)。
- 列: □(済)・項目・メモ・期日・担当。期日は、契約前・契約日なら契約日、決済前・決済日なら決済日を入れる。日付が無ければ空欄。担当は空欄で出す。
- 土地建物用は「土地のある物件だけ」の項目を入れ、マンション用は「区分だけ」の項目を入れる(今の書類確認書と同じ判定)。
- 書類確認書にある自動の行(謄本の権利の抹消の依頼など)も、同じ決まりで入れる。
- テストに実在の人の名前・住所を使わない。画面の文言は平易な日本語にする。

## Review Focus

1. 保存済みの設定(`use` が無い項目だけ)の取引。期待する動き: 書類確認書は今と同じ項目のまま。準備チェックリストにも全部出る。Task 1 で固定する。
2. 「準備チェックリストだけ」の項目は、書類確認書に出ない。契約のご案内の持ち物や、取引完了確認書の引き渡し書類の初期値にも入らない。Task 1 で固定する。
3. 物件の種別が決まっていない取引(自分で作った種別などで、元の種別が無い)。期待する動き: 出す前の確認に「物件の種別」が出る。種類を選ぶまで発行のボタンが押せない。サーバーも 422 で止める。Task 2・3 で固定する。
4. 契約日・決済日が無い。期待する動き: 期日の欄を空けて出し、落ちない。Task 2 で固定する。
5. 謄本に権利が残っている取引。期待する動き: 決済前と決済日に、抹消の自動の行が入る。Task 2 で固定する。

## 決めたこと(この計画での読み替え)

- **`use` は任意の欄にする**。初期値を付けて必須にはしない。こうすると、保存済みの JSON・初めの項目・テストの項目をそのまま使える。違っていた場合のコスト: 型を必須にして、項目を作る箇所に1語ずつ足すだけ。
- **種類の選択は、土地建物用なら「土地のある物件」、マンション用なら「区分」として項目を絞る**。取引の物件の種別とは別に、選んだ種類で決める。種別が無い取引でも出せるようにするため。
- **準備チェックリストには前回の入力を引き継がない**(remember なし)。選ぶものは種類だけで、それも物件から決まるため。

---

### Task 1: 項目に「使う書類」を足し、書類ごとに出し分ける

**Files:**
- Modify: `src/lib/deals/checklist.ts`
- Modify: `src/lib/deals/documents/business/checklist-doc.ts`(`checklistItemsOf` に出し分けを渡す)
- Modify: `src/components/deals/checklist-items-editor.tsx`(「使う書類」の選び方)
- Test: `src/lib/deals/__tests__/checklist.test.ts`(describe を足す)、`src/lib/deals/__tests__/checklist-editor-source.test.ts`(新規)

**Interfaces:**
- Produces:
  - `CHECKLIST_USES`
  - `type ChecklistUse = "both" | "checklist" | "prep"`
  - `type ChecklistDoc = "checklist" | "prep"`
  - `usedIn(i: { use?: ChecklistUse }, doc: ChecklistDoc): boolean`
  - `itemsFor(items, phase, deal, doc: ChecklistDoc = "checklist")`
  - `checklistItemsOf(phase, c, opts?: { use?: ChecklistDoc; base?: BaseKind | null })`
  - `ChecklistItem.use?: ChecklistUse`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/__tests__/checklist.test.ts` の末尾に足す(import に `CHECKLIST_USES, usedIn` を足す。`checklistItemsSchema`・`itemsFor`・`DEFAULT_CHECKLIST_ITEMS` がまだ import に無ければそれも足す):

```ts
describe("使う書類(第2段階 §4.4)", () => {
  const base = DEFAULT_CHECKLIST_ITEMS[0];
  it("保存済みの項目(use が無い)は両方として読む・知らない値は断る", () => {
    const parsed = checklistItemsSchema.parse([base]);
    expect(parsed[0].use).toBeUndefined();
    expect(usedIn(parsed[0], "checklist")).toBe(true);
    expect(usedIn(parsed[0], "prep")).toBe(true);
    expect(checklistItemsSchema.parse([{ ...base, use: "prep" }])[0].use).toBe("prep");
    expect(checklistItemsSchema.safeParse([{ ...base, use: "other" }]).success).toBe(false);
    expect(Object.keys(CHECKLIST_USES)).toEqual(["both", "checklist", "prep"]);
  });
  it("書類ごとに出し分ける(書類確認書=両方と書類確認書だけ・準備チェックリスト=両方と準備チェックリストだけ)", () => {
    const items = [
      { ...base, id: "a" }, { ...base, id: "b", use: "checklist" as const }, { ...base, id: "c", use: "prep" as const }, { ...base, id: "d", use: "both" as const },
    ];
    const deal = { base: "house" as const, hasOc: false };
    expect(itemsFor(items, base.phase, deal).map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(itemsFor(items, base.phase, deal, "checklist").map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(itemsFor(items, base.phase, deal, "prep").map((i) => i.id)).toEqual(["a", "c", "d"]);
  });
});
```

`src/lib/deals/__tests__/checklist-editor-source.test.ts`(新規):

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("書類確認書の項目の編集(第2段階 §4.4)", () => {
  it("項目ごとに「使う書類」を選べる(無い項目は両方として見せる)", () => {
    const src = read("src/components/deals/checklist-items-editor.tsx");
    expect(src).toContain('label="使う書類"');
    expect(src).toContain('value={i.use ?? "both"}');
    expect(src).toContain("optionsOf(CHECKLIST_USES)");
  });
});
```

契約のご案内・取引完了確認書の初期値が「準備チェックリストだけ」の項目を使わないことも固定する。`src/lib/deals/documents/__tests__/business-docs-contract.test.ts` の describe「取引完了確認書」の末尾に足す:

```ts
  it("「準備チェックリストだけ」の項目は、持ち物・引き渡した書類の初期値に入れない(第2段階 段C)", () => {
    const c = ctx();
    const items = c.settings.checklistItems.map((i) => (i.id === "s_recv_keys" || i.id === "c_bring_stamp" ? { ...i, use: "prep" as const } : i));
    const c2 = { ...c, settings: { ...c.settings, checklistItems: items } };
    expect(String(doc(C).defaults(c2).values.handover)).not.toContain("鍵");
    expect(String(doc(G).defaults(c2).values.belongings)).not.toContain("収入印紙");
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/__tests__/checklist.test.ts src/lib/deals/__tests__/checklist-editor-source.test.ts src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: FAIL(`usedIn`・`CHECKLIST_USES` が無い・「使う書類」が無い・「鍵」が入ったまま)

- [ ] **Step 3: 実装**

`src/lib/deals/checklist.ts`:

1. `CHECKLIST_SCOPES` の型の後ろに:
```ts
/** その項目を使う書類(設計 第2段階 §4.4)。保存済みの項目には無い=両方として読む。 */
export const CHECKLIST_USES = { both: "両方", checklist: "書類確認書だけ", prep: "準備チェックリストだけ" } as const;
export type ChecklistUse = keyof typeof CHECKLIST_USES;
/** 項目を取り出す先の書類。 */
export type ChecklistDoc = "checklist" | "prep";
export const usedIn = (i: { use?: ChecklistUse }, doc: ChecklistDoc): boolean => (i.use ?? "both") === "both" || i.use === doc;
```
2. `checklistItemSchema` の `amount: ...,` の次に:
```ts
  use: z.enum(keys(CHECKLIST_USES)).optional(),
```
3. `itemsFor` を次に替える:
```ts
/** その取引・時点・書類で出す項目(並びは保存の順のまま)。doc の初めは書類確認書。 */
export function itemsFor(
  items: ChecklistItem[], phase: ChecklistPhase, deal: { base: (typeof BASE_PROPERTY_KINDS)[number] | null; hasOc: boolean },
  doc: ChecklistDoc = "checklist",
): ChecklistItem[] {
  const ok = (s: ChecklistScope) =>
    s === "all" || (s === "unit" && deal.base === "unit") || (s === "oc" && deal.hasOc)
    || (s === "land" && (deal.base === "house" || deal.base === "land" || deal.base === "building"));
  return items.filter((i) => i.phase === phase && ok(i.scope) && usedIn(i, doc));
}
```

`src/lib/deals/documents/business/checklist-doc.ts`:

1. import に `type ChecklistDoc` を足す(`../../checklist` から)。`import type { BASE_PROPERTY_KINDS } from "../../constants";` を足す。
2. `checklistItemsOf` を次に替える(自動の行の作り方は今のまま):
```ts
/**
 * その取引で出す項目(取引の物件種別の元の種別・OC の有無・使う書類で出し分ける)。
 * 決済時は、謄本の乙区に権利が残っていれば抹消の3項目を足す(設計 §4.6.1)。持参の抹消費用は、設定にすでに抹消費用の金額付き項目があれば足さない。
 * opts.use = 取り出す先の書類(初めは書類確認書)・opts.base = 元の種別を置き換える(準備チェックリストの種類)。
 */
export function checklistItemsOf(
  phase: ChecklistPhase, c: BusinessDocContext,
  opts: { use?: ChecklistDoc; base?: (typeof BASE_PROPERTY_KINDS)[number] | null } = {},
): ChecklistItem[] {
  const base = opts.base !== undefined ? opts.base : c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  const items = itemsFor(c.settings.checklistItems, phase, { base, hasOc: c.deal.hasOc }, opts.use ?? "checklist");
  const n = c.registry?.activeRights ?? 0;
  if (phase !== "settlement" || n === 0) return items;
  return [
    ...items,
    auto("auto_cancel_request", "prepare", `司法書士への抹消の依頼(抵当権など ${n}件)`),
    ...(items.some((i) => i.amount === "cancellation") ? [] : [auto("auto_cancel_fee", "bring", "抹消費用", "cancellation")]),
    auto("auto_cancel_docs", "receive", "抵当権抹消書類(金融機関)"),
  ];
}
```

`src/components/deals/checklist-items-editor.tsx`:

1. import に `CHECKLIST_USES`・`type ChecklistUse` を足す。
2. 説明のコメントの1行目を次にする: `書類確認書の項目(取引の設定)。準備チェックリストと共通。契約時・決済時 × 3つのまとまりごとに、項目・注意事項・出す取引・使う書類・金額を直す。`
3. 行の grid を `sm:grid-cols-[2fr_2fr_1.4fr_1.2fr_1.2fr_auto]` にする。`<SelectBox label="出す取引" … />` の次に:
```tsx
                      <SelectBox label="使う書類" value={i.use ?? "both"} onChange={(v) => patch(i.id, { use: v as ChecklistUse })} options={optionsOf(CHECKLIST_USES)} />
```

`src/app/(dashboard)/admin/deal-settings/page.tsx` の見出し `書類確認書の項目` を `書類確認書・準備チェックリストの項目` にする。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals src/app && npx tsc --noEmit`
Expected: PASS・型エラー 0。見出しの文言を固定している既存のテストが落ちたら、期待値だけを新しい見出しに直す。直したものは台帳に書く。

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals src/components/deals/checklist-items-editor.tsx "src/app/(dashboard)/admin/deal-settings/page.tsx"
git commit -m "feat(deals): 書類確認書の項目に「使う書類」を足す(第2段階 段C)"
```

---

### Task 2: 準備チェックリスト(組み立て+一覧表)

**Files:**
- Create: `src/lib/deals/documents/business/prep-checklist.ts`
- Modify: `src/lib/deals/documents/registry.ts`(`checklist_settlement` の次に1行)
- Modify: `src/lib/deals/documents/issue.ts`(`DEAL_DOC_TYPES` に1行)
- Test: `src/lib/deals/documents/__tests__/business-docs-prep.test.ts`(新規)、既存の一覧の並びの期待値

**Interfaces:**
- Consumes: `checklistItemsOf(phase, c, { use, base })`(Task 1)、`ymdJa`(段A `contract-guide.ts`)
- Produces: `PREP_KINDS`、`prepChecklistOptionsSchema`(`{ kind: "land" | "unit" }`・strict)、`defaultPrepKind(c)`、`prepKindChoices()`、`prepChecklistMissing(c)`、`prepStagesOf(c, kind)`、`buildPrepChecklist(c, o)`、一覧表のキー `prep_checklist`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-prep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const deal: DealView = {
  id: "d", dealNo: "2026-0041", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: null,
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "",
  parties: [party({ id: "s", role: "seller", name: "架空 一郎<i>" }), party({ id: "b", role: "buyer", name: "架空 花子" })],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal, activeRights = 0): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: null,
  staff: { sales: "架空 営業", ops: null }, registry: { activeRights, caution: null },
});
const K = "prep_checklist";
const doc = () => businessDocOf(K)!;
const order = (h: string, words: string[]) => words.map((w) => h.indexOf(w));

describe("準備チェックリスト(第2段階 §4.4)", () => {
  it("書類確認書のまとまりの、書類確認書(決済時)の次・どの取引でも出せる", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("checklist_settlement") + 1);
    expect(doc().label).toBe("準備チェックリスト");
    expect(doc().group).toBe("checklist");
    expect(doc().applies(ctx())).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("準備チェックリスト");
  });

  it("種類の初期値は物件の元の種別から(区分=マンション用・それ以外=土地建物用・決まらなければ選ぶ)", () => {
    expect(doc().defaults(ctx()).values.kind).toBe("land");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "custom_kind" })).values.kind).toBeNull();
    expect(doc().defaults(ctx()).choices?.kind).toEqual([{ value: "land", label: "土地建物用" }, { value: "unit", label: "マンション用" }]);
    expect(doc().missing(ctx())).toEqual([]);
    expect(doc().missing(ctx({ ...deal, propertyKind: "custom_kind", contractAt: null, settlementAt: null }))).toEqual(["物件の種別", "契約日", "決済日"]);
    expect(doc().options.safeParse({ kind: null }).success).toBe(false);
    expect(doc().options.safeParse({ kind: "land", extra: 1 }).success).toBe(false);
  });

  it("並びは 契約前 → 契約日 → 決済前 → 決済日。列は 済・項目・メモ・期日・担当、期日はその時点の日付", () => {
    const h = doc().build(ctx(), { kind: "land" }).html;
    expect(h).toContain("準備チェックリスト(土地建物用)");
    const at = order(h, ["<h2>契約前</h2>", "<h2>契約日</h2>", "<h2>決済前</h2>", "<h2>決済日</h2>"]);
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).toContain("<th>済</th><th>項目</th><th>メモ</th><th>期日</th><th>担当</th>");
    expect(h).toContain("2026年5月1日");
    expect(h).toContain("2026年6月30日");
    expect(h).toContain("境界・越境の確認");
    expect(h).not.toContain("管理規約・重要事項調査報告書の取得");
    expect(h).toContain("試験ハイツ&lt;b&gt;");
    expect(h).toContain("架空 一郎&lt;i&gt;");
  });

  it("マンション用は区分だけの項目を入れ、土地のある物件だけの項目は入れない", () => {
    const h = doc().build(ctx(), { kind: "unit" }).html;
    expect(h).toContain("準備チェックリスト(マンション用)");
    expect(h).toContain("管理規約・重要事項調査報告書の取得");
    expect(h).not.toContain("境界・越境の確認");
  });

  it("使う書類で出し分ける(準備チェックリストだけ=出す・書類確認書だけ=出さない)", () => {
    const c = ctx();
    const items = c.settings.checklistItems.map((i) =>
      i.id === "c_registry" ? { ...i, use: "prep" as const } : i.id === "c_identity" ? { ...i, use: "checklist" as const } : i);
    const c2 = { ...c, settings: { ...c.settings, checklistItems: items } };
    const prep = doc().build(c2, { kind: "land" }).html;
    expect(prep).toContain("登記事項証明書・公図の取得");
    expect(prep).not.toContain("当事者の本人確認");
    const cl = businessDocOf("checklist_contract")!.build(c2, { pay: {} }).html;
    expect(cl).not.toContain("登記事項証明書・公図の取得");
    expect(cl).toContain("当事者の本人確認");
  });

  it("謄本に権利が残っていれば、抹消の自動の行も入る", () => {
    const h = doc().build(ctx(deal, 2), { kind: "land" }).html;
    expect(h).toContain("司法書士への抹消の依頼(抵当権など 2件)");
    expect(h).toContain("抵当権抹消書類(金融機関)");
  });

  it("日付が無くても落ちない(期日は空欄)・Excel の行", () => {
    const out = doc().build(ctx({ ...deal, contractAt: null, settlementAt: null }), { kind: "land" });
    expect(out.html).not.toContain("2026年5月1日");
    expect(out.rows).toContainEqual({ label: "契約前", heading: true });
    expect(out.rows).toContainEqual({ label: "境界・越境の確認", value: null });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-prep.test.ts`
Expected: FAIL(`prep_checklist` が一覧表に無い)

- [ ] **Step 3: 組み立てを書く**

`src/lib/deals/documents/business/prep-checklist.ts`:

```ts
import { z } from "zod";
import { CHECKLIST_GROUPS, type ChecklistGroup, type ChecklistItem, type ChecklistPhase } from "../../checklist";
import { html } from "../html";
import { documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { ymdJa } from "./contract-guide";
import { DASH, dateJa, headTable, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 準備チェックリストの種類(設計 第2段階 §2 の 4・5)。 */
export const PREP_KINDS = { land: "土地建物用", unit: "マンション用" } as const;
export type PrepKind = keyof typeof PREP_KINDS;
export const prepChecklistOptionsSchema = z.object({ kind: z.enum(["land", "unit"]) }).strict();
export type PrepChecklistOptions = z.output<typeof prepChecklistOptionsSchema>;

/** 種類の初期値: 元の種別が区分ならマンション用、戸建・土地・一棟なら土地建物用。決まらなければ null(発行のときに選ぶ)。 */
export function defaultPrepKind(c: BusinessDocContext): PrepKind | null {
  const base = c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  return base === "unit" ? "unit" : base ? "land" : null;
}

export const prepKindChoices = (): Choice[] => (Object.keys(PREP_KINDS) as PrepKind[]).map((k) => ({ value: k, label: PREP_KINDS[k] }));

export function prepChecklistMissing(c: BusinessDocContext): string[] {
  const out: string[] = [];
  if (!defaultPrepKind(c)) out.push("物件の種別");
  if (!c.deal.contractAt) out.push("契約日");
  if (!c.deal.settlementAt) out.push("決済日");
  return out;
}

/** 並び(設計 §4.4): 契約前 → 契約日 → 決済前 → 決済日。 */
const STAGES: { title: string; phase: ChecklistPhase; groups: ChecklistGroup[] }[] = [
  { title: "契約前", phase: "contract", groups: ["prepare"] },
  { title: "契約日", phase: "contract", groups: ["bring", "receive"] },
  { title: "決済前", phase: "settlement", groups: ["prepare"] },
  { title: "決済日", phase: "settlement", groups: ["bring", "receive"] },
];

/** 時点ごとの項目。種類で項目を絞る(土地建物用=土地のある物件・マンション用=区分)。謄本の抹消の自動の行も同じ決まりで入る。 */
export function prepStagesOf(c: BusinessDocContext, kind: PrepKind): { title: string; phase: ChecklistPhase; groups: { group: ChecklistGroup; items: ChecklistItem[] }[] }[] {
  const base = kind === "unit" ? "unit" : "house";
  return STAGES.map((s) => {
    const items = checklistItemsOf(s.phase, c, { use: "prep", base });
    return { title: s.title, phase: s.phase, groups: s.groups.map((g) => ({ group: g, items: items.filter((i) => i.group === g) })) };
  });
}

/** 準備チェックリスト(設計 第2段階 §4.4)。済・担当の欄は空欄(紙に手で書く)。 */
export function buildPrepChecklist(c: BusinessDocContext, o: PrepChecklistOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const title = `準備チェックリスト(${PREP_KINDS[o.kind]})`;
  const due: Record<ChecklistPhase, string | null> = { contract: ymdJa(d.contractAt), settlement: ymdJa(d.settlementAt) };
  const head: [string, string | null][] = [
    ["取引番号", d.dealNo], ["物件", propertyLabel(d)],
    ["売主", namesOf(partiesOf(d, "seller"))], ["買主", namesOf(partiesOf(d, "buyer"))],
    ["契約日", due.contract], ["決済日", due.settlement],
    ["営業担当", c.staff?.sales ?? null], ["業務担当", c.staff?.ops ?? null],
  ];
  const stages = prepStagesOf(c, o.kind);
  const body = html`
<h1>${title}</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable(head)}
${stages.map((s) => (s.groups.some((g) => g.items.length) ? html`<h2>${s.title}</h2>
<table><tr><th>済</th><th>項目</th><th>メモ</th><th>期日</th><th>担当</th></tr>
${s.groups.map((g) => (g.items.length ? html`${s.groups.length > 1 ? html`<tr><th colspan="5">${CHECKLIST_GROUPS[g.group]}</th></tr>` : null}
${g.items.map((i) => html`<tr><td style="text-align:center;width:10mm">□</td><td>${i.label}</td><td style="width:30%">${i.note ?? ""}</td><td style="width:22mm">${due[s.phase] ?? ""}</td><td style="width:18mm"></td></tr>`)}` : null))}
</table>` : null))}`;
  return {
    html: documentHtml({ title, body }),
    rows: [
      { label: "書類", value: title },
      ...head.map(([label, value]) => ({ label, value: value ?? DASH })),
      ...stages.flatMap((s) => [
        { label: s.title, heading: true },
        ...s.groups.flatMap((g) => g.items.map((i): ValueRow => ({ label: i.label, value: [i.note, due[s.phase]].filter(Boolean).join(" / ") || null }))),
      ]),
    ],
  };
}
```

⚠テストの「`<h2>契約前</h2>` が出る」は、その時点に項目があるときだけ成り立つ。初めの項目なら4つとも項目があるので出る。

- [ ] **Step 4: 一覧表・書類の名前**

`src/lib/deals/documents/registry.ts`:
1. import に足す:
```ts
import {
  buildPrepChecklist, defaultPrepKind, prepChecklistMissing, prepChecklistOptionsSchema, prepKindChoices,
} from "./business/prep-checklist";
```
2. `checklistDef("settlement", "checklist_settlement", "書類確認書(決済時)"),` の**次**に:
```ts
  {
    key: "prep_checklist",
    label: "準備チェックリスト",
    group: "checklist",
    applies: () => true,
    missing: (c) => prepChecklistMissing(c),
    blocking: () => [],
    options: prepChecklistOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { kind: defaultPrepKind(c) }, choices: { kind: prepKindChoices() } }),
    build: (c, o) => buildPrepChecklist(c, prepChecklistOptionsSchema.parse(o)),
  },
```

`src/lib/deals/documents/issue.ts` の `DEAL_DOC_TYPES` の書類確認書(決済時)の行の次に:
```ts
  prep_checklist: { label: "準備チェックリスト", variants: { default: "" } },
```

謄本は、発行の route では `group === "checklist"` のときに読むので、この書類でも読まれる(変更なし)。

- [ ] **Step 5: 通ることを確かめる・一覧の並びの期待値を直す**

Run: `npx vitest run src/lib/deals src/app`
Expected: 新しいテストは PASS(7 tests)。一覧の並びを固定している既存のテストが落ちたら、並びの期待値にだけ `"prep_checklist"` を `"checklist_settlement"` の次に足す。対象は `business-docs-5b.test.ts`、`documents-route.test.ts` の「出せる書類」など。挙動は直さない。書類確認書のまとまりを数えているテスト(`business-docs-5c.test.ts` など)も同じ扱いにする。直したものは台帳に書く。

- [ ] **Step 6: Commit**

```bash
git add src/lib/deals
git commit -m "feat(deals): 準備チェックリスト(土地建物用・マンション用)(第2段階 段C)"
```

---

### Task 3: 書類タブの小窓で種類を選ぶ

**Files:**
- Modify: `src/components/deals/business-docs-section.tsx`
- Test: `src/lib/deals/__tests__/business-docs-page-source.test.ts`(it を足す)

- [ ] **Step 1: 失敗するテストを書く**

`business-docs-page-source.test.ts` の describe の末尾に:

```ts
  it("準備チェックリストは種類を選ぶまで発行できない(第2段階 段C)", () => {
    const src = read(SECTION);
    expect(src).toContain('doc.docType === "prep_checklist"');
    expect(src).toContain('aria-label="準備チェックリストの種類"');
    expect(src).toContain("(choices.kind ?? [])");
    expect(src).toContain('(doc.docType === "prep_checklist" && !str(values.kind))');
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/__tests__/business-docs-page-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

`business-docs-section.tsx`:

1. `const incomplete = ...` の最後の行 `|| (doc.docType === "settlement_guide_seller" && !costRows.every(costRowOk));` を次に替える:
```ts
    || (doc.docType === "settlement_guide_seller" && !costRows.every(costRowOk))
    || (doc.docType === "prep_checklist" && !str(values.kind));
```
2. 小窓の `{doc.docType === "contract_guide" && (` の**前**に:
```tsx
        {doc.docType === "prep_checklist" && (
          <>
            <Field label="種類">
              <select aria-label="準備チェックリストの種類" value={str(values.kind)} onChange={(e) => set("kind", e.target.value || null)} className={inputCls}>
                <option value="">(選んでください)</option>
                {(choices.kind ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <p className="text-xs text-gray-500">項目は「取引の設定」の書類確認書・準備チェックリストの項目から入ります(「使う書類」で書類確認書だけにした項目は入りません)。済・担当の欄は空けて出します。</p>
          </>
        )}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/business-docs-page-source.test.ts && npx tsc --noEmit`
Expected: PASS・型エラー 0

- [ ] **Step 5: Commit**

```bash
git add src/components/deals/business-docs-section.tsx src/lib/deals/__tests__/business-docs-page-source.test.ts
git commit -m "feat(deals): 書類タブで準備チェックリストの種類を選ぶ"
```

---

### Task 4: 使い方ガイドとマニュアル・全部のゲート

**Files:**
- Modify: `public/docs/guide.html`、`public/docs/manual.html`

- [ ] **Step 1: ガイドとマニュアルを直す**

`public/docs/guide.html`:
- 「書類確認書（契約時・決済時）までです。」を「書類確認書（契約時・決済時）・準備チェックリスト（土地建物用・マンション用）までです。」にする。
- 「<li><b>売主属性調査書（社内用）</b>は、…</li>」の行の後ろに1行足す:
```html
        <li><b>準備チェックリスト</b>は、契約前→契約日→決済前→決済日の順に、やること・持ち物・受け取るものを並べます（期日に契約日・決済日が入ります）。項目は「取引の設定」の書類確認書と共通で、項目ごとに「使う書類」（両方・書類確認書だけ・準備チェックリストだけ）を選べます</li>
```

`public/docs/manual.html`:
- 675行目あたりの「書類確認書（契約時・決済時）の PDF・Excel の発行までです。」を「書類確認書（契約時・決済時）・準備チェックリストの PDF・Excel の発行までです。」にする。
- 「<li><b>売主属性調査書（社内用）</b>：…</li>」の行の後ろに1行足す:
```html
              <li><b>準備チェックリスト</b>：土地建物用（戸建・土地・一棟）とマンション用（区分）があり、物件の種別から自動で選ばれます（種別が決まらない取引では発行のときに選びます）。契約前・契約日・決済前・決済日の順に、□（済）・項目・メモ・期日・担当の表で出します。期日には契約日・決済日が入り、無ければ空欄です。項目は「取引の設定」の書類確認書の項目と共通で、項目ごとの「使う書類」で「書類確認書だけ」にした項目は入らず、「準備チェックリストだけ」にした項目は書類確認書に出ません。謄本に権利が残っていれば、抹消の依頼などの行も入ります。</li>
```

- [ ] **Step 2: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals src/components/deals "src/app/(dashboard)/admin/deal-settings/page.tsx"; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0 / eslint=0 / build=0

PC の負荷で時間切れになったテストは、落ちたファイルだけを `--maxWorkers=2 --testTimeout=120000` で回し直して確かめる。

- [ ] **Step 3: Commit**

```bash
git add public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 準備チェックリスト・使う書類をガイドとマニュアルに"
```
