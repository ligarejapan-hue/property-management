# 取引・帳票 第2段階 段A(契約のご案内・取引完了確認書)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取引の書類タブに「契約・媒介の書類」のまとまりを足し、契約のご案内と取引完了確認書を発行できるようにし、2つの書類は前回発行したときの入力を初めの値にする。

**Architecture:** 第1段階と同じく、組み立て関数(`src/lib/deals/documents/business/*.ts`)+一覧表 `BUSINESS_DOCS` に1行ずつ。前回の入力は、発行の履歴(`DealDocument.inputSnapshot.options`)を「出せる書類」API で読み、書類の options の形で検査して通れば初めの値にする(一覧表の `remember: true` の書類だけ)。表・列は足さない。

**Tech Stack:** Next.js 16 / React 19 / Prisma 7 / zod 4.6 / vitest(env=node)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§2・§3.1・§3.2・§4.1・§4.3・§5 段A)

## Global Constraints

- 表・列は足さない(migration なし)。新しい依存も足さない。
- 書類は「組み立て1つ+一覧表に1行」で足す。発行・履歴・PDF と Excel(値だけ)の出し方は第1段階のまま。
- 一覧表の `group` に `"contract"`(契約・媒介の書類)を足し、書類タブの一番上に置く。
- 前の会社の社名・文言、リースバックの項目・語は使わない(足した文面に「インテリックス」「リースバック」が無いことをテストで守る)。
- 署名・押印の欄は空欄で出す。角印は付けない。
- テストに実在の人の名前・住所を使わない(「架空」を使う)。
- お金は整数の円。日付は日本時間。
- 返答・画面の文言は平易な日本語。

## Review Focus

1. 宛先に選んだ役割の当事者がいない(買主未登録で「買主様」を選ぶ)→ 名前の欄を空けて「様」だけにせず、空欄で出す(名前の線だけ)。Task 1 のテストで固定。
2. 契約日・決済日が無い → 日付の欄は空欄(「年 月 日」の空き)で出し、落ちない。Task 1・2 のテストで固定。
3. 前回の写しが今の形に合わない(古い版・壊れた JSON・options が無い)→ 捨てて初めの値。Task 3 のテストで固定。
4. 持ち物・引き渡した書類の欄が空(null)→ 見出しだけ出して行は無し、落ちない。Task 1・2 のテストで固定。
5. 当事者の名前に `<` などが入っている → エスケープされて出る。Task 1 のテストで固定。

## 決めたこと(この計画での読み替え)

- **前回の入力を引き継ぐのは `remember: true` の書類だけ**(段A では契約のご案内・取引完了確認書)。領収書の受領日・発行者などを前回から引き継ぐと誤りやすいため、第1段階の書類には付けない — 違っていた場合のコスト: 一覧表の1行に `remember: true` を足すだけ。
- **「入力の途中で別の画面へ移っても消さない」(設計 §3.2 の最後)は段B に回す**。段A の2つの書類は入力欄が2〜3個で、入力の多い画面(告知書など)が出る段B で共通の部品と一緒に作る — コスト: 段A の間は、ダイアログを閉じると入力が消える(今の書類と同じ)。

---

### Task 1: 契約のご案内(組み立て+一覧表+書類の名前)

**Files:**
- Create: `src/lib/deals/documents/business/contract-guide.ts`
- Modify: `src/lib/deals/documents/registry.ts`(group の型・`remember`・1行)
- Modify: `src/lib/deals/documents/issue.ts`(`DEAL_DOC_TYPES` に1行)
- Test: `src/lib/deals/documents/__tests__/business-docs-contract.test.ts`(新規)

**Interfaces:**
- Produces:
  - `contractGuideOptionsSchema`(zod: `{ addressee: "seller" | "buyer"; belongings: string | null; notes: string | null }`・strict)
  - `defaultAddressee(c: BusinessDocContext): "seller" | "buyer"`
  - `defaultContractBelongings(c: BusinessDocContext): string | null`
  - `contractGuideMissing(c: BusinessDocContext): string[]`
  - `addresseeChoices(c: BusinessDocContext): Choice[]`
  - `buildContractGuide(c, o): { html: string; rows: ValueRow[] }`
  - `ymdJa(iso: string | null): string | null`(ISO → 「2026年5月1日」日本時間。Task 2 も使う)
  - `BusinessDocDef.group` に `"contract"`、`BusinessDocDef.remember?: boolean`
  - 一覧表のキー `contract_guide`(`BUSINESS_DOCS` の先頭)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-contract.test.ts`:

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
import { contractGuideOptionsSchema } from "../business/contract-guide";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const deal: DealView = {
  id: "d", dealNo: "2026-0021", name: "試験", businessType: "resale", tradeSide: null, status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: SEAL,
  staff: { sales: "架空 営業", ops: null },
});
const doc = (key: string) => businessDocOf(key)!;
const G = "contract_guide";

describe("契約のご案内", () => {
  it("「契約・媒介の書類」の先頭に出て、どの取引でも出せる・前回の入力を引き継ぐ", () => {
    expect(BUSINESS_DOCS[0].key).toBe(G);
    expect(doc(G).label).toBe("契約のご案内");
    expect(doc(G).group).toBe("contract");
    expect(doc(G).remember).toBe(true);
    expect(doc(G).applies(ctx())).toBe(true);
    expect(dealDocumentTitle(G, "default")).toBe("契約のご案内");
  });

  it("宛先の初期値: 買主側の仲介なら買主、それ以外は売主。選べる宛先に名前が付く", () => {
    expect(doc(G).defaults(ctx()).values.addressee).toBe("seller");
    expect(doc(G).defaults(ctx({ ...deal, businessType: "brokerage", tradeSide: "buyer" })).values.addressee).toBe("buyer");
    expect(doc(G).defaults(ctx()).choices?.addressee).toEqual([
      { value: "seller", label: "売主様(架空 一郎<i>)" }, { value: "buyer", label: "買主様(架空 花子)" },
    ]);
    expect(doc(G).defaults(ctx({ ...deal, parties: [] })).choices?.addressee[1]).toEqual({ value: "buyer", label: "買主様(未入力)" });
  });

  it("お持ちいただくものの初期値は、書類確認書(契約時)の「持参するもの」", () => {
    expect(doc(G).defaults(ctx()).values.belongings).toBe(["手付金", "収入印紙", "印鑑(認印または実印)", "本人確認書類"].join("\n"));
    expect(doc(G).defaults(ctx()).values.notes).toBeNull();
  });

  it("空欄の確認: 契約日時・契約場所・宛先の当事者", () => {
    expect(doc(G).missing(ctx())).toEqual(["契約場所"]);
    expect(doc(G).missing(ctx({ ...deal, contractAt: null, contractPlace: "架空会議室", parties: [BUYER] }))).toEqual(["契約日時", "売主"]);
    expect(doc(G).blocking(ctx({ ...deal, parties: [] }))).toEqual([]);
  });

  it("組み立て: 宛先・日時・手付金・持ち物・この後の流れ・会社と担当(エスケープする)", () => {
    const out = doc(G).build(ctx(), { addressee: "seller", belongings: "実印\n印鑑証明書", notes: null });
    expect(out.html).toContain("不動産売買契約のご案内");
    expect(out.html).toContain("架空 一郎&lt;i&gt; 様");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("2,000,000円");
    expect(out.html).toContain("<li>実印</li>");
    expect(out.html).toContain("<li>印鑑証明書</li>");
    expect(out.html).toContain("2026年5月1日");
    expect(out.html).toContain("2026年6月30日");
    expect(out.html).toContain("架空不動産株式会社");
    expect(out.html).toContain("担当 架空 営業");
    expect(out.html).not.toContain("ご連絡事項");
    expect(out.html).not.toContain(SEAL);
    expect(out.rows).toContainEqual({ label: "宛先", value: "架空 一郎<i>" });
    expect(out.rows).toContainEqual({ label: "手付金", value: 2_000_000 });
    const withNotes = doc(G).build(ctx(), { addressee: "buyer", belongings: null, notes: "駐車場はありません" });
    expect(withNotes.html).toContain("架空 花子 様");
    expect(withNotes.html).toContain("ご連絡事項");
    expect(withNotes.html).toContain("駐車場はありません");
  });

  it("宛先の当事者・日付・手付金が無くても落ちない(名前と日付は空けて出す)", () => {
    const out = doc(G).build(ctx({ ...deal, parties: [], contractAt: null, settlementAt: null, deposit: null }), { addressee: "buyer", belongings: null, notes: null });
    expect(out.html).toContain('<div class="customer"> 様</div>');
    expect(out.html).toContain("決まりしだいご案内します");
    expect(out.rows).toContainEqual({ label: "宛先", value: null });
  });

  it("宛先は売主・買主だけ", () => {
    expect(contractGuideOptionsSchema.safeParse({ addressee: "agent", belongings: null, notes: null }).success).toBe(false);
    expect(contractGuideOptionsSchema.safeParse({ addressee: "seller", belongings: "x".repeat(501), notes: null }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: FAIL(`../business/contract-guide` が無い)

- [ ] **Step 3: 組み立てを書く**

`src/lib/deals/documents/business/contract-guide.ts`:

```ts
import { z } from "zod";
import { text } from "../../schema-parts";
import { jstDateString } from "../../datetime";
import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 発行のときに選ぶもの(設計 第2段階 §4.1)。 */
export const contractGuideOptionsSchema = z.object({
  addressee: z.enum(["seller", "buyer"]),
  belongings: text(500),
  notes: text(500),
}).strict();
export type ContractGuideOptions = z.output<typeof contractGuideOptionsSchema>;

const ADDRESSEE_LABELS = { seller: "売主様", buyer: "買主様" } as const;

/** ISO の日時 → 日本時間の「2026年5月1日」。無ければ null。 */
export const ymdJa = (iso: string | null): string | null => (iso ? dateJa(jstDateString(new Date(iso))) : null);

/** 宛先の初期値: 買主側の仲介なら買主、それ以外は売主。 */
export function defaultAddressee(c: BusinessDocContext): "seller" | "buyer" {
  return c.deal.tradeSide === "buyer" ? "buyer" : "seller";
}

export function addresseeChoices(c: BusinessDocContext): Choice[] {
  return (["seller", "buyer"] as const).map((r) => ({ value: r, label: `${ADDRESSEE_LABELS[r]}(${namesOf(partiesOf(c.deal, r)) ?? "未入力"})` }));
}

/** お持ちいただくものの初期値: 書類確認書(契約時)の「持参するもの」(この取引に当てはまる項目・1行に1つ)。 */
export function defaultContractBelongings(c: BusinessDocContext): string | null {
  const labels = checklistItemsOf("contract", c).filter((i) => i.group === "bring").map((i) => i.label);
  return labels.length ? labels.join("\n") : null;
}

/** 出す前の確認: 契約日時・契約場所・宛先(初期値の役割)の当事者。 */
export function contractGuideMissing(c: BusinessDocContext): string[] {
  const d = c.deal;
  const out: string[] = [];
  if (!d.contractAt) out.push("契約日時");
  if (!d.contractPlace) out.push("契約場所");
  const to = defaultAddressee(c);
  if (!partiesOf(d, to).length) out.push(to === "seller" ? "売主" : "買主");
  return out;
}

const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const LATER = "(決まりしだいご案内します)";

/** 契約のご案内(設計 第2段階 §4.1)。宛先・日時・場所・手付金・お持ちいただくもの・この後の流れ・会社と担当。 */
export function buildContractGuide(c: BusinessDocContext, o: ContractGuideOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const to = namesOf(partiesOf(d, o.addressee));
  const title = "不動産売買契約のご案内";
  const items = lines(o.belongings);
  const flow: [string, string | null][] = [
    ["売買契約のご締結(手付金の授受)", ymdJa(d.contractAt)],
    ["残代金のお支払い・お引渡し(決済)", ymdJa(d.settlementAt)],
  ];
  const staff = c.staff?.sales ?? null;
  const body = html`
<h1>${title}</h1>
<div class="meta"><div class="customer">${to ?? ""} 様</div><div class="right">${dateJa(c.today)}</div></div>
<p class="greeting">拝啓　平素は格別のお引き立てを賜り、厚く御礼申し上げます。
さて、不動産の売買契約につきまして、下記のとおりご案内申し上げます。</p>
<p class="right">敬具</p>
<p style="text-align:center">記</p>
${headTable([
  ["物件", propertyLabel(d)], ["日時", d.contractAt ? dateTimeJa(d.contractAt) : null], ["場所", d.contractPlace],
  ["手付金", d.deposit === null ? null : money(d.deposit)],
])}
<h2>お持ちいただくもの</h2>
${items.length ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : null}
<h2>この後の流れ</h2>
<table>${flow.map(([k, v]) => html`<tr><th style="width:28%">${v ?? LATER}</th><td>${k}</td></tr>`)}</table>
${o.notes ? html`<h2>ご連絡事項</h2><p class="remarks">${o.notes}</p>` : null}
<p>ご不明な点は、お気軽に担当までお問い合わせください。</p>
<p class="right">以上</p>
${companyBlock(c.company, c.logo)}
${staff ? html`<div class="right">担当 ${staff}</div>` : null}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "宛先", value: to }, { label: "物件", value: propertyLabel(d) },
      { label: "契約日時", value: d.contractAt ? dateTimeJa(d.contractAt) : null }, { label: "契約場所", value: d.contractPlace },
      { label: "手付金", value: d.deposit }, { label: "お持ちいただくもの", value: o.belongings },
      { label: "決済予定日", value: ymdJa(d.settlementAt) }, { label: "ご連絡事項", value: o.notes }, { label: "担当", value: staff },
    ],
  };
}
```

`src/lib/deals/documents/registry.ts` の変更:

1. import に足す:
```ts
import {
  addresseeChoices, buildContractGuide, contractGuideMissing, contractGuideOptionsSchema, defaultAddressee, defaultContractBelongings,
} from "./business/contract-guide";
```
2. `BusinessDocDef` の `group` と `remember`:
```ts
  /** 書類タブのまとまり(契約・媒介の書類/決済の書類/そのほかの書類/OC の書類/書類確認書)。 */
  group: "contract" | "settlement" | "other" | "oc" | "checklist";
  /** 前回発行したときの入力を、次の発行の初めの値にする(設計 第2段階 §3.2)。 */
  remember?: boolean;
```
3. `BUSINESS_DOCS` の**先頭**に足す:
```ts
  {
    key: "contract_guide",
    label: "契約のご案内",
    group: "contract",
    remember: true,
    applies: () => true,
    missing: (c) => contractGuideMissing(c),
    blocking: () => [],
    options: contractGuideOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({
      values: { addressee: defaultAddressee(c), belongings: defaultContractBelongings(c), notes: null },
      choices: { addressee: addresseeChoices(c) },
    }),
    build: (c, o) => buildContractGuide(c, contractGuideOptionsSchema.parse(o)),
  },
```

`src/lib/deals/documents/issue.ts` の `DEAL_DOC_TYPES` に足す(`settlement_statement` の行の前):
```ts
  contract_guide: { label: "契約のご案内", variants: { default: "" } },
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 既存の一覧のテストを直す**

`src/lib/deals/__tests__/documents-route.test.ts` の「出せる書類と出す前の確認」の `expect(keys).toEqual([...])` の先頭に `"contract_guide",` を足す。

Run: `npx vitest run src/lib/deals`
Expected: PASS(落ちたものがあれば、書類の並びの期待値だけを直す。挙動は直さない)

- [ ] **Step 6: Commit**

```bash
git add src/lib/deals/documents/business/contract-guide.ts src/lib/deals/documents/registry.ts src/lib/deals/documents/issue.ts src/lib/deals/documents/__tests__/business-docs-contract.test.ts src/lib/deals/__tests__/documents-route.test.ts
git commit -m "feat(deals): 契約のご案内(第2段階 段A)"
```

---

### Task 2: 取引完了確認書(組み立て+一覧表+書類の名前)

**Files:**
- Create: `src/lib/deals/documents/business/completion.ts`
- Modify: `src/lib/deals/documents/registry.ts`(`settlement_receipt` の後ろに1行)
- Modify: `src/lib/deals/documents/issue.ts`(`DEAL_DOC_TYPES` に1行)
- Test: `src/lib/deals/documents/__tests__/business-docs-contract.test.ts`(describe を足す)

**Interfaces:**
- Consumes: `ymdJa`(Task 1)、`checklistItemsOf`(既存)
- Produces: `completionOptionsSchema`(`{ handover: string | null }`・strict)、`defaultHandover(c): string | null`、`completionMissing(c): string[]`、`buildCompletion(c, o)`、一覧表のキー `completion_confirmation`

- [ ] **Step 1: 失敗するテストを書く**(`business-docs-contract.test.ts` の末尾に足す)

```ts
const C = "completion_confirmation";
const brokerDeal: DealView = {
  ...deal, businessType: "brokerage", tradeSide: "both",
  costs: { ...DEFAULT_COSTS, scrivener: { name: "架空司法書士事務所", address: null, tel: null, staff: "架空 書士" } },
};

describe("取引完了確認書", () => {
  it("決済の書類の、精算金領収書のすぐ後ろに出る・前回の入力を引き継ぐ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(C)).toBe(keys.indexOf("settlement_receipt") + 1);
    expect(doc(C).label).toBe("取引完了確認書");
    expect(doc(C).group).toBe("settlement");
    expect(doc(C).remember).toBe(true);
    expect(doc(C).applies(ctx())).toBe(true);
    expect(dealDocumentTitle(C, "default")).toBe("取引完了確認書");
  });

  it("引き渡した書類の初期値は、書類確認書(決済時)の「受け取るもの」(物件種別で出し分け)", () => {
    expect(doc(C).defaults(ctx()).values.handover).toBe(
      ["鍵", "登記識別情報(権利証)・登記に必要な書類", "残代金・精算金の領収書", "境界確認書・測量図"].join("\n"),
    );
    expect(doc(C).defaults(ctx({ ...deal, propertyKind: "unit" })).values.handover).toBe(
      ["鍵", "登記識別情報(権利証)・登記に必要な書類", "残代金・精算金の領収書", "管理規約・使用細則"].join("\n"),
    );
  });

  it("空欄の確認: 契約日・売主・買主", () => {
    expect(doc(C).missing(ctx())).toEqual([]);
    expect(doc(C).missing(ctx({ ...deal, contractAt: null, parties: [] }))).toEqual(["契約日", "売主", "買主"]);
    expect(doc(C).blocking(ctx({ ...deal, parties: [] }))).toEqual([]);
  });

  it("組み立て: 本文・当事者の署名欄・物件・引き渡した書類(□)・司法書士・仲介業者", () => {
    const out = doc(C).build(ctx(brokerDeal), { handover: "鍵\n登記識別情報" });
    expect(out.html).toContain("取引完了確認書");
    expect(out.html).toContain("2026年5月1日付で締結した下記不動産の売買契約");
    expect(out.html).toContain("残代金の授受、物件の引渡し及び所有権移転登記の申請手続きが本日完了したことを確認します");
    expect(out.html).toContain("架空 一郎&lt;i&gt;");
    expect(out.html).toContain("架空県架空市1-1");
    expect(out.html).toContain("架空 花子");
    expect(out.html).toContain("2026年6月30日");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("□ 鍵");
    expect(out.html).toContain("□ 登記識別情報");
    expect(out.html).toContain("架空司法書士事務所");
    expect(out.html).toContain("仲介業者");
    expect(out.html).toContain("架空不動産株式会社");
    expect(out.html).not.toContain(SEAL);
    expect(out.rows).toContainEqual({ label: "売主", value: "架空 一郎<i>" });
    expect(out.rows).toContainEqual({ label: "引き渡した書類など", value: "鍵\n登記識別情報" });
    // 仲介でない取引(買取再販)には仲介業者の欄を出さない
    expect(doc(C).build(ctx(), { handover: null }).html).not.toContain("仲介業者");
  });

  it("当事者・日付・引き渡した書類が無くても落ちない(空けて出す)", () => {
    const out = doc(C).build(ctx({ ...deal, parties: [], contractAt: null, settlementAt: null }), { handover: null });
    expect(out.html).toContain("年　　月　　日付で締結した");
    expect(out.html).not.toContain("□ ");
    expect(out.rows).toContainEqual({ label: "売主", value: null });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: FAIL(`completion_confirmation` が一覧表に無い)

- [ ] **Step 3: 組み立てを書く**

`src/lib/deals/documents/business/completion.ts`:

```ts
import { z } from "zod";
import { text } from "../../schema-parts";
import type { DealPartyView } from "../../view";
import { html, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { ymdJa } from "./contract-guide";
import { namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

/** 発行のときに直すもの: 引き渡した書類など(1行に1つ・設計 第2段階 §4.3)。 */
export const completionOptionsSchema = z.object({ handover: text(1000) }).strict();
export type CompletionOptions = z.output<typeof completionOptionsSchema>;

/** 初期値: 書類確認書(決済時)の「受け取るもの」(この取引に当てはまる項目)。 */
export function defaultHandover(c: BusinessDocContext): string | null {
  const labels = checklistItemsOf("settlement", c).filter((i) => i.group === "receive").map((i) => i.label);
  return labels.length ? labels.join("\n") : null;
}

export function completionMissing(c: BusinessDocContext): string[] {
  const d = c.deal;
  const out: string[] = [];
  if (!d.contractAt) out.push("契約日");
  if (!partiesOf(d, "seller").length) out.push("売主");
  if (!partiesOf(d, "buyer").length) out.push("買主");
  return out;
}

const BLANK_DATE = "　　年　　月　　日";
const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const signRow = (role: string, p: DealPartyView): SafeHtml =>
  html`<tr><th style="width:16%">${role}</th><td>住所 ${p.address ?? ""}<br>氏名 ${p.name}</td><td style="width:22mm;text-align:center;height:16mm">印</td></tr>`;
const blankSignRow = (role: string): SafeHtml =>
  html`<tr><th style="width:16%">${role}</th><td>住所<br>氏名</td><td style="width:22mm;text-align:center;height:16mm">印</td></tr>`;

/** 取引完了確認書(仲介用・設計 第2段階 §4.3)。署名・押印の欄は空欄。角印は付けない。 */
export function buildCompletion(c: BusinessDocContext, o: CompletionOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const sellers = partiesOf(d, "seller");
  const buyers = partiesOf(d, "buyer");
  const contractOn = ymdJa(d.contractAt);
  const settledOn = ymdJa(d.settlementAt);
  const items = lines(o.handover);
  const sc = d.costs.scrivener;
  const scrivener = [sc.name, sc.staff && `担当 ${sc.staff}`].filter(Boolean).join(" ") || null;
  const brokerage = d.businessType === "brokerage";
  const title = "取引完了確認書";
  const body = html`
<h1>${title}</h1>
<div class="right">${settledOn ?? BLANK_DATE}</div>
<p class="greeting">売主 ${namesOf(sellers) ?? "　　　　　　"} と買主 ${namesOf(buyers) ?? "　　　　　　"} との間で${contractOn ?? BLANK_DATE}付で締結した下記不動産の売買契約について、残代金の授受、物件の引渡し及び所有権移転登記の申請手続きが本日完了したことを確認します。</p>
<h2>対象の不動産</h2>
<table><tr><th style="width:28%">物件</th><td>${propertyLabel(d)}</td></tr></table>
<h2>引き渡した書類など</h2>
${items.length ? html`<table>${items.map((i) => html`<tr><td>□ ${i}</td></tr>`)}</table>` : null}
<h2>署名・押印</h2>
<table>
${sellers.length ? sellers.map((p) => signRow("売主", p)) : blankSignRow("売主")}
${buyers.length ? buyers.map((p) => signRow("買主", p)) : blankSignRow("買主")}
${brokerage ? html`<tr><th>仲介業者</th><td>${c.company.address ?? ""}<br>${c.company.nameJa}${c.company.license ? html`<br>${c.company.license}` : null}</td><td style="text-align:center;height:16mm">印</td></tr>` : null}
</table>
<table style="margin-top:3mm"><tr><th style="width:16%">司法書士</th><td>${scrivener ?? ""}</td></tr></table>`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "売主", value: namesOf(sellers) }, { label: "買主", value: namesOf(buyers) },
      { label: "契約日", value: contractOn }, { label: "決済日", value: settledOn }, { label: "物件", value: propertyLabel(d) },
      { label: "引き渡した書類など", value: o.handover }, { label: "司法書士", value: scrivener },
    ],
  };
}
```

`registry.ts`: import を足し、`receiptDef("settlement_receipt"),` のすぐ後ろに:
```ts
import { buildCompletion, completionMissing, completionOptionsSchema, defaultHandover } from "./business/completion";
```
```ts
  {
    key: "completion_confirmation",
    label: "取引完了確認書",
    group: "settlement",
    remember: true,
    applies: () => true,
    missing: (c) => completionMissing(c),
    blocking: () => [],
    options: completionOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: { handover: defaultHandover(c) } }),
    build: (c, o) => buildCompletion(c, completionOptionsSchema.parse(o)),
  },
```

`issue.ts` の `DEAL_DOC_TYPES` に(`settlement_receipt` の行の後ろ):
```ts
  completion_confirmation: { label: "取引完了確認書", variants: { default: "" } },
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS(12 tests)

- [ ] **Step 5: 既存の一覧のテストを直す**

`documents-route.test.ts` の同じ `toEqual([...])` の `"settlement_receipt",` の後ろに `"completion_confirmation",` を足す。

Run: `npx vitest run src/lib/deals`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/deals/documents/business/completion.ts src/lib/deals/documents/registry.ts src/lib/deals/documents/issue.ts src/lib/deals/documents/__tests__/business-docs-contract.test.ts src/lib/deals/__tests__/documents-route.test.ts
git commit -m "feat(deals): 取引完了確認書(第2段階 段A)"
```

---

### Task 3: 前回の入力を初めの値にする(出せる書類 API)

**Files:**
- Create: `src/lib/deals/documents/remember.ts`
- Modify: `src/app/api/deals/[id]/documents/available/route.ts`
- Test: `src/lib/deals/documents/__tests__/remember.test.ts`(新規)、`src/lib/deals/__tests__/documents-route.test.ts`(describe を足す・beforeEach に1行)

**Interfaces:**
- Consumes: `BusinessDocDef.remember`(Task 1)、`contract_guide`・`completion_confirmation`(Task 1・2)
- Produces: `rememberedValues(schema, defaults, snapshot): Record<string, unknown>`、`latestSnapshots(rows): Map<string, unknown>`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/remember.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { latestSnapshots, rememberedValues } from "../remember";

const schema = z.object({ a: z.enum(["x", "y"]), b: z.string().nullable() }).strict() as z.ZodType<Record<string, unknown>>;
const defaults = { a: "x", b: null };

describe("前回の入力を初めの値にする", () => {
  it("写しの options が今の形に合えば、それを初めの値にする", () => {
    expect(rememberedValues(schema, defaults, { options: { a: "y", b: "前回" } })).toEqual({ a: "y", b: "前回" });
  });
  it("合わない・無い・壊れている写しは捨てて初めの値のまま", () => {
    for (const snap of [undefined, null, "壊れた", 1, {}, { options: null }, { options: { a: "z", b: null } }, { options: { a: "x", b: null, c: 1 } }]) {
      expect(rememberedValues(schema, defaults, snap)).toBe(defaults);
    }
  });
  it("書類の種類ごとに、最初に出てきた(=いちばん新しい版の)写しだけを使う", () => {
    const m = latestSnapshots([
      { docType: "a", inputSnapshot: { options: 2 } }, { docType: "b", inputSnapshot: { options: 9 } }, { docType: "a", inputSnapshot: { options: 1 } },
    ]);
    expect(m.get("a")).toEqual({ options: 2 });
    expect(m.get("b")).toEqual({ options: 9 });
    expect(m.size).toBe(2);
  });
});
```

`documents-route.test.ts`:

1. `beforeEach` の `pm.deal.findUnique.mockResolvedValue(row);` の次の行に:
```ts
  pm.dealDocument.findMany.mockResolvedValue([]);
```
2. ファイルの末尾に:
```ts
describe("前回の入力を初めの値にする(第2段階 §3.2)", () => {
  const SELLER = { id: "33333333-3333-4333-8333-000000000011", role: "seller", partyType: "individual", name: "架空 一郎", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 };
  const docOf = (body: { documents: { docType: string; defaults: Record<string, unknown> }[] }, k: string) => body.documents.find((d) => d.docType === k)!;
  it("前に発行した入力を初めの値にする・覚える書類だけを新しい版から読む・形の合わない写しは捨てる", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, parties: [SELLER] });
    const prev = { addressee: "buyer", belongings: "前回の持ち物", notes: "前回の連絡" };
    pm.dealDocument.findMany.mockResolvedValue([
      { docType: "contract_guide", inputSnapshot: { options: prev } },
      { docType: "completion_confirmation", inputSnapshot: { options: { handover: "前回の鍵" } } },
      { docType: "contract_guide", inputSnapshot: { options: { addressee: "seller", belongings: "古い版", notes: null } } },
    ]);
    const body = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    expect(docOf(body, "contract_guide").defaults).toEqual(prev);
    expect(docOf(body, "completion_confirmation").defaults).toEqual({ handover: "前回の鍵" });
    const q = pm.dealDocument.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ dealId: DEAL_ID, docType: { in: ["contract_guide", "completion_confirmation"] } });
    expect(q.orderBy).toEqual({ version: "desc" });
    expect(q.select).toEqual({ docType: true, inputSnapshot: true });

    pm.dealDocument.findMany.mockResolvedValue([{ docType: "contract_guide", inputSnapshot: { options: { addressee: "landlord" } } }]);
    const again = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    // row は両手の仲介 → 宛先の初期値は売主
    expect(docOf(again, "contract_guide").defaults.addressee).toBe("seller");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/remember.test.ts src/lib/deals/__tests__/documents-route.test.ts`
Expected: FAIL(`../remember` が無い・初めの値が前回の入力になっていない)

- [ ] **Step 3: 実装**

`src/lib/deals/documents/remember.ts`:

```ts
import type { z } from "zod";

/**
 * 前回の発行の入力(写しの options)を、次の発行の初めの値にする(設計 第2段階 §3.2)。
 * 今の形(書類の options)で検査して通ったときだけ使う。古い版・壊れた写しは捨てて初めの値のまま。
 */
export function rememberedValues(
  schema: z.ZodType<Record<string, unknown>>, defaults: Record<string, unknown>, snapshot: unknown,
): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || !("options" in snapshot)) return defaults;
  const r = schema.safeParse((snapshot as { options: unknown }).options);
  return r.success ? r.data : defaults;
}

/** 書類の種類ごとに、いちばん新しい版の写し(rows は版の新しい順に並んでいること)。 */
export function latestSnapshots(rows: { docType: string; inputSnapshot: unknown }[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const r of rows) if (!m.has(r.docType)) m.set(r.docType, r.inputSnapshot);
  return m;
}
```

`src/app/api/deals/[id]/documents/available/route.ts`:

1. import に `import { latestSnapshots, rememberedValues } from "@/lib/deals/documents/remember";`
2. `const bctx = {...};` の後ろに:
```ts
    // 前回の入力を初めの値にする書類だけ、発行の履歴を新しい版から読む(設計 第2段階 §3.2)。
    const rememberKeys = BUSINESS_DOCS.filter((d) => d.remember).map((d) => d.key);
    const last = latestSnapshots(rememberKeys.length ? await prisma.dealDocument.findMany({
      where: { dealId: id, docType: { in: rememberKeys } }, orderBy: { version: "desc" }, select: { docType: true, inputSnapshot: true },
    }) : []);
```
3. `defaults: def.values,` を次に替える:
```ts
        defaults: d.remember ? rememberedValues(d.options, def.values, last.get(d.key)) : def.values,
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/documents/remember.ts "src/app/api/deals/[id]/documents/available/route.ts" src/lib/deals/documents/__tests__/remember.test.ts src/lib/deals/__tests__/documents-route.test.ts
git commit -m "feat(deals): 前回発行したときの入力を初めの値にする(契約のご案内・取引完了確認書)"
```

---

### Task 4: 書類タブ(まとまり「契約・媒介の書類」と入力欄)

**Files:**
- Modify: `src/components/deals/business-docs-section.tsx`(GROUPS・入力欄2つ)
- Modify: `src/lib/deals/client.ts:43`(group の型)
- Test: `src/lib/deals/__tests__/business-docs-page-source.test.ts`(it を足す・まとまりの it を直す)

**Interfaces:**
- Consumes: `contract_guide` の defaults `{ addressee, belongings, notes }` と choices `addressee`、`completion_confirmation` の defaults `{ handover }`

- [ ] **Step 1: 失敗するテストを書く**

`business-docs-page-source.test.ts` の「書類をまとまり…で分けて並べる」の it の配列の先頭に `'{ key: "contract", label: "契約・媒介の書類" }',` を足し、ファイルの describe の末尾に:

```ts
  it("契約のご案内・取引完了確認書の入力欄(第2段階 段A)", () => {
    const src = read(SECTION);
    expect(src.indexOf('{ key: "contract", label: "契約・媒介の書類" }')).toBeLessThan(src.indexOf('{ key: "settlement", label: "決済の書類" }'));
    expect(src).toContain('doc.docType === "contract_guide"');
    expect(src).toContain('aria-label="宛先"');
    expect(src).toContain("(choices.addressee ?? [])");
    expect(src).toContain('aria-label="ご連絡事項"');
    expect(src).toContain('doc.docType === "completion_confirmation"');
    expect(src).toContain('aria-label="引き渡した書類など"');
    expect(read("src/lib/deals/client.ts")).toContain('group: "contract" | "settlement" | "other" | "oc" | "checklist";');
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/__tests__/business-docs-page-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

`business-docs-section.tsx` の `GROUPS` の先頭に:
```ts
  { key: "contract", label: "契約・媒介の書類" },
```

`{doc.docType === "settlement_guide" && (` のブロックの**前**に:
```tsx
        {doc.docType === "contract_guide" && (
          <>
            <Field label="宛先">
              <select aria-label="宛先" value={str(values.addressee)} onChange={(e) => set("addressee", e.target.value)} className={inputCls}>
                {(choices.addressee ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="お持ちいただくもの(1行に1つ)">
              <textarea value={str(values.belongings)} onChange={(e) => set("belongings", e.target.value || null)} maxLength={500} rows={4} aria-label="お持ちいただくもの" className={inputCls} />
            </Field>
            <Field label="ご連絡事項(空なら載せない)">
              <textarea value={str(values.notes)} onChange={(e) => set("notes", e.target.value || null)} maxLength={500} rows={3} aria-label="ご連絡事項" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">前に発行したことがあれば、そのときの入力が初めから入っています。</p>
          </>
        )}
        {doc.docType === "completion_confirmation" && (
          <>
            <Field label="引き渡した書類など(1行に1つ・チェック欄は空けて出す)">
              <textarea value={str(values.handover)} onChange={(e) => set("handover", e.target.value || null)} maxLength={1000} rows={6} aria-label="引き渡した書類など" className={inputCls} />
            </Field>
            <p className="text-xs text-gray-500">署名・押印の欄は空けて出します。前に発行したことがあれば、そのときの入力が初めから入っています。</p>
          </>
        )}
```

`src/lib/deals/client.ts:43` の `group: "settlement" | "other" | "oc";` を:
```ts
group: "contract" | "settlement" | "other" | "oc" | "checklist";
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/business-docs-page-source.test.ts && npx tsc --noEmit`
Expected: PASS・型エラー 0

- [ ] **Step 5: Commit**

```bash
git add src/components/deals/business-docs-section.tsx src/lib/deals/client.ts src/lib/deals/__tests__/business-docs-page-source.test.ts
git commit -m "feat(deals): 書類タブに「契約・媒介の書類」と入力欄"
```

---

### Task 5: 前の会社の語の走査テスト・使い方ガイドとマニュアル

**Files:**
- Test: `src/lib/deals/documents/__tests__/business-docs-contract.test.ts`(describe を足す)
- Modify: `public/docs/guide.html:146-148`、`public/docs/manual.html`(書類の説明の箇条)

- [ ] **Step 1: 走査テストを書く**(`business-docs-contract.test.ts` の末尾。import に `readFileSync`/`join` を足す)

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("第2段階の書類の文面", () => {
  it("前の会社の名前・リースバックの語を使わない", () => {
    for (const f of ["contract-guide.ts", "completion.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/deals/documents/business", f), "utf8");
      for (const w of ["インテリックス", "リースバック", "LB"]) expect(src, `${f} に ${w}`).not.toContain(w);
    }
  });
});
```

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-contract.test.ts`
Expected: PASS(13 tests。文面に語が無いことの確認なので最初から通る。変異確認として `contract-guide.ts` のコメントに一時的に「リースバック」を足して落ちることを見てから戻す)

- [ ] **Step 2: ガイドとマニュアルを直す**

`public/docs/guide.html` 146行目の「いまは入力・計算と、資金計画表・事業計画書（PDF・Excel で発行）、」の後ろに「契約の書類（契約のご案内）、」を足し、「決済の書類（精算書・残金決済のご案内［買主様あて・売主様あて］・手付金／残金／精算金の領収書）」を「決済の書類（精算書・残金決済のご案内［買主様あて・売主様あて］・手付金／残金／精算金の領収書・取引完了確認書）」にする。148行目の「「決済の書類」「そのほかの書類」」を「「契約・媒介の書類」「決済の書類」「そのほかの書類」」にする。148行目の `</li>` の後ろに1行足す:

```html
        <li><b>契約のご案内</b>（売主様あて・買主様あて）と<b>取引完了確認書</b>は、前に発行したことがあれば、そのときの入力（宛先・お持ちいただくもの・引き渡した書類など）が初めから入っています</li>
```

`public/docs/manual.html` の675行目の「いまは入力・計算と、」の書類の並びにも同じく「契約のご案内」「取引完了確認書」を足し、「委任状」の `<li>` の**前**に2行足す:

```html
              <li><b>契約のご案内</b>：宛先（売主様・買主様）を選びます。契約の日時・場所・手付金、お持ちいただくもの（初めは書類確認書（契約時）の「持参するもの」）、この後の流れ（契約日→決済予定日）、ご連絡事項（空なら載せません）、会社名と営業担当を出します。</li>
              <li><b>取引完了確認書</b>：「残代金の授受、物件の引渡し及び所有権移転登記の申請手続きが本日完了したことを確認します」の本文に、売主・買主（全員）・契約日・物件を入れ、引き渡した書類など（初めは書類確認書（決済時）の「受け取るもの」・チェック欄は空欄）、署名・押印の欄（売主・買主・仲介の取引なら仲介業者）、司法書士の名前を出します。</li>
```

「Excel は値だけが入ります。…」の `<li>` の「発行のときに選んだもの（…）は発行の履歴に残ります。」の後ろに「契約のご案内と取引完了確認書は、次に発行するときにその入力が初めから入ります。」を足す。

- [ ] **Step 3: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals/documents src/components/deals/business-docs-section.tsx src/lib/deals/client.ts "src/app/api/deals/[id]/documents/available/route.ts"; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0(全件 pass)/ eslint=0 / build=0

- [ ] **Step 4: Commit**

```bash
git add src/lib/deals/documents/__tests__/business-docs-contract.test.ts public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 契約のご案内・取引完了確認書をガイドとマニュアルに"
```
