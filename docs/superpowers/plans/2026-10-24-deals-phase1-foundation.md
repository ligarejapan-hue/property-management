# 取引・帳票機能 段1(土台) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「取引」を作って、一覧で探せて、基本・物件・当事者を入力・保存できるようにする。あわせて、取引の設定(代表者・口座・物件種別)と税率の表の初期データを用意する。

**Architecture:**
- 新しいテーブルを5つ足す(追加だけ)。既存の作りに合わせて、純粋関数・API・画面の3層にする。
  - 純粋関数(`src/lib/deals/*`)に、入力の検証、物件からの写し、番号の採番、画面の入力と送る値の変換を置く。
  - API(`src/app/api/deals/*`)は、権限、版の番号による楽観ロック、変更履歴、監査記録を受け持つ。
  - 画面(`src/app/(dashboard)/deals/*`)は API を呼ぶだけにする。
- 計算(段2)と書類(段3〜5)は、この段では作らない。テーブルの列だけ先に用意しておく。
- 固都税の評価額の行(assessments)と費用(costs)は、計算で使う段2で、物件タブと「金額・費用」タブに足す。

**Tech Stack:** Next.js 16 (app router)、React 19、Prisma 7 (adapter-pg)、zod 4、vitest 4 (env=node)、Tailwind

**Spec:** `docs/superpowers/specs/2026-10-23-deals-documents-design.md`

## Global Constraints

- DB の変更は追加だけ。既存テーブルの列は消さず、変えもしない。migration の中身は、本番に入れる前に発注者に見せる。
- 実在の個人情報はテストに使わない。テストの氏名・住所は「試験 太郎」「東京都試験区1-2-3」のような架空のものにする。
- 監査記録の detail には、項目の名前だけを入れる(値・氏名・住所・金額は入れない)。`targetId` は UUID だけ(設定の singleton には付けない)。
- 権限 `deal`(read / write)は、3つのテンプレート(管理者用・事務担当用・現地担当用)すべてに付ける。取引の設定と税率の表は、`user_management:write` を持つ人だけが変えられる。
- 権限の一覧は2画面(`admin/templates/[id]/page.tsx` と `admin/users/[id]/permissions/page.tsx`)で同じにする。
- 状態などの選択肢は、TEXT の列と、アプリ側の許可リストで持つ(DB の enum は使わない)。
- 画面の言葉は「取引」。コード上の名前は `deal`。
- 素の `<button>` は使わない(`Button` 部品を使う)。タブは `Tabs` と `tabPanelProps` で作る。題名は `PageHeader` で出す。
- 金額は整数(円)。この段では金額は保存するだけで、計算はしない。
- 日時は、画面では日本時間で入出力し、API では ISO 文字列でやりとりする。

## Review Focus

1. **現地担当が、担当外の物件から取引を作る**: 物件の写しが取れてはいけない。404 を返し、住所は返さない(Task 5 のテストで確かめる)。
2. **2人が同じ取引を同時に直す**: 後から保存した人は 409 になり、先の人の変更を上書きしない(Task 6 と Task 7 の当事者でも確かめる)。
3. **同じ年に同時に2件を作る**: 取引番号がぶつかったら、作り直して別の番号にする(Task 5 で P2002 を1回返す mock で確かめる)。
4. **買取再販に切り替える**: 取引態様(売主側・買主側・両手)が残らず空になる(Task 2 の純粋関数で確かめる)。
5. **設定にない物件種別を送る**: 422 になり、保存しない(Task 5・Task 6 で確かめる)。

---

## ファイルの地図

| ファイル | 役目 |
|---|---|
| `prisma/schema.prisma` | 5つのモデルを足す。User・Property には、逆向きの参照だけを足す(列は増えない) |
| `prisma/migrations/20261024100000_add_deals/migration.sql` | 表の作成、税率の初期データ、権限の付与 |
| `src/lib/deals/constants.ts` | 選択肢と日本語名 |
| `src/lib/deals/property-kind.ts` | 物件の種類を、取引の物件種別に当てる |
| `src/lib/deals/deal-no.ts` | 取引番号(年+4桁) |
| `src/lib/deals/datetime.ts` | 日本時間と ISO の変換 |
| `src/lib/deals/schemas.ts` | zod の入力の検証 |
| `src/lib/deals/snapshot.ts` | 物件から写しを作る |
| `src/lib/deals/rate-tables.ts` | 税率の表の初期値と、期間で選ぶ関数 |
| `src/lib/deals/settings.ts` | 設定の解決(初期値で補う。純粋関数) |
| `src/lib/deals/settings-store.ts` | 設定を DB から読む |
| `src/lib/deals/change-values.ts` | 更新データの組み立てと、変更履歴の値 |
| `src/lib/deals/view.ts` | DB の行を API の形にする |
| `src/lib/deals/forms.ts` | 画面の入力と送る値の変換 |
| `src/lib/deals/guard.ts` | 権限の確認 |
| `src/lib/deals/client.ts` | 画面から API を呼ぶ |
| `src/app/api/deals/route.ts` | 一覧と作成 |
| `src/app/api/deals/options/route.ts` | 物件種別と自社の情報 |
| `src/app/api/deals/[id]/route.ts` | 1件の取得と更新 |
| `src/app/api/deals/[id]/refresh-property/route.ts` | 物件から取り直す |
| `src/app/api/deals/[id]/parties/route.ts` | 当事者を足す |
| `src/app/api/deals/[id]/parties/[partyId]/route.ts` | 当事者を直す・消す |
| `src/app/api/admin/deal-settings/route.ts` | 設定の取得と保存(管理者) |
| `src/app/api/admin/deal-settings/rate-tables/route.ts` | 税率の表を見る(管理者) |
| `src/components/deals/form-parts.tsx` | 入力欄の共通部品 |
| `src/components/deals/deal-basic-panel.tsx` | 基本タブ |
| `src/components/deals/deal-property-panel.tsx` | 物件タブ |
| `src/components/deals/deal-parties-panel.tsx` | 当事者タブ |
| `src/app/(dashboard)/deals/page.tsx` | 一覧 |
| `src/app/(dashboard)/deals/new/page.tsx` | 新しい取引 |
| `src/app/(dashboard)/deals/[id]/page.tsx` | 詳しい画面 |
| `src/app/(dashboard)/admin/deal-settings/page.tsx` | 取引の設定 |

テストは `src/lib/deals/__tests__/` に置きます。

---

### Task 0: 作業場所の準備

**Files:** なし

- [ ] **Step 1: 部品を入れて、Prisma の型を作る**

```bash
cd /c/Users/issin/Desktop/Claude/property-management-worktrees/deals-foundation
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci > /tmp/deals-ci.log 2>&1; echo exit=$?
./node_modules/.bin/prisma generate > /tmp/deals-gen.log 2>&1; echo exit=$?
```
Expected: どちらも `exit=0`

- [ ] **Step 2: 着手前に、全部のテストが通ることを確かめる**

```bash
npx vitest run > /tmp/deals-baseline.log 2>&1; echo exit=$?; tail -5 /tmp/deals-baseline.log
```
Expected: `exit=0`。失敗があれば、それは既存の問題です。進めずに、発注者に報告します。

---

### Task 1: 選択肢・物件種別・取引番号・日時の純粋関数

**Files:**
- Create: `src/lib/deals/constants.ts`, `src/lib/deals/property-kind.ts`, `src/lib/deals/deal-no.ts`, `src/lib/deals/datetime.ts`
- Test: `src/lib/deals/__tests__/basics.test.ts`

**Interfaces:**
- Produces:
  - `DEAL_BUSINESS_TYPES`, `DEAL_TRADE_SIDES`, `DEAL_STATUSES`, `DEAL_PARTY_ROLES`, `DEAL_PARTY_TYPES`, `BASE_PROPERTY_KINDS`, `LAND_RIGHTS`, `BANK_ACCOUNT_TYPES`(すべて `as const` の配列)
  - それぞれの日本語名 `*_LABELS: Record<値, string>`
  - `type BasePropertyKind`、`interface PropertyKindDef { key: string; label: string; base: BasePropertyKind }`、`DEFAULT_PROPERTY_KINDS: PropertyKindDef[]`
  - `propertyKindFromPropertyType(t: string): BasePropertyKind | null`
  - `jstYear(now: Date): number`、`nextDealNo(year: number, latest: string | null): string`
  - `jstDateString(now: Date): string`(`YYYY-MM-DD`)、`isoToJstLocal(iso: string | null): string`、`jstLocalToIso(v: string): string | null`、`formatJstDateTime(iso: string | null): string`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/basics.test.ts
import { describe, it, expect } from "vitest";
import {
  DEAL_STATUSES, DEAL_STATUS_LABELS, DEAL_BUSINESS_TYPE_LABELS, DEAL_TRADE_SIDE_LABELS,
  DEAL_PARTY_ROLE_LABELS, DEFAULT_PROPERTY_KINDS,
} from "../constants";
import { propertyKindFromPropertyType } from "../property-kind";
import { jstYear, nextDealNo } from "../deal-no";
import { jstDateString, isoToJstLocal, jstLocalToIso, formatJstDateTime } from "../datetime";

describe("選択肢", () => {
  it("状態は4つで、日本語名がある", () => {
    expect(DEAL_STATUSES).toEqual(["considering", "contracted", "settled", "cancelled"]);
    expect(DEAL_STATUS_LABELS).toEqual({ considering: "検討中", contracted: "契約済", settled: "決済済", cancelled: "中止" });
  });
  it("事業区分・取引態様・当事者の役割の日本語名", () => {
    expect(DEAL_BUSINESS_TYPE_LABELS).toEqual({ brokerage: "仲介", resale: "買取再販" });
    expect(DEAL_TRADE_SIDE_LABELS).toEqual({ seller: "売主側", buyer: "買主側", both: "両手" });
    expect(DEAL_PARTY_ROLE_LABELS).toEqual({ seller: "売主", buyer: "買主", agent: "代理人", tenant: "賃借人" });
  });
  it("物件種別の初期値は4つ", () => {
    expect(DEFAULT_PROPERTY_KINDS.map((k) => [k.key, k.label, k.base])).toEqual([
      ["unit", "区分マンション", "unit"],
      ["house", "戸建", "house"],
      ["land", "土地", "land"],
      ["building", "一棟", "building"],
    ]);
  });
});

describe("物件の種類 → 取引の物件種別", () => {
  it.each([
    ["apartment_unit", "unit"], ["unit", "unit"],
    ["house", "house"], ["land", "land"],
    ["apartment_building", "building"], ["apartment_block", "building"], ["building", "building"],
    ["store", null], ["parking", null], ["unknown", null],
  ])("%s → %s", (t, k) => {
    expect(propertyKindFromPropertyType(t)).toBe(k);
  });
});

describe("取引番号", () => {
  it("日本時間の年で数える(UTC の大晦日 15:00 は日本の元日)", () => {
    expect(jstYear(new Date("2026-12-31T14:59:59Z"))).toBe(2026);
    expect(jstYear(new Date("2026-12-31T15:00:00Z"))).toBe(2027);
  });
  it("その年の最初は 0001、次は1つ足す、前の年の番号は無視する", () => {
    expect(nextDealNo(2026, null)).toBe("2026-0001");
    expect(nextDealNo(2026, "2026-0041")).toBe("2026-0042");
    expect(nextDealNo(2027, "2026-0041")).toBe("2027-0001");
  });
  it("1年に 9999 件を超えたら止める", () => {
    expect(() => nextDealNo(2026, "2026-9999")).toThrow();
  });
});

describe("日時", () => {
  it("日本時間の日付", () => {
    expect(jstDateString(new Date("2026-06-30T15:00:00Z"))).toBe("2026-07-01");
  });
  it("ISO と画面の入力(日本時間)を行き来する", () => {
    expect(isoToJstLocal("2026-07-01T01:30:00.000Z")).toBe("2026-07-01T10:30");
    expect(jstLocalToIso("2026-07-01T10:30")).toBe("2026-07-01T01:30:00.000Z");
    expect(isoToJstLocal(null)).toBe("");
    expect(jstLocalToIso("")).toBeNull();
  });
  it("表示用", () => {
    expect(formatJstDateTime("2026-07-01T01:30:00.000Z")).toBe("2026/07/01 10:30");
    expect(formatJstDateTime(null)).toBe("");
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/basics.test.ts`
Expected: FAIL(`Cannot find module '../constants'`)

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/constants.ts
/** 取引(設計 2026-10-23 §2)の選択肢。DB は TEXT の列・ここが許可リスト。 */
export const DEAL_BUSINESS_TYPES = ["brokerage", "resale"] as const;
export type DealBusinessType = (typeof DEAL_BUSINESS_TYPES)[number];
export const DEAL_BUSINESS_TYPE_LABELS: Record<DealBusinessType, string> = { brokerage: "仲介", resale: "買取再販" };

/** 取引態様。買取再販では使わない(自社が買主にも売主にもなる)。 */
export const DEAL_TRADE_SIDES = ["seller", "buyer", "both"] as const;
export type DealTradeSide = (typeof DEAL_TRADE_SIDES)[number];
export const DEAL_TRADE_SIDE_LABELS: Record<DealTradeSide, string> = { seller: "売主側", buyer: "買主側", both: "両手" };

export const DEAL_STATUSES = ["considering", "contracted", "settled", "cancelled"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  considering: "検討中", contracted: "契約済", settled: "決済済", cancelled: "中止",
};

export const DEAL_PARTY_ROLES = ["seller", "buyer", "agent", "tenant"] as const;
export type DealPartyRole = (typeof DEAL_PARTY_ROLES)[number];
export const DEAL_PARTY_ROLE_LABELS: Record<DealPartyRole, string> = { seller: "売主", buyer: "買主", agent: "代理人", tenant: "賃借人" };

export const DEAL_PARTY_TYPES = ["individual", "corporation"] as const;
export type DealPartyType = (typeof DEAL_PARTY_TYPES)[number];
export const DEAL_PARTY_TYPE_LABELS: Record<DealPartyType, string> = { individual: "個人", corporation: "法人" };

/** 帳票の出し分けに使う4つの基本の種別。設定で足す種別も、どれか1つを「元」に持つ。 */
export const BASE_PROPERTY_KINDS = ["unit", "house", "land", "building"] as const;
export type BasePropertyKind = (typeof BASE_PROPERTY_KINDS)[number];
export const BASE_PROPERTY_KIND_LABELS: Record<BasePropertyKind, string> = {
  unit: "区分マンション", house: "戸建", land: "土地", building: "一棟",
};
export interface PropertyKindDef { key: string; label: string; base: BasePropertyKind }
export const DEFAULT_PROPERTY_KINDS: PropertyKindDef[] = BASE_PROPERTY_KINDS.map((k) => ({
  key: k, label: BASE_PROPERTY_KIND_LABELS[k], base: k,
}));

export const LAND_RIGHTS = ["ownership", "leasehold"] as const;
export type LandRight = (typeof LAND_RIGHTS)[number];
export const LAND_RIGHT_LABELS: Record<LandRight, string> = { ownership: "所有権", leasehold: "借地権" };

export const BANK_ACCOUNT_TYPES = ["ordinary", "current"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];
export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = { ordinary: "普通", current: "当座" };
```

```ts
// src/lib/deals/property-kind.ts
import type { BasePropertyKind } from "./constants";

/**
 * 物件の種類(PropertyType)を、取引の物件種別に当てる。当てられない種類(店舗・駐車場など)は null
 * =画面で選んでもらう。旧値の building/unit も当てる(既存データに残っている)。
 */
const MAP: Record<string, BasePropertyKind> = {
  apartment_unit: "unit",
  unit: "unit",
  house: "house",
  land: "land",
  apartment_building: "building",
  apartment_block: "building",
  building: "building",
};

export function propertyKindFromPropertyType(t: string): BasePropertyKind | null {
  return MAP[t] ?? null;
}
```

```ts
// src/lib/deals/datetime.ts
/** 画面は日本時間・API は ISO(UTC)。端末の時間帯に左右されないよう、+09:00 を明示して変換する。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    y: j.getUTCFullYear(), mo: p(j.getUTCMonth() + 1), d: p(j.getUTCDate()),
    h: p(j.getUTCHours()), mi: p(j.getUTCMinutes()),
  };
}

export function jstDateString(now: Date): string {
  const t = jstParts(now);
  return `${t.y}-${t.mo}-${t.d}`;
}

export function isoToJstLocal(iso: string | null): string {
  if (!iso) return "";
  const t = jstParts(new Date(iso));
  return `${t.y}-${t.mo}-${t.d}T${t.h}:${t.mi}`;
}

export function jstLocalToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatJstDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = jstParts(new Date(iso));
  return `${t.y}/${t.mo}/${t.d} ${t.h}:${t.mi}`;
}
```

```ts
// src/lib/deals/deal-no.ts
/** 取引番号 = 日本時間の年 + "-" + 4桁の通し番号(例 2026-0001)。 */
export function jstYear(now: Date): number {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

export function nextDealNo(year: number, latest: string | null): string {
  const prefix = `${year}-`;
  const seq = latest && latest.startsWith(prefix) ? Number(latest.slice(prefix.length)) + 1 : 1;
  // 4桁を超えると文字列の並びで最新が取れなくなる(9999 の次が 10000 で前に並ぶ)ため止める。
  if (!Number.isInteger(seq) || seq > 9999) throw new Error("取引番号がこの年の上限(9999)に達しました");
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/basics.test.ts`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 取引の選択肢・物件種別・取引番号・日時の純粋関数"
```

---

### Task 2: 入力の検証・物件の写し・更新データ

**Files:**
- Create: `src/lib/deals/schemas.ts`, `src/lib/deals/snapshot.ts`, `src/lib/deals/change-values.ts`
- Test: `src/lib/deals/__tests__/schemas.test.ts`, `src/lib/deals/__tests__/snapshot.test.ts`, `src/lib/deals/__tests__/change-values.test.ts`

**Interfaces:**
- Consumes: Task 1 の定数
- Produces:
  - 型: `PropertySnapshot`、`CounterpartyBroker`、`BankAccount`、`DealCreateInput`、`DealUpdateInput`、`PartyInput`
  - 検証: `propertySnapshotSchema`、`counterpartyBrokerSchema`、`bankAccountSchema`、`propertyKindsSchema`、`dealCreateSchema`、`dealUpdateSchema`、`partyInputSchema`、`partyUpdateSchema`、`dealSettingsUpdateSchema`
  - 空の値: `EMPTY_SNAPSHOT`、`EMPTY_BROKER`、`EMPTY_BANK_ACCOUNT`
  - 写し: `readSnapshot(json: unknown): PropertySnapshot`、`readBroker(json: unknown): CounterpartyBroker`、`SNAPSHOT_PROPERTY_SELECT`、`buildSnapshotFromProperty(p): PropertySnapshot`
  - 更新: `DEAL_TRACKED_FIELDS`、`normalizeTradeSide(businessType: string, tradeSide: string | null | undefined): string | null`、`toDealUpdateData(patch: Omit<DealUpdateInput, "version">, currentBusinessType: string): Record<string, unknown>`、`dealChangeValues(v: Record<string, unknown>): Record<string, unknown>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import {
  dealCreateSchema, dealUpdateSchema, partyInputSchema, partyUpdateSchema,
  dealSettingsUpdateSchema, propertySnapshotSchema, EMPTY_SNAPSHOT,
} from "../schemas";

const UID = "66666666-6666-4666-8666-666666666666";

describe("取引の作成", () => {
  it("名前と事業区分があれば作れる・名前の前後の空白は落とす", () => {
    expect(dealCreateSchema.parse({ name: " 試験の取引 ", businessType: "brokerage" })).toMatchObject({ name: "試験の取引", businessType: "brokerage" });
  });
  it("名前が空・事業区分が知らない値は弾く", () => {
    expect(() => dealCreateSchema.parse({ name: "  ", businessType: "brokerage" })).toThrow();
    expect(() => dealCreateSchema.parse({ name: "a", businessType: "leaseback" })).toThrow();
  });
});

describe("取引の更新", () => {
  it("版の番号が要る・知らない項目は弾く", () => {
    expect(() => dealUpdateSchema.parse({ name: "a" })).toThrow();
    expect(() => dealUpdateSchema.parse({ version: 1, price: 100 })).toThrow();
  });
  it("空文字の場所は null にする・日時は ISO だけ", () => {
    expect(dealUpdateSchema.parse({ version: 1, contractPlace: " " }).contractPlace).toBeNull();
    expect(dealUpdateSchema.parse({ version: 1, contractAt: "2026-07-01T01:30:00.000Z" }).contractAt).toBe("2026-07-01T01:30:00.000Z");
    expect(() => dealUpdateSchema.parse({ version: 1, contractAt: "2026/07/01" })).toThrow();
  });
  it("担当は UUID か null", () => {
    expect(dealUpdateSchema.parse({ version: 1, assigneeId: UID }).assigneeId).toBe(UID);
    expect(dealUpdateSchema.parse({ version: 1, assigneeId: null }).assigneeId).toBeNull();
    expect(() => dealUpdateSchema.parse({ version: 1, assigneeId: "abc" })).toThrow();
  });
});

describe("物件の写し", () => {
  it("空の写しは検証を通る", () => {
    expect(propertySnapshotSchema.parse(EMPTY_SNAPSHOT)).toEqual(EMPTY_SNAPSHOT);
  });
  it("築月は 1〜12・面積は 0 以上", () => {
    expect(() => propertySnapshotSchema.parse({ ...EMPTY_SNAPSHOT, builtMonth: 13 })).toThrow();
    expect(() => propertySnapshotSchema.parse({ ...EMPTY_SNAPSHOT, landArea: -1 })).toThrow();
  });
});

describe("当事者", () => {
  it("持分は分子・分母の両方か、どちらも無し・分子は分母以下", () => {
    const base = { role: "seller", partyType: "individual", name: "試験 太郎" };
    expect(partyInputSchema.parse({ ...base, shareNum: 1, shareDen: 2 })).toMatchObject({ shareNum: 1, shareDen: 2 });
    expect(() => partyInputSchema.parse({ ...base, shareNum: 1 })).toThrow();
    expect(() => partyInputSchema.parse({ ...base, shareNum: 3, shareDen: 2 })).toThrow();
    expect(partyInputSchema.parse(base).isSelf).toBe(false);
  });
  it("更新は版の番号つきの一部だけでよい", () => {
    expect(partyUpdateSchema.parse({ version: 2, phone: "03-0000-0000" })).toEqual({ version: 2, phone: "03-0000-0000" });
  });
});

describe("取引の設定", () => {
  it("物件種別は基本の4つを必ず含み、鍵が重ならない", () => {
    const four = [
      { key: "unit", label: "区分マンション", base: "unit" }, { key: "house", label: "戸建", base: "house" },
      { key: "land", label: "土地", base: "land" }, { key: "building", label: "一棟", base: "building" },
    ];
    expect(dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, { key: "shop_unit", label: "店舗区分", base: "unit" }] }).propertyKinds).toHaveLength(5);
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: four.slice(1) })).toThrow();
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, four[0]] })).toThrow();
    expect(() => dealSettingsUpdateSchema.parse({ version: 0, propertyKinds: [...four, { key: "Bad Key", label: "x", base: "unit" }] })).toThrow();
  });
  it("口座番号は数字7桁まで", () => {
    expect(() => dealSettingsUpdateSchema.parse({ version: 1, bankAccount: { bankName: null, branchName: null, accountType: "ordinary", accountNumber: "12a4567", accountHolder: null } })).toThrow();
  });
});
```

```ts
// src/lib/deals/__tests__/snapshot.test.ts
import { describe, it, expect } from "vitest";
import { buildSnapshotFromProperty, readSnapshot, readBroker } from "../snapshot";
import { EMPTY_SNAPSHOT, EMPTY_BROKER } from "../schemas";

const prop = {
  propertyType: "apartment_unit", address: "東京都試験区試験町1-2-3", lotNumber: "試験町100番1", buildingNumber: "100番1の201",
  buildingName: "試験マンション", roomNo: "201", exclusiveArea: "65.40", totalFloorArea: "3000.00", landArea: "500.00",
  structureType: "RC", builtYear: 2001, builtMonth: 4, access: "試験線 試験駅 徒歩5分", layoutType: "3LDK",
  createdBy: "u1", assignedTo: null,
};

describe("物件から写しを作る", () => {
  it("区分は専有面積を、それ以外は延床面積を使う・数は数にする", () => {
    const s = buildSnapshotFromProperty(prop);
    expect(s).toEqual({
      buildingName: "試験マンション", roomNo: "201", address: "東京都試験区試験町1-2-3", lotNumber: "試験町100番1",
      buildingNumber: "100番1の201", propertyTypeLabel: "区分マンション", structure: "RC", builtYear: 2001, builtMonth: 4,
      floorArea: 65.4, landArea: 500, landRight: null, access: "試験線 試験駅 徒歩5分", layout: "3LDK",
    });
    expect(buildSnapshotFromProperty({ ...prop, propertyType: "house" }).floorArea).toBe(3000);
  });
  it("空の値は null", () => {
    const s = buildSnapshotFromProperty({ ...prop, roomNo: null, exclusiveArea: null, landArea: null, builtYear: null, builtMonth: null });
    expect([s.roomNo, s.floorArea, s.landArea, s.builtYear]).toEqual([null, null, null, null]);
  });
});

describe("保存済みの写しを読む", () => {
  it("欠けた項目・壊れた値は空で補う", () => {
    expect(readSnapshot({})).toEqual(EMPTY_SNAPSHOT);
    expect(readSnapshot({ roomNo: "301", builtMonth: 99 })).toEqual({ ...EMPTY_SNAPSHOT, roomNo: "301" });
    expect(readSnapshot(null)).toEqual(EMPTY_SNAPSHOT);
    expect(readBroker({ company: "試験不動産" })).toEqual({ ...EMPTY_BROKER, company: "試験不動産" });
  });
});
```

```ts
// src/lib/deals/__tests__/change-values.test.ts
import { describe, it, expect } from "vitest";
import { normalizeTradeSide, toDealUpdateData, dealChangeValues, DEAL_TRACKED_FIELDS } from "../change-values";
import { buildChangeLogEntries } from "@/lib/change-log";

describe("取引態様", () => {
  it("買取再販では常に空", () => {
    expect(normalizeTradeSide("resale", "both")).toBeNull();
    expect(normalizeTradeSide("brokerage", "both")).toBe("both");
    expect(normalizeTradeSide("brokerage", undefined)).toBeNull();
  });
});

describe("更新データ", () => {
  it("送られた項目だけ・日時は Date にする", () => {
    expect(toDealUpdateData({ name: "新しい名前", contractAt: "2026-07-01T01:30:00.000Z", settlementAt: null }, "brokerage")).toEqual({
      name: "新しい名前", contractAt: new Date("2026-07-01T01:30:00.000Z"), settlementAt: null,
    });
  });
  it("買取再販へ切り替えたら取引態様を空にする(態様を送っていなくても)", () => {
    expect(toDealUpdateData({ businessType: "resale" }, "brokerage")).toEqual({ businessType: "resale", tradeSide: null });
  });
  it("買取再販のまま態様だけ送っても空のまま", () => {
    expect(toDealUpdateData({ tradeSide: "seller" }, "resale")).toEqual({ tradeSide: null });
  });
  it("仲介へ戻すときは送った態様を使う", () => {
    expect(toDealUpdateData({ businessType: "brokerage", tradeSide: "buyer" }, "resale")).toEqual({ businessType: "brokerage", tradeSide: "buyer" });
  });
  it("写しと相手方の仲介会社は、そのまま入れる", () => {
    const broker = { company: "試験不動産", staff: null, tel: null };
    expect(toDealUpdateData({ counterpartyBroker: broker }, "brokerage")).toEqual({ counterpartyBroker: broker });
  });
});

describe("変更履歴の値", () => {
  it("追跡する項目だけ・日時は ISO 文字列", () => {
    const v = dealChangeValues({ name: "a", contractAt: new Date("2026-07-01T01:30:00.000Z"), price: 1n, propertySnapshot: {} });
    expect(v).toEqual({ name: "a", contractAt: "2026-07-01T01:30:00.000Z" });
  });
  it("変わった項目だけが履歴の行になる", () => {
    const old = dealChangeValues({ name: "a", status: "considering", contractAt: null });
    const neu = dealChangeValues({ name: "a", status: "contracted", contractAt: null });
    const rows = buildChangeLogEntries({ targetTable: "deals", targetId: "d", changedBy: "u", oldValues: old, newValues: neu, trackedFields: DEAL_TRACKED_FIELDS });
    expect(rows.map((r) => [r.fieldName, r.oldValue, r.newValue])).toEqual([["status", "considering", "contracted"]]);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/schemas.test.ts src/lib/deals/__tests__/snapshot.test.ts src/lib/deals/__tests__/change-values.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/schemas.ts
import { z } from "zod";
import {
  BANK_ACCOUNT_TYPES, BASE_PROPERTY_KINDS, DEAL_BUSINESS_TYPES, DEAL_PARTY_ROLES, DEAL_PARTY_TYPES,
  DEAL_STATUSES, DEAL_TRADE_SIDES, LAND_RIGHTS,
} from "./constants";

/** 文字の欄: 前後の空白を落とし、空なら null。 */
const text = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === "" ? null : v));
const isoDateTime = z.string().datetime({ offset: true }).nullable();
const userRef = z.string().uuid().nullable();

export const propertySnapshotSchema = z.object({
  buildingName: text(200),
  roomNo: text(50),
  address: text(300),
  lotNumber: text(300),
  buildingNumber: text(100),
  propertyTypeLabel: text(50),
  structure: text(100),
  builtYear: z.number().int().min(1800).max(2200).nullable(),
  builtMonth: z.number().int().min(1).max(12).nullable(),
  floorArea: z.number().nonnegative().max(10_000_000).nullable(),
  landArea: z.number().nonnegative().max(10_000_000).nullable(),
  landRight: z.enum(LAND_RIGHTS).nullable(),
  access: text(500),
  layout: text(50),
}).strict();
export type PropertySnapshot = z.output<typeof propertySnapshotSchema>;
export const EMPTY_SNAPSHOT: PropertySnapshot = {
  buildingName: null, roomNo: null, address: null, lotNumber: null, buildingNumber: null, propertyTypeLabel: null,
  structure: null, builtYear: null, builtMonth: null, floorArea: null, landArea: null, landRight: null, access: null, layout: null,
};

export const counterpartyBrokerSchema = z.object({ company: text(200), staff: text(100), tel: text(50) }).strict();
export type CounterpartyBroker = z.output<typeof counterpartyBrokerSchema>;
export const EMPTY_BROKER: CounterpartyBroker = { company: null, staff: null, tel: null };

export const bankAccountSchema = z.object({
  bankName: text(100),
  branchName: text(100),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable(),
  accountNumber: z.string().trim().regex(/^\d{0,7}$/).nullable().transform((v) => (v ? v : null)),
  accountHolder: text(100),
}).strict();
export type BankAccount = z.output<typeof bankAccountSchema>;
export const EMPTY_BANK_ACCOUNT: BankAccount = { bankName: null, branchName: null, accountType: null, accountNumber: null, accountHolder: null };

const propertyKindSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,30}$/),
  label: z.string().trim().min(1).max(30),
  base: z.enum(BASE_PROPERTY_KINDS),
}).strict();
export const propertyKindsSchema = z.array(propertyKindSchema).min(4).max(20)
  .refine((ks) => new Set(ks.map((k) => k.key)).size === ks.length, "物件種別の鍵が重なっています")
  .refine((ks) => BASE_PROPERTY_KINDS.every((b) => ks.some((k) => k.key === b)), "基本の4種別は消せません");

export const dealCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  businessType: z.enum(DEAL_BUSINESS_TYPES),
  tradeSide: z.enum(DEAL_TRADE_SIDES).nullable().optional(),
  propertyId: z.string().uuid().nullable().optional(),
  propertyKind: z.string().min(1).max(30).nullable().optional(),
  hasOc: z.boolean().optional(),
  propertySnapshot: propertySnapshotSchema.optional(),
}).strict();
export type DealCreateInput = z.output<typeof dealCreateSchema>;

export const dealUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  businessType: z.enum(DEAL_BUSINESS_TYPES).optional(),
  tradeSide: z.enum(DEAL_TRADE_SIDES).nullable().optional(),
  status: z.enum(DEAL_STATUSES).optional(),
  assigneeId: userRef.optional(),
  licensedAgentId: userRef.optional(),
  salesStaffId: userRef.optional(),
  opsStaffId: userRef.optional(),
  propertyKind: z.string().min(1).max(30).nullable().optional(),
  hasOc: z.boolean().optional(),
  contractAt: isoDateTime.optional(),
  contractPlace: text(200).optional(),
  settlementAt: isoDateTime.optional(),
  settlementPlace: text(200).optional(),
  propertySnapshot: propertySnapshotSchema.optional(),
  counterpartyBroker: counterpartyBrokerSchema.optional(),
}).strict();
export type DealUpdateInput = z.output<typeof dealUpdateSchema>;

const partyFields = {
  role: z.enum(DEAL_PARTY_ROLES),
  partyType: z.enum(DEAL_PARTY_TYPES),
  name: z.string().trim().min(1).max(200),
  representative: text(100).optional(),
  address: text(300).optional(),
  phone: text(50).optional(),
  shareNum: z.number().int().positive().nullable().optional(),
  shareDen: z.number().int().positive().nullable().optional(),
};
type Share = { shareNum?: number | null; shareDen?: number | null };
const shareOk = (v: Share) => {
  const n = v.shareNum ?? null;
  const d = v.shareDen ?? null;
  if (n === null && d === null) return true;
  return n !== null && d !== null && n <= d;
};
const SHARE_MESSAGE = "持分は分子と分母の両方を入れてください(分子は分母以下)";

export const partyInputSchema = z.object({ ...partyFields, isSelf: z.boolean().default(false) }).strict()
  .refine(shareOk, SHARE_MESSAGE);
export type PartyInput = z.output<typeof partyInputSchema>;

export const partyUpdateSchema = z.object({
  version: z.number().int().positive(),
  role: partyFields.role.optional(),
  partyType: partyFields.partyType.optional(),
  name: partyFields.name.optional(),
  representative: partyFields.representative,
  address: partyFields.address,
  phone: partyFields.phone,
  shareNum: partyFields.shareNum,
  shareDen: partyFields.shareDen,
  isSelf: z.boolean().optional(),
}).strict()
  // 持分は片方だけ直すと組がずれるので、直すときは両方送る。
  .refine((v) => (v.shareNum === undefined) === (v.shareDen === undefined), SHARE_MESSAGE)
  .refine((v) => v.shareNum === undefined || shareOk(v), SHARE_MESSAGE);

export const dealSettingsUpdateSchema = z.object({
  /** 0 = まだ設定の行が無い(初めての保存)。 */
  version: z.number().int().min(0),
  representativeTitle: text(50).optional(),
  representativeName: text(100).optional(),
  bankAccount: bankAccountSchema.optional(),
  propertyKinds: propertyKindsSchema.optional(),
}).strict();
```

```ts
// src/lib/deals/snapshot.ts
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import {
  EMPTY_BROKER, EMPTY_SNAPSHOT, counterpartyBrokerSchema, propertySnapshotSchema,
  type CounterpartyBroker, type PropertySnapshot,
} from "./schemas";

/** 写しに使う物件の列(+現地担当の範囲判定に使う createdBy/assignedTo)。 */
export const SNAPSHOT_PROPERTY_SELECT = {
  propertyType: true, address: true, lotNumber: true, buildingNumber: true, buildingName: true, roomNo: true,
  exclusiveArea: true, totalFloorArea: true, landArea: true, structureType: true, builtYear: true, builtMonth: true,
  access: true, layoutType: true, createdBy: true, assignedTo: true,
} as const;

type Num = { toString(): string } | number | string | null;
interface SnapshotSource {
  propertyType: string; address: string; lotNumber: string | null; buildingNumber: string | null;
  buildingName: string | null; roomNo: string | null; exclusiveArea: Num; totalFloorArea: Num; landArea: Num;
  structureType: string | null; builtYear: number | null; builtMonth: number | null; access: string | null; layoutType: string | null;
}

const num = (v: Num): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | null) => (v && v.trim() ? v.trim() : null);

/** 物件 → 写し。住居表示の専用欄は無いので住所を当てる(設計 §1)。土地の権利は物件に無い=空。 */
export function buildSnapshotFromProperty(p: SnapshotSource): PropertySnapshot {
  const isUnit = p.propertyType === "apartment_unit" || p.propertyType === "unit";
  return {
    buildingName: str(p.buildingName), roomNo: str(p.roomNo), address: str(p.address), lotNumber: str(p.lotNumber),
    buildingNumber: str(p.buildingNumber), propertyTypeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? null,
    structure: str(p.structureType), builtYear: p.builtYear, builtMonth: p.builtMonth,
    floorArea: num(isUnit ? p.exclusiveArea : p.totalFloorArea), landArea: num(p.landArea), landRight: null,
    access: str(p.access), layout: str(p.layoutType),
  };
}

/** 保存済みの JSON を読む。欠け・壊れた項目は1つずつ空で補う(1つの不正で全体を捨てない)。 */
function readEach<T extends Record<string, unknown>>(json: unknown, empty: T, shape: Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>): T {
  const src = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...empty };
  for (const key of Object.keys(empty)) {
    if (!(key in src)) continue;
    const r = shape[key].safeParse(src[key]);
    if (r.success) out[key] = r.data;
  }
  return out as T;
}

export function readSnapshot(json: unknown): PropertySnapshot {
  return readEach(json, EMPTY_SNAPSHOT, propertySnapshotSchema.shape);
}

export function readBroker(json: unknown): CounterpartyBroker {
  return readEach(json, EMPTY_BROKER, counterpartyBrokerSchema.shape);
}
```

```ts
// src/lib/deals/change-values.ts
import type { DealUpdateInput } from "./schemas";

/** 変更履歴に残す取引の項目(値が人に読める単純な項目だけ。写しなどの JSON は監査に項目名だけ残す)。 */
export const DEAL_TRACKED_FIELDS = [
  "name", "businessType", "tradeSide", "status", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId",
  "propertyKind", "hasOc", "contractAt", "contractPlace", "settlementAt", "settlementPlace",
];

const SIMPLE_KEYS = [
  "name", "businessType", "status", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId",
  "propertyKind", "hasOc", "contractPlace", "settlementPlace", "propertySnapshot", "counterpartyBroker",
] as const;
const DATE_KEYS = ["contractAt", "settlementAt"] as const;

export function normalizeTradeSide(businessType: string, tradeSide: string | null | undefined): string | null {
  return businessType === "resale" ? null : tradeSide ?? null;
}

/** PATCH の本文 → DB に書く値。送られていない項目は入れない(=触らない)。 */
export function toDealUpdateData(
  patch: Omit<DealUpdateInput, "version">,
  currentBusinessType: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const k of SIMPLE_KEYS) if (patch[k] !== undefined) data[k] = patch[k];
  for (const k of DATE_KEYS) {
    const v = patch[k];
    if (v !== undefined) data[k] = v === null ? null : new Date(v);
  }
  if (patch.tradeSide !== undefined || patch.businessType !== undefined) {
    const bt = patch.businessType ?? currentBusinessType;
    if (bt === "resale") data.tradeSide = null;
    else if (patch.tradeSide !== undefined) data.tradeSide = patch.tradeSide;
  }
  return data;
}

/** 変更履歴に渡す値(追跡する項目だけ・日時は ISO 文字列=String(Date) の読みにくい形を避ける)。 */
export function dealChangeValues(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DEAL_TRACKED_FIELDS) {
    if (!(k in v)) continue;
    const val = v[k];
    out[k] = val instanceof Date ? val.toISOString() : val;
  }
  return out;
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 入力の検証・物件の写し・更新データの純粋関数"
```

---

### Task 3: 税率の表と取引の設定(純粋関数)

**Files:**
- Create: `src/lib/deals/rate-tables.ts`, `src/lib/deals/settings.ts`
- Test: `src/lib/deals/__tests__/rate-tables.test.ts`, `src/lib/deals/__tests__/settings.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 の `DEFAULT_PROPERTY_KINDS`、`BASE_PROPERTY_KINDS`、`jstDateString`
  - Task 2 の `bankAccountSchema`、`propertyKindsSchema`、`EMPTY_BANK_ACCOUNT`
- Produces:
  - 税率の表: `RATE_TABLE_KINDS`、`RATE_TABLE_KIND_LABELS`、`interface RateTableSeed { kind; validFrom: string; validTo: string | null; content: unknown }`、`INITIAL_RATE_TABLES: RateTableSeed[]`
  - 期間で選ぶ: `interface RateTableRow { kind: string; validFrom: Date; validTo: Date | null; content: unknown }`、`pickRateTable(rows: RateTableRow[], kind: string, baseDate: string): RateTableRow | null`、`consumptionTaxRateBp(rows: RateTableRow[], baseDate: string): number`
  - 設定: `interface DealSettingsView { representativeTitle; representativeName; bankAccount: BankAccount; propertyKinds: PropertyKindDef[]; version: number; updatedAt: string | null }`、`interface DealSettingsRow`、`resolveDealSettings(row: DealSettingsRow | null): DealSettingsView`、`isKnownPropertyKind(s: DealSettingsView, kind: string | null | undefined): boolean`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/rate-tables.test.ts
import { describe, it, expect } from "vitest";
import { INITIAL_RATE_TABLES, pickRateTable, consumptionTaxRateBp, type RateTableRow } from "../rate-tables";

const row = (kind: string, from: string, to: string | null, content: unknown): RateTableRow => ({
  kind, validFrom: new Date(`${from}T00:00:00Z`), validTo: to ? new Date(`${to}T00:00:00Z`) : null, content,
});

describe("期間で表を選ぶ", () => {
  const rows = [
    row("stamp_contract", "2014-04-01", "2027-03-31", { v: "reduced" }),
    row("stamp_contract", "2027-04-01", null, { v: "standard" }),
    row("consumption_tax", "2019-10-01", null, { rateBp: 1000 }),
  ];
  it("終了日の当日までは古い表・翌日から新しい表", () => {
    expect(pickRateTable(rows, "stamp_contract", "2027-03-31")?.content).toEqual({ v: "reduced" });
    expect(pickRateTable(rows, "stamp_contract", "2027-04-01")?.content).toEqual({ v: "standard" });
  });
  it("始まる前は無い", () => {
    expect(pickRateTable(rows, "stamp_contract", "2014-03-31")).toBeNull();
  });
  it("消費税率・表が無ければ 10%", () => {
    expect(consumptionTaxRateBp(rows, "2026-10-24")).toBe(1000);
    expect(consumptionTaxRateBp([], "2026-10-24")).toBe(1000);
  });
});

describe("初期データ", () => {
  it("5種類がそろい、同じ種類の期間は重ならない", () => {
    expect(new Set(INITIAL_RATE_TABLES.map((t) => t.kind))).toEqual(
      new Set(["consumption_tax", "brokerage_tiers", "stamp_contract", "stamp_receipt", "capital_gains"]),
    );
    const contract = INITIAL_RATE_TABLES.filter((t) => t.kind === "stamp_contract");
    expect(contract.map((t) => [t.validFrom, t.validTo])).toEqual([["2014-04-01", "2027-03-31"], ["2027-04-01", null]]);
  });
  it("印紙税の金額の区分は小さい順で、最後は上限なし", () => {
    for (const t of INITIAL_RATE_TABLES.filter((x) => x.kind.startsWith("stamp_"))) {
      const b = (t.content as { brackets: { upTo: number | null; tax: number }[] }).brackets;
      const ups = b.slice(0, -1).map((x) => x.upTo as number);
      expect([...ups].sort((x, y) => x - y)).toEqual(ups);
      expect(b[b.length - 1].upTo).toBeNull();
    }
  });
});
```

```ts
// src/lib/deals/__tests__/settings.test.ts
import { describe, it, expect } from "vitest";
import { resolveDealSettings, isKnownPropertyKind } from "../settings";
import { DEFAULT_PROPERTY_KINDS } from "../constants";
import { EMPTY_BANK_ACCOUNT } from "../schemas";

describe("取引の設定の解決", () => {
  it("行が無ければ初期値・版は 0", () => {
    expect(resolveDealSettings(null)).toEqual({
      representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT,
      propertyKinds: DEFAULT_PROPERTY_KINDS, version: 0, updatedAt: null,
    });
  });
  it("保存した種別を使う・壊れていれば初期値", () => {
    const kinds = [...DEFAULT_PROPERTY_KINDS, { key: "shop_unit", label: "店舗区分", base: "unit" }];
    const at = new Date("2026-10-24T00:00:00Z");
    const base = { representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, version: 3, updatedAt: at };
    expect(resolveDealSettings({ ...base, propertyKinds: kinds }).propertyKinds).toHaveLength(5);
    expect(resolveDealSettings({ ...base, propertyKinds: [{ key: "x" }] }).propertyKinds).toEqual(DEFAULT_PROPERTY_KINDS);
    expect(resolveDealSettings({ ...base, propertyKinds: [] }).version).toBe(3);
  });
  it("知っている種別か", () => {
    const s = resolveDealSettings(null);
    expect(isKnownPropertyKind(s, "unit")).toBe(true);
    expect(isKnownPropertyKind(s, null)).toBe(true);
    expect(isKnownPropertyKind(s, "castle")).toBe(false);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/rate-tables.test.ts src/lib/deals/__tests__/settings.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/rate-tables.ts
/**
 * 税率・税額の表(設計 §2.5)。適用期間で切り替える。初期値は 2026-10 時点で公開されている現行の制度。
 * 率の単位は 1/100 %(10% = 1000)。金額の区分 upTo は「その金額以下」・null は上限なし。
 * ⚠この初期値は migration 20261024100000_add_deals の INSERT と一致させる(テストで照合)。
 */
export const RATE_TABLE_KINDS = ["consumption_tax", "brokerage_tiers", "stamp_contract", "stamp_receipt", "capital_gains"] as const;
export type RateTableKind = (typeof RATE_TABLE_KINDS)[number];
export const RATE_TABLE_KIND_LABELS: Record<RateTableKind, string> = {
  consumption_tax: "消費税率",
  brokerage_tiers: "仲介手数料",
  stamp_contract: "印紙税(売買契約書)",
  stamp_receipt: "印紙税(領収書)",
  capital_gains: "譲渡所得の税率",
};

export interface RateTableSeed { kind: RateTableKind; validFrom: string; validTo: string | null; content: unknown }

const bracket = (upTo: number | null, tax: number) => ({ upTo, tax });

export const INITIAL_RATE_TABLES: RateTableSeed[] = [
  { kind: "consumption_tax", validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 } },
  {
    kind: "brokerage_tiers", validFrom: "2024-07-01", validTo: null,
    content: {
      tiers: [{ upTo: 2000000, rateBp: 500 }, { upTo: 4000000, rateBp: 400 }, { upTo: null, rateBp: 300 }],
      lowCostSpecial: { priceLimit: 8000000, feeCap: 300000 },
    },
  },
  {
    // 軽減措置(令和9年3月31日まで)。
    kind: "stamp_contract", validFrom: "2014-04-01", validTo: "2027-03-31",
    content: { brackets: [
      bracket(9999, 0), bracket(100000, 200), bracket(500000, 200), bracket(1000000, 500), bracket(5000000, 1000),
      bracket(10000000, 5000), bracket(50000000, 10000), bracket(100000000, 30000), bracket(500000000, 60000),
      bracket(1000000000, 160000), bracket(5000000000, 320000), bracket(null, 480000),
    ] },
  },
  {
    // 本則。
    kind: "stamp_contract", validFrom: "2027-04-01", validTo: null,
    content: { brackets: [
      bracket(9999, 0), bracket(100000, 200), bracket(500000, 400), bracket(1000000, 1000), bracket(5000000, 2000),
      bracket(10000000, 10000), bracket(50000000, 20000), bracket(100000000, 60000), bracket(500000000, 100000),
      bracket(1000000000, 200000), bracket(5000000000, 400000), bracket(null, 600000),
    ] },
  },
  {
    // 売上代金の受取書。5万円未満は非課税。
    kind: "stamp_receipt", validFrom: "2014-04-01", validTo: null,
    content: { brackets: [
      bracket(49999, 0), bracket(1000000, 200), bracket(2000000, 400), bracket(3000000, 600), bracket(5000000, 1000),
      bracket(10000000, 2000), bracket(20000000, 4000), bracket(30000000, 6000), bracket(50000000, 10000),
      bracket(100000000, 20000), bracket(200000000, 40000), bracket(300000000, 60000), bracket(500000000, 100000),
      bracket(1000000000, 150000), bracket(null, 200000),
    ] },
  },
  {
    // 復興特別所得税(所得税額の 2.1%)は 2037 年まで。
    kind: "capital_gains", validFrom: "2013-01-01", validTo: "2037-12-31",
    content: {
      long: { incomeTaxBp: 1500, residentTaxBp: 500 },
      short: { incomeTaxBp: 3000, residentTaxBp: 900 },
      reconstructionBp: 210, longTermYears: 5, residentialDeduction: 30000000, unknownCostRateBp: 500,
    },
  },
];

export interface RateTableRow { kind: string; validFrom: Date; validTo: Date | null; content: unknown }

const day = (d: Date) => d.toISOString().slice(0, 10);

/** baseDate(YYYY-MM-DD)が期間に入る表。重なっていたら始まりが新しい方。 */
export function pickRateTable(rows: RateTableRow[], kind: string, baseDate: string): RateTableRow | null {
  const hits = rows.filter((r) => r.kind === kind && day(r.validFrom) <= baseDate && (r.validTo === null || baseDate <= day(r.validTo)));
  hits.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
  return hits[0] ?? null;
}

export function consumptionTaxRateBp(rows: RateTableRow[], baseDate: string): number {
  const c = pickRateTable(rows, "consumption_tax", baseDate)?.content as { rateBp?: unknown } | undefined;
  return typeof c?.rateBp === "number" && Number.isInteger(c.rateBp) ? c.rateBp : 1000;
}
```

```ts
// src/lib/deals/settings.ts
import { DEFAULT_PROPERTY_KINDS, type PropertyKindDef } from "./constants";
import { EMPTY_BANK_ACCOUNT, bankAccountSchema, propertyKindsSchema, type BankAccount } from "./schemas";

export const DEAL_SETTINGS_ID = "singleton";

export interface DealSettingsRow {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: unknown;
  propertyKinds: unknown;
  version: number;
  updatedAt: Date;
}

export interface DealSettingsView {
  representativeTitle: string | null;
  representativeName: string | null;
  bankAccount: BankAccount;
  propertyKinds: PropertyKindDef[];
  /** 0 = 行がまだ無い。 */
  version: number;
  updatedAt: string | null;
}

/** DB の行 → 画面・API で使う形。欠けた・壊れた値は初期値で補う。 */
export function resolveDealSettings(row: DealSettingsRow | null): DealSettingsView {
  if (!row) {
    return { representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT, propertyKinds: DEFAULT_PROPERTY_KINDS, version: 0, updatedAt: null };
  }
  const kinds = propertyKindsSchema.safeParse(row.propertyKinds);
  const bank = bankAccountSchema.safeParse({ ...EMPTY_BANK_ACCOUNT, ...(row.bankAccount && typeof row.bankAccount === "object" ? row.bankAccount : {}) });
  return {
    representativeTitle: row.representativeTitle,
    representativeName: row.representativeName,
    bankAccount: bank.success ? bank.data : EMPTY_BANK_ACCOUNT,
    propertyKinds: kinds.success ? kinds.data : DEFAULT_PROPERTY_KINDS,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isKnownPropertyKind(s: DealSettingsView, kind: string | null | undefined): boolean {
  return kind === null || kind === undefined || s.propertyKinds.some((k) => k.key === kind);
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 税率の表の初期値と取引の設定の解決"
```

---

### Task 4: DB(5つの表)・migration・権限の配線

**Files:**
- Modify: `prisma/schema.prisma`(末尾にモデルを足す。User と Property には逆向きの参照の行を足す)
- Create: `prisma/migrations/20261024100000_add_deals/migration.sql`
- Modify: `prisma/seed.ts`(agent_inquiry の付与の直後)
- Modify: `src/app/(dashboard)/admin/templates/[id]/page.tsx`、`src/app/(dashboard)/admin/users/[id]/permissions/page.tsx`(RESOURCES の agent_inquiry の次)
- Modify: `src/lib/api-helpers.ts`(mock の権限の一覧)
- Test: `src/lib/deals/__tests__/migration-scan.test.ts`

**Interfaces:**
- Consumes: Task 3 の `INITIAL_RATE_TABLES`
- Produces:
  - Prisma のモデル: `prisma.deal`、`prisma.dealParty`、`prisma.dealDocument`、`prisma.dealSettings`、`prisma.dealRateTable`(項目名は下のとおり)
  - 権限: `deal`(read / write)

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/migration-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INITIAL_RATE_TABLES } from "../rate-tables";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261024100000_add_deals/migration.sql");

describe("取引の migration(設計 §2)", () => {
  it("5表を作る", () => {
    for (const t of ["deals", "deal_parties", "deal_documents", "deal_settings", "deal_rate_tables"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });
  it("取引番号は一意・版の番号を持つ", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "deals_deal_no_key" ON "deals"\("deal_no"\);/);
    expect(sql).toMatch(/CREATE TABLE "deals" \([^;]*"version" INTEGER NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/CREATE TABLE "deal_parties" \([^;]*"version" INTEGER NOT NULL DEFAULT 1/);
  });
  it("物件・担当を消しても取引は残る(空欄に戻す)・当事者は取引と一緒に消える・発行履歴は取引を消させない", () => {
    expect(sql).toMatch(/"deals_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE SET NULL/);
    expect(sql).toMatch(/"deals_assignee_id_fkey" FOREIGN KEY \("assignee_id"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/);
    expect(sql).toMatch(/"deal_parties_deal_id_fkey" FOREIGN KEY \("deal_id"\) REFERENCES "deals"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"deal_documents_deal_id_fkey" FOREIGN KEY \("deal_id"\) REFERENCES "deals"\("id"\) ON DELETE RESTRICT/);
  });
  it("税率の初期データは INITIAL_RATE_TABLES と同じ", () => {
    const rows = [...sql.matchAll(/\('([a-z_]+)', DATE '(\d{4}-\d{2}-\d{2})', (NULL|DATE '\d{4}-\d{2}-\d{2}'), '([^']+)'::jsonb\)/g)].map((m) => ({
      kind: m[1], validFrom: m[2], validTo: m[3] === "NULL" ? null : m[3].slice(6, 16), content: JSON.parse(m[4]),
    }));
    expect(rows).toEqual(INITIAL_RATE_TABLES);
  });
  it("3テンプレートに deal read/write を付与(重複しない)", () => {
    for (const a of ["read", "write"]) {
      expect(sql).toMatch(new RegExp(`'deal', '${a}', true[\\s\\S]*?IN \\('管理者用', '事務担当用', '現地担当用'\\)[\\s\\S]*?ON CONFLICT \\("template_id", "resource", "action"\\) DO NOTHING`));
    }
  });
  it("既存の行を書き換えない・既存の表の列を変えない", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)" ([A-Z ]+)/g)) {
      expect(m[1], m[1]).toMatch(/^deal/);
      expect(m[2], `${m[1]} ${m[2]}`).toMatch(/^ADD CONSTRAINT/);
    }
  });
});

describe("権限 deal の配線", () => {
  it("2つの権限画面の RESOURCES に同じ行", () => {
    for (const p of [
      "src/app/(dashboard)/admin/templates/[id]/page.tsx",
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    ]) {
      expect(read(p), p).toContain('{ key: "deal", label: "取引", actions: ["read", "write"] }');
    }
  });
  it("seed で3テンプレートに付与・mock にもある", () => {
    const seed = read("prisma/seed.ts");
    for (const t of ["fieldStaffTemplate", "officeStaffTemplate", "adminTemplate"]) {
      for (const a of ["read", "write"]) {
        expect(seed).toContain(`{ templateId: ${t}.id, resource: "deal", action: "${a}", granted: true }`);
      }
    }
    const helpers = read("src/lib/api-helpers.ts");
    expect(helpers).toContain('{ resource: "deal", action: "read", granted: true }');
    expect(helpers).toContain('{ resource: "deal", action: "write", granted: true }');
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/migration-scan.test.ts`
Expected: FAIL(`ENOENT ... migration.sql`)

- [ ] **Step 3: schema.prisma にモデルを足す**

`prisma/schema.prisma` の末尾に足します。

```prisma
// 取引(設計 docs/superpowers/specs/2026-10-23-deals-documents-design.md §2)。画面の名前は「取引」。
// 選択肢は TEXT + アプリの許可リスト(src/lib/deals/constants.ts)。金額は円の整数(BigInt)。
model Deal {
  id                 String    @id @default(uuid()) @db.Uuid
  /// 年+4桁(例 2026-0001)。src/lib/deals/deal-no.ts。
  dealNo             String    @unique @map("deal_no")
  name               String
  businessType       String    @map("business_type")
  /// 売主側/買主側/両手。買取再販では null。
  tradeSide          String?   @map("trade_side")
  status             String    @default("considering")
  assigneeId         String?   @map("assignee_id") @db.Uuid
  licensedAgentId    String?   @map("licensed_agent_id") @db.Uuid
  salesStaffId       String?   @map("sales_staff_id") @db.Uuid
  opsStaffId         String?   @map("ops_staff_id") @db.Uuid
  /// 既存物件。手入力の物件は null で、写し(propertySnapshot)だけを持つ。
  propertyId         String?   @map("property_id") @db.Uuid
  propertyKind       String?   @map("property_kind")
  hasOc              Boolean   @default(false) @map("has_oc")
  contractAt         DateTime? @map("contract_at")
  contractPlace      String?   @map("contract_place")
  settlementAt       DateTime? @map("settlement_at")
  settlementPlace    String?   @map("settlement_place")
  price              BigInt?
  buildingTax        BigInt?   @map("building_tax")
  deposit            BigInt?
  /// 1/100 %(10% = 1000)。作成時に税率の表から入れる。
  taxRateBp          Int       @default(1000) @map("tax_rate_bp")
  propertySnapshot   Json      @default("{}") @map("property_snapshot") @db.JsonB
  assessments        Json      @default("[]") @db.JsonB
  costs              Json      @default("{}") @db.JsonB
  counterpartyBroker Json      @default("{}") @map("counterparty_broker") @db.JsonB
  settlementTerms    Json      @default("{}") @map("settlement_terms") @db.JsonB
  leases             Json      @default("[]") @db.JsonB
  planInputs         Json      @default("{}") @map("plan_inputs") @db.JsonB
  checklistState     Json      @default("{}") @map("checklist_state") @db.JsonB
  overrides          Json      @default("{}") @db.JsonB
  version            Int       @default(1)
  createdById        String    @map("created_by_id") @db.Uuid
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  assignee      User?          @relation("DealAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  licensedAgent User?          @relation("DealLicensedAgent", fields: [licensedAgentId], references: [id], onDelete: SetNull)
  salesStaff    User?          @relation("DealSalesStaff", fields: [salesStaffId], references: [id], onDelete: SetNull)
  opsStaff      User?          @relation("DealOpsStaff", fields: [opsStaffId], references: [id], onDelete: SetNull)
  createdBy     User           @relation("DealCreatedBy", fields: [createdById], references: [id])
  property      Property?      @relation(fields: [propertyId], references: [id], onDelete: SetNull)
  parties       DealParty[]
  documents     DealDocument[]

  @@index([status, settlementAt])
  @@index([businessType])
  @@index([assigneeId])
  @@index([propertyId])
  @@index([createdAt])
  @@map("deals")
}

model DealParty {
  id             String   @id @default(uuid()) @db.Uuid
  dealId         String   @map("deal_id") @db.Uuid
  /// seller/buyer/agent/tenant
  role           String
  /// individual/corporation
  partyType      String   @map("party_type")
  name           String
  representative String?
  address        String?
  phone          String?
  shareNum       Int?     @map("share_num")
  shareDen       Int?     @map("share_den")
  isSelf         Boolean  @default(false) @map("is_self")
  sortOrder      Int      @default(0) @map("sort_order")
  version        Int      @default(1)
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  deal Deal @relation(fields: [dealId], references: [id], onDelete: Cascade)

  @@index([dealId, role, sortOrder])
  @@map("deal_parties")
}

/// 書類の発行履歴(段3から使う)。再発行しても前の版は消さない。
model DealDocument {
  id            String   @id @default(uuid()) @db.Uuid
  dealId        String   @map("deal_id") @db.Uuid
  docType       String   @map("doc_type")
  /// 購入/売却・社内用/銀行向け など。無いときは空文字(一意の鍵に null を入れない)。
  variant       String   @default("")
  version       Int
  issuedAt      DateTime @default(now()) @map("issued_at")
  issuedById    String   @map("issued_by_id") @db.Uuid
  inputSnapshot Json     @map("input_snapshot") @db.JsonB
  calcSnapshot  Json     @map("calc_snapshot") @db.JsonB
  pdfKey        String?  @map("pdf_key")
  xlsxKey       String?  @map("xlsx_key")
  fileBaseName  String   @map("file_base_name")

  deal     Deal @relation(fields: [dealId], references: [id], onDelete: Restrict)
  issuedBy User @relation("DealDocumentIssuedBy", fields: [issuedById], references: [id])

  @@unique([dealId, docType, variant, version])
  @@index([dealId, issuedAt])
  @@map("deal_documents")
}

/// 取引の設定(1行だけ・id=singleton)。会社名・免許・電話・住所は company_profile を使う。
model DealSettings {
  id                  String   @id @default("singleton")
  representativeTitle String?  @map("representative_title")
  representativeName  String?  @map("representative_name")
  bankAccount         Json     @default("{}") @map("bank_account") @db.JsonB
  logoKey             String?  @map("logo_key")
  sealKey             String?  @map("seal_key")
  texts               Json     @default("{}") @db.JsonB
  checklistItems      Json     @default("[]") @map("checklist_items") @db.JsonB
  propertyKinds       Json     @default("[]") @map("property_kinds") @db.JsonB
  sectionMatrix       Json     @default("{}") @map("section_matrix") @db.JsonB
  /// cap=上限で計算 / manual=手入力
  brokerageMethod     String   @default("cap") @map("brokerage_method")
  version             Int      @default(1)
  updatedAt           DateTime @updatedAt @map("updated_at")
  updatedById         String?  @map("updated_by_id") @db.Uuid

  @@map("deal_settings")
}

/// 税率・税額の表(適用期間つき)。src/lib/deals/rate-tables.ts。
model DealRateTable {
  id          String    @id @default(uuid()) @db.Uuid
  kind        String
  validFrom   DateTime  @map("valid_from") @db.Date
  validTo     DateTime? @map("valid_to") @db.Date
  content     Json      @db.JsonB
  updatedById String?   @map("updated_by_id") @db.Uuid
  updatedAt   DateTime  @default(now()) @updatedAt @map("updated_at")

  @@index([kind, validFrom])
  @@map("deal_rate_tables")
}
```

`model User { ... }` の relation が並んでいるところに、次を足します(列は増えません)。

```prisma
  dealsAssigned       Deal[]         @relation("DealAssignee")
  dealsLicensed       Deal[]         @relation("DealLicensedAgent")
  dealsSales          Deal[]         @relation("DealSalesStaff")
  dealsOps            Deal[]         @relation("DealOpsStaff")
  dealsCreated        Deal[]         @relation("DealCreatedBy")
  dealDocumentsIssued DealDocument[] @relation("DealDocumentIssuedBy")
```

`model Property { ... }` の relation が並んでいるところに、`deals Deal[]` を足します。

- [ ] **Step 4: migration の SQL を作る**

```bash
git show origin/main:prisma/schema.prisma > /tmp/schema-main.prisma
./node_modules/.bin/prisma migrate diff --help | grep -i "from-schema\|to-schema"
```

ヘルプに出たフラグ名(Prisma 7 では `--from-schema` / `--to-schema`)で、次を実行します。

```bash
mkdir -p prisma/migrations/20261024100000_add_deals
./node_modules/.bin/prisma migrate diff --from-schema /tmp/schema-main.prisma --to-schema prisma/schema.prisma --script > prisma/migrations/20261024100000_add_deals/migration.sql; echo exit=$?
```

Expected: `exit=0`。SQL に入っているのは、`CREATE TABLE`(5つ)、`CREATE INDEX` / `CREATE UNIQUE INDEX`、`ALTER TABLE "deal..." ADD CONSTRAINT ... FOREIGN KEY` だけです。既存の表への `ALTER` が混ざっていたら、schema の書き間違いです。直してから作り直します。

作った SQL の末尾に、次を手で足します。JSON は `INITIAL_RATE_TABLES` を `JSON.stringify` した形と同じにします。テストで照合します。

```sql
-- 税率・税額の表の初期データ(src/lib/deals/rate-tables.ts の INITIAL_RATE_TABLES と同じ)。
INSERT INTO "deal_rate_tables" ("id", "kind", "valid_from", "valid_to", "content", "updated_at")
SELECT gen_random_uuid(), v.kind, v.valid_from, v.valid_to, v.content, now()
FROM (VALUES
  ('consumption_tax', DATE '2019-10-01', NULL, '{"rateBp":1000}'::jsonb),
  ('brokerage_tiers', DATE '2024-07-01', NULL, '{"tiers":[{"upTo":2000000,"rateBp":500},{"upTo":4000000,"rateBp":400},{"upTo":null,"rateBp":300}],"lowCostSpecial":{"priceLimit":8000000,"feeCap":300000}}'::jsonb),
  ('stamp_contract', DATE '2014-04-01', DATE '2027-03-31', '{"brackets":[{"upTo":9999,"tax":0},{"upTo":100000,"tax":200},{"upTo":500000,"tax":200},{"upTo":1000000,"tax":500},{"upTo":5000000,"tax":1000},{"upTo":10000000,"tax":5000},{"upTo":50000000,"tax":10000},{"upTo":100000000,"tax":30000},{"upTo":500000000,"tax":60000},{"upTo":1000000000,"tax":160000},{"upTo":5000000000,"tax":320000},{"upTo":null,"tax":480000}]}'::jsonb),
  ('stamp_contract', DATE '2027-04-01', NULL, '{"brackets":[{"upTo":9999,"tax":0},{"upTo":100000,"tax":200},{"upTo":500000,"tax":400},{"upTo":1000000,"tax":1000},{"upTo":5000000,"tax":2000},{"upTo":10000000,"tax":10000},{"upTo":50000000,"tax":20000},{"upTo":100000000,"tax":60000},{"upTo":500000000,"tax":100000},{"upTo":1000000000,"tax":200000},{"upTo":5000000000,"tax":400000},{"upTo":null,"tax":600000}]}'::jsonb),
  ('stamp_receipt', DATE '2014-04-01', NULL, '{"brackets":[{"upTo":49999,"tax":0},{"upTo":1000000,"tax":200},{"upTo":2000000,"tax":400},{"upTo":3000000,"tax":600},{"upTo":5000000,"tax":1000},{"upTo":10000000,"tax":2000},{"upTo":20000000,"tax":4000},{"upTo":30000000,"tax":6000},{"upTo":50000000,"tax":10000},{"upTo":100000000,"tax":20000},{"upTo":200000000,"tax":40000},{"upTo":300000000,"tax":60000},{"upTo":500000000,"tax":100000},{"upTo":1000000000,"tax":150000},{"upTo":null,"tax":200000}]}'::jsonb),
  ('capital_gains', DATE '2013-01-01', DATE '2037-12-31', '{"long":{"incomeTaxBp":1500,"residentTaxBp":500},"short":{"incomeTaxBp":3000,"residentTaxBp":900},"reconstructionBp":210,"longTermYears":5,"residentialDeduction":30000000,"unknownCostRateBp":500}'::jsonb)
) AS v(kind, valid_from, valid_to, content);

-- 権限 deal(取引)を3テンプレートへ付与(設計 §2.6: 全員が閲覧・編集)。
-- fresh DB ではテンプレート未作成のため 0 行になり、seed が同じ行を作る。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'deal', 'read', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'deal', 'write', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
```

⚠ `VALUES` の中の `NULL` は型が決まりません。PostgreSQL が「date と text を合わせられない」で止まる場合は、`NULL::date` と書きます。その場合は、テストの正規表現の `NULL` も `NULL::date` に合わせて直します。どちらにしたかは、この計画の実行記録に残します。

- [ ] **Step 5: 権限を配線する**

`prisma/seed.ts` の agent_inquiry 6行の直後に、次を足します。

```ts
    // 取引(設計 2026-10-23 §2.6)。全員が閲覧・編集。
    { templateId: fieldStaffTemplate.id, resource: "deal", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "deal", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "deal", action: "read", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "deal", action: "write", granted: true },
    { templateId: officeStaffTemplate.id, resource: "deal", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "deal", action: "write", granted: true },
```

2つの権限画面の `RESOURCES` で、agent_inquiry の行の次に、次を足します。

```ts
  // 取引(設計 2026-10-23)。全員に既定付与。⚠ もう一方の権限画面の RESOURCES と必ず同内容にすること。
  { key: "deal", label: "取引", actions: ["read", "write"] },
```

`src/lib/api-helpers.ts` の mock の一覧で、agent_inquiry の2行の次に、次を足します。

```ts
      // 取引(deal)。mock は admin 相当のため付与。
      { resource: "deal", action: "read", granted: true },
      { resource: "deal", action: "write", granted: true },
```

- [ ] **Step 6: 型を作り直し、テストを走らせる**

```bash
./node_modules/.bin/prisma generate > /tmp/deals-gen.log 2>&1; echo exit=$?
npx vitest run src/lib/deals/__tests__ > /tmp/deals-t4.log 2>&1; echo exit=$?; tail -5 /tmp/deals-t4.log
npx tsc --noEmit > /tmp/deals-tsc.log 2>&1; echo exit=$?
```
Expected: どれも `exit=0`

- [ ] **Step 7: コミットする**

```bash
git add prisma src/lib/api-helpers.ts "src/app/(dashboard)/admin/templates/[id]/page.tsx" "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx" src/lib/deals
git commit -m "feat(deals): 取引の5表・税率の初期データ・権限 deal"
```

---

### Task 5: 権限の確認・設定の読み込み・監査の名前、一覧と作成の API

**Files:**
- Create: `src/lib/deals/guard.ts`、`src/lib/deals/settings-store.ts`、`src/lib/deals/view.ts`、`src/app/api/deals/route.ts`、`src/app/api/deals/options/route.ts`
- Modify: `src/app/(dashboard)/admin/audit-logs/page.tsx`(ACTION_LABELS と TARGET_TABLE_LABELS)
- Test: `src/lib/deals/__tests__/deals-route.test.ts`、`src/lib/deals/__tests__/route-mocks.ts`

**Interfaces:**
- Consumes:
  - Task 1〜3 の関数
  - Prisma のモデル
  - `canAccessPropertyRecord`(`@/lib/property-access`)
  - `resolveCompanyProfile`(`@/lib/sales-sheet/company-profile-store`)
- Produces:
  - 権限の確認: `requireDeal(action: "read" | "write"): Promise<{ session; perms }>`、`requireDealAdmin(): Promise<session>`、`DEAL_VERSION_CONFLICT_MESSAGE`
  - 設定の読み込み: `loadDealSettings(): Promise<DealSettingsView>`
  - 一覧の形: `DEAL_LIST_SELECT`、`interface DealListItem { id; dealNo; name; businessType; status; contractAt: string | null; settlementAt: string | null; assigneeName: string | null }`、`toDealListItem(row): DealListItem`
  - API の応答:
    - `GET /api/deals` → `{ deals: DealListItem[]; total: number; page: number; pageSize: number }`
    - `POST /api/deals` → 201 `{ id, dealNo }`
    - `GET /api/deals/options` → `{ propertyKinds: PropertyKindDef[]; selfParty: { name: string; representative: string | null; address: string | null; phone: string | null } }`
  - 監査の action: `deal_create`、`deal_update`、`deal_property_refresh`、`deal_party_create`、`deal_party_update`、`deal_party_delete`、`deal_settings_update`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/route-mocks.ts
/** 取引の route テストの共通 mock。既存の反響の受付の部品を使い回す。 */
export { nextServerMock, apiHelpersMock, jsonRequest } from "@/lib/__tests__/agent-inquiry-route-mocks";
export const DEAL_ID = "11111111-1111-4111-8111-111111111111";
export const PROP_ID = "22222222-2222-4222-8222-222222222222";
export const PARTY_ID = "33333333-3333-4333-8333-333333333333";
export const USER_ID = "66666666-6666-4666-8666-666666666666";
export const DEAL_PERMS = [
  { resource: "deal", action: "read", granted: true },
  { resource: "deal", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
];
```

```ts
// src/lib/deals/__tests__/deals-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null), create: vi.fn() },
    property: { findUnique: vi.fn(async () => null) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    dealRateTable: { findMany: vi.fn(async () => []) },
    companyProfile: { findUnique: vi.fn(async () => null) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, DEAL_PERMS } from "./route-mocks";
import { GET as LIST, POST } from "../../../app/api/deals/route";
import { GET as OPTIONS } from "../../../app/api/deals/options/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findMany: Fn; count: Fn; findFirst: Fn; create: Fn };
  property: { findUnique: Fn };
  dealSettings: { findUnique: Fn };
  dealRateTable: { findMany: Fn };
  companyProfile: { findUnique: Fn };
};
const propRow = {
  propertyType: "apartment_unit", address: "東京都試験区試験町1-2-3", lotNumber: null, buildingNumber: null,
  buildingName: "試験マンション", roomNo: "201", exclusiveArea: "65.40", totalFloorArea: null, landArea: null,
  structureType: null, builtYear: 2001, builtMonth: 4, access: null, layoutType: null, createdBy: "someone", assignedTo: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T03:00:00Z"));
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.create.mockResolvedValue({ id: DEAL_ID, dealNo: "2026-0001" });
});

describe("GET /api/deals", () => {
  it("権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await LIST(new Request("http://x/api/deals"))).status).toBe(403);
  });
  it("絞り込み(状態・事業区分・自分の担当・名前か番号)", async () => {
    const res = await LIST(new Request("http://x/api/deals?status=contracted&businessType=resale&assignee=me&q=試験&page=2"));
    expect(res.status).toBe(200);
    expect(pm.deal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "contracted", businessType: "resale", assigneeId: "u-office",
        OR: [{ name: { contains: "試験", mode: "insensitive" } }, { dealNo: { contains: "試験" } }],
      },
      skip: 50, take: 50,
    }));
  });
  it("知らない状態は 422", async () => {
    expect((await LIST(new Request("http://x/api/deals?status=lease"))).status).toBe(422);
  });
});

describe("POST /api/deals", () => {
  it("手入力の物件で作る・番号は日本時間の年の最初・税率は表から", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([{ kind: "consumption_tax", validFrom: new Date("2019-10-01T00:00:00Z"), validTo: null, content: { rateBp: 1000 } }]);
    const res = await POST(json("POST", { name: "試験の取引", businessType: "brokerage", tradeSide: "both", propertyKind: "land" }));
    expect(res.status).toBe(201);
    expect(pm.deal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", propertyKind: "land",
      propertyId: null, taxRateBp: 1000, createdById: "u-office",
    }) }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_create", targetTable: "deals", targetId: DEAL_ID }));
    const detail = JSON.stringify((writeAuditLog as Fn).mock.calls[0][0].detail);
    expect(detail).not.toContain("試験の取引");
  });
  it("買取再販では取引態様を空にする", async () => {
    await POST(json("POST", { name: "再販", businessType: "resale", tradeSide: "seller" }));
    expect(pm.deal.create.mock.calls[0][0].data.tradeSide).toBeNull();
  });
  it("物件から作ると写しと種別をサーバーで入れる(送られた写しは使わない)", async () => {
    pm.property.findUnique.mockResolvedValue(propRow);
    await POST(json("POST", { name: "a", businessType: "brokerage", propertyId: PROP_ID, propertySnapshot: { buildingName: "偽物" } }));
    const data = pm.deal.create.mock.calls[0][0].data;
    expect(data.propertyId).toBe(PROP_ID);
    expect(data.propertyKind).toBe("unit");
    expect(data.propertySnapshot).toMatchObject({ buildingName: "試験マンション", roomNo: "201", floorArea: 65.4 });
  });
  it("現地担当は担当外の物件から作れない(404・住所は返さない)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue(propRow);
    const res = await POST(json("POST", { name: "a", businessType: "brokerage", propertyId: PROP_ID }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("試験町");
    expect(pm.deal.create).not.toHaveBeenCalled();
  });
  it("物件を見る権限が無ければ物件から作れない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.resource !== "property"));
    expect((await POST(json("POST", { name: "a", businessType: "brokerage", propertyId: PROP_ID }))).status).toBe(403);
  });
  it("設定にない種別は 422", async () => {
    expect((await POST(json("POST", { name: "a", businessType: "brokerage", propertyKind: "castle" }))).status).toBe(422);
  });
  it("番号がぶつかったら次の番号で作り直す", async () => {
    pm.deal.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ dealNo: "2026-0001" });
    pm.deal.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" })).mockResolvedValueOnce({ id: DEAL_ID, dealNo: "2026-0002" });
    const res = await POST(json("POST", { name: "a", businessType: "brokerage" }));
    expect(res.status).toBe(201);
    expect(pm.deal.create.mock.calls.map((c) => c[0].data.dealNo)).toEqual(["2026-0001", "2026-0002"]);
  });
});

describe("GET /api/deals/options", () => {
  it("物件種別と、自社を入れるための会社情報(代表者は設定から)", async () => {
    pm.dealSettings.findUnique.mockResolvedValue({ representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, propertyKinds: [], version: 1, updatedAt: new Date() });
    pm.companyProfile.findUnique.mockResolvedValue({ nameJa: "試験不動産株式会社", license: null, tel: "03-0000-0000", fax: null, email: null, hp: null, address: "東京都試験区1-1" });
    const body = await (await OPTIONS()).json();
    expect(body.propertyKinds.map((k: { key: string }) => k.key)).toEqual(["unit", "house", "land", "building"]);
    expect(body.selfParty).toEqual({ name: "試験不動産株式会社", representative: "代表取締役 試験 太郎", address: "東京都試験区1-1", phone: "03-0000-0000" });
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/deals-route.test.ts`
Expected: FAIL(route が無い)

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/guard.ts
import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/** 取引の権限(設計 §2.6)。全員に既定付与・管理画面で個別に外せる。 */
export async function requireDeal(action: "read" | "write") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "deal", action)) {
    throw new ApiError(403, "取引の権限がありません", "FORBIDDEN");
  }
  return { session, perms };
}

/** 取引の設定・税率の表は管理者だけ(会社情報の設定と同じ判定)。 */
export async function requireDealAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "取引の設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

export const DEAL_VERSION_CONFLICT_MESSAGE = "ほかの人が先に更新しました。画面を読み込み直してください。";
```

```ts
// src/lib/deals/settings-store.ts
import prisma from "@/lib/prisma";
import { DEAL_SETTINGS_ID, resolveDealSettings, type DealSettingsView } from "./settings";

export async function loadDealSettings(): Promise<DealSettingsView> {
  const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
  return resolveDealSettings(row);
}
```

```ts
// src/lib/deals/view.ts
import type { Prisma } from "@/generated/prisma";
import { readBroker, readSnapshot } from "./snapshot";
import type { CounterpartyBroker, PropertySnapshot } from "./schemas";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const yen = (v: bigint | null) => (v === null ? null : Number(v));
const userName = { select: { id: true, name: true } } as const;

export const DEAL_LIST_SELECT = {
  id: true, dealNo: true, name: true, businessType: true, status: true, contractAt: true, settlementAt: true,
  assignee: userName,
} satisfies Prisma.DealSelect;

export interface DealListItem {
  id: string; dealNo: string; name: string; businessType: string; status: string;
  contractAt: string | null; settlementAt: string | null; assigneeName: string | null;
}

export function toDealListItem(r: Prisma.DealGetPayload<{ select: typeof DEAL_LIST_SELECT }>): DealListItem {
  return {
    id: r.id, dealNo: r.dealNo, name: r.name, businessType: r.businessType, status: r.status,
    contractAt: iso(r.contractAt), settlementAt: iso(r.settlementAt), assigneeName: r.assignee?.name ?? null,
  };
}

export const DEAL_PARTY_SELECT = {
  id: true, role: true, partyType: true, name: true, representative: true, address: true, phone: true,
  shareNum: true, shareDen: true, isSelf: true, sortOrder: true, version: true,
} satisfies Prisma.DealPartySelect;
export type DealPartyView = Prisma.DealPartyGetPayload<{ select: typeof DEAL_PARTY_SELECT }>;

export const DEAL_DETAIL_SELECT = {
  id: true, dealNo: true, name: true, businessType: true, tradeSide: true, status: true,
  assigneeId: true, licensedAgentId: true, salesStaffId: true, opsStaffId: true,
  propertyId: true, propertyKind: true, hasOc: true,
  contractAt: true, contractPlace: true, settlementAt: true, settlementPlace: true,
  price: true, buildingTax: true, deposit: true, taxRateBp: true,
  propertySnapshot: true, counterpartyBroker: true, version: true, createdAt: true, updatedAt: true,
  parties: { select: DEAL_PARTY_SELECT, orderBy: [{ role: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.DealSelect;

export interface DealView {
  id: string; dealNo: string; name: string; businessType: string; tradeSide: string | null; status: string;
  assigneeId: string | null; licensedAgentId: string | null; salesStaffId: string | null; opsStaffId: string | null;
  propertyId: string | null; propertyKind: string | null; hasOc: boolean;
  contractAt: string | null; contractPlace: string | null; settlementAt: string | null; settlementPlace: string | null;
  price: number | null; buildingTax: number | null; deposit: number | null; taxRateBp: number;
  propertySnapshot: PropertySnapshot; counterpartyBroker: CounterpartyBroker;
  version: number; createdAt: string; updatedAt: string; parties: DealPartyView[];
}

export function toDealView(r: Prisma.DealGetPayload<{ select: typeof DEAL_DETAIL_SELECT }>): DealView {
  return {
    id: r.id, dealNo: r.dealNo, name: r.name, businessType: r.businessType, tradeSide: r.tradeSide, status: r.status,
    assigneeId: r.assigneeId, licensedAgentId: r.licensedAgentId, salesStaffId: r.salesStaffId, opsStaffId: r.opsStaffId,
    propertyId: r.propertyId, propertyKind: r.propertyKind, hasOc: r.hasOc,
    contractAt: iso(r.contractAt), contractPlace: r.contractPlace, settlementAt: iso(r.settlementAt), settlementPlace: r.settlementPlace,
    price: yen(r.price), buildingTax: yen(r.buildingTax), deposit: yen(r.deposit), taxRateBp: r.taxRateBp,
    propertySnapshot: readSnapshot(r.propertySnapshot), counterpartyBroker: readBroker(r.counterpartyBroker),
    version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), parties: r.parties,
  };
}
```

```ts
// src/app/api/deals/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal } from "@/lib/deals/guard";
import { dealCreateSchema, EMPTY_SNAPSHOT } from "@/lib/deals/schemas";
import { DEAL_BUSINESS_TYPES, DEAL_STATUSES } from "@/lib/deals/constants";
import { jstYear, nextDealNo } from "@/lib/deals/deal-no";
import { jstDateString } from "@/lib/deals/datetime";
import { buildSnapshotFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";
import { propertyKindFromPropertyType } from "@/lib/deals/property-kind";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { isKnownPropertyKind } from "@/lib/deals/settings";
import { consumptionTaxRateBp } from "@/lib/deals/rate-tables";
import { normalizeTradeSide } from "@/lib/deals/change-values";
import { DEAL_LIST_SELECT, toDealListItem } from "@/lib/deals/view";

const NO_STORE = { "Cache-Control": "no-store" };
const PAGE_SIZE = 50;
/** 取引番号がぶつかったとき(同時に作った)に作り直す回数。 */
const DEAL_NO_ATTEMPTS = 3;

const listQuery = z.object({
  status: z.enum(DEAL_STATUSES).optional(),
  businessType: z.enum(DEAL_BUSINESS_TYPES).optional(),
  assignee: z.union([z.literal("me"), z.string().uuid()]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

/** 取引の一覧(新しい順・50件ずつ)。 */
export async function GET(request: Request) {
  try {
    const { session } = await requireDeal("read");
    const sp = new URL(request.url).searchParams;
    const query = listQuery.parse(Object.fromEntries([...sp.entries()].filter(([, v]) => v.trim() !== "")));
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.businessType ? { businessType: query.businessType } : {}),
      ...(query.assignee ? { assigneeId: query.assignee === "me" ? session.id : query.assignee } : {}),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: "insensitive" as const } }, { dealNo: { contains: query.q } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.deal.findMany({
        where, select: DEAL_LIST_SELECT, orderBy: [{ createdAt: "desc" }],
        skip: (query.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      }),
      prisma.deal.count({ where }),
    ]);
    return NextResponse.json(
      { deals: rows.map(toDealListItem), total, page: query.page, pageSize: PAGE_SIZE },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * 取引を作る。物件から作るときは、写しと種別をサーバーで物件から入れる(送られた写しは使わない)。
 * 物件は「物件を見る権限」+「現地担当は自分の作成・担当の物件だけ」(物件の詳しい画面と同じ範囲)。
 */
export async function POST(request: Request) {
  try {
    const { session, perms } = await requireDeal("write");
    const body = dealCreateSchema.parse(await parseJsonBody(request));

    let snapshot = body.propertySnapshot ?? EMPTY_SNAPSHOT;
    let propertyKind = body.propertyKind ?? null;
    if (body.propertyId) {
      if (!hasPermission(perms, "property", "read")) {
        throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
      }
      const p = await prisma.property.findUnique({ where: { id: body.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
      // 見られない物件は「無い」と同じ返事にする(あることも住所も漏らさない)。
      if (!p || !canAccessPropertyRecord(session, p)) {
        throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
      }
      snapshot = buildSnapshotFromProperty(p);
      propertyKind = propertyKind ?? propertyKindFromPropertyType(p.propertyType);
    }

    const settings = await loadDealSettings();
    if (!isKnownPropertyKind(settings, propertyKind)) {
      throw new ApiError(422, "物件種別を選び直してください", "UNKNOWN_PROPERTY_KIND");
    }

    const now = new Date();
    const rateRows = await prisma.dealRateTable.findMany({ where: { kind: "consumption_tax" } });
    const taxRateBp = consumptionTaxRateBp(rateRows, jstDateString(now));
    const year = jstYear(now);

    for (let attempt = 1; ; attempt++) {
      const latest = await prisma.deal.findFirst({
        where: { dealNo: { startsWith: `${year}-` } }, orderBy: { dealNo: "desc" }, select: { dealNo: true },
      });
      const dealNo = nextDealNo(year, latest?.dealNo ?? null);
      try {
        const created = await prisma.deal.create({
          data: {
            dealNo, name: body.name, businessType: body.businessType,
            tradeSide: normalizeTradeSide(body.businessType, body.tradeSide),
            propertyId: body.propertyId ?? null, propertyKind, hasOc: body.hasOc ?? false,
            propertySnapshot: snapshot, taxRateBp, createdById: session.id,
          },
          select: { id: true, dealNo: true },
        });
        await writeAuditLog({
          userId: session.id, action: "deal_create", targetTable: "deals", targetId: created.id,
          detail: { fields: Object.keys(body).sort() },
        });
        return NextResponse.json(created, { status: 201, headers: NO_STORE });
      } catch (e) {
        if (isUniqueViolation(e) && attempt < DEAL_NO_ATTEMPTS) continue;
        throw e;
      }
    }
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/deals/options/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

/** 取引の画面で使う選択肢(物件種別)と、当事者に「自社を入れる」ための会社情報。 */
export async function GET() {
  try {
    await requireDeal("read");
    const [settings, companyRow] = await Promise.all([
      loadDealSettings(),
      prisma.companyProfile.findUnique({ where: { id: "singleton" } }),
    ]);
    const company = resolveCompanyProfile(companyRow);
    const representative = [settings.representativeTitle, settings.representativeName].filter(Boolean).join(" ") || null;
    return NextResponse.json(
      {
        propertyKinds: settings.propertyKinds,
        selfParty: { name: company.nameJa, representative, address: company.address || null, phone: company.tel || null },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/(dashboard)/admin/audit-logs/page.tsx` の `ACTION_LABELS` の末尾(閉じ括弧の前)に、次を足します。

```ts
  // 取引(設計 2026-10-23)。detail は変えた項目の名前だけ。
  deal_create: "取引を作成",
  deal_update: "取引を更新",
  deal_property_refresh: "取引の物件を取り直し",
  deal_party_create: "取引の当事者を追加",
  deal_party_update: "取引の当事者を更新",
  deal_party_delete: "取引の当事者を削除",
  deal_settings_update: "取引の設定を変更",
```

`TARGET_TABLE_LABELS` には、次を足します。

```ts
  deals: "取引",
  deal_settings: "取引の設定",
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__ "src/app/(dashboard)/__tests__/audit-action-labels-scan.test.ts"`
Expected: PASS。ラベル走査が、この段の後の Task で足す action も求める場合は、上のラベルで足りています。

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals src/app/api/deals "src/app/(dashboard)/admin/audit-logs/page.tsx"
git commit -m "feat(deals): 取引の一覧・作成・選択肢の API"
```

---

### Task 6: 1件の取得・更新・物件から取り直す API

**Files:**
- Create: `src/app/api/deals/[id]/route.ts`、`src/app/api/deals/[id]/refresh-property/route.ts`
- Test: `src/lib/deals/__tests__/deal-item-route.test.ts`

**Interfaces:**
- Consumes:
  - Task 5 の `requireDeal`、`DEAL_VERSION_CONFLICT_MESSAGE`、`DEAL_DETAIL_SELECT`、`toDealView`、`loadDealSettings`
  - Task 2 の `toDealUpdateData`、`dealChangeValues`、`DEAL_TRACKED_FIELDS`
  - `assertActiveUser`(`@/lib/agent-inquiry/user-check`)
  - `recordChangesInTx`(`@/lib/change-log`)
- Produces:
  - `GET /api/deals/[id]` → `{ deal: DealView; canOpenProperty: boolean }`
  - `PATCH /api/deals/[id]`(本文 `DealUpdateInput`)→ `{ version: number }`。版が合わなければ 409 `VERSION_CONFLICT`
  - `POST /api/deals/[id]/refresh-property`(本文 `{ version }`)→ `{ version: number }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/deal-item-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { recordChangesInTx } = vi.hoisted(() => ({ recordChangesInTx: vi.fn() }));
vi.mock("@/lib/change-log", async (orig) => ({ ...(await orig<typeof import("@/lib/change-log")>()), recordChangesInTx }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    property: { findUnique: vi.fn(async () => null) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, USER_ID, DEAL_PERMS } from "./route-mocks";
import { GET, PATCH } from "../../../app/api/deals/[id]/route";
import { POST as REFRESH } from "../../../app/api/deals/[id]/refresh-property/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn; updateMany: Fn };
  property: { findUnique: Fn };
  user: { findUnique: Fn };
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const detailRow = {
  id: DEAL_ID, dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: PROP_ID, propertyKind: "unit", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null, price: 30000000n, buildingTax: null, deposit: null,
  taxRateBp: 1000, propertySnapshot: { roomNo: "201" }, counterpartyBroker: {}, version: 3,
  createdAt: new Date("2026-10-24T00:00:00Z"), updatedAt: new Date("2026-10-24T00:00:00Z"), parties: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(detailRow);
  pm.user.findUnique.mockResolvedValue({ isActive: true });
});

describe("GET /api/deals/[id]", () => {
  it("金額は数・写しは空で補う・物件を開けるか", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.deal.price).toBe(30000000);
    expect(body.deal.propertySnapshot.roomNo).toBe("201");
    expect(body.deal.propertySnapshot.address).toBeNull();
    expect(body.canOpenProperty).toBe(true);
  });
  it("現地担当で担当外の物件なら、物件は開けない(取引は見られる)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue({ createdBy: "other", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(false);
  });
  it("無ければ 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
});

describe("PATCH /api/deals/[id]", () => {
  it("版の番号で書き、変更履歴と監査(項目名だけ)を残す", async () => {
    const res = await PATCH(json("PATCH", { version: 3, status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 4 });
    expect(pm.deal.updateMany).toHaveBeenCalledWith({
      where: { id: DEAL_ID, version: 3 },
      data: { status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID, version: { increment: 1 } },
    });
    expect(recordChangesInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetTable: "deals", targetId: DEAL_ID, changedBy: "u-office",
      oldValues: expect.objectContaining({ status: "considering" }), newValues: expect.objectContaining({ status: "contracted" }),
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "deal_update", targetId: DEAL_ID, detail: { fields: ["assigneeId", "contractPlace", "status"] },
    }));
  });
  it("ほかの人が先に保存していたら 409・上書きしない", async () => {
    pm.deal.updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(json("PATCH", { version: 2, name: "古い画面からの保存" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("無効な担当者・設定にない種別は 422", async () => {
    pm.user.findUnique.mockResolvedValue({ isActive: false });
    expect((await PATCH(json("PATCH", { version: 3, assigneeId: USER_ID }), ctx)).status).toBe(422);
    pm.user.findUnique.mockResolvedValue({ isActive: true });
    expect((await PATCH(json("PATCH", { version: 3, propertyKind: "castle" }), ctx)).status).toBe(422);
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("買取再販へ切り替えたら取引態様も空にする", async () => {
    await PATCH(json("PATCH", { version: 3, businessType: "resale" }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ businessType: "resale", tradeSide: null });
  });
});

describe("POST /api/deals/[id]/refresh-property", () => {
  const propRow = {
    propertyType: "house", address: "東京都試験区2-2", lotNumber: null, buildingNumber: null, buildingName: null, roomNo: null,
    exclusiveArea: null, totalFloorArea: "98.5", landArea: "120", structureType: null, builtYear: null, builtMonth: null,
    access: null, layoutType: null, createdBy: "u-office", assignedTo: null,
  };
  it("物件の今の値で写しを上書きする", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue(propRow);
    const res = await REFRESH(json("POST", { version: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(pm.deal.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: DEAL_ID, version: 3 },
      data: { propertySnapshot: expect.objectContaining({ address: "東京都試験区2-2", floorArea: 98.5, landArea: 120 }) },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_property_refresh" }));
  });
  it("手入力の物件の取引では 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: null });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(422);
  });
  it("見られない物件なら 404", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue({ ...propRow, createdBy: "other" });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(404);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/deal-item-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/app/api/deals/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { recordChangesInTx } from "@/lib/change-log";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { dealUpdateSchema } from "@/lib/deals/schemas";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { isKnownPropertyKind } from "@/lib/deals/settings";
import { DEAL_TRACKED_FIELDS, dealChangeValues, toDealUpdateData } from "@/lib/deals/change-values";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

/** 取引の詳しい中身。物件を開くリンクは、その物件を見られる人にだけ出す。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = await idOf(ctx);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    let canOpenProperty = false;
    if (row.propertyId && hasPermission(perms, "property", "read")) {
      const p = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { createdBy: true, assignedTo: true } });
      canOpenProperty = !!p && canAccessPropertyRecord(session, p);
    }
    return NextResponse.json({ deal: toDealView(row), canOpenProperty }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 基本・物件の写し・相手方の仲介会社の変更(版の番号で 409・送っていない項目は触らない)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const id = await idOf(ctx);
    const { version, ...patch } = dealUpdateSchema.parse(await parseJsonBody(request));
    for (const key of ["assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId"] as const) {
      await assertActiveUser(patch[key], "INVALID_STAFF");
    }
    if (patch.propertyKind !== undefined && !isKnownPropertyKind(await loadDealSettings(), patch.propertyKind)) {
      throw new ApiError(422, "物件種別を選び直してください", "UNKNOWN_PROPERTY_KIND");
    }

    await prisma.$transaction(async (tx) => {
      const cur = await tx.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
      if (!cur) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
      const data = toDealUpdateData(patch, cur.businessType);
      const res = await tx.deal.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      await recordChangesInTx(tx, {
        targetTable: "deals", targetId: id, changedBy: session.id,
        oldValues: dealChangeValues(cur), newValues: dealChangeValues({ ...cur, ...data }),
        trackedFields: DEAL_TRACKED_FIELDS, source: "manual",
      });
    });

    await writeAuditLog({
      userId: session.id, action: "deal_update", targetTable: "deals", targetId: id,
      detail: { fields: Object.keys(patch).sort() },
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/deals/[id]/refresh-property/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { buildSnapshotFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ version: z.number().int().positive() }).strict();

/** 「物件から取り直す」: 物件の今の値で写しを上書きする(写しに手で直した分も上書きされる=画面で確認してから押す)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { version } = bodySchema.parse(await parseJsonBody(request));
    const deal = await prisma.deal.findUnique({ where: { id }, select: { propertyId: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
    const p = await prisma.property.findUnique({ where: { id: deal.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
    if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");

    const res = await prisma.deal.updateMany({
      where: { id, version },
      data: { propertySnapshot: buildSnapshotFromProperty(p), version: { increment: 1 } },
    });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_property_refresh", targetTable: "deals", targetId: id,
      detail: { fields: ["propertySnapshot"] },
    });
    return NextResponse.json({ version: version + 1 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/app/api/deals src/lib/deals
git commit -m "feat(deals): 取引の取得・更新・物件から取り直す API"
```

---

### Task 7: 当事者の API

**Files:**
- Create: `src/app/api/deals/[id]/parties/route.ts`、`src/app/api/deals/[id]/parties/[partyId]/route.ts`
- Test: `src/lib/deals/__tests__/parties-route.test.ts`

**Interfaces:**
- Consumes: `requireDeal`、`DEAL_VERSION_CONFLICT_MESSAGE`、`partyInputSchema`、`partyUpdateSchema`、`DEAL_PARTY_SELECT`
- Produces:
  - `POST /api/deals/[id]/parties` → 201 `{ party: DealPartyView }`
  - `PATCH /api/deals/[id]/parties/[partyId]`(本文 `{ version, ...一部 }`)→ `{ version }`
  - `DELETE /api/deals/[id]/parties/[partyId]?version=N` → `{ ok: true }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/parties-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn(async () => ({ id: "d" })) },
    dealParty: {
      count: vi.fn(async () => 0), create: vi.fn(), findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PARTY_ID, DEAL_PERMS } from "./route-mocks";
import { POST } from "../../../app/api/deals/[id]/parties/route";
import { PATCH, DELETE } from "../../../app/api/deals/[id]/parties/[partyId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  dealParty: { count: Fn; create: Fn; findFirst: Fn; updateMany: Fn; deleteMany: Fn };
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const pctx = { params: Promise.resolve({ id: DEAL_ID, partyId: PARTY_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue({ id: DEAL_ID });
  pm.dealParty.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: PARTY_ID, version: 1, ...data }));
});

describe("当事者を足す", () => {
  it("同じ役割の最後に並べる・監査に氏名を出さない", async () => {
    pm.dealParty.count.mockResolvedValue(2);
    const res = await POST(json("POST", { role: "seller", partyType: "individual", name: "試験 花子", address: "東京都試験区3-3" }), ctx);
    expect(res.status).toBe(201);
    expect(pm.dealParty.count).toHaveBeenCalledWith({ where: { dealId: DEAL_ID, role: "seller" } });
    expect(pm.dealParty.create.mock.calls[0][0].data).toMatchObject({ dealId: DEAL_ID, role: "seller", name: "試験 花子", sortOrder: 2 });
    const audit = JSON.stringify((writeAuditLog as Fn).mock.calls[0][0]);
    expect(audit).not.toContain("試験 花子");
    expect(audit).not.toContain("試験区");
  });
  it("取引が無ければ 404・書く権限が無ければ 403", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await POST(json("POST", { role: "seller", partyType: "individual", name: "a" }), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.action !== "write"));
    expect((await POST(json("POST", { role: "seller", partyType: "individual", name: "a" }), ctx)).status).toBe(403);
  });
});

describe("当事者を直す・消す", () => {
  it("取引と当事者と版の番号がそろったときだけ書く", async () => {
    const res = await PATCH(json("PATCH", { version: 2, phone: "03-0000-0000" }), pctx);
    expect(await res.json()).toEqual({ version: 3 });
    expect(pm.dealParty.updateMany).toHaveBeenCalledWith({
      where: { id: PARTY_ID, dealId: DEAL_ID, version: 2 },
      data: { phone: "03-0000-0000", version: { increment: 1 } },
    });
  });
  it("版が古ければ 409・当事者が無ければ 404", async () => {
    pm.dealParty.updateMany.mockResolvedValue({ count: 0 });
    pm.dealParty.findFirst.mockResolvedValueOnce({ id: PARTY_ID });
    expect((await PATCH(json("PATCH", { version: 1, phone: "x" }), pctx)).status).toBe(409);
    pm.dealParty.findFirst.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { version: 1, phone: "x" }), pctx)).status).toBe(404);
  });
  it("消すときも版の番号を見る", async () => {
    const res = await DELETE(new Request(`http://x/api?version=4`, { method: "DELETE" }), pctx);
    expect(res.status).toBe(200);
    expect(pm.dealParty.deleteMany).toHaveBeenCalledWith({ where: { id: PARTY_ID, dealId: DEAL_ID, version: 4 } });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_party_delete", targetId: DEAL_ID }));
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/parties-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/app/api/deals/[id]/parties/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { partyInputSchema } from "@/lib/deals/schemas";
import { DEAL_PARTY_SELECT } from "@/lib/deals/view";

type Ctx = { params: Promise<{ id: string }> };

/** 当事者を足す。並び順は同じ役割の最後。監査には項目名だけ(氏名・住所は残さない)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const dealId = z.string().uuid().parse((await ctx.params).id);
    const body = partyInputSchema.parse(await parseJsonBody(request));
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const sortOrder = await prisma.dealParty.count({ where: { dealId, role: body.role } });
    const party = await prisma.dealParty.create({ data: { ...body, dealId, sortOrder }, select: DEAL_PARTY_SELECT });
    await writeAuditLog({
      userId: session.id, action: "deal_party_create", targetTable: "deals", targetId: dealId,
      detail: { fields: Object.keys(body).sort() },
    });
    return NextResponse.json({ party }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/deals/[id]/parties/[partyId]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { partyUpdateSchema } from "@/lib/deals/schemas";

type Ctx = { params: Promise<{ id: string; partyId: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

async function ids(ctx: Ctx) {
  const p = await ctx.params;
  return { dealId: z.string().uuid().parse(p.id), partyId: z.string().uuid().parse(p.partyId) };
}

/** 書けなかった理由を 404(無い)と 409(先に直された)に分ける。 */
async function missOrConflict(dealId: string, partyId: string): Promise<never> {
  const cur = await prisma.dealParty.findFirst({ where: { id: partyId, dealId }, select: { id: true } });
  if (!cur) throw new ApiError(404, "当事者が見つかりません", "NOT_FOUND");
  throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const { dealId, partyId } = await ids(ctx);
    const { version, ...patch } = partyUpdateSchema.parse(await parseJsonBody(request));
    const res = await prisma.dealParty.updateMany({
      where: { id: partyId, dealId, version },
      data: { ...patch, version: { increment: 1 } },
    });
    if (res.count === 0) await missOrConflict(dealId, partyId);
    await writeAuditLog({
      userId: session.id, action: "deal_party_update", targetTable: "deals", targetId: dealId,
      detail: { fields: Object.keys(patch).sort() },
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const { dealId, partyId } = await ids(ctx);
    const version = z.coerce.number().int().positive().parse(new URL(request.url).searchParams.get("version"));
    const res = await prisma.dealParty.deleteMany({ where: { id: partyId, dealId, version } });
    if (res.count === 0) await missOrConflict(dealId, partyId);
    await writeAuditLog({
      userId: session.id, action: "deal_party_delete", targetTable: "deals", targetId: dealId, detail: { fields: [] },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/app/api/deals src/lib/deals
git commit -m "feat(deals): 当事者の追加・更新・削除 API"
```

---

### Task 8: 取引の設定と税率の表の API(管理者)

**Files:**
- Create: `src/app/api/admin/deal-settings/route.ts`、`src/app/api/admin/deal-settings/rate-tables/route.ts`
- Test: `src/lib/deals/__tests__/settings-route.test.ts`

**Interfaces:**
- Consumes: `requireDealAdmin`、`dealSettingsUpdateSchema`、`resolveDealSettings`、`DEAL_SETTINGS_ID`
- Produces:
  - `GET /api/admin/deal-settings` → `{ settings: DealSettingsView }`
  - `PUT /api/admin/deal-settings`(本文 `{ version, ...一部 }`)→ `{ settings: DealSettingsView }`
  - `GET /api/admin/deal-settings/rate-tables` → `{ tables: { id; kind; validFrom: string; validTo: string | null; content: unknown }[] }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/settings-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dealSettings: { findUnique: vi.fn(async () => null), create: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    dealRateTable: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./route-mocks";
import { GET, PUT } from "../../../app/api/admin/deal-settings/route";
import { GET as RATES } from "../../../app/api/admin/deal-settings/rate-tables/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dealSettings: { findUnique: Fn; create: Fn; updateMany: Fn };
  dealRateTable: { findMany: Fn };
};
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const row = (v: number) => ({ representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, propertyKinds: [], version: v, updatedAt: new Date("2026-10-24T00:00:00Z") });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
});

describe("取引の設定", () => {
  it("管理者でなければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "deal", action: "write", granted: true }]);
    expect((await GET()).status).toBe(403);
    expect((await PUT(json("PUT", { version: 0 }))).status).toBe(403);
  });
  it("初めての保存は行を作る", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(row(1));
    const res = await PUT(json("PUT", { version: 0, representativeName: "試験 太郎" }));
    expect(res.status).toBe(200);
    expect(pm.dealSettings.create).toHaveBeenCalledWith({ data: { id: "singleton", representativeName: "試験 太郎", updatedById: "u-admin" } });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_settings_update", targetTable: "deal_settings", detail: { fields: ["representativeName"] } }));
    expect((writeAuditLog as Fn).mock.calls[0][0].targetId).toBeUndefined();
  });
  it("2回目からは版の番号で書く・古ければ 409", async () => {
    pm.dealSettings.findUnique.mockResolvedValue(row(3));
    await PUT(json("PUT", { version: 2, representativeTitle: "代表" }));
    expect(pm.dealSettings.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", version: 2 },
      data: { representativeTitle: "代表", updatedById: "u-admin", version: { increment: 1 } },
    });
    pm.dealSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await PUT(json("PUT", { version: 2, representativeTitle: "代表" }))).status).toBe(409);
  });
  it("ほかの人が先に初めての保存をしていたら 409", async () => {
    pm.dealSettings.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await PUT(json("PUT", { version: 0, representativeName: "a" }))).status).toBe(409);
  });
});

describe("税率の表", () => {
  it("日付は YYYY-MM-DD で返す", async () => {
    pm.dealRateTable.findMany.mockResolvedValue([
      { id: "r1", kind: "consumption_tax", validFrom: new Date("2019-10-01T00:00:00Z"), validTo: null, content: { rateBp: 1000 } },
    ]);
    const body = await (await RATES()).json();
    expect(body.tables).toEqual([{ id: "r1", kind: "consumption_tax", validFrom: "2019-10-01", validTo: null, content: { rateBp: 1000 } }]);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/settings-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/app/api/admin/deal-settings/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDealAdmin, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { dealSettingsUpdateSchema } from "@/lib/deals/schemas";
import { DEAL_SETTINGS_ID, resolveDealSettings } from "@/lib/deals/settings";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await requireDealAdmin();
    const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
    return NextResponse.json({ settings: resolveDealSettings(row) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 部分更新。version 0 = 行がまだ無い(初めての保存)。同時の初回保存は一意の鍵で 409。 */
export async function PUT(request: Request) {
  try {
    const session = await requireDealAdmin();
    const { version, ...patch } = dealSettingsUpdateSchema.parse(await parseJsonBody(request));
    if (version === 0) {
      try {
        await prisma.dealSettings.create({ data: { id: DEAL_SETTINGS_ID, ...patch, updatedById: session.id } });
      } catch (e) {
        if ((e as { code?: string } | null)?.code === "P2002") throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
        throw e;
      }
    } else {
      const res = await prisma.dealSettings.updateMany({
        where: { id: DEAL_SETTINGS_ID, version },
        data: { ...patch, updatedById: session.id, version: { increment: 1 } },
      });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    // targetId は UUID 列。singleton は UUID でないため付けない(会社情報の設定と同じ)。
    await writeAuditLog({
      userId: session.id, action: "deal_settings_update", targetTable: "deal_settings",
      detail: { fields: Object.keys(patch).sort() },
    });
    const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID } });
    return NextResponse.json({ settings: resolveDealSettings(row) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/admin/deal-settings/rate-tables/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDealAdmin } from "@/lib/deals/guard";

const day = (d: Date) => d.toISOString().slice(0, 10);

/** 税率・税額の表(段1は見るだけ。編集は段2)。 */
export async function GET() {
  try {
    await requireDealAdmin();
    const rows = await prisma.dealRateTable.findMany({ orderBy: [{ kind: "asc" }, { validFrom: "asc" }] });
    return NextResponse.json(
      { tables: rows.map((r) => ({ id: r.id, kind: r.kind, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null, content: r.content })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/app/api/admin/deal-settings src/lib/deals
git commit -m "feat(deals): 取引の設定・税率の表の API(管理者)"
```

---

### Task 9: 画面の入力の変換と、API を呼ぶ部品

**Files:**
- Create: `src/lib/deals/forms.ts`、`src/lib/deals/client.ts`
- Test: `src/lib/deals/__tests__/forms.test.ts`

**Interfaces:**
- Consumes: `DealView`、`DealPartyView`、`PropertySnapshot`、Task 1 の日時の関数
- Produces:
  - 基本タブ: `interface BasicForm`、`basicFormFromDeal(d: DealView): BasicForm`、`basicPatch(f: BasicForm, d: DealView): Record<string, unknown>`
  - 物件タブ: `type SnapshotForm = Record<keyof PropertySnapshot, string>`、`snapshotFormFromDeal(d)`、`snapshotFromForm(f): PropertySnapshot`
  - 当事者: `interface PartyForm`、`EMPTY_PARTY_FORM`、`partyFormFromView(p)`、`partyBodyFromForm(f)`
  - API を呼ぶ: `class DealApiError { status; code }`、`dealsApi`(`list`, `create`, `get`, `update`, `refreshProperty`, `addParty`, `updateParty`, `deleteParty`, `options`, `getSettings`, `saveSettings`, `rateTables`, `users`)

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/forms.test.ts
import { describe, it, expect } from "vitest";
import {
  basicFormFromDeal, basicPatch, snapshotFormFromDeal, snapshotFromForm,
  EMPTY_PARTY_FORM, partyBodyFromForm, partyFormFromView,
} from "../forms";
import { EMPTY_SNAPSHOT, EMPTY_BROKER } from "../schemas";
import type { DealView } from "../view";

const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-07-01T01:30:00.000Z", contractPlace: null, settlementAt: null, settlementPlace: null,
  price: null, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, roomNo: "201", floorArea: 65.4 }, counterpartyBroker: EMPTY_BROKER,
  version: 3, createdAt: "", updatedAt: "", parties: [],
};

describe("基本タブ", () => {
  it("変えた項目だけを送る・日本時間の入力を ISO に・空は null", () => {
    const f = basicFormFromDeal(deal);
    expect(f.contractAt).toBe("2026-07-01T10:30");
    expect(basicPatch(f, deal)).toEqual({});
    expect(basicPatch({ ...f, status: "contracted", contractAt: "2026-07-02T09:00", contractPlace: "試験区の事務所", tradeSide: "" }, deal)).toEqual({
      status: "contracted", contractAt: "2026-07-02T00:00:00.000Z", contractPlace: "試験区の事務所", tradeSide: null,
    });
  });
  it("相手方の仲介会社は3項目まとめて送る", () => {
    const f = basicFormFromDeal(deal);
    expect(basicPatch({ ...f, brokerCompany: "試験不動産" }, deal)).toEqual({
      counterpartyBroker: { company: "試験不動産", staff: null, tel: null },
    });
  });
});

describe("物件タブ", () => {
  it("数の欄は数に・読めなければ null", () => {
    const f = snapshotFormFromDeal(deal);
    expect(f.floorArea).toBe("65.4");
    expect(snapshotFromForm({ ...f, landArea: "120.5", builtYear: "abc", landRight: "leasehold" })).toEqual({
      ...EMPTY_SNAPSHOT, roomNo: "201", floorArea: 65.4, landArea: 120.5, builtYear: null, landRight: "leasehold",
    });
  });
});

describe("当事者", () => {
  it("空は null・持分は数", () => {
    expect(partyBodyFromForm({ ...EMPTY_PARTY_FORM, name: "試験 太郎", shareNum: "1", shareDen: "2" })).toEqual({
      role: "seller", partyType: "individual", name: "試験 太郎", representative: null, address: null, phone: null,
      shareNum: 1, shareDen: 2, isSelf: false,
    });
  });
  it("保存済みから入力の形へ", () => {
    const f = partyFormFromView({ id: "p", role: "buyer", partyType: "corporation", name: "試験株式会社", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 });
    expect(f).toMatchObject({ role: "buyer", partyType: "corporation", name: "試験株式会社", shareNum: "", representative: "" });
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/forms.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

```ts
// src/lib/deals/forms.ts
import { isoToJstLocal, jstLocalToIso } from "./datetime";
import { EMPTY_SNAPSHOT, type PropertySnapshot } from "./schemas";
import type { DealPartyView, DealView } from "./view";

const nn = (v: string) => (v.trim() === "" ? null : v.trim());

export interface BasicForm {
  name: string; businessType: string; tradeSide: string; status: string;
  assigneeId: string; licensedAgentId: string; salesStaffId: string; opsStaffId: string;
  propertyKind: string; hasOc: boolean;
  contractAt: string; contractPlace: string; settlementAt: string; settlementPlace: string;
  brokerCompany: string; brokerStaff: string; brokerTel: string;
}

export function basicFormFromDeal(d: DealView): BasicForm {
  return {
    name: d.name, businessType: d.businessType, tradeSide: d.tradeSide ?? "", status: d.status,
    assigneeId: d.assigneeId ?? "", licensedAgentId: d.licensedAgentId ?? "", salesStaffId: d.salesStaffId ?? "", opsStaffId: d.opsStaffId ?? "",
    propertyKind: d.propertyKind ?? "", hasOc: d.hasOc,
    contractAt: isoToJstLocal(d.contractAt), contractPlace: d.contractPlace ?? "",
    settlementAt: isoToJstLocal(d.settlementAt), settlementPlace: d.settlementPlace ?? "",
    brokerCompany: d.counterpartyBroker.company ?? "", brokerStaff: d.counterpartyBroker.staff ?? "", brokerTel: d.counterpartyBroker.tel ?? "",
  };
}

const NULLABLE_TEXT = ["tradeSide", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId", "propertyKind", "contractPlace", "settlementPlace"] as const;

/** 読み込んだときから変わった項目だけ(PATCH は部分更新)。 */
export function basicPatch(f: BasicForm, d: DealView): Record<string, unknown> {
  const base = basicFormFromDeal(d);
  const out: Record<string, unknown> = {};
  if (f.name !== base.name) out.name = f.name.trim();
  if (f.businessType !== base.businessType) out.businessType = f.businessType;
  if (f.status !== base.status) out.status = f.status;
  if (f.hasOc !== base.hasOc) out.hasOc = f.hasOc;
  for (const k of NULLABLE_TEXT) if (f[k] !== base[k]) out[k] = nn(f[k]);
  for (const k of ["contractAt", "settlementAt"] as const) if (f[k] !== base[k]) out[k] = jstLocalToIso(f[k]);
  if (f.brokerCompany !== base.brokerCompany || f.brokerStaff !== base.brokerStaff || f.brokerTel !== base.brokerTel) {
    out.counterpartyBroker = { company: nn(f.brokerCompany), staff: nn(f.brokerStaff), tel: nn(f.brokerTel) };
  }
  return out;
}

export type SnapshotForm = Record<keyof PropertySnapshot, string>;
const NUMBER_KEYS = ["builtYear", "builtMonth", "floorArea", "landArea"] as const;

export function snapshotFormFromDeal(d: DealView): SnapshotForm {
  const s = d.propertySnapshot;
  const out = {} as SnapshotForm;
  for (const k of Object.keys(EMPTY_SNAPSHOT) as (keyof PropertySnapshot)[]) out[k] = s[k] === null ? "" : String(s[k]);
  return out;
}

export function snapshotFromForm(f: SnapshotForm): PropertySnapshot {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EMPTY_SNAPSHOT) as (keyof PropertySnapshot)[]) {
    if ((NUMBER_KEYS as readonly string[]).includes(k)) {
      const n = Number(f[k]);
      out[k] = f[k].trim() === "" || !Number.isFinite(n) ? null : n;
    } else if (k === "landRight") {
      out[k] = f[k] === "ownership" || f[k] === "leasehold" ? f[k] : null;
    } else {
      out[k] = nn(f[k]);
    }
  }
  return out as PropertySnapshot;
}

export interface PartyForm {
  role: string; partyType: string; name: string; representative: string; address: string; phone: string;
  shareNum: string; shareDen: string; isSelf: boolean;
}
export const EMPTY_PARTY_FORM: PartyForm = {
  role: "seller", partyType: "individual", name: "", representative: "", address: "", phone: "", shareNum: "", shareDen: "", isSelf: false,
};

export function partyFormFromView(p: DealPartyView): PartyForm {
  return {
    role: p.role, partyType: p.partyType, name: p.name, representative: p.representative ?? "", address: p.address ?? "",
    phone: p.phone ?? "", shareNum: p.shareNum === null ? "" : String(p.shareNum), shareDen: p.shareDen === null ? "" : String(p.shareDen),
    isSelf: p.isSelf,
  };
}

const intOrNull = (v: string) => {
  const n = Number(v);
  return v.trim() === "" || !Number.isInteger(n) ? null : n;
};

export function partyBodyFromForm(f: PartyForm) {
  return {
    role: f.role, partyType: f.partyType, name: f.name.trim(), representative: nn(f.representative), address: nn(f.address),
    phone: nn(f.phone), shareNum: intOrNull(f.shareNum), shareDen: intOrNull(f.shareDen), isSelf: f.isSelf,
  };
}
```

```ts
// src/lib/deals/client.ts
import type { DealListItem, DealPartyView, DealView } from "./view";
import type { DealSettingsView } from "./settings";
import type { PropertyKindDef } from "./constants";

/** 取引の画面から API を呼ぶ。失敗はサーバーの文言とコードを持った DealApiError にする。 */
export class DealApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new DealApiError(res.status, body?.error?.code ?? "ERROR", body?.error?.message ?? "通信に失敗しました。もう一度お試しください。");
  }
  return body as T;
}

export interface DealOptions {
  propertyKinds: PropertyKindDef[];
  selfParty: { name: string; representative: string | null; address: string | null; phone: string | null };
}
export interface UserOption { id: string; name: string; role: string }
export interface RateTableView { id: string; kind: string; validFrom: string; validTo: string | null; content: unknown }

export const dealsApi = {
  list: (params: Record<string, string>) =>
    call<{ deals: DealListItem[]; total: number; page: number; pageSize: number }>(`/api/deals?${new URLSearchParams(params)}`),
  create: (body: Record<string, unknown>) => call<{ id: string; dealNo: string }>("/api/deals", { method: "POST", body }),
  get: (id: string) => call<{ deal: DealView; canOpenProperty: boolean }>(`/api/deals/${id}`),
  update: (id: string, body: Record<string, unknown>) => call<{ version: number }>(`/api/deals/${id}`, { method: "PATCH", body }),
  refreshProperty: (id: string, version: number) =>
    call<{ version: number }>(`/api/deals/${id}/refresh-property`, { method: "POST", body: { version } }),
  addParty: (id: string, body: Record<string, unknown>) =>
    call<{ party: DealPartyView }>(`/api/deals/${id}/parties`, { method: "POST", body }),
  updateParty: (id: string, partyId: string, body: Record<string, unknown>) =>
    call<{ version: number }>(`/api/deals/${id}/parties/${partyId}`, { method: "PATCH", body }),
  deleteParty: (id: string, partyId: string, version: number) =>
    call<{ ok: true }>(`/api/deals/${id}/parties/${partyId}?version=${version}`, { method: "DELETE" }),
  options: () => call<DealOptions>("/api/deals/options"),
  getSettings: () => call<{ settings: DealSettingsView }>("/api/admin/deal-settings"),
  saveSettings: (body: Record<string, unknown>) => call<{ settings: DealSettingsView }>("/api/admin/deal-settings", { method: "PUT", body }),
  rateTables: () => call<{ tables: RateTableView[] }>("/api/admin/deal-settings/rate-tables"),
  users: () => call<{ data: UserOption[] }>("/api/users"),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "通信に失敗しました。もう一度お試しください。");
```

- [ ] **Step 4: テストを走らせて、通ることを確かめる**

Run: `npx vitest run src/lib/deals/__tests__`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/lib/deals
git commit -m "feat(deals): 画面の入力の変換と API を呼ぶ部品"
```

---

### Task 10: 一覧・新しい取引の画面・左メニュー・物件からの入口

**Files:**
- Create: `src/components/deals/form-parts.tsx`、`src/app/(dashboard)/deals/page.tsx`、`src/app/(dashboard)/deals/new/page.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`(「物件」の柱の次に「取引」の柱を足す)
- Modify: `src/components/layout/__tests__/sidebar-reorg.test.ts`(並びの期待値を3か所)
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx`(「その他」に「この物件で取引を作る」)
- Test: `src/lib/deals/__tests__/pages-source.test.ts`

**Interfaces:**
- Consumes: `dealsApi`、`errorText`、Task 1 の選択肢と日本語名、`formatJstDateTime`、`PageHeader`、`Button`
- Produces:
  - 共通部品: `inputCls`、`Field({ label, hint?, children })`、`SelectBox({ value, onChange, options, label, allowEmpty? })`
  - 画面: `/deals`、`/deals/new?propertyId=`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/pages-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("取引の画面", () => {
  it("左メニューの柱「取引」は物件の次・全員に出す", () => {
    const keys = SIDEBAR_GROUPS.map((g) => g.key);
    expect(keys.indexOf("deal")).toBe(keys.indexOf("prop") + 1);
    const g = SIDEBAR_GROUPS.find((x) => x.key === "deal");
    expect(g?.pillar).toBe(true);
    expect(g?.items).toEqual([expect.objectContaining({ label: "取引", href: "/deals", minRole: "field_staff" })]);
  });
  it("一覧の題名はメニューと同じ「取引」", () => {
    expect(read("src/app/(dashboard)/deals/page.tsx")).toContain('title="取引"');
  });
  it("新しい取引は物件から作れる(propertyId を受け取る)", () => {
    const src = read("src/app/(dashboard)/deals/new/page.tsx");
    expect(src).toContain('title="新しい取引"');
    expect(src).toContain('get("propertyId")');
  });
  it("物件の画面の「その他」に入口がある(取引を書ける人だけ)", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toContain('label: "この物件で取引を作る"');
    expect(src).toContain("/deals/new?propertyId=");
    expect(src).toMatch(/p\.resource === "deal" && p\.action === "write"/);
  });
  it("取引の画面は素の button を使わない", () => {
    for (const p of ["src/app/(dashboard)/deals/page.tsx", "src/app/(dashboard)/deals/new/page.tsx"]) {
      expect(existsSync(join(process.cwd(), p)), p).toBe(true);
      expect(read(p), p).not.toMatch(/<button[\s>]/);
    }
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/pages-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 共通部品・一覧・新しい取引を実装する**

```tsx
// src/components/deals/form-parts.tsx
import type { ReactNode } from "react";

export const inputCls =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {hint && <span className="ml-1 font-normal text-gray-400">（{hint}）</span>}
      </span>
      {children}
    </label>
  );
}

export function SelectBox({
  label, value, onChange, options, allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** 空欄を選べる(「未設定」)。 */
  allowEmpty?: boolean;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      {allowEmpty && <option value="">未設定</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Record の日本語名 → select の選択肢。 */
export const optionsOf = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
```

```tsx
// src/app/(dashboard)/deals/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, errorText } from "@/lib/deals/client";
import type { DealListItem } from "@/lib/deals/view";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { formatJstDateTime } from "@/lib/deals/datetime";

/** 取引の一覧(設計 §5)。新しい順・50件ずつ。 */
export default function DealsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<DealListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await dealsApi.list({ status, businessType, q, page: String(page), ...(mine ? { assignee: "me" } : {}) });
      setRows(res.deals);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [status, businessType, q, page, mine]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastPage = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-5">
      <PageHeader
        title="取引"
        description="仲介・買取再販の取引です。取引ごとに資金計画表・事業計画書・業務書類を出せるようになります。"
        actions={
          <Button onClick={() => router.push("/deals/new")}>
            <Plus className="h-4 w-4" />
            新しい取引
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="状態">
          <SelectBox label="状態" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={optionsOf(DEAL_STATUS_LABELS)} allowEmpty />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={businessType} onChange={(v) => { setBusinessType(v); setPage(1); }} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} allowEmpty />
        </Field>
        <Field label="取引名・取引番号で探す">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} maxLength={100} aria-label="取引名・取引番号で探す" className={inputCls} />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} />
          自分の担当だけ
        </label>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      {rows === null ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">取引はまだありません。「新しい取引」から作れます。</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">取引番号</th>
                <th className="px-3 py-2">取引名</th>
                <th className="px-3 py-2">事業区分</th>
                <th className="px-3 py-2">状態</th>
                <th className="px-3 py-2">契約</th>
                <th className="px-3 py-2">決済</th>
                <th className="px-3 py-2">担当</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 tabular-nums">{r.dealNo}</td>
                  <td className="px-3 py-2">
                    <Link href={`/deals/${r.id}`} className="text-indigo-700 hover:underline dark:text-indigo-400">{r.name}</Link>
                  </td>
                  <td className="px-3 py-2">{DEAL_BUSINESS_TYPE_LABELS[r.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? r.businessType}</td>
                  <td className="px-3 py-2">{DEAL_STATUS_LABELS[r.status as keyof typeof DEAL_STATUS_LABELS] ?? r.status}</td>
                  <td className="px-3 py-2 tabular-nums">{formatJstDateTime(r.contractAt)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatJstDateTime(r.settlementAt)}</td>
                  <td className="px-3 py-2">{r.assigneeName ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>前へ</Button>
          <span className="tabular-nums">{page} / {lastPage}</span>
          <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>次へ</Button>
        </div>
      )}
    </div>
  );
}
```

```tsx
// src/app/(dashboard)/deals/new/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Save } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, errorText, type DealOptions } from "@/lib/deals/client";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_TRADE_SIDE_LABELS } from "@/lib/deals/constants";

/**
 * 新しい取引(設計 §5)。?propertyId= があれば物件から作る(写しと種別はサーバーが物件から入れる)。
 * 無ければ手入力の物件(物件の中身は作ったあと「物件」タブで入れる)。
 */
export default function NewDealPage() {
  const router = useRouter();
  const propertyId = useSearchParams().get("propertyId");
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("brokerage");
  const [tradeSide, setTradeSide] = useState("");
  const [propertyKind, setPropertyKind] = useState("");
  const [hasOc, setHasOc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dealsApi.options().then(setOptions).catch((e) => setError(errorText(e)));
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await dealsApi.create({
        name, businessType, hasOc,
        tradeSide: businessType === "brokerage" && tradeSide ? tradeSide : null,
        propertyKind: propertyKind || null,
        ...(propertyId ? { propertyId } : {}),
      });
      router.push(`/deals/${res.id}`);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="新しい取引"
        back={{ href: "/deals", to: "取引" }}
        description={propertyId ? "選んだ物件の情報を写して作ります。" : "物件は手で入力します(物件の一覧には登録しません)。"}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="space-y-4">
        <Field label="取引名">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="取引名" className={inputCls} />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={businessType} onChange={setBusinessType} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} />
        </Field>
        {businessType === "brokerage" && (
          <Field label="取引態様">
            <SelectBox label="取引態様" value={tradeSide} onChange={setTradeSide} options={optionsOf(DEAL_TRADE_SIDE_LABELS)} allowEmpty />
          </Field>
        )}
        <Field label="物件種別" hint={propertyId ? "空欄なら物件の種類から自動で選びます" : undefined}>
          <SelectBox
            label="物件種別" value={propertyKind} onChange={setPropertyKind} allowEmpty
            options={(options?.propertyKinds ?? []).map((k) => ({ value: k.key, label: k.label }))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hasOc} onChange={(e) => setHasOc(e.target.checked)} />
          オーナーチェンジ(賃貸中のまま売買)
        </label>
      </div>
      <Button onClick={save} disabled={saving || !name.trim()} loading={saving} loadingLabel="作成中">
        <Save className="h-4 w-4" />
        作成
      </Button>
    </div>
  );
}
```

⚠ `useSearchParams` を使うページは、build のときに Suspense の境界が要ることがあります。build が「useSearchParams() should be wrapped in a suspense boundary」で落ちたら、次の形に直します。`page.tsx` の default export は `<Suspense><NewDealForm /></Suspense>` を返すだけにし、上の中身を `NewDealForm` という関数に移します。題名の `title="新しい取引"` は、そのまま同じファイルに残します。

- [ ] **Step 4: 左メニュー・物件の画面・メニューのテストを直す**

`src/components/layout/sidebar-model.tsx`:
- import に `Handshake` を足します。
- `key: "prop"` のグループの閉じ括弧の直後に、次を足します。

```tsx
  {
    // 取引(設計 2026-10-23 §5)。全員が使う(発注者決定)。項目が1つなので見出しがそのままリンクになる。
    key: "deal",
    label: "取引",
    pillar: true,
    icon: ic(Handshake),
    items: [{ label: "取引", href: "/deals", icon: ic(Handshake), minRole: "field_staff" }],
  },
```

`src/components/layout/__tests__/sidebar-reorg.test.ts`:
- 「グループの順序と数」の期待値で、`"prop",` の次に `"deal",` を足します。
- 現地担当のメニューの期待値で、`["home", "inquiry", "field", "doc"]` を `["home", "inquiry", "deal", "field", "doc"]` にします。
- 同じテストの href の並びで、`"/properties/sale-dm/inquiries",` の次に `"/deals",` を足します。
- テストの名前が「従来どおり」となっているので、説明のコメントに「+ 取引(2026-10-24 全員が使う)」と1行足します。
- 柱の一覧の期待値で、`"prop",` の次に `"deal",` を足します。

`src/app/(dashboard)/properties/[id]/page.tsx`:
- `canSendInquiryMaterial` の定義の次に、次を足し、返す object にも入れます。

```tsx
    // 「この物件で取引を作る」。作成 API も deal:write(+物件を見られること)を要求する=見た目のため。
    const canCreateDeal = effectivePermissions.some(
      (p) => p.resource === "deal" && p.action === "write" && p.granted,
    );
```

- 返す object から取り出す側の分割代入にも `canCreateDeal` を足します。
- `moreMenuItems` の先頭に、次を足します。import の lucide に `Handshake` を足します。

```tsx
    ...(canCreateDeal
      ? [{ key: "new-deal", label: "この物件で取引を作る", icon: Handshake, href: `/deals/new?propertyId=${property.id}` }]
      : []),
```

- [ ] **Step 5: テストを走らせる(左メニューの全部のテストを含む)**

```bash
npx vitest run src/lib/deals/__tests__ src/components/layout src/components/home > /tmp/deals-t10.log 2>&1; echo exit=$?; tail -15 /tmp/deals-t10.log
```
Expected: `exit=0`。`sidebar-page-title-parity`(メニューの名前と題名の一致)も通ります。ほかに、左メニューの並びを固定で見ているテストが落ちたら、そのテストの期待値に「取引」を足して直します。足した場所は、この計画の実行記録に残します。

- [ ] **Step 6: コミットする**

```bash
git add src/components/deals "src/app/(dashboard)/deals" src/components/layout "src/app/(dashboard)/properties/[id]/page.tsx" src/lib/deals
git commit -m "feat(deals): 取引の一覧・新しい取引・左メニュー・物件からの入口"
```

---

### Task 11: 取引の詳しい画面(基本・物件・当事者のタブ)

**Files:**
- Create: `src/app/(dashboard)/deals/[id]/page.tsx`、`src/components/deals/deal-basic-panel.tsx`、`src/components/deals/deal-property-panel.tsx`、`src/components/deals/deal-parties-panel.tsx`
- Test: `src/lib/deals/__tests__/detail-source.test.ts`

**Interfaces:**
- Consumes:
  - Task 9 の `forms.ts` と `dealsApi`
  - `Tabs` と `tabPanelProps`(`@/components/ui/tabs`)、`ConfirmDialog`(`@/components/ui/confirm-dialog`)
- Produces:
  - `DEAL_TABS`(このファイルの中だけで使う)
  - `DealBasicPanel`、`DealPropertyPanel`、`DealPartiesPanel` の props:
    - `DealBasicPanel`: `{ deal: DealView; users: UserOption[]; kinds: PropertyKindDef[]; onSaved: () => Promise<void> }`
    - `DealPropertyPanel`: `{ deal: DealView; canOpenProperty: boolean; onSaved: () => Promise<void> }`
    - `DealPartiesPanel`: `{ deal: DealView; selfParty: DealOptions["selfParty"] | null; onSaved: () => Promise<void> }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/detail-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/page.tsx";
const PANELS = ["deal-basic-panel", "deal-property-panel", "deal-parties-panel"].map((n) => `src/components/deals/${n}.tsx`);

describe("取引の詳しい画面", () => {
  it("タブは 基本・物件・当事者 の順(共通のタブ部品)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\{ key: "basic", label: "基本" \},\s*\{ key: "property", label: "物件" \},\s*\{ key: "parties", label: "当事者" \}/);
    expect(src).toContain("<Tabs");
    expect(src).toContain("tabPanelProps(");
  });
  it("ほかの人が先に保存したら、読み込み直すよう知らせる", () => {
    for (const p of PANELS) expect(read(p), p).toContain("VERSION_CONFLICT");
  });
  it("物件から取り直す前に確かめる・物件を開くリンクは見られる人だけ", () => {
    const src = read(PANELS[1]);
    expect(src).toContain("物件から取り直す");
    expect(src).toContain("<ConfirmDialog");
    expect(src).toContain("canOpenProperty &&");
  });
  it("当事者は「自社を入れる」で会社情報を写せる・消す前に確かめる", () => {
    const src = read(PANELS[2]);
    expect(src).toContain("自社を入れる");
    expect(src).toContain("<ConfirmDialog");
  });
  it("素の button を使わない", () => {
    for (const p of [PAGE, ...PANELS]) expect(read(p), p).not.toMatch(/<button[\s>]/);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/detail-source.test.ts`
Expected: FAIL

- [ ] **Step 3: ConfirmDialog の props を確かめる**

Run: `grep -n "interface\|export" src/components/ui/confirm-dialog.tsx`

下のコードでは、props を `open`、`title`、`message`、`confirmLabel`、`onConfirm`、`onCancel`、`danger` と書いています。実際の名前が違えば、それに合わせて書き換えます。合わせた名前は、この計画の実行記録に残します。

- [ ] **Step 4: 実装する**

```tsx
// src/app/(dashboard)/deals/[id]/page.tsx
"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import DealBasicPanel from "@/components/deals/deal-basic-panel";
import DealPropertyPanel from "@/components/deals/deal-property-panel";
import DealPartiesPanel from "@/components/deals/deal-parties-panel";
import { dealsApi, errorText, type DealOptions, type UserOption } from "@/lib/deals/client";
import type { DealView } from "@/lib/deals/view";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS } from "@/lib/deals/constants";

// 段2以降で 金額・費用/精算/OC/書類 を足す(設計 §5)。
const DEAL_TABS = [
  { key: "basic", label: "基本" },
  { key: "property", label: "物件" },
  { key: "parties", label: "当事者" },
] as const;
type DealTabKey = (typeof DEAL_TABS)[number]["key"];

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ deal: DealView; canOpenProperty: boolean } | null>(null);
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [tab, setTab] = useState<DealTabKey>("basic");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await dealsApi.get(id));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
    dealsApi.options().then(setOptions).catch(() => {});
    dealsApi.users().then((r) => setUsers(r.data)).catch(() => {});
  }, [reload]);

  if (!data) {
    return error ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }
  const { deal } = data;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={deal.name}
        back={{ href: "/deals", to: "取引" }}
        description={`${deal.dealNo} ・ ${DEAL_BUSINESS_TYPE_LABELS[deal.businessType as keyof typeof DEAL_BUSINESS_TYPE_LABELS] ?? deal.businessType} ・ ${DEAL_STATUS_LABELS[deal.status as keyof typeof DEAL_STATUS_LABELS] ?? deal.status}`}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <Tabs tabs={DEAL_TABS} active={tab} onChange={setTab} idBase="deal-detail" />
      <div {...tabPanelProps("deal-detail", tab)}>
        {tab === "basic" && <DealBasicPanel key={deal.version} deal={deal} users={users} kinds={options?.propertyKinds ?? []} onSaved={reload} />}
        {tab === "property" && <DealPropertyPanel key={deal.version} deal={deal} canOpenProperty={data.canOpenProperty} onSaved={reload} />}
        {tab === "parties" && <DealPartiesPanel deal={deal} selfParty={options?.selfParty ?? null} onSaved={reload} />}
      </div>
    </div>
  );
}
```

`key={deal.version}` にしてあるので、保存して版が変わったとき、入力欄は新しい値で作り直されます(effect の中で setState しないため)。

```tsx
// src/components/deals/deal-basic-panel.tsx
"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { dealsApi, DealApiError, errorText, type UserOption } from "@/lib/deals/client";
import { basicFormFromDeal, basicPatch, type BasicForm } from "@/lib/deals/forms";
import type { DealView } from "@/lib/deals/view";
import {
  DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS, DEAL_TRADE_SIDE_LABELS, type PropertyKindDef,
} from "@/lib/deals/constants";

export default function DealBasicPanel({
  deal, users, kinds, onSaved,
}: { deal: DealView; users: UserOption[]; kinds: PropertyKindDef[]; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<BasicForm>(() => basicFormFromDeal(deal));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const set = <K extends keyof BasicForm>(k: K, v: BasicForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const patch = basicPatch(form, deal);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, ...patch });
      await onSaved();
    } catch (e) {
      const text = e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
        : errorText(e);
      setMessage({ kind: "err", text });
      setSaving(false);
    }
  };

  const staff = (k: "assigneeId" | "licensedAgentId" | "salesStaffId" | "opsStaffId", label: string) => (
    <Field label={label}>
      <SelectBox label={label} value={form[k]} onChange={(v) => set(k, v)} options={userOptions} allowEmpty />
    </Field>
  );

  return (
    <div className="space-y-5">
      {message && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{message.text}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="取引名">
          <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} aria-label="取引名" className={inputCls} />
        </Field>
        <Field label="状態">
          <SelectBox label="状態" value={form.status} onChange={(v) => set("status", v)} options={optionsOf(DEAL_STATUS_LABELS)} />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={form.businessType} onChange={(v) => set("businessType", v)} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} />
        </Field>
        {form.businessType === "brokerage" ? (
          <Field label="取引態様">
            <SelectBox label="取引態様" value={form.tradeSide} onChange={(v) => set("tradeSide", v)} options={optionsOf(DEAL_TRADE_SIDE_LABELS)} allowEmpty />
          </Field>
        ) : (
          <p className="self-end pb-2 text-xs text-gray-500">買取再販では、自社が買主にも売主にもなります。</p>
        )}
        <Field label="物件種別">
          <SelectBox label="物件種別" value={form.propertyKind} onChange={(v) => set("propertyKind", v)} options={kinds.map((k) => ({ value: k.key, label: k.label }))} allowEmpty />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={form.hasOc} onChange={(e) => set("hasOc", e.target.checked)} />
          オーナーチェンジ(賃貸中のまま売買)
        </label>
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">担当</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {staff("assigneeId", "担当者")}
        {staff("licensedAgentId", "宅建士")}
        {staff("salesStaffId", "営業担当")}
        {staff("opsStaffId", "業務担当")}
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">契約・決済</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="契約日時">
          <input type="datetime-local" value={form.contractAt} onChange={(e) => set("contractAt", e.target.value)} aria-label="契約日時" className={inputCls} />
        </Field>
        <Field label="契約場所">
          <input value={form.contractPlace} onChange={(e) => set("contractPlace", e.target.value)} maxLength={200} aria-label="契約場所" className={inputCls} />
        </Field>
        <Field label="決済日時">
          <input type="datetime-local" value={form.settlementAt} onChange={(e) => set("settlementAt", e.target.value)} aria-label="決済日時" className={inputCls} />
        </Field>
        <Field label="決済場所">
          <input value={form.settlementPlace} onChange={(e) => set("settlementPlace", e.target.value)} maxLength={200} aria-label="決済場所" className={inputCls} />
        </Field>
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">相手方の仲介会社</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="会社名">
          <input value={form.brokerCompany} onChange={(e) => set("brokerCompany", e.target.value)} maxLength={200} aria-label="相手方の仲介会社" className={inputCls} />
        </Field>
        <Field label="担当">
          <input value={form.brokerStaff} onChange={(e) => set("brokerStaff", e.target.value)} maxLength={100} aria-label="相手方の担当" className={inputCls} />
        </Field>
        <Field label="電話">
          <input value={form.brokerTel} onChange={(e) => set("brokerTel", e.target.value)} maxLength={50} aria-label="相手方の電話" className={inputCls} />
        </Field>
      </div>

      <Button onClick={save} disabled={saving || !dirty || !form.name.trim()} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>
    </div>
  );
}
```

```tsx
// src/components/deals/deal-property-panel.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { snapshotFormFromDeal, snapshotFromForm, type SnapshotForm } from "@/lib/deals/forms";
import type { DealView } from "@/lib/deals/view";
import { LAND_RIGHT_LABELS } from "@/lib/deals/constants";

const TEXT_FIELDS: [keyof SnapshotForm, string, number][] = [
  ["buildingName", "物件名", 200], ["roomNo", "号室", 50], ["address", "住居表示", 300], ["lotNumber", "所在・地番", 300],
  ["buildingNumber", "家屋番号", 100], ["propertyTypeLabel", "種類", 50], ["structure", "構造", 100],
  ["access", "交通", 500], ["layout", "間取り", 50],
];
const NUMBER_FIELDS: [keyof SnapshotForm, string][] = [
  ["builtYear", "築年(西暦)"], ["builtMonth", "築月"], ["floorArea", "延床面積(区分は専有面積)㎡"], ["landArea", "土地面積㎡"],
];

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

export default function DealPropertyPanel({
  deal, canOpenProperty, onSaved,
}: { deal: DealView; canOpenProperty: boolean; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<SnapshotForm>(() => snapshotFormFromDeal(deal));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof SnapshotForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(snapshotFromForm(form)) !== JSON.stringify(deal.propertySnapshot);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {deal.propertyId ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600 dark:text-gray-400">登録済みの物件から写しています。</span>
          {canOpenProperty && (
            <Link href={`/properties/${deal.propertyId}`} className="text-indigo-700 hover:underline dark:text-indigo-400">物件を開く</Link>
          )}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            <RefreshCw className="h-4 w-4" />
            物件から取り直す
          </Button>
        </div>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-400">手入力の物件です(物件の一覧には登録しません)。</p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {TEXT_FIELDS.map(([k, label, max]) => (
          <Field key={k} label={label}>
            <input value={form[k]} onChange={(e) => set(k, e.target.value)} maxLength={max} aria-label={label} className={inputCls} />
          </Field>
        ))}
        {NUMBER_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <input inputMode="decimal" value={form[k]} onChange={(e) => set(k, e.target.value)} aria-label={label} className={inputCls} />
          </Field>
        ))}
        <Field label="土地の権利">
          <SelectBox label="土地の権利" value={form.landRight} onChange={(v) => set("landRight", v)} options={optionsOf(LAND_RIGHT_LABELS)} allowEmpty />
        </Field>
      </div>

      <Button
        onClick={() => run(() => dealsApi.update(deal.id, { version: deal.version, propertySnapshot: snapshotFromForm(form) }))}
        disabled={busy || !dirty} loading={busy} loadingLabel="保存中"
      >
        <Save className="h-4 w-4" />
        保存
      </Button>

      <ConfirmDialog
        open={confirming}
        title="物件から取り直しますか？"
        message="物件の今の情報で、この画面の項目を上書きします。ここで手直しした内容は消えます。"
        confirmLabel="取り直す"
        onConfirm={() => { setConfirming(false); void run(() => dealsApi.refreshProperty(deal.id, deal.version)); }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
```

```tsx
// src/components/deals/deal-parties-panel.tsx
"use client";

import { useState } from "react";
import { Building2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { dealsApi, DealApiError, errorText, type DealOptions } from "@/lib/deals/client";
import { EMPTY_PARTY_FORM, partyBodyFromForm, partyFormFromView, type PartyForm } from "@/lib/deals/forms";
import type { DealPartyView, DealView } from "@/lib/deals/view";
import { DEAL_PARTY_ROLE_LABELS, DEAL_PARTY_TYPE_LABELS } from "@/lib/deals/constants";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

/** 当事者(売主・買主・代理人・賃借人)。1件ずつ開いて直す。 */
export default function DealPartiesPanel({
  deal, selfParty, onSaved,
}: { deal: DealView; selfParty: DealOptions["selfParty"] | null; onSaved: () => Promise<void> }) {
  /** null=閉じている / "new"=新しく足す / それ以外=直している当事者の id */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<PartyForm>(EMPTY_PARTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DealPartyView | null>(null);
  const set = <K extends keyof PartyForm>(k: K, v: PartyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const open = (p: DealPartyView | null) => {
    setError(null);
    setEditing(p ? p.id : "new");
    setForm(p ? partyFormFromView(p) : EMPTY_PARTY_FORM);
  };
  const fillSelf = () => {
    if (!selfParty) return;
    setForm((f) => ({
      ...f, partyType: "corporation", name: selfParty.name, representative: selfParty.representative ?? "",
      address: selfParty.address ?? "", phone: selfParty.phone ?? "", isSelf: true,
    }));
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const body = partyBodyFromForm(form);
    const current = deal.parties.find((p) => p.id === editing);
    return run(() => (current
      ? dealsApi.updateParty(deal.id, current.id, { version: current.version, ...body })
      : dealsApi.addParty(deal.id, body)));
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {deal.parties.length === 0 && editing === null && (
        <p className="text-sm text-gray-500 dark:text-gray-400">当事者はまだいません。「当事者を足す」から入れられます。</p>
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {deal.parties.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="w-16 text-xs text-gray-500">{DEAL_PARTY_ROLE_LABELS[p.role as keyof typeof DEAL_PARTY_ROLE_LABELS] ?? p.role}</span>
            <span className="flex-1">{p.name}{p.shareNum && p.shareDen ? `(持分 ${p.shareNum}/${p.shareDen})` : ""}</span>
            <Button variant="ghost" size="sm" onClick={() => open(p)}>直す</Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(p)}>
              <Trash2 className="h-4 w-4" />
              消す
            </Button>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <Button variant="secondary" onClick={() => open(null)}>
          <Plus className="h-4 w-4" />
          当事者を足す
        </Button>
      ) : (
        <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="役割">
              <SelectBox label="役割" value={form.role} onChange={(v) => set("role", v)} options={optionsOf(DEAL_PARTY_ROLE_LABELS)} />
            </Field>
            <Field label="個人・法人">
              <SelectBox label="個人・法人" value={form.partyType} onChange={(v) => set("partyType", v)} options={optionsOf(DEAL_PARTY_TYPE_LABELS)} />
            </Field>
            <Field label="氏名(法人名)">
              <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} aria-label="氏名(法人名)" className={inputCls} />
            </Field>
            <Field label="代表者">
              <input value={form.representative} onChange={(e) => set("representative", e.target.value)} maxLength={100} aria-label="代表者" className={inputCls} />
            </Field>
            <Field label="住所">
              <input value={form.address} onChange={(e) => set("address", e.target.value)} maxLength={300} aria-label="住所" className={inputCls} />
            </Field>
            <Field label="連絡先">
              <input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={50} aria-label="連絡先" className={inputCls} />
            </Field>
            <Field label="共有持分(分子)">
              <input inputMode="numeric" value={form.shareNum} onChange={(e) => set("shareNum", e.target.value)} aria-label="共有持分(分子)" className={inputCls} />
            </Field>
            <Field label="共有持分(分母)">
              <input inputMode="numeric" value={form.shareDen} onChange={(e) => set("shareDen", e.target.value)} aria-label="共有持分(分母)" className={inputCls} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy || !form.name.trim()} loading={busy} loadingLabel="保存中">
              <Save className="h-4 w-4" />
              保存
            </Button>
            {selfParty && (
              <Button variant="secondary" onClick={fillSelf} disabled={busy}>
                <Building2 className="h-4 w-4" />
                自社を入れる
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>やめる</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="この当事者を消しますか？"
        message={deleting ? `${deleting.name} を当事者から外します。` : ""}
        confirmLabel="消す"
        danger
        onConfirm={() => {
          const p = deleting;
          setDeleting(null);
          if (p) void run(() => dealsApi.deleteParty(deal.id, p.id, p.version));
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
```

- [ ] **Step 5: テストを走らせて、通ることを確かめる**

```bash
npx vitest run src/lib/deals/__tests__ > /tmp/deals-t11.log 2>&1; echo exit=$?; tail -5 /tmp/deals-t11.log
npx tsc --noEmit > /tmp/deals-tsc.log 2>&1; echo exit=$?; tail -20 /tmp/deals-tsc.log
```
Expected: どちらも `exit=0`

- [ ] **Step 6: コミットする**

```bash
git add "src/app/(dashboard)/deals" src/components/deals src/lib/deals
git commit -m "feat(deals): 取引の詳しい画面(基本・物件・当事者)"
```

---

### Task 12: 取引の設定の画面

**Files:**
- Create: `src/app/(dashboard)/admin/deal-settings/page.tsx`
- Modify: `src/components/layout/sidebar-model.tsx`(「システム管理」の会社情報の次に「取引の設定」)
- Modify: `src/components/layout/__tests__/sidebar-reorg.test.ts`(システム管理の項目を固定で見ているテストがあれば、その期待値)
- Test: `src/lib/deals/__tests__/settings-page-source.test.ts`

**Interfaces:**
- Consumes: `dealsApi.getSettings` / `saveSettings` / `rateTables`、`RATE_TABLE_KIND_LABELS`、`BANK_ACCOUNT_TYPE_LABELS`、`BASE_PROPERTY_KIND_LABELS`、`BASE_PROPERTY_KINDS`
- Produces: 画面 `/admin/deal-settings`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/deals/__tests__/settings-page-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/admin/deal-settings/page.tsx";

describe("取引の設定の画面", () => {
  it("システム管理の会社情報の次・管理者だけ", () => {
    const admin = SIDEBAR_GROUPS.find((g) => g.key === "admin")!;
    const hrefs = admin.items.map((i) => i.href);
    expect(hrefs.indexOf("/admin/deal-settings")).toBe(hrefs.indexOf("/admin/company-settings") + 1);
    expect(admin.items.find((i) => i.href === "/admin/deal-settings")).toMatchObject({ label: "取引の設定", minRole: "admin" });
  });
  it("題名・代表者・口座・物件種別・税率の表(見るだけ)", () => {
    const src = read(PAGE);
    expect(src).toContain('title="取引の設定"');
    for (const s of ["代表者", "振込先口座", "物件種別", "税率・税額の表"]) expect(src).toContain(s);
    expect(src).toContain("会社情報（販売図面の差出人）");
    expect(src).not.toMatch(/<button[\s>]/);
  });
  it("基本の4種別は消せない(消すボタンを出さない)", () => {
    expect(read(PAGE)).toMatch(/BASE_PROPERTY_KINDS\.includes/);
  });
});
```

- [ ] **Step 2: テストを走らせて、失敗することを確かめる**

Run: `npx vitest run src/lib/deals/__tests__/settings-page-source.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`sidebar-model.tsx` の会社情報の行の次に、次を足します。

```tsx
      // 取引の設定(設計 2026-10-23 §5)。会社名・住所などは上の会社情報を使う。
      { label: "取引の設定", href: "/admin/deal-settings", icon: ic(Handshake), minRole: "admin" },
```

```tsx
// src/app/(dashboard)/admin/deal-settings/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, DealApiError, errorText, type RateTableView } from "@/lib/deals/client";
import type { DealSettingsView } from "@/lib/deals/settings";
import {
  BANK_ACCOUNT_TYPE_LABELS, BASE_PROPERTY_KINDS, BASE_PROPERTY_KIND_LABELS, type PropertyKindDef,
} from "@/lib/deals/constants";
import { RATE_TABLE_KIND_LABELS } from "@/lib/deals/rate-tables";

type Bank = DealSettingsView["bankAccount"];
const BANK_FIELDS: [keyof Bank, string, number][] = [
  ["bankName", "銀行名", 100], ["branchName", "支店名", 100], ["accountNumber", "口座番号(7桁まで)", 7], ["accountHolder", "名義", 100],
];

/** 取引の設定(管理者だけ)。段1は代表者・口座・物件種別。税率・税額の表は見るだけ(編集は段2)。 */
export default function DealSettingsPage() {
  const [settings, setSettings] = useState<DealSettingsView | null>(null);
  const [tables, setTables] = useState<RateTableView[]>([]);
  const [title, setTitle] = useState("");
  const [repName, setRepName] = useState("");
  const [bank, setBank] = useState<Record<keyof Bank, string>>({ bankName: "", branchName: "", accountType: "", accountNumber: "", accountHolder: "" });
  const [kinds, setKinds] = useState<PropertyKindDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = (s: DealSettingsView) => {
    setSettings(s);
    setTitle(s.representativeTitle ?? "");
    setRepName(s.representativeName ?? "");
    setBank({
      bankName: s.bankAccount.bankName ?? "", branchName: s.bankAccount.branchName ?? "", accountType: s.bankAccount.accountType ?? "",
      accountNumber: s.bankAccount.accountNumber ?? "", accountHolder: s.bankAccount.accountHolder ?? "",
    });
    setKinds(s.propertyKinds);
  };

  useEffect(() => {
    dealsApi.getSettings().then((r) => apply(r.settings)).catch((e) => setMessage({ kind: "err", text: errorText(e) }));
    dealsApi.rateTables().then((r) => setTables(r.tables)).catch(() => {});
  }, []);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await dealsApi.saveSettings({
        version: settings.version,
        representativeTitle: title,
        representativeName: repName,
        bankAccount: { ...bank, accountType: bank.accountType || null },
        propertyKinds: kinds,
      });
      apply(res.settings);
      setMessage({ kind: "ok", text: "取引の設定を保存しました" });
    } catch (e) {
      const text = e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "ほかの人が先に保存しました。画面を読み込み直してから、もう一度入力してください。"
        : errorText(e);
      setMessage({ kind: "err", text });
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return message ? (
      <p className="p-6 text-sm text-red-600 dark:text-red-400" role="alert">{message.text}</p>
    ) : (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…</div>
    );
  }

  const setKind = (i: number, patch: Partial<PropertyKindDef>) => setKinds((ks) => ks.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="取引の設定"
        description={
          <>
            取引の書類に使う情報です。会社名・住所・電話・免許番号は
            <Link href="/admin/company-settings" className="mx-1 text-indigo-700 hover:underline dark:text-indigo-400">会社情報（販売図面の差出人）</Link>
            の値を使います。
          </>
        }
      />
      {message && (
        <p className={`text-sm ${message.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} role="alert">{message.text}</p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">代表者</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="肩書"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={50} aria-label="代表者の肩書" className={inputCls} /></Field>
          <Field label="氏名"><input value={repName} onChange={(e) => setRepName(e.target.value)} maxLength={100} aria-label="代表者の氏名" className={inputCls} /></Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">振込先口座</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {BANK_FIELDS.map(([k, label, max]) => (
            <Field key={k} label={label}>
              <input value={bank[k]} onChange={(e) => setBank((b) => ({ ...b, [k]: e.target.value }))} maxLength={max} aria-label={label} className={inputCls} />
            </Field>
          ))}
          <Field label="種別">
            <SelectBox label="口座の種別" value={bank.accountType} onChange={(v) => setBank((b) => ({ ...b, accountType: v }))} options={optionsOf(BANK_ACCOUNT_TYPE_LABELS)} allowEmpty />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">物件種別</h2>
        <p className="text-xs text-gray-500">足した種別は、書類の出し分けで「元の種別」と同じに扱います。基本の4つは消せません。</p>
        <ul className="space-y-2">
          {kinds.map((k, i) => {
            const isBase = (BASE_PROPERTY_KINDS as readonly string[]).includes(k.key);
            return (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label="鍵(英小文字・数字・_)">
                  <input value={k.key} disabled={isBase} onChange={(e) => setKind(i, { key: e.target.value })} maxLength={30} aria-label="種別の鍵" className={inputCls} />
                </Field>
                <Field label="名前"><input value={k.label} onChange={(e) => setKind(i, { label: e.target.value })} maxLength={30} aria-label="種別の名前" className={inputCls} /></Field>
                <Field label="元の種別">
                  <SelectBox label="元の種別" value={k.base} onChange={(v) => setKind(i, { base: v as PropertyKindDef["base"] })} options={optionsOf(BASE_PROPERTY_KIND_LABELS)} />
                </Field>
                {isBase ? <span /> : (
                  <Button variant="ghost" size="sm" onClick={() => setKinds((ks) => ks.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                    消す
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <Button variant="secondary" size="sm" onClick={() => setKinds((ks) => [...ks, { key: "", label: "", base: "unit" }])} disabled={kinds.length >= 20}>
          <Plus className="h-4 w-4" />
          種別を足す
        </Button>
      </section>

      <Button onClick={save} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">税率・税額の表</h2>
        <p className="text-xs text-gray-500">計算では、契約日(なければ決済日)が期間に入る表を使います。表を直す画面は、計算を入れるときに足します。</p>
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr><th className="px-3 py-2">表</th><th className="px-3 py-2">適用開始</th><th className="px-3 py-2">適用終了</th></tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2">{RATE_TABLE_KIND_LABELS[t.kind as keyof typeof RATE_TABLE_KIND_LABELS] ?? t.kind}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validFrom}</td>
                  <td className="px-3 py-2 tabular-nums">{t.validTo ?? "期限なし"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: テストを走らせる**

```bash
npx vitest run src/lib/deals/__tests__ src/components/layout > /tmp/deals-t12.log 2>&1; echo exit=$?; tail -15 /tmp/deals-t12.log
```
Expected: `exit=0`。システム管理の項目の並びを固定で見ているテストが落ちたら、その期待値に `/admin/deal-settings` を会社情報の次として足します。

- [ ] **Step 5: コミットする**

```bash
git add "src/app/(dashboard)/admin/deal-settings" src/components/layout src/lib/deals
git commit -m "feat(deals): 取引の設定の画面(代表者・口座・物件種別・税率の表)"
```

---

### Task 13: 使い方ガイドの更新と全部の確認

**Files:**
- Modify: `public/docs/guide.html`、`public/docs/manual.html`(取引の節を足す)

- [ ] **Step 1: 使い方ガイドとマニュアルに「取引」の節を足す**

まず、既存の節の書き方を確かめます。

```bash
grep -n "<h2\|<h3" public/docs/guide.html | head -40
```

その書き方に合わせて、短い節を足します。中身は次のとおりです。
- 左メニューの「取引」で一覧が開くこと
- 「新しい取引」で作ること。物件の詳しい画面の「その他」から「この物件で取引を作る」でも作れること
- 詳しい画面のタブ(基本・物件・当事者)
- 管理者向けに、「取引の設定」で代表者・口座・物件種別を入れること
- 資金計画表・書類の出力は、これから足すこと

画面名を書くときはリンクにします(発注者ルール)。

- [ ] **Step 2: 全部の確認(どれも終了コードで判定する)**

```bash
npx tsc --noEmit > /tmp/g-tsc.log 2>&1; echo tsc=$?
npx vitest run > /tmp/g-test.log 2>&1; echo test=$?; tail -6 /tmp/g-test.log
npx eslint src/lib/deals src/app/api/deals src/app/api/admin/deal-settings "src/app/(dashboard)/deals" "src/app/(dashboard)/admin/deal-settings" src/components/deals src/components/layout/sidebar-model.tsx "src/app/(dashboard)/properties/[id]/page.tsx" "src/app/(dashboard)/admin/audit-logs/page.tsx" > /tmp/g-lint.log 2>&1; echo lint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/g-build.log 2>&1; echo build=$?; grep -n "/deals\|deal-settings" /tmp/g-build.log | head
```
Expected:
- `tsc=0`、`test=0`、`lint=0`、`build=0`
- build の route の一覧に、`/deals`、`/deals/[id]`、`/deals/new`、`/admin/deal-settings`、`/api/deals...` が載る

lint で物件の画面などに既存の指摘が出た場合は、自分の差分かどうかを確かめます。`git stash` で同じコマンドを走らせ、結果を比べてから `git stash pop` します。

- [ ] **Step 3: コミットする**

```bash
git add public/docs
git commit -m "docs: 使い方ガイドとマニュアルに「取引」を追加"
```

- [ ] **Step 4: PR の本文に入れるもの(ship スキルに従う)**

- **読み替えた点**: 設計書 §1 の表と、この段で決めたこと(設定画面のうち税率の表は見るだけ、ほかは使う段で足す)
- **migration の中身**: 新しい表5つ・初期データ・権限の付与だけで、既存の表は変えないこと。本番に入れる前に発注者に見せること
- **税率の初期値**: 2026-10 時点の公開の制度で入れたこと。印紙税の軽減は 2027-03-31 まで。発注者に確かめてもらうこと
- **実際の画面で確かめる手順**:
  1. 左メニューの「取引」→ `/deals` が開き、「取引はまだありません」と出る
  2. 「新しい取引」→ 取引名「試験」、仲介、両手、土地で「作成」→ 詳しい画面に移り、番号が `2026-0001` になる
  3. 基本タブで状態を「契約済」、契約日時を入れて「保存」→ 画面を読み込み直しても残っている
  4. 同じ取引を2つのタブで開き、片方で保存してから、もう片方で保存 →「ほかの人が先に更新しました」と出て上書きされない
  5. 物件の詳しい画面の「その他」→「この物件で取引を作る」→ 作成 → 物件タブに物件名・住所・面積が入っていて、「物件を開く」で物件に戻れる
  6. 当事者タブで「当事者を足す」→「自社を入れる」→ 会社名・住所・電話が入る → 保存 → 一覧に出る → 「消す」で確認が出て消える
  7. 管理者で「システム管理」→「取引の設定」→ 代表者と口座を入れて保存 → 税率・税額の表が6行出ている
  8. 現地担当でログイン → 左メニューに「取引」が出る。担当外の物件で「この物件で取引を作る」は出ない(物件を開けないため)
  9. 監査ログに「取引を作成」「取引を更新」が日本語で出て、中身に名前・住所が出ていない
