# 取引・帳票 第2段階 段B(項目の表の部品・売主属性調査書・入力を消さない)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1つの「項目の表」から入力画面と PDF の両方を作る共通の部品を作る。その部品で売主属性調査書(社内用)を出せるようにする。書類の発行の小窓では、入力の途中で別の画面へ移っても入力を消さない。

**Architecture:**
- 項目の表(`src/lib/deals/documents/forms/`)は、ただのデータにする。そこから次の3つを作る。
  - 値の形(zod)
  - PDF の表(□/■)
  - Excel の行
- 一覧表の行に `form` を持たせる。出せる書類の API は `form` をそのまま画面へ渡し、画面は共通の部品 `DocFormFields` で描く。
- 入力の控えは、今ある仕組み(`useRestoredDraft`/`useDraftAutosave`・sessionStorage)に、新しい画面の名前 `deal-document` を足して乗せる。
- 表・列は足さない。

**Tech Stack:** Next.js 16 / React 19 / Prisma 7 / zod 4.6 / vitest(env=node・画面は `renderToStaticMarkup` とソースの文字列で試す)

**Spec:** `docs/superpowers/specs/2026-10-27-deals-documents-phase2-design.md`(§3.2 の最後・§3.3・§3.5・§4.2・§5 段B)

## Global Constraints

- 表・列は足さない(migration なし)。新しい依存も足さない。
- 書類は「組み立て1つ+一覧表に1行」で足す。発行・履歴・PDF と Excel(値だけ)の出し方は第1段階のまま。
- **何も選ばなかった項目は、選択肢を □ で並べた空欄で出す。選んだ項目は ■ で印字する。書き込み欄が空なら下線の空欄で出す**(設計 §3.3)。
- 入力画面の一番上に「すべて空欄に戻す」を置く(設計 §3.3)。
- 売主属性調査書は、書類の名前に「社内用」を付ける(設計 §3.5)。
- 前の会社の書式にあった「取引先マスタ」「リースバック」の項目は入れない(設計 §4.2)。足した文面に「インテリックス」「リースバック」「取引先マスタ」が無いことを、走査テストで守る。
- 控えは sessionStorage だけ。localStorage・IndexedDB は使わない。控えの中身をログに出さない(今の仕組みのまま)。
- テストに実在の人の名前・住所を使わない(「架空」を使う)。
- 返答・画面の文言は平易な日本語。

## Review Focus

1. 前の版の項目の表で保存された値には、今は無い選択肢の値や鍵が入ることがある。前回の入力・控えにそういう値があると、発行が 422 で止まる。期待する動き: 前回の入力は捨てて初期値に戻す(段A の仕組み)。控えから戻したときは、小窓に誤りの文と「最初からやり直す」が出て戻れる。Task 1 で、知らない値を形の検査が断ることを固定する。
2. 謄本を見る権限が無い人・物件がつながっていない取引でも、権利の件数は 0 と読める。期待する動き: 「権利はありません」と言い切らず、「謄本で確かめてください」と出す。Task 2 で固定する。
3. 全部空欄のまま発行する(手書き用)。期待する動き: 選ぶ項目はすべて □ で並び、■ は1つも出ない。書き込み欄は下線になる。Task 1・2 で固定する。
4. 名前・住所・書き込み欄に `<` などが入っている。期待する動き: エスケープされて出る。Task 1・2 で固定する。
5. 発行に成功したあと、もう一度同じ書類を開く。期待する動き: 控えは消えている。前回の発行の入力(remember)が初めから入り、「前回の続き」の帯は出ない。Task 4 のソーステストで、成功のとき `draft.close()` を呼ぶことを固定する。

## 決めたこと(この計画での読み替え)

- **書き込み欄の鍵は、項目の鍵とは別に、表の中で重ならない名前にする**(例: 項目 `capacity` の書き込み欄は `capacityDetail`)。値は平らな1つの表(`Record<string, string | string[] | null>`)で持つ。こうすると、前回の入力・控え・Excel の行の形が単純になる。違っていた場合のコスト: 表の鍵の付け直しだけ。
- **選ぶ項目は、1つ選ぶもの=セレクト(先頭に「(空欄=□ で出す)」)、いくつでも選ぶもの=チェックボックスにする**。ラジオボタンは選び直して空欄に戻す手段が無いため使わない。コスト: 見た目の好みだけ。
- **入力の控えは、発行の小窓すべてに付ける**(売主属性調査書だけにしない)。小窓は1つの部品で、書類ごとに分けるとかえって複雑になるため。
  - 「入力に戻る」と × では控えを残す。理由は2つ。1つは、入力に戻るのは空欄を取引の画面で埋めに行くためで、そのとき入力を消すと困ること。もう1つは、2026-10-15 の発注者の判断(× では残す)と同じ扱いにすること。
  - 控えを消すのは、発行に成功したときと「最初からやり直す」を押したときだけ。
  - 二重に発行しても新しい版ができるだけなので、送信中の印(pendingSubmit)は使わない。
  - コスト: 書類ボタンに「(入力の途中)」が出続ける。気になれば「入力に戻る」で消す形に1行で変えられる。
- **売主属性調査書の初期値**: 「個人・法人」と「共有者」は取引の売主から入れる。抵当権などは、謄本の件数と意味がずれることがあるため、自動では入れない。
- **書類の画面の権限は今のまま**(設計 §3.5)。謄本の状況は、書類確認書と同じ読み方で件数と注意書きだけを入れ、名前は入れない。

---

### Task 1: 項目の表の部品(値の形・PDF・Excel の行)

**Files:**
- Create: `src/lib/deals/documents/forms/types.ts`
- Create: `src/lib/deals/documents/forms/values.ts`(zod を使わない=画面からも読める)
- Create: `src/lib/deals/documents/forms/schema.ts`
- Create: `src/lib/deals/documents/forms/render.ts`
- Test: `src/lib/deals/documents/__tests__/forms.test.ts`(新規)

**Interfaces:**
- Produces:
  - 型 `FormChoice`・`FormField`・`FormEntry`・`FormItem`・`FormDef`・`FormValues`
  - `formItems(f: FormDef): FormItem[]`・`emptyFormValues(f: FormDef): FormValues`(values.ts)
  - `formValuesSchema(f: FormDef): z.ZodType<FormValues>`(schema.ts)
  - `renderFormHtml(f: FormDef, v: FormValues): SafeHtml`・`formValueRows(f: FormDef, v: FormValues): ValueRow[]`(render.ts)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/forms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FormDef } from "../forms/types";
import { emptyFormValues, formItems } from "../forms/values";
import { formValuesSchema } from "../forms/schema";
import { formValueRows, renderFormHtml } from "../forms/render";

const FORM: FormDef = {
  key: "test",
  entries: [
    { kind: "section", title: "1. 試験の区切り" },
    { kind: "item", key: "yn", label: "有無<x>", choices: [{ value: "no", label: "無" }, { value: "yes", label: "有" }], fields: [{ key: "ynDetail", label: "内容", max: 20 }] },
    { kind: "item", key: "many", label: "いくつでも", multiple: true, choices: [{ value: "a", label: "あ" }, { value: "b", label: "い" }] },
    { kind: "section", title: "2. 注意" },
    { kind: "item", key: "warn", label: "非居住者", choices: [{ value: "no", label: "該当しない" }, { value: "yes", label: "該当する" }], note: { when: "yes", text: "源泉徴収が要ります" } },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 50, lines: 3 }] },
  ],
};

describe("項目の表(設計 第2段階 §3.3)", () => {
  it("項目だけを並び順に取り出し、空の値を作る", () => {
    expect(formItems(FORM).map((i) => i.key)).toEqual(["yn", "many", "warn", "remarks"]);
    expect(emptyFormValues(FORM)).toEqual({ yn: null, ynDetail: null, many: [], warn: null, remarksText: null });
  });

  it("値の形: 無い鍵は空欄として読み、知らない値・知らない鍵・長すぎる書き込みは断る", () => {
    const s = formValuesSchema(FORM);
    expect(s.parse({})).toEqual(emptyFormValues(FORM));
    expect(s.parse({ yn: "yes", ynDetail: " 雨漏り ", many: ["b"] })).toEqual({ yn: "yes", ynDetail: "雨漏り", many: ["b"], warn: null, remarksText: null });
    expect(s.parse({ ynDetail: "  " }).ynDetail).toBeNull();
    for (const bad of [{ yn: "maybe" }, { many: ["z"] }, { many: "a" }, { other: 1 }, { ynDetail: "x".repeat(21) }]) {
      expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("PDF: 何も選ばなければ選択肢を □ で並べ、書き込み欄は下線の空欄", () => {
    const out = renderFormHtml(FORM, emptyFormValues(FORM)).toString();
    expect(out).toContain("<h2>1. 試験の区切り</h2>");
    expect(out).toContain("□ 無");
    expect(out).toContain("□ 有");
    expect(out).toContain("□ あ");
    expect(out).not.toContain("■");
    expect(out).toContain('<span class="form-blank"></span>');
    expect(out).not.toContain("源泉徴収が要ります");
    expect(out).toContain("有無&lt;x&gt;");
  });

  it("PDF: 選んだものは ■、書き込みは印字(エスケープ)、条件の注意書きは選んだときだけ", () => {
    const out = renderFormHtml(FORM, { ...emptyFormValues(FORM), yn: "yes", ynDetail: "<b>雨漏り</b>", many: ["a", "b"], warn: "yes" }).toString();
    expect(out).toContain("■ 有");
    expect(out).toContain("□ 無");
    expect(out).toContain("■ あ");
    expect(out).toContain("■ い");
    expect(out).toContain("&lt;b&gt;雨漏り&lt;/b&gt;");
    expect(out).toContain("源泉徴収が要ります");
  });

  it("Excel の行: 区切りは見出し、選んだものはその名前、空欄は null", () => {
    expect(formValueRows(FORM, { ...emptyFormValues(FORM), yn: "yes", many: ["a", "b"], remarksText: "メモ" })).toEqual([
      { label: "1. 試験の区切り", heading: true },
      { label: "有無<x>", value: "有" },
      { label: "有無<x> 内容", value: null },
      { label: "いくつでも", value: "あ・い" },
      { label: "2. 注意", heading: true },
      { label: "非居住者", value: null },
      { label: "注意事項 内容", value: "メモ" },
    ]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/forms.test.ts`
Expected: FAIL(`../forms/types` などが無い)

- [ ] **Step 3: 部品を書く**

`src/lib/deals/documents/forms/types.ts`:

```ts
/**
 * 項目の表(設計 第2段階 §3.3)。入力画面・PDF・Excel の行は、すべてこの表から作る(項目がずれないように)。
 * ⚠ただのデータにする(関数を入れない)。出せる書類の API がそのまま画面へ渡す。
 */
export interface FormChoice { value: string; label: string }
/** 書き込み欄。key は表の中で重ならない名前(項目の鍵とも重ならない)。 */
export interface FormField { key: string; label: string; max: number; lines?: number }
export interface FormItem {
  kind: "item";
  key: string;
  label: string;
  /** 選び方(無ければ書き込みだけの項目)。 */
  choices?: FormChoice[];
  /** いくつでも選べる(チェックボックス)。 */
  multiple?: boolean;
  fields?: FormField[];
  /** when を選んだときだけ出す注意書き。 */
  note?: { when: string; text: string };
}
export type FormEntry = { kind: "section"; title: string } | FormItem;
export interface FormDef { key: string; entries: FormEntry[] }
/** 発行のときの値(平らな1つの表)。選ぶ項目=値か null(いくつでも=配列)・書き込み欄=文字か null。 */
export type FormValues = Record<string, string | string[] | null>;
```

`src/lib/deals/documents/forms/values.ts`:

```ts
import type { FormDef, FormItem, FormValues } from "./types";

/** 項目だけを並び順に。 */
export const formItems = (f: FormDef): FormItem[] => f.entries.filter((e): e is FormItem => e.kind === "item");

/** すべて空欄(手書き用)の値。 */
export function emptyFormValues(f: FormDef): FormValues {
  const v: FormValues = {};
  for (const it of formItems(f)) {
    if (it.choices?.length) v[it.key] = it.multiple ? [] : null;
    for (const fl of it.fields ?? []) v[fl.key] = null;
  }
  return v;
}
```

`src/lib/deals/documents/forms/schema.ts`:

```ts
import { z } from "zod";
import { text } from "../../schema-parts";
import type { FormDef, FormValues } from "./types";
import { formItems } from "./values";

/**
 * 項目の表から、発行のときの値の形を作る。無い鍵は空欄として読む。
 * 知らない鍵・知らない値は断る(前回の入力は捨てて初期値に・発行は 422)。
 */
export function formValuesSchema(f: FormDef): z.ZodType<FormValues> {
  const shape: Record<string, z.ZodType> = {};
  for (const it of formItems(f)) {
    if (it.choices?.length) {
      const one = z.enum(it.choices.map((c) => c.value) as [string, ...string[]]);
      shape[it.key] = it.multiple ? z.array(one).max(it.choices.length).default([]) : one.nullable().default(null);
    }
    for (const fl of it.fields ?? []) shape[fl.key] = text(fl.max).default(null);
  }
  return z.object(shape).strict() as unknown as z.ZodType<FormValues>;
}
```

`src/lib/deals/documents/forms/render.ts`:

```ts
import { html, raw, type SafeHtml } from "../html";
import type { ValueRow } from "../business/common";
import type { FormDef, FormItem, FormValues } from "./types";

const FORM_CSS = `.form-choice{margin-right:4mm;white-space:nowrap}
.form-field{margin-top:1mm}
.form-blank{display:inline-block;min-width:70mm;border-bottom:1px solid #333;height:1.1em;vertical-align:bottom}
.form-text{white-space:pre-wrap}
.form-note{font-size:8.5pt;margin-top:1mm}`;

const picked = (it: FormItem, v: FormValues): string[] => {
  const x = v[it.key];
  return Array.isArray(x) ? x : typeof x === "string" ? [x] : [];
};
const str = (x: FormValues[string] | undefined) => (typeof x === "string" && x ? x : null);

function sections(f: FormDef): { title: string | null; items: FormItem[] }[] {
  const out: { title: string | null; items: FormItem[] }[] = [];
  for (const e of f.entries) {
    if (e.kind === "section") out.push({ title: e.title, items: [] });
    else {
      if (!out.length) out.push({ title: null, items: [] });
      out[out.length - 1].items.push(e);
    }
  }
  return out;
}

/** PDF の表。選ばなかった選択肢は □、選んだものは ■、書き込みが空なら下線の空欄(設計 §3.3)。 */
export function renderFormHtml(f: FormDef, v: FormValues): SafeHtml {
  return html`<style>${raw(FORM_CSS)}</style>${sections(f).map((s) => html`
${s.title ? html`<h2>${s.title}</h2>` : null}
<table>${s.items.map((it) => {
    const on = picked(it, v);
    return html`<tr><th style="width:30%">${it.label}</th><td>
${it.choices?.length ? html`<div>${it.choices.map((c) => html`<span class="form-choice">${on.includes(c.value) ? "■" : "□"} ${c.label}</span>`)}</div>` : null}
${(it.fields ?? []).map((fl) => {
      const t = str(v[fl.key]);
      return html`<div class="form-field">${fl.label}: ${t ? html`<span class="form-text">${t}</span>` : html`<span class="form-blank"></span>`}</div>`;
    })}
${it.note && on.includes(it.note.when) ? html`<div class="form-note">※ ${it.note.text}</div>` : null}
</td></tr>`;
  })}</table>`)}`;
}

/** Excel(値だけ)の行。区切りは見出し・選んだものはその名前(いくつでもは「・」でつなぐ)・空欄は null。 */
export function formValueRows(f: FormDef, v: FormValues): ValueRow[] {
  return sections(f).flatMap((s) => [
    ...(s.title ? [{ label: s.title, heading: true }] : []),
    ...s.items.flatMap((it): ValueRow[] => {
      const on = picked(it, v);
      const labels = (it.choices ?? []).filter((c) => on.includes(c.value)).map((c) => c.label);
      return [
        ...(it.choices?.length ? [{ label: it.label, value: labels.length ? labels.join("・") : null }] : []),
        ...(it.fields ?? []).map((fl) => ({ label: `${it.label} ${fl.label}`, value: str(v[fl.key]) })),
      ];
    }),
  ]);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/forms.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/documents/forms src/lib/deals/documents/__tests__/forms.test.ts
git commit -m "feat(deals): 項目の表から値の形・PDF・Excel の行を作る部品(第2段階 段B)"
```

---

### Task 2: 売主属性調査書(項目の表+組み立て+一覧表)

**Files:**
- Create: `src/lib/deals/documents/forms/seller-survey.ts`
- Create: `src/lib/deals/documents/business/seller-survey.ts`
- Modify: `src/lib/deals/documents/registry.ts`(`BusinessDocDef` に `usesRegistry?`・`form?`、`contract_guide` の次に1行)
- Modify: `src/lib/deals/documents/issue.ts`(`DEAL_DOC_TYPES` に1行)
- Modify: `src/app/api/deals/[id]/documents/route.ts`(謄本を読む条件)
- Test: `src/lib/deals/documents/__tests__/business-docs-seller-survey.test.ts`(新規)、既存の一覧の並びの期待値

**Interfaces:**
- Consumes: Task 1 の `FormDef`・`emptyFormValues`・`formValuesSchema`・`renderFormHtml`・`formValueRows`
- Produces: `SELLER_SURVEY_FORM: FormDef`、`sellerSurveyOptionsSchema`、`sellerSurveyDefaults(c)`、`sellerSurveyMissing(c)`、`registryStatusText(c)`、`buildSellerSurvey(c, o)`、一覧表のキー `seller_survey`、`BusinessDocDef.form?: FormDef`・`BusinessDocDef.usesRegistry?: boolean`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/deals/documents/__tests__/business-docs-seller-survey.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { SELLER_SURVEY_FORM } from "../forms/seller-survey";
import { emptyFormValues, formItems } from "../forms/values";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const S1 = party({ id: "p-s1", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1", shareNum: 1, shareDen: 2 });
const S2 = party({ id: "p-s2", role: "seller", name: "架空 次郎", address: null, shareNum: 1, shareDen: 2, sortOrder: 1 });
const BUYER = party({ id: "p-b", role: "buyer", name: "架空 花子" });
const deal: DealView = {
  id: "d", dealNo: "2026-0031", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: "prop-1", propertyKind: "building", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null,
  price: 50_000_000, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [S1, S2, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal, registry: BusinessDocContext["registry"] = { activeRights: 2, caution: "乙区 1番 抵当権が残っています。" }): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: "data:image/png;base64,c2VhbA==",
  staff: { sales: "架空 営業", ops: null }, registry,
});
const K = "seller_survey";
const doc = () => businessDocOf(K)!;

describe("売主属性調査書(社内用)", () => {
  it("「契約・媒介の書類」の契約のご案内の次・売主がいる取引だけ・前回の入力を引き継ぐ・謄本を読む", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("contract_guide") + 1);
    expect(doc().label).toBe("売主属性調査書(社内用)");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().usesRegistry).toBe(true);
    expect(doc().form).toBe(SELLER_SURVEY_FORM);
    expect(doc().applies(ctx())).toBe(true);
    expect(doc().applies(ctx({ ...deal, parties: [BUYER] }))).toBe(false);
    expect(dealDocumentTitle(K, "default")).toBe("売主属性調査書(社内用)");
  });

  it("項目の表: 設計 §4.2 の5つの区切り・鍵が重ならない・前の会社の項目が無い", () => {
    const titles = SELLER_SURVEY_FORM.entries.filter((e) => e.kind === "section").map((e) => (e as { title: string }).title);
    expect(titles).toEqual(["1. 売主のこと", "2. 確認したこと", "3. 売却の経緯", "4. 物件のこと", "5. 注意事項"]);
    const keys = formItems(SELLER_SURVEY_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    const labels = JSON.stringify(SELLER_SURVEY_FORM);
    for (const w of ["取引先マスタ", "リースバック", "インテリックス"]) expect(labels).not.toContain(w);
    for (const w of ["非居住者", "反社会的勢力", "成年後見", "取得の原因", "売却の理由", "第三者からの異議", "今の使い方", "差押え・仮登記", "抵当権など", "近隣との取り決め"]) expect(labels).toContain(w);
  });

  it("初期値: 個人・法人と共有者は取引の売主から。ほかは空欄", () => {
    const v = doc().defaults(ctx()).values;
    expect(v.sellerType).toBe("individual");
    expect(v.coOwners).toBe("yes");
    expect(v.mortgage).toBeNull();
    expect(doc().defaults(ctx({ ...deal, parties: [{ ...S1, partyType: "corporation" }] })).values).toMatchObject({ sellerType: "corporation", coOwners: "no" });
    expect(doc().defaults(ctx({ ...deal, parties: [S1, { ...S2, partyType: "corporation" }] })).values.sellerType).toBeNull();
    expect(doc().options.parse(doc().defaults(ctx()).values)).toBeTruthy();
  });

  it("空欄の確認: 売主の住所・営業担当", () => {
    expect(doc().missing(ctx())).toEqual(["売主の住所"]);
    expect(doc().missing({ ...ctx({ ...deal, parties: [S1] }), staff: { sales: null, ops: null } })).toEqual(["営業担当"]);
    expect(doc().blocking(ctx())).toEqual([]);
  });

  it("組み立て(全部空欄=手書き用): 社内用・自動で入る値・売主全員と持分・□ だけ", () => {
    const out = doc().build(ctx(), emptyFormValues(SELLER_SURVEY_FORM));
    expect(out.html).toContain("売主属性調査書(社内用)");
    expect(out.html).toContain("お客様にはお渡ししません");
    expect(out.html).toContain("2026-0031");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("2026年10月28日");
    expect(out.html).toContain("架空 営業");
    expect(out.html).toContain("架空 一郎&lt;i&gt;");
    expect(out.html).toContain("架空 次郎");
    expect(out.html).toContain("1/2");
    expect(out.html).toContain("抹消の手続きが要る権利 2件");
    expect(out.html).toContain("乙区 1番 抵当権が残っています。");
    expect(out.html).toContain("□ 個人");
    expect(out.html).not.toContain("■");
    expect(out.html).not.toContain("源泉徴収");
    expect(out.html).not.toContain("c2VhbA==");
    expect(out.rows).toContainEqual({ label: "売主1", value: "架空 一郎<i> / 架空県架空市1-1 / 1/2" });
    expect(out.rows).toContainEqual({ label: "1. 売主のこと", heading: true });
  });

  it("組み立て(選んだもの): ■ で印字・非居住者なら源泉徴収の注意", () => {
    const out = doc().build(ctx(), { ...emptyFormValues(SELLER_SURVEY_FORM), sellerType: "individual", nonResident: "yes", remarksText: "<注意>" });
    expect(out.html).toContain("■ 個人");
    expect(out.html).toContain("源泉徴収");
    expect(out.html).toContain("&lt;注意&gt;");
    expect(out.rows).toContainEqual({ label: "非居住者", value: "該当する" });
  });

  it("謄本の権利が読めない・見られないときは「無い」と言い切らない", () => {
    expect(doc().build(ctx(deal, { activeRights: 0, caution: null }), emptyFormValues(SELLER_SURVEY_FORM)).html).toContain("謄本で確かめてください");
    expect(doc().build(ctx(deal, undefined), emptyFormValues(SELLER_SURVEY_FORM)).html).toContain("謄本で確かめてください");
  });

  it("前の会社の名前・リースバックの語を使わない", () => {
    for (const f of ["business/seller-survey.ts", "forms/seller-survey.ts", "forms/render.ts", "forms/schema.ts", "forms/values.ts", "forms/types.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/deals/documents", f), "utf8");
      for (const w of ["インテリックス", "リースバック", "取引先マスタ", "LB"]) expect(src, `${f} に ${w}`).not.toContain(w);
    }
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/deals/documents/__tests__/business-docs-seller-survey.test.ts`
Expected: FAIL(`../forms/seller-survey` が無い)

- [ ] **Step 3: 項目の表を書く**

`src/lib/deals/documents/forms/seller-survey.ts`:

```ts
import type { FormChoice, FormDef } from "./types";

/**
 * 売主属性調査書(社内用)の項目の表(設計 第2段階 §4.2)。
 * 項目は以前の Excel を参考に、文面はこちらで起案。前の会社の「取引先マスタ」「リースバック」の項目は入れない。
 */
const YN: FormChoice[] = [{ value: "no", label: "無" }, { value: "yes", label: "有" }];
const DONE: FormChoice[] = [{ value: "done", label: "済" }, { value: "notYet", label: "未" }];
const CAN: FormChoice[] = [{ value: "can", label: "できる" }, { value: "cannot", label: "できない" }];

export const SELLER_SURVEY_FORM: FormDef = {
  key: "seller_survey",
  entries: [
    { kind: "section", title: "1. 売主のこと" },
    { kind: "item", key: "sellerType", label: "個人・法人", choices: [{ value: "individual", label: "個人" }, { value: "corporation", label: "法人" }] },
    { kind: "item", key: "coOwners", label: "共有者", choices: YN },
    { kind: "item", key: "sameAsRegistry", label: "登記名義人と売主", choices: [{ value: "same", label: "同じ" }, { value: "different", label: "違う" }] },
    {
      kind: "item", key: "differentReason", label: "違うときの理由", multiple: true,
      choices: [{ value: "changeNotRegistered", label: "住所・氏名の変更登記がまだ" }, { value: "inheritanceNotRegistered", label: "相続登記がまだ" }, { value: "other", label: "その他" }],
      fields: [{ key: "differentReasonOther", label: "内容", max: 200 }],
    },
    {
      kind: "item", key: "linkDocs", label: "つながりを示す書類", multiple: true,
      choices: [{ value: "residentCard", label: "住民票" }, { value: "familyRegister", label: "戸籍" }, { value: "divisionAgreement", label: "遺産分割協議書" }, { value: "other", label: "その他" }],
      fields: [{ key: "linkDocsOther", label: "その他の書類", max: 200 }],
    },
    { kind: "item", key: "capacity", label: "破産・成年後見・入院など、本人の意思確認が要る事情", choices: YN, fields: [{ key: "capacityDetail", label: "内容", max: 200 }] },
    { kind: "item", key: "byAgent", label: "代理人による契約(委任状)", choices: YN, fields: [{ key: "agentName", label: "代理人", max: 100 }] },
    {
      kind: "item", key: "nonResident", label: "非居住者", choices: [{ value: "no", label: "該当しない" }, { value: "yes", label: "該当する" }],
      note: { when: "yes", text: "売主が非居住者のときは、買主が代金を支払うときに源泉徴収をする必要があります(所得税法)。" },
    },
    { kind: "section", title: "2. 確認したこと" },
    { kind: "item", key: "idCheck", label: "本人確認書類の確認", choices: DONE, fields: [{ key: "idCheckDocs", label: "確認した書類", max: 200 }] },
    {
      kind: "item", key: "antisocialCheck", label: "反社会的勢力でないことの確認", choices: DONE,
      fields: [{ key: "antisocialBy", label: "確認した人", max: 100 }, { key: "antisocialOn", label: "確認した日", max: 50 }],
    },
    { kind: "section", title: "3. 売却の経緯" },
    {
      kind: "item", key: "acquiredBy", label: "取得の原因",
      choices: [{ value: "purchase", label: "売買" }, { value: "inheritance", label: "相続" }, { value: "gift", label: "贈与" }, { value: "auction", label: "競売" }, { value: "other", label: "その他" }],
      fields: [{ key: "acquiredWhen", label: "時期", max: 50 }, { key: "acquiredOther", label: "その他の内容", max: 200 }],
    },
    {
      kind: "item", key: "saleReason", label: "売却の理由",
      choices: [{ value: "replace", label: "買い替え" }, { value: "relocate", label: "住み替え" }, { value: "inheritanceCash", label: "相続による換金" }, { value: "assetCleanup", label: "資産整理" }, { value: "other", label: "その他" }],
      fields: [{ key: "saleReasonOther", label: "その他の内容", max: 200 }],
    },
    { kind: "item", key: "objection", label: "第三者からの異議", choices: YN, fields: [{ key: "objectionDetail", label: "内容", max: 200 }] },
    { kind: "section", title: "4. 物件のこと" },
    {
      kind: "item", key: "usage", label: "今の使い方",
      choices: [
        { value: "self", label: "自分で住んでいる" }, { value: "family", label: "家族が住んでいる" }, { value: "rented", label: "賃貸中" },
        { value: "office", label: "事務所や店舗" }, { value: "vacant", label: "空室" }, { value: "other", label: "その他" },
      ],
      fields: [{ key: "usageOther", label: "その他の内容", max: 200 }],
    },
    {
      kind: "item", key: "incidents", label: "これまでの出来事", multiple: true,
      choices: [{ value: "fire", label: "火災" }, { value: "leak", label: "漏水" }, { value: "accident", label: "事件や事故" }, { value: "neighborTrouble", label: "近隣とのトラブル" }, { value: "none", label: "特になし" }],
      fields: [{ key: "incidentsDetail", label: "内容", max: 300 }],
    },
    { kind: "item", key: "feeArrears", label: "管理費等の滞納", choices: YN },
    { kind: "item", key: "feeArrearsSettle", label: "管理費等の滞納を決済で精算できるか", choices: CAN },
    { kind: "item", key: "taxArrears", label: "税の滞納", choices: YN },
    { kind: "item", key: "taxArrearsSettle", label: "税の滞納を決済で精算できるか", choices: CAN },
    { kind: "item", key: "seizure", label: "差押え・仮登記", choices: YN, fields: [{ key: "seizureParty", label: "相手の種類", max: 100 }] },
    { kind: "item", key: "mortgage", label: "抵当権など", choices: YN, fields: [{ key: "mortgageParty", label: "相手の種類", max: 100 }] },
    {
      kind: "item", key: "payoff", label: "売買代金で借入れを返しきれるか",
      choices: [{ value: "can", label: "返せる" }, { value: "cannot", label: "返せない" }, { value: "noLoan", label: "借入れなし" }],
    },
    { kind: "item", key: "neighborAgreement", label: "近隣との取り決め", choices: YN, fields: [{ key: "neighborAgreementDetail", label: "内容", max: 200 }] },
    { kind: "section", title: "5. 注意事項" },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 1000, lines: 4 }] },
  ],
};
```

- [ ] **Step 4: 組み立てを書く**

`src/lib/deals/documents/business/seller-survey.ts`:

```ts
import { html } from "../html";
import { documentHtml } from "../layout";
import { SELLER_SURVEY_FORM } from "../forms/seller-survey";
import { formValuesSchema } from "../forms/schema";
import { emptyFormValues } from "../forms/values";
import { formValueRows, renderFormHtml } from "../forms/render";
import type { FormValues } from "../forms/types";
import { DASH, dateJa, headTable, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

export const SELLER_SURVEY_TITLE = "売主属性調査書(社内用)";
export const sellerSurveyOptionsSchema = formValuesSchema(SELLER_SURVEY_FORM);

/** 初期値: 個人・法人と共有者だけ取引の売主から(設計 §4.2)。抵当権などは謄本の件数と意味がずれうるので入れない。 */
export function sellerSurveyDefaults(c: BusinessDocContext): FormValues {
  const sellers = partiesOf(c.deal, "seller");
  const types = new Set(sellers.map((p) => p.partyType));
  return {
    ...emptyFormValues(SELLER_SURVEY_FORM),
    sellerType: types.size === 1 ? [...types][0] : null,
    coOwners: sellers.length > 1 ? "yes" : sellers.length === 1 ? "no" : null,
  };
}

export function sellerSurveyMissing(c: BusinessDocContext): string[] {
  const out: string[] = [];
  if (partiesOf(c.deal, "seller").some((p) => !p.address)) out.push("売主の住所");
  if (!c.staff?.sales) out.push("営業担当");
  return out;
}

/**
 * 謄本の登記の状況(書類確認書と同じ読み方・名前は入れない)。
 * 権利の件数が 0 でも、謄本が無い・読めない・見る権限が無いことがあるので「無い」とは書かない。
 */
export function registryStatusText(c: BusinessDocContext): string {
  const n = c.registry?.activeRights ?? 0;
  return [n > 0 ? `抹消の手続きが要る権利 ${n}件` : "謄本で確かめてください", c.registry?.caution ?? null].filter(Boolean).join(" / ");
}

const share = (n: number | null, d: number | null) => (n && d ? `${n}/${d}` : "");

/** 売主属性調査書(社内用・設計 第2段階 §4.2)。項目は項目の表から(選ばなければ □ の空欄)。 */
export function buildSellerSurvey(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const sellers = partiesOf(d, "seller");
  const head: [string, string | null][] = [
    ["取引番号", d.dealNo], ["物件", propertyLabel(d)], ["記入日", dateJa(c.today)], ["営業担当", c.staff?.sales ?? null],
    ["謄本の登記の状況", registryStatusText(c)],
  ];
  const body = html`
<h1>${SELLER_SURVEY_TITLE}</h1>
<p class="right" style="font-size:8.5pt">社内用の書類です(お客様にはお渡ししません)</p>
${headTable(head)}
<h2>売主</h2>
<table><tr><th style="width:30%">名前</th><th>住所</th><th style="width:14%">持分</th></tr>
${sellers.map((p) => html`<tr><td>${p.name}</td><td>${p.address ?? ""}</td><td>${share(p.shareNum, p.shareDen)}</td></tr>`)}</table>
${renderFormHtml(SELLER_SURVEY_FORM, o)}
<table style="margin-top:6mm"><tr><th style="width:33%">営業担当</th><th style="width:33%">業務担当</th><th>承認</th></tr>
<tr><td style="height:16mm"></td><td></td><td></td></tr></table>`;
  return {
    html: documentHtml({ title: SELLER_SURVEY_TITLE, font: "gothic", body }),
    rows: [
      { label: "書類", value: SELLER_SURVEY_TITLE },
      ...head.map(([label, value]) => ({ label, value: value ?? DASH })),
      { label: "売主", heading: true },
      ...sellers.map((p, i) => ({ label: `売主${i + 1}`, value: [p.name, p.address, share(p.shareNum, p.shareDen)].filter(Boolean).join(" / ") })),
      ...formValueRows(SELLER_SURVEY_FORM, o),
    ],
  };
}
```

- [ ] **Step 5: 一覧表・書類の名前・謄本を読む条件**

`src/lib/deals/documents/registry.ts`:

1. import に足す:
```ts
import type { FormDef } from "./forms/types";
import { SELLER_SURVEY_FORM } from "./forms/seller-survey";
import {
  SELLER_SURVEY_TITLE, buildSellerSurvey, sellerSurveyDefaults, sellerSurveyMissing, sellerSurveyOptionsSchema,
} from "./business/seller-survey";
```
2. `BusinessDocDef` の `remember?: boolean;` の次に:
```ts
  /** 謄本の登記の状況を使う(発行のときにも謄本を読む・書類確認書と同じ読み方)。 */
  usesRegistry?: boolean;
  /** 項目の表(入力画面と PDF をこの表から作る・設計 第2段階 §3.3)。画面へそのまま渡す。 */
  form?: FormDef;
```
3. `key: "contract_guide"` の行の**次**に:
```ts
  {
    key: "seller_survey",
    label: SELLER_SURVEY_TITLE,
    group: "contract",
    remember: true,
    usesRegistry: true,
    form: SELLER_SURVEY_FORM,
    applies: (c) => partiesOf(c.deal, "seller").length > 0,
    missing: (c) => sellerSurveyMissing(c),
    blocking: () => [],
    options: sellerSurveyOptionsSchema as z.ZodType<Record<string, unknown>>,
    defaults: (c) => ({ values: sellerSurveyDefaults(c) }),
    build: (c, o) => buildSellerSurvey(c, sellerSurveyOptionsSchema.parse(o)),
  },
```

`src/lib/deals/documents/issue.ts` の `DEAL_DOC_TYPES` の `contract_guide` の行の次に:
```ts
  seller_survey: { label: "売主属性調査書(社内用)", variants: { default: "" } },
```

`src/app/api/deals/[id]/documents/route.ts` の謄本の行を次に替える:
```ts
        // 謄本は書類確認書と、謄本の状況を使う書類(売主属性調査書)のときだけ読む(計画 段5c-2 の読み替え 5・第2段階 段B)。
        registry: businessDoc.group === "checklist" || businessDoc.usesRegistry ? await loadRegistryDocInfo(await registryPropertyFor(session, perms, deal.propertyId)) : undefined,
```

- [ ] **Step 6: 通ることを確かめる・一覧の並びの期待値を直す**

Run: `npx vitest run src/lib/deals`
Expected: 新しいテストは PASS(8 tests)。一覧の並びを固定している既存のテストが落ちたら、並びの期待値にだけ `"seller_survey"` を `"contract_guide"` の次に足す。対象は `business-docs-5b.test.ts`、`documents-route.test.ts` の「出せる書類」(売主がいる取引の fixture のとき)、そのほかの並びのテスト。挙動は直さない。

`documents-route.test.ts` の、発行の route の謄本のテスト(書類確認書のときだけ謄本を読む)が落ちたら、期待値に「売主属性調査書も読む」を足す。それ以外の意味は変えない。どちらを直したかを台帳に書く。

Run: `npx vitest run src/lib/deals src/app`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/deals/documents src/app/api/deals src/lib/deals/__tests__
git commit -m "feat(deals): 売主属性調査書(社内用)(第2段階 段B)"
```

---

### Task 3: 書類タブ — 項目の表から入力欄を描く部品と「すべて空欄に戻す」

**Files:**
- Create: `src/components/deals/doc-form-fields.tsx`
- Modify: `src/app/api/deals/[id]/documents/available/route.ts`(`form` を返す)
- Modify: `src/lib/deals/client.ts`(`AvailableDocument.form`)
- Modify: `src/components/deals/business-docs-section.tsx`(小窓で描く)
- Test: `src/components/deals/__tests__/doc-form-fields.test.tsx`(新規)、`src/lib/deals/__tests__/business-docs-page-source.test.ts`(it を足す)、`src/lib/deals/__tests__/documents-route.test.ts`(it を足す)

**Interfaces:**
- Consumes: `FormDef`・`emptyFormValues`(Task 1)、`seller_survey` の `form`(Task 2)
- Produces: `DocFormFields({ form, values, onChange })`、`AvailableDocument.form: FormDef | null`

- [ ] **Step 1: 失敗するテストを書く**

`src/components/deals/__tests__/doc-form-fields.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocFormFields } from "../doc-form-fields";
import type { FormDef } from "@/lib/deals/documents/forms/types";

const FORM: FormDef = {
  key: "t",
  entries: [
    { kind: "section", title: "1. 区切り" },
    { kind: "item", key: "yn", label: "有無", choices: [{ value: "no", label: "無" }, { value: "yes", label: "有" }], fields: [{ key: "ynDetail", label: "内容", max: 20 }] },
    { kind: "item", key: "many", label: "いくつでも", multiple: true, choices: [{ value: "a", label: "あ" }, { value: "b", label: "い" }] },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 50, lines: 3 }] },
  ],
};
const render = (values: Record<string, unknown>) => renderToStaticMarkup(<DocFormFields form={FORM} values={values} onChange={() => {}} />);

describe("項目の表から入力欄を描く(設計 第2段階 §3.3)", () => {
  it("区切りの見出し・1つ選ぶ=セレクト(空欄の選択肢つき)・いくつでも=チェックボックス・書き込み欄", () => {
    const out = render({ yn: "yes", ynDetail: "雨漏り", many: ["b"], remarksText: null });
    expect(out).toContain("1. 区切り");
    expect(out).toContain('aria-label="有無"');
    expect(out).toContain("(空欄=□ で出す)");
    expect(out).toMatch(/<option value="yes" selected="">有<\/option>/);
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/?>い/);
    expect(out).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/?>あ/);
    expect(out).toContain('aria-label="有無 内容"');
    expect(out).toContain('value="雨漏り"');
    expect(out).toContain("<textarea");
    expect(out).toContain('maxLength="50"');
  });
  it("空欄の値でも落ちない", () => {
    expect(() => render({})).not.toThrow();
  });
});
```

`business-docs-page-source.test.ts` の describe の末尾に:

```ts
  it("項目の表のある書類は共通の部品で描き、「すべて空欄に戻す」を一番上に置く(第2段階 段B)", () => {
    const src = read(SECTION);
    expect(src).toContain("<DocFormFields form={doc.form} values={values} onChange={set} />");
    expect(src).toContain("setValues(emptyFormValues(doc.form))");
    expect(src.indexOf("すべて空欄に戻す")).toBeLessThan(src.indexOf("<DocFormFields"));
    expect(read("src/lib/deals/client.ts")).toContain("form: FormDef | null;");
    expect(read("src/app/api/deals/[id]/documents/available/route.ts")).toContain("form: d.form ?? null,");
  });
```

`documents-route.test.ts` の末尾の describe「前回の入力を初めの値にする」の中に it を足す:

```ts
  it("項目の表のある書類は form を返す・無い書類は null", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, parties: [SELLER] });
    const body = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    expect((docOf(body, "seller_survey") as unknown as { form: { key: string } }).form.key).toBe("seller_survey");
    expect((docOf(body, "contract_guide") as unknown as { form: null }).form).toBeNull();
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/components/deals/__tests__/doc-form-fields.test.tsx src/lib/deals/__tests__/business-docs-page-source.test.ts src/lib/deals/__tests__/documents-route.test.ts`
Expected: FAIL(`../doc-form-fields` が無い・`form` が返っていない)

- [ ] **Step 3: 実装**

`src/components/deals/doc-form-fields.tsx`:

```tsx
"use client";

import type { FormDef, FormItem } from "@/lib/deals/documents/forms/types";
import { inputCls } from "./form-parts";

type OnChange = (key: string, v: string | string[] | null) => void;
const strOf = (v: unknown) => (typeof v === "string" ? v : "");
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 項目の表から入力欄を描く(設計 第2段階 §3.3)。PDF も同じ表から作るので、画面と PDF の項目がずれない。
 * 1つ選ぶ=セレクト(先頭が空欄=PDF では □ を並べる)・いくつでも=チェックボックス・書き込み欄。
 */
export function DocFormFields({ form, values, onChange }: { form: FormDef; values: Record<string, unknown>; onChange: OnChange }) {
  return (
    <div className="space-y-3">
      {form.entries.map((e, i) => (e.kind === "section"
        ? <h4 key={`s${i}`} className="pt-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{e.title}</h4>
        : <ItemFields key={e.key} item={e} values={values} onChange={onChange} />))}
    </div>
  );
}

function ItemFields({ item, values, onChange }: { item: FormItem; values: Record<string, unknown>; onChange: OnChange }) {
  const picked = listOf(values[item.key]);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">{item.label}</p>
      {item.choices?.length ? (item.multiple ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {item.choices.map((c) => (
            <label key={c.value} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(c.value)}
                onChange={(ev) => onChange(item.key, ev.target.checked ? [...picked, c.value] : picked.filter((x) => x !== c.value))}
              />
              {c.label}
            </label>
          ))}
        </div>
      ) : (
        <select aria-label={item.label} value={strOf(values[item.key])} onChange={(ev) => onChange(item.key, ev.target.value || null)} className={inputCls}>
          <option value="">(空欄=□ で出す)</option>
          {item.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )) : null}
      {(item.fields ?? []).map((f) => (f.lines && f.lines > 1 ? (
        <textarea
          key={f.key} aria-label={`${item.label} ${f.label}`} placeholder={f.label} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} rows={f.lines} className={inputCls}
        />
      ) : (
        <input
          key={f.key} type="text" aria-label={`${item.label} ${f.label}`} placeholder={f.label} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} className={inputCls}
        />
      )))}
    </div>
  );
}
```

`src/app/api/deals/[id]/documents/available/route.ts` の、書類ごとに返す形の `defaults: values, issuers: def.issuers ?? null, choices: def.choices ?? null,` の次の行に:
```ts
        form: d.form ?? null,
```

`src/lib/deals/client.ts`:
- 先頭の import に `import type { FormDef } from "@/lib/deals/documents/forms/types";`
- `AvailableDocument` の `choices: ...;` の次に:
```ts
  /** 項目の表(入力欄を共通の部品で描く・第2段階 段B)。無い書類は null。 */
  form: FormDef | null;
```

`src/components/deals/business-docs-section.tsx`:
- import に足す:
```ts
import { DocFormFields } from "./doc-form-fields";
import { emptyFormValues } from "@/lib/deals/documents/forms/values";
```
- 小窓の `{doc.docType === "contract_guide" && (` の**前**に:
```tsx
        {doc.form && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => doc.form && setValues(emptyFormValues(doc.form))}>すべて空欄に戻す</Button>
              <p className="text-xs text-gray-500">選ばなかった項目は □ を並べた空欄で出ます(手で書けます)。全部空欄のまま出すと、手書き用の書式になります。前に発行したことがあれば、そのときの入力が初めから入っています。</p>
            </div>
            <DocFormFields form={doc.form} values={values} onChange={set} />
          </>
        )}
```

⚠ソーステストは `setValues(emptyFormValues(doc.form))` の文字列を探す。上の `doc.form && setValues(emptyFormValues(doc.form))` はその文字列を含むので、そのままでよい。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/components/deals src/lib/deals && npx tsc --noEmit`
Expected: PASS・型エラー 0。

`src/lib` は `@/components` を読めない(走査テスト)。今回は components が lib を読むだけなので、該当しない。

- [ ] **Step 5: Commit**

```bash
git add src/components/deals "src/app/api/deals/[id]/documents/available/route.ts" src/lib/deals/client.ts src/lib/deals/__tests__
git commit -m "feat(deals): 書類タブで項目の表から入力欄を描く・すべて空欄に戻す"
```

---

### Task 4: 発行の小窓の入力を、別の画面へ移っても消さない

**Files:**
- Modify: `src/lib/drafts/draft-store.ts`(`DRAFT_SCREENS` に `"deal-document"`)
- Create: `src/lib/drafts/screens/deal-document.ts`
- Modify: `src/components/deals/business-docs-section.tsx`
- Test: `src/lib/drafts/__tests__/deal-document-draft.test.ts`(新規)、`src/lib/deals/__tests__/business-docs-page-source.test.ts`(it を足す)

**Interfaces:**
- Consumes: `draftKey`・`useRestoredDraft`・`useDraftAutosave`・`useDraftExists`・`DraftRestoredNotice`・`DraftTooLargeNotice`(既存)
- Produces: `DealDocumentDraft`、`parseDealDocumentDraft(d: unknown): DealDocumentDraft | null`、`dealDocumentDraftKey(dealId, docType): string`、`sameAsInitial(initial): (d: DealDocumentDraft) => boolean`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/drafts/__tests__/deal-document-draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DRAFT_PREFIX, DRAFT_SCREENS } from "../draft-store";
import { dealDocumentDraftKey, parseDealDocumentDraft, sameAsInitial } from "../screens/deal-document";

describe("取引の書類の発行の小窓の控え(第2段階 §3.2)", () => {
  it("画面の名前を足し、取引と書類の種類ごとの鍵にする", () => {
    expect(DRAFT_SCREENS).toContain("deal-document");
    expect(dealDocumentDraftKey("d-1", "seller_survey")).toBe(`${DRAFT_PREFIX}deal-document:d-1:seller_survey`);
  });
  it("形の合う控えだけ戻す", () => {
    expect(parseDealDocumentDraft({ rev: 1, values: { a: "x", b: ["y"], c: null } })).toEqual({ rev: 1, values: { a: "x", b: ["y"], c: null } });
    for (const bad of [null, "x", {}, { rev: 2, values: {} }, { rev: 1, values: [] }, { rev: 1, values: {}, extra: 1 }]) {
      expect(parseDealDocumentDraft(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("初めの値(前回の入力・初期値)から変えていなければ控えない", () => {
    const empty = sameAsInitial({ a: "x", b: null });
    expect(empty({ rev: 1, values: { a: "x", b: null } })).toBe(true);
    expect(empty({ rev: 1, values: { a: "y", b: null } })).toBe(false);
  });
});
```

`business-docs-page-source.test.ts` の describe の末尾に:

```ts
  it("発行の小窓の入力を控え、戻ったら続きから・発行したら消す(第2段階 §3.2)", () => {
    const src = read(SECTION);
    expect(src).toContain("const restored = useRestoredDraft(draftKeyValue, parseDealDocumentDraft);");
    expect(src).toContain("useDraftAutosave(draftKeyValue, draftData, isEmpty, restored)");
    expect(src).toContain("restored?.data.values ?? initial");
    // 発行に成功したら控えを消してから閉じる(次に開くと前回の発行の入力が初めの値・帯は出ない)
    expect(src).toMatch(/draft\.close\(\);\s*onDone\(/);
    expect(src).toContain("<DraftRestoredNotice");
    expect(src).toContain('<DraftTooLargeNotice kind="input" />');
    // 書類ボタンに「入力の途中」
    expect(src).toContain("useDraftExists(dealDocumentDraftKey(dealId, d.docType))");
    expect(src).toContain("(入力の途中)");
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/drafts/__tests__/deal-document-draft.test.ts src/lib/deals/__tests__/business-docs-page-source.test.ts`
Expected: FAIL(`../screens/deal-document` が無い)

- [ ] **Step 3: 実装**

`src/lib/drafts/draft-store.ts` の `DRAFT_SCREENS` の `"csv-import",` の次に:
```ts
  "deal-document",
```

`src/lib/drafts/screens/deal-document.ts`:

```ts
/** 取引の書類の発行の小窓の控え(設計 第2段階 §3.2)。値の中身は書類ごとに違うので、形は表であることだけ確かめる(発行のときにサーバーが検査し直す)。 */
import { z } from "zod/v4";
import { draftKey } from "../draft-store";

export interface DealDocumentDraft {
  rev: 1;
  values: Record<string, unknown>;
}

const schema = z.object({ rev: z.literal(1), values: z.record(z.string(), z.unknown()) }).strict();

export function parseDealDocumentDraft(d: unknown): DealDocumentDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as DealDocumentDraft) : null;
}

export const dealDocumentDraftKey = (dealId: string, docType: string) => draftKey("deal-document", `${dealId}:${docType}`);

/** 初めの値(前回の入力・初期値)から変えていなければ控えない(開いただけで「入力の途中」にしない)。 */
export const sameAsInitial = (initial: Record<string, unknown>) => (d: DealDocumentDraft) => JSON.stringify(d.values) === JSON.stringify(initial);
```

`src/components/deals/business-docs-section.tsx`:

1. import に足す(`useMemo` も react から):
```ts
import { useEffect, useMemo, useState } from "react";
import { useDraftAutosave, useDraftExists, useRestoredDraft } from "@/hooks/use-draft";
import { DraftRestoredNotice, DraftTooLargeNotice } from "@/components/drafts/draft-notices";
import { dealDocumentDraftKey, parseDealDocumentDraft, sameAsInitial, type DealDocumentDraft } from "@/lib/drafts/screens/deal-document";
```
2. 小窓の値の初めの値を、ファイルの関数にする(今の `useState` の引数の式と同じ中身):
```ts
/** 小窓の初めの値(前回の入力・初期値)。鍵の行の本数・諸費用の金額は入力しやすいよう文字で持ち、送るときに数にする。 */
function initialValuesOf(doc: AvailableDocument): Record<string, unknown> {
  if (doc.docType === "key_receipt") return { ...doc.defaults, keys: [{ label: "", count: "1" }] };
  if (doc.docType === "settlement_guide_seller") {
    return { ...doc.defaults, costs: (doc.defaults.costs as { label: string; amount: number }[] ?? []).map((r) => ({ label: r.label, amount: String(r.amount) })) };
  }
  return doc.defaults;
}
```
3. `IssueDialog` の先頭の `const [values, setValues] = useState<Record<string, unknown>>(...)` を次に替える:
```tsx
  // 入力の控え(別の画面へ移って戻っても続きから・設計 第2段階 §3.2)。× と「入力に戻る」は残し、発行の成功と「最初からやり直す」で消す。
  const draftKeyValue = dealDocumentDraftKey(dealId, doc.docType);
  const restored = useRestoredDraft(draftKeyValue, parseDealDocumentDraft);
  const [initial] = useState(() => initialValuesOf(doc));
  const [values, setValues] = useState<Record<string, unknown>>(() => restored?.data.values ?? initial);
  const [restoredShown, setRestoredShown] = useState(restored != null);
  const draftData = useMemo<DealDocumentDraft>(() => ({ rev: 1, values }), [values]);
  const isEmpty = useMemo(() => sameAsInitial(initial), [initial]);
  const draft = useDraftAutosave(draftKeyValue, draftData, isEmpty, restored);
  const discardDraft = () => {
    draft.discard();
    setValues(initial);
    setRestoredShown(false);
  };
```
4. 発行の成功のところ `onDone({ id: r.id, title: r.title, version: r.version });` を次に替える:
```ts
      draft.close();
      onDone({ id: r.id, title: r.title, version: r.version });
```
5. 小窓の本文 `<div className="space-y-4">` のすぐ後に:
```tsx
        {restored && restoredShown && <DraftRestoredNotice savedAt={restored.savedAt} onDiscard={discardDraft} />}
        {draft.tooLarge && <DraftTooLargeNotice kind="input" />}
```
6. 一覧の書類ボタンを小さな部品に分けて、「入力の途中」を出す。`{list.map((d) => ( <li key={d.docType}> <Button ...> ... </Button> </li> ))}` を次に替える:
```tsx
              {list.map((d) => (
                <li key={d.docType}>
                  <DocButton dealId={dealId} doc={d} onOpen={() => { setDone(null); setOpen(d); }} />
                </li>
              ))}
```
ファイルの末尾に:
```tsx
/** 書類のボタン。入力の途中の控えがあれば「(入力の途中)」を添える(サーバー描画では出さない)。 */
function DocButton({ dealId, doc: d, onOpen }: { dealId: string; doc: AvailableDocument; onOpen: () => void }) {
  const hasDraft = useDraftExists(dealDocumentDraftKey(dealId, d.docType));
  return (
    <Button variant="secondary" size="sm" onClick={onOpen}>
      <FileOutput className="h-4 w-4" />
      {d.label}
      {d.missing.length > 0 && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(空欄 {d.missing.length})</span>}
      {hasDraft && <span className="ml-1 text-xs text-indigo-700 dark:text-indigo-300">(入力の途中)</span>}
    </Button>
  );
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run src/lib/drafts src/lib/deals src/components && npx tsc --noEmit`
Expected: PASS・型エラー 0。

控えの既存の走査テストが落ちることがある。たとえば `draft-shape-lock.test.ts` の指紋や、`DRAFT_SCREENS` の数を数えるテストなど。そのときは、テストの冒頭の説明どおりに期待値だけを直す。直したものは台帳にルーリングとして書く。

- [ ] **Step 5: Commit**

```bash
git add src/lib/drafts src/components/deals/business-docs-section.tsx src/lib/deals/__tests__/business-docs-page-source.test.ts
git commit -m "feat(deals): 書類の発行の小窓の入力を、別の画面へ移っても消さない"
```

---

### Task 5: 使い方ガイドとマニュアル・全部のゲート

**Files:**
- Modify: `public/docs/guide.html`、`public/docs/manual.html`

- [ ] **Step 1: ガイドとマニュアルを直す**

`public/docs/guide.html`:
- 「契約の書類（契約のご案内）」を「契約の書類（契約のご案内・売主属性調査書［社内用］）」にする。
- 「<li><b>契約のご案内</b>（売主様あて・買主様あて）と<b>取引完了確認書</b>は、…</li>」の行の後ろに2行足す:
```html
        <li><b>売主属性調査書（社内用）</b>は、売主のこと・確認したこと・売却の経緯・物件のことを選んで書けます。選ばなかった項目は □ の空欄で出るので、全部空欄のまま出せば手書き用になります（「すべて空欄に戻す」で空にできます）</li>
        <li>書類を発行する小窓に入れた内容は、途中で別の画面へ移っても消えません。もう一度その書類を開くと続きが出ます（書類のボタンに「入力の途中」と出ます）。発行すると消えます。いらなければ「最初からやり直す」で消せます</li>
```

`public/docs/manual.html`:
- 675行目あたりの「資金計画表・事業計画書・契約のご案内・決済の書類」を「資金計画表・事業計画書・契約のご案内・売主属性調査書（社内用）・決済の書類」にする。
- 「<li><b>契約のご案内</b>：…</li>」の行の後ろに1行足す:
```html
              <li><b>売主属性調査書（社内用）</b>：取引番号・物件・記入日・営業担当・売主全員の名前と住所と持分・謄本の登記の状況（抹消の手続きが要る権利の件数と注意書き。件数が無いときは「謄本で確かめてください」）が自動で入ります。売主のこと（個人・法人、共有者、登記名義人と同じか、つながりを示す書類、意思確認が要る事情、代理人、非居住者）・確認したこと（本人確認・反社会的勢力でないことの確認）・売却の経緯・物件のこと・注意事項を選んで書けます。選ばなかった項目は □ を並べた空欄、選んだものは ■ で出ます。非居住者を「該当する」にすると、源泉徴収の注意を添えます。お客様に渡す書類ではありません。</li>
```
- 「契約のご案内と取引完了確認書は、次に発行するときにその入力が初めから入ります。」を「契約のご案内・売主属性調査書・取引完了確認書は、次に発行するときにその入力が初めから入ります。発行の小窓に入れた内容は、途中で別の画面へ移っても消えず、もう一度開くと続きが出ます（発行すると消えます）。」にする。

- [ ] **Step 2: 全部のゲート**

```bash
npx tsc --noEmit > /tmp/tsc.txt; echo tsc=$?
npx vitest run > /tmp/vitest.txt; echo vitest=$?; tail -5 /tmp/vitest.txt
npx eslint src/lib/deals/documents src/lib/drafts src/components/deals "src/app/api/deals/[id]/documents" src/lib/deals/client.ts; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?
```
Expected: tsc=0 / vitest=0(全件 pass。PC の負荷で時間切れになったテストは単独で回し直して確かめる)/ eslint=0 / build=0

- [ ] **Step 3: Commit**

```bash
git add public/docs/guide.html public/docs/manual.html
git commit -m "docs(deals): 売主属性調査書・発行の小窓の入力を消さないことをガイドとマニュアルに"
```
