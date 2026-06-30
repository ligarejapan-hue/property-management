# 売却促進DM 作成 — Plan 4: 配達結果 + 反響 + 宛先不明→物件連動 + 集計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 確定済みの宛先下書きに対して「送付確定(mark-sent)」「配達結果(届いた/宛先不明/その他返送)」「反響(電話)」を記録し、宛先不明はその物件のDM送付ステータスを自動で「送付不可」に連動(監査・手動解除可)させ、型(variant)別の **送付/到達/宛先不明/反響(LP・電話内訳)/反響率(母数=到達)/宛先不明率** を集計するところまでを作る。反響(`outcome=inquiry`)は LP アクセス(Plan 5)または電話の **導出値**(純関数 `deriveOutcome`)。

**Architecture:** Plan 1 で用意した Prisma モデル(`DmRecipientDraft` / `DmVariant` / `DmCampaign`・`Property.dmUndeliverableAt`)と route 基盤(`requireSaleDmAccess()` / `no-store` / 非PII AuditLog)に乗る。新規ロジックは **純関数**(`deriveOutcome` / `aggregateByVariant`)に切り出して単体テストし、route(`outcome` / `mark-sent` / `aggregate` / 物件側 `clear-dm-undeliverable`)は薄く保つ。宛先不明の物件連動・送付確定の `PropertyDmLog` 連携は **同一トランザクション**で行う。raw SQL は使わない。

**Tech Stack:** Next.js 16 (App Router) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`、上位土台: `docs/superpowers/plans/2026-06-22-sale-dm-letter-assist-01-foundation.md`(Plan 1)。本プランは Plan 1 が作る lib/route/schema を **再定義しない**(import して使う)。
- 実装は **専用 git worktree** で行う(`superpowers:using-git-worktrees` を実行時に使用)。base = `main`・branch = `feat/sale-dm-letter-assist`(Plan 1 と同一ブランチに積む)。
- 本文・宛名・住所・メモは **PII**。route レスポンスは `Cache-Control: no-store`。AuditLog に本文/PII を残さない(非PIIメタのみ=campaignId/draftId/propertyId/件数/状態・時刻)。
- 権限ゲートは Plan 1 の `requireSaleDmAccess()`(`@/lib/sale-dm-letter/route-guard`)を使う(`property:read`+`csv_export:read`+`csv_export_personal:read`+`owner:read` かつ氏名/郵便番号/住所が生値レベル `isPlainOwnerLevel`)。不足は 403(副作用なし)。物件側 `clear-dm-undeliverable` も同ゲートを使う(DM運用権限と同等とみなす)。
- `Property.dmStatus` の enum は `DmStatus { send hold no_send }`(`prisma/schema.prisma:56`)。宛先不明連動は `no_send` を使う。
- `Property.dmUndeliverableAt: DateTime?`(Plan 1 Task 1 で追加済み)を denormalized フラグとして使う。物件一覧のバッジ/フィルタはこのフィールド参照。
- 既存ヘルパ再利用(再実装しない): `@/lib/api-helpers`(getApiSession/handleApiError/ApiError/apiResponse), `@/lib/sale-dm-letter/route-guard`(requireSaleDmAccess), `@/lib/audit`(writeAuditLog), `@/lib/prisma`(default prisma), `@/lib/csv-encode`(将来CSV拡張で使用・本プランでは未使用), zod。
- 反響の正準定義: **`outcome=inquiry` は導出値**。`deriveOutcome(draft)` = `lpFirstAccessAt != null || phoneInquiryAt != null ? "inquiry" : "none"`。LP アクセスは Plan 5 が書き込む。本プランは **電話(`phoneInquiryAt`)の手入力**と **導出**を担当する。`outcome` カラムは導出値の永続キャッシュとして write 時に同期更新する(集計はカラムにも純関数にも依存しすぎないよう、集計入力は `lpFirstAccessAt`/`phoneInquiryAt`/`deliveryStatus`/`variantId` の生値から計算する)。
- 反響率の母数は **到達数(`deliveryStatus=delivered`)**。宛先不明数 = `deliveryStatus=returned_undeliverable`。宛先不明率の母数は **送付数(該当型の draft 数)**。
- DRY / YAGNI / TDD / こまめにコミット。raw SQL は入れない(既存方針踏襲)。
- 本プランのスコープ外(他プラン): デザインテンプレ/印刷/CSV(Plan 2)・複数型と割当(Plan 3)・LP追跡と `/t/[token]`/proxy.ts 公開パス(Plan 5)・作業画面UI全体(Plan 6)。本プランの UI 触りは「物件一覧の宛先不明バッジ列+フィルタ」のみ(連動の可視化に必要な最小)。

---

### Task 1: 反響導出の純関数 `deriveOutcome`

**Files:**
- Create: `src/lib/sale-dm-letter/outcome.ts`
- Test: `src/lib/__tests__/sale-dm-outcome.test.ts`

**Interfaces:**
- Produces: `deriveOutcome(input: { lpFirstAccessAt: Date | null; phoneInquiryAt: Date | null }): "none" | "inquiry"`。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-outcome.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveOutcome } from "../sale-dm-letter/outcome";

describe("deriveOutcome", () => {
  it("どちらの反響シグナルも無ければ none", () => {
    expect(deriveOutcome({ lpFirstAccessAt: null, phoneInquiryAt: null })).toBe("none");
  });
  it("LP アクセスがあれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: new Date(), phoneInquiryAt: null })).toBe("inquiry");
  });
  it("電話があれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: null, phoneInquiryAt: new Date() })).toBe("inquiry");
  });
  it("両方あれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: new Date(), phoneInquiryAt: new Date() })).toBe("inquiry");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-outcome.test.ts`
Expected: FAIL(`deriveOutcome` 未定義 / モジュール解決不可)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/outcome.ts`:

```ts
// 反響(問い合わせ)の正準定義(設計書):
//   outcome=inquiry ⇔ LP アクセス(lpFirstAccessAt) または 電話(phoneInquiryAt) のいずれかが存在。
// DB の outcome カラムはこの値の永続キャッシュ。書き込み route はこの関数で同期する。
export type DmOutcomeValue = "none" | "inquiry";

export function deriveOutcome(input: {
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
}): DmOutcomeValue {
  return input.lpFirstAccessAt != null || input.phoneInquiryAt != null
    ? "inquiry"
    : "none";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-outcome.test.ts`
Expected: PASS(4 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/outcome.ts src/lib/__tests__/sale-dm-outcome.test.ts
git commit -m "feat(sale-dm): add deriveOutcome pure function (LP or phone => inquiry)"
```

---

### Task 2: 型別集計の純関数 `aggregateByVariant`

**Files:**
- Create: `src/lib/sale-dm-letter/aggregate.ts`
- Test: `src/lib/__tests__/sale-dm-aggregate.test.ts`

**Interfaces:**
- Consumes: `deriveOutcome`(Task 1)。
- Produces:
  - `interface AggregateDraftInput { variantId: string; deliveryStatus: string; lpFirstAccessAt: Date | null; phoneInquiryAt: Date | null }`
  - `interface VariantAggregate { variantId: string; sent: number; delivered: number; undeliverable: number; inquiry: number; inquiryLp: number; inquiryPhone: number; inquiryBoth: number; responseRate: number | null; undeliverableRate: number | null }`
  - `interface CampaignAggregate { byVariant: VariantAggregate[]; total: VariantAggregate }`
  - `aggregateByVariant(drafts: AggregateDraftInput[]): CampaignAggregate`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aggregateByVariant, type AggregateDraftInput } from "../sale-dm-letter/aggregate";

const d = (over: Partial<AggregateDraftInput>): AggregateDraftInput => ({
  variantId: "A",
  deliveryStatus: "delivered",
  lpFirstAccessAt: null,
  phoneInquiryAt: null,
  ...over,
});

describe("aggregateByVariant", () => {
  it("空入力は byVariant=[]・total が全ゼロ・率は null(0除算回避)", () => {
    const r = aggregateByVariant([]);
    expect(r.byVariant).toEqual([]);
    expect(r.total.sent).toBe(0);
    expect(r.total.responseRate).toBeNull();
    expect(r.total.undeliverableRate).toBeNull();
  });

  it("送付数は型ごとの draft 数・到達は delivered のみ・宛先不明は returned_undeliverable のみ", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "returned_undeliverable" }),
      d({ variantId: "A", deliveryStatus: "unknown" }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.sent).toBe(4);
    expect(a.delivered).toBe(2);
    expect(a.undeliverable).toBe(1);
  });

  it("反響=LP∪電話・内訳(lp/phone/both)・反響率の母数は到達数", () => {
    const r = aggregateByVariant([
      // 到達3 のうち 2 が反響(LP1 / 電話1) → 反響率 = 2/3
      d({ variantId: "A", deliveryStatus: "delivered", lpFirstAccessAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered", phoneInquiryAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      // returned は到達に数えない(分母外)。反響シグナルがあってもカウントするが率の母数は到達
      d({ variantId: "A", deliveryStatus: "returned_undeliverable", phoneInquiryAt: new Date() }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.delivered).toBe(3);
    expect(a.inquiryLp).toBe(1);
    expect(a.inquiryPhone).toBe(2); // delivered の電話1 + undeliverable の電話1
    expect(a.inquiry).toBe(3); // LP1 + 電話2(重複なし)
    // 反響率 = 到達のうち反響した数 / 到達数 = 2/3
    expect(a.responseRate).toBeCloseTo(2 / 3, 5);
  });

  it("LP と電話の両方があるドラフトは both にも数え・inquiry は1として数える", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: new Date() }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.inquiry).toBe(1);
    expect(a.inquiryLp).toBe(1);
    expect(a.inquiryPhone).toBe(1);
    expect(a.inquiryBoth).toBe(1);
    expect(a.responseRate).toBeCloseTo(1, 5);
  });

  it("宛先不明率の母数は送付数(該当型の draft 数)", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "returned_undeliverable" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "unknown" }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.undeliverableRate).toBeCloseTo(1 / 4, 5);
  });

  it("型をまたいで集計し total に合算・byVariant は variantId 昇順", () => {
    const r = aggregateByVariant([
      d({ variantId: "B", deliveryStatus: "delivered", phoneInquiryAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
    ]);
    expect(r.byVariant.map((v) => v.variantId)).toEqual(["A", "B"]);
    expect(r.total.sent).toBe(2);
    expect(r.total.delivered).toBe(2);
    expect(r.total.inquiry).toBe(1);
    expect(r.total.responseRate).toBeCloseTo(1 / 2, 5);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/aggregate.ts`:

```ts
import { deriveOutcome } from "./outcome";

export interface AggregateDraftInput {
  variantId: string;
  deliveryStatus: string; // "unknown" | "delivered" | "returned_undeliverable" | "returned_other"
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
}

export interface VariantAggregate {
  variantId: string;
  sent: number; // 送付数 = 該当型の draft 数
  delivered: number; // 到達数 = deliveryStatus===delivered
  undeliverable: number; // 宛先不明 = deliveryStatus===returned_undeliverable
  inquiry: number; // 反響(LP∪電話。重複は1)
  inquiryLp: number; // LP 反響件数
  inquiryPhone: number; // 電話 反響件数
  inquiryBoth: number; // LP と電話の両方を持つ件数
  responseRate: number | null; // 反響率 = (到達のうち反響した数) / 到達数。到達0なら null
  undeliverableRate: number | null; // 宛先不明率 = 宛先不明数 / 送付数。送付0なら null
}

export interface CampaignAggregate {
  byVariant: VariantAggregate[];
  total: VariantAggregate;
}

function emptyAggregate(variantId: string): VariantAggregate {
  return {
    variantId,
    sent: 0,
    delivered: 0,
    undeliverable: 0,
    inquiry: 0,
    inquiryLp: 0,
    inquiryPhone: 0,
    inquiryBoth: 0,
    responseRate: null,
    undeliverableRate: null,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

// 1ドラフトを集計バケットへ反映する(byVariant と total で共有)。
// deliveredResponded は「到達かつ反響」= 反響率の分子。
function accumulate(
  agg: VariantAggregate,
  draft: AggregateDraftInput,
  counters: { deliveredResponded: number },
): { deliveredResponded: number } {
  agg.sent += 1;
  const isDelivered = draft.deliveryStatus === "delivered";
  const isUndeliverable = draft.deliveryStatus === "returned_undeliverable";
  if (isDelivered) agg.delivered += 1;
  if (isUndeliverable) agg.undeliverable += 1;

  const hasLp = draft.lpFirstAccessAt != null;
  const hasPhone = draft.phoneInquiryAt != null;
  const isInquiry = deriveOutcome(draft) === "inquiry";
  if (hasLp) agg.inquiryLp += 1;
  if (hasPhone) agg.inquiryPhone += 1;
  if (hasLp && hasPhone) agg.inquiryBoth += 1;
  if (isInquiry) agg.inquiry += 1;

  let { deliveredResponded } = counters;
  if (isDelivered && isInquiry) deliveredResponded += 1;
  return { deliveredResponded };
}

export function aggregateByVariant(drafts: AggregateDraftInput[]): CampaignAggregate {
  const map = new Map<string, { agg: VariantAggregate; deliveredResponded: number }>();
  const total = emptyAggregate("__total__");
  let totalDeliveredResponded = 0;

  for (const draft of drafts) {
    let bucket = map.get(draft.variantId);
    if (!bucket) {
      bucket = { agg: emptyAggregate(draft.variantId), deliveredResponded: 0 };
      map.set(draft.variantId, bucket);
    }
    bucket.deliveredResponded = accumulate(bucket.agg, draft, {
      deliveredResponded: bucket.deliveredResponded,
    }).deliveredResponded;
    totalDeliveredResponded = accumulate(total, draft, {
      deliveredResponded: totalDeliveredResponded,
    }).deliveredResponded;
  }

  const byVariant = Array.from(map.values())
    .map(({ agg, deliveredResponded }) => {
      agg.responseRate = rate(deliveredResponded, agg.delivered);
      agg.undeliverableRate = rate(agg.undeliverable, agg.sent);
      return agg;
    })
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  total.responseRate = rate(totalDeliveredResponded, total.delivered);
  total.undeliverableRate = rate(total.undeliverable, total.sent);

  return { byVariant, total };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate.test.ts`
Expected: PASS(6 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/aggregate.ts src/lib/__tests__/sale-dm-aggregate.test.ts
git commit -m "feat(sale-dm): add aggregateByVariant pure function (delivered/inquiry/rates)"
```

---

### Task 3: 配達結果 + 反響(電話) route `PATCH .../drafts/[id]/outcome`(宛先不明→物件連動)

**Files:**
- Create: `src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts`
- Test: `src/lib/__tests__/sale-dm-outcome-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`deriveOutcome`(Task 1)、`writeAuditLog`、prisma。
- Produces: `PATCH /api/properties/sale-dm/drafts/[id]/outcome`。`returned_undeliverable` 記録時に対象 `Property.dmStatus`→`no_send`・`dmUndeliverableAt` を同一 tx で更新+監査。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-outcome-route.test.ts`(dm-export route test と同じ `vi.mock` 流儀。`requireSaleDmAccess` をモックし、`prisma.$transaction`/`dmRecipientDraft.{findUnique,update}`/`property.update` をモックする):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const draftUpdate = vi.fn();
  const propertyUpdate = vi.fn();
  const draftFindUnique = vi.fn();
  return {
    default: {
      dmRecipientDraft: { findUnique: draftFindUnique, update: draftUpdate },
      property: { update: propertyUpdate },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          dmRecipientDraft: { update: draftUpdate },
          property: { update: propertyUpdate },
        }),
      ),
    },
  };
});

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { PATCH } from "../../app/api/properties/sale-dm/drafts/[id]/outcome/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  property: { update: ReturnType<typeof vi.fn> };
};
const req = (b: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "r1",
    propertyId: "p1",
    deliveryStatus: "unknown",
    lpFirstAccessAt: null,
    phoneInquiryAt: null,
  });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.property.update.mockResolvedValue({ id: "p1" });
});

describe("PATCH outcome", () => {
  it("delivered を記録し deliveryStatus/returnedAt を更新・物件は触らない", async () => {
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.deliveryStatus).toBe("delivered");
    expect(arg.data.returnedAt).toBeNull();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("電話反響を記録し outcome を inquiry に同期する", async () => {
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeInstanceOf(Date);
    expect(arg.data.outcome).toBe("inquiry");
  });

  it("電話反響を取り消すと outcome は LP の有無で再導出(LPなし→none)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1",
      propertyId: "p1",
      deliveryStatus: "delivered",
      lpFirstAccessAt: null,
      phoneInquiryAt: new Date(),
    });
    const res = await PATCH(req({ phoneInquiry: false }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeNull();
    expect(arg.data.outcome).toBe("none");
  });

  it("returned_undeliverable を記録すると物件を no_send + dmUndeliverableAt にし監査する", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    const draftArg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(draftArg.data.deliveryStatus).toBe("returned_undeliverable");
    expect(draftArg.data.returnedAt).toBeInstanceOf(Date);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.where.id).toBe("p1");
    expect(propArg.data.dmStatus).toBe("no_send");
    expect(propArg.data.dmUndeliverableAt).toBeInstanceOf(Date);
    expect(writeAuditLog).toHaveBeenCalled();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(audit.detail)).not.toContain("本文");
  });

  it("returned_other は物件連動しない", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_other" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("不正な deliveryStatus は 422", async () => {
    const res = await PATCH(req({ deliveryStatus: "bogus" }) as never, ctx());
    expect(res.status).toBe(422);
  });

  it("存在しない draft は 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(404);
  });

  it("権限不足(requireSaleDmAccess が 403 throw)で 403・副作用なし", async () => {
    class MockApiError extends Error {
      status = 403;
      code = "FORBIDDEN";
    }
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new MockApiError("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });
});
```

> 注: `requireSaleDmAccess` は内部で `ApiError` を throw する。テストでは route-guard 自体をモックして 403 を再現する(api-helpers の `ApiError` と同型の `status`/`code` を持つオブジェクトを reject すれば `handleApiError` が 403 を返す)。実装の `handleApiError` は本物の `ApiError` を扱うが、このテストでは api-helpers をモックしているため、route-guard モックが reject する error も `MockApiError` 形(status/code 持ち)にすること。

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-outcome-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: zod スキーマ + route を実装**

`src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { deriveOutcome } from "@/lib/sale-dm-letter/outcome";

// 配達結果は明示指定された時のみ更新する(省略時は据え置き)。
// 反響(電話)は true/false で立て下げ可能にする(取り消し時は LP の有無で再導出)。
const outcomeSchema = z
  .object({
    deliveryStatus: z
      .enum(["unknown", "delivered", "returned_undeliverable", "returned_other"])
      .optional(),
    phoneInquiry: z.boolean().optional(),
    outcomeNote: z.string().max(2000).optional(),
  })
  .refine(
    (b) =>
      b.deliveryStatus !== undefined ||
      b.phoneInquiry !== undefined ||
      b.outcomeNote !== undefined,
    { message: "更新内容がありません" },
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const input = outcomeSchema.parse(await request.json());

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: {
        id: true,
        propertyId: true,
        deliveryStatus: true,
        lpFirstAccessAt: true,
        phoneInquiryAt: true,
      },
    });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    const now = new Date();

    // 反響(電話)の確定値: 明示指定があればそれ、無ければ現状維持。
    const nextPhoneInquiryAt =
      input.phoneInquiry === undefined
        ? draft.phoneInquiryAt
        : input.phoneInquiry
          ? (draft.phoneInquiryAt ?? now)
          : null;

    // outcome は LP と電話の有無から再導出(永続キャッシュの同期)。
    const nextOutcome = deriveOutcome({
      lpFirstAccessAt: draft.lpFirstAccessAt,
      phoneInquiryAt: nextPhoneInquiryAt,
    });

    const nextDeliveryStatus = input.deliveryStatus ?? draft.deliveryStatus;
    const becameUndeliverable =
      input.deliveryStatus === "returned_undeliverable" &&
      draft.deliveryStatus !== "returned_undeliverable";

    const draftData: Record<string, unknown> = {
      phoneInquiryAt: nextPhoneInquiryAt,
      outcome: nextOutcome,
    };
    if (input.deliveryStatus !== undefined) {
      draftData.deliveryStatus = input.deliveryStatus;
      // 返送(宛先不明 / その他)を記録した時のみ returnedAt を立てる。それ以外は null へ戻す。
      draftData.returnedAt =
        input.deliveryStatus === "returned_undeliverable" ||
        input.deliveryStatus === "returned_other"
          ? now
          : null;
    }
    if (input.outcomeNote !== undefined) {
      draftData.outcomeNote = input.outcomeNote;
    }

    // 下書き更新と(宛先不明なら)物件連動を 1 トランザクションで行う。
    await prisma.$transaction(async (tx) => {
      await tx.dmRecipientDraft.update({ where: { id }, data: draftData });
      if (becameUndeliverable) {
        await tx.property.update({
          where: { id: draft.propertyId },
          data: { dmStatus: "no_send", dmUndeliverableAt: now },
        });
      }
    });

    // 非PII の監査(本文・宛名・住所・メモは残さない)。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_outcome_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: {
        propertyId: draft.propertyId,
        deliveryStatus: nextDeliveryStatus,
        outcome: nextOutcome,
        undeliverableLinked: becameUndeliverable,
        updatedAt: now.toISOString(),
      },
    });

    return NextResponse.json(
      { id, deliveryStatus: nextDeliveryStatus, outcome: nextOutcome, undeliverableLinked: becameUndeliverable },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

> 実装メモ: テストは `tx.dmRecipientDraft.update`/`tx.property.update` を共有モックで観測する(`$transaction` モックが同じ vi.fn を tx に渡す)。`returned_other` の分岐で `property.update` が呼ばれないこと・`becameUndeliverable` が状態遷移時のみ true になることを満たす。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-outcome-route.test.ts`
Expected: PASS(8 件)。

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts src/lib/__tests__/sale-dm-outcome-route.test.ts
git commit -m "feat(sale-dm): add outcome route (delivery/phone) + undeliverable->property link"
```

---

### Task 4: 宛先不明の手動解除 route `POST /api/properties/[id]/clear-dm-undeliverable`

**Files:**
- Create: `src/app/api/properties/[id]/clear-dm-undeliverable/route.ts`
- Test: `src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`writeAuditLog`、prisma。
- Produces: `POST /api/properties/[id]/clear-dm-undeliverable`。対象物件の `dmUndeliverableAt` を null に戻す(連動で立った「宛先不明」フラグの手動解除)。`dmStatus` は人が判断するため自動では戻さない(オプションで `restoreDmStatus` 指定時のみ `send`/`hold` に戻す)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts`(Task 3 と同じ `vi.mock` 流儀。`prisma.property.{findUnique,update}` をモック):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/[id]/clear-dm-undeliverable/route";

const pm = prismaMock as never as {
  property: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
const req = (b: unknown = {}) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const ctx = (id = "p1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.property.findUnique.mockResolvedValue({ id: "p1", dmUndeliverableAt: new Date(), dmStatus: "no_send" });
  pm.property.update.mockResolvedValue({ id: "p1" });
});

describe("POST clear-dm-undeliverable", () => {
  it("dmUndeliverableAt を null に戻し dmStatus は据え置き・監査する", async () => {
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const arg = pm.property.update.mock.calls[0][0];
    expect(arg.data.dmUndeliverableAt).toBeNull();
    expect(arg.data.dmStatus).toBeUndefined();
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("restoreDmStatus=send 指定時は dmStatus も戻す", async () => {
    const res = await POST(req({ restoreDmStatus: "send" }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.property.update.mock.calls[0][0];
    expect(arg.data.dmStatus).toBe("send");
  });

  it("存在しない物件は 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(404);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("不正な restoreDmStatus は 422", async () => {
    const res = await POST(req({ restoreDmStatus: "bogus" }) as never, ctx());
    expect(res.status).toBe(422);
  });

  it("権限不足で 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.property.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: route を実装**

`src/app/api/properties/[id]/clear-dm-undeliverable/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";

// 宛先不明フラグ(dmUndeliverableAt)の手動解除。dmStatus は人の判断で戻すため、
// restoreDmStatus が指定された時のみ send/hold に戻す(no_send のまま据え置きも可)。
const clearSchema = z.object({
  restoreDmStatus: z.enum(["send", "hold"]).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const { restoreDmStatus } = clearSchema.parse(await request.json());

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, dmUndeliverableAt: true, dmStatus: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");

    const data: { dmUndeliverableAt: null; dmStatus?: "send" | "hold" } = {
      dmUndeliverableAt: null,
    };
    if (restoreDmStatus !== undefined) {
      data.dmStatus = restoreDmStatus;
    }

    await prisma.property.update({ where: { id }, data });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_undeliverable_clear",
      targetTable: "properties",
      targetId: id,
      detail: {
        restoredDmStatus: restoreDmStatus ?? null,
        clearedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(
      { id, dmStatus: restoreDmStatus ?? property.dmStatus },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts`
Expected: PASS(5 件)。

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/[id]/clear-dm-undeliverable/route.ts src/lib/__tests__/sale-dm-clear-undeliverable-route.test.ts
git commit -m "feat(sale-dm): add manual clear-dm-undeliverable route (audit)"
```

---

### Task 5: 送付確定 route `POST .../drafts/[id]/mark-sent`(PropertyDmLog 連携)

**Files:**
- Create: `src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts`
- Test: `src/lib/__tests__/sale-dm-mark-sent-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`writeAuditLog`、prisma。
- Produces: `POST /api/properties/sale-dm/drafts/[id]/mark-sent`。draft を `status=sent`+`sentAt`、既存 `PropertyDmLog` に 1 件 create(method="sale_dm")を同一 tx で行う。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-mark-sent-route.test.ts`(Task 3 と同じ流儀。`prisma.$transaction`/`dmRecipientDraft.{findUnique,update}`/`propertyDmLog.create` をモック):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const draftUpdate = vi.fn();
  const dmLogCreate = vi.fn();
  const draftFindUnique = vi.fn();
  return {
    default: {
      dmRecipientDraft: { findUnique: draftFindUnique, update: draftUpdate },
      propertyDmLog: { create: dmLogCreate },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          dmRecipientDraft: { update: draftUpdate },
          propertyDmLog: { create: dmLogCreate },
        }),
      ),
    },
  };
});

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/sale-dm/drafts/[id]/mark-sent/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  propertyDmLog: { create: ReturnType<typeof vi.fn> };
};
const req = () => new Request("http://x", { method: "POST", body: "{}" });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "confirmed" });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.propertyDmLog.create.mockResolvedValue({ id: "log1" });
});

describe("POST mark-sent", () => {
  it("confirmed の draft を sent にし PropertyDmLog を作る・no-store・監査", async () => {
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const draftArg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(draftArg.data.status).toBe("sent");
    expect(draftArg.data.sentAt).toBeInstanceOf(Date);
    const logArg = pm.propertyDmLog.create.mock.calls[0][0];
    expect(logArg.data.propertyId).toBe("p1");
    expect(logArg.data.sentBy).toBe("u1");
    expect(logArg.data.method).toBe("sale_dm");
    expect(writeAuditLog).toHaveBeenCalled();
  });

  it("既に sent の draft は冪等(再 create しない)で 200", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "sent" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("draft が draft(未確定)状態なら 409", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", propertyId: "p1", status: "draft" });
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(409);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("存在しない draft は 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(404);
  });

  it("権限不足で 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await POST(req() as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-mark-sent-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: route を実装**

`src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";

// 送付確定: 確定済み(confirmed)の下書きを sent にし、既存「送付履歴」(PropertyDmLog)へ
// 1 件記録して既存画面に連携する。冪等(既に sent なら再記録しない)。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: { id: true, propertyId: true, status: true },
    });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    // 既に送付済みなら何もしない(冪等)。
    if (draft.status === "sent") {
      return NextResponse.json(
        { id, status: "sent", alreadySent: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // 未確定(draft)からの送付は不可。先に確定(confirm)が必要。
    if (draft.status !== "confirmed") {
      throw new ApiError(409, "確定済みの下書きのみ送付できます", "INVALID_STATE");
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.dmRecipientDraft.update({
        where: { id },
        data: { status: "sent", sentAt: now },
      });
      // PropertyDmLog.sentAt は @db.Date(日付のみ)。method で売却DM由来と分かるようにする。
      await tx.propertyDmLog.create({
        data: {
          propertyId: draft.propertyId,
          sentAt: now,
          method: "sale_dm",
          sentBy: session.id,
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_mark_sent",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: { propertyId: draft.propertyId, sentAt: now.toISOString() },
    });

    return NextResponse.json(
      { id, status: "sent" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-mark-sent-route.test.ts`
Expected: PASS(5 件)。

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts src/lib/__tests__/sale-dm-mark-sent-route.test.ts
git commit -m "feat(sale-dm): add mark-sent route (PropertyDmLog link, idempotent)"
```

---

### Task 6: 集計 route `GET .../campaigns/[id]/aggregate`

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts`
- Test: `src/lib/__tests__/sale-dm-aggregate-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(Plan 1)、`aggregateByVariant`(Task 2)、prisma。
- Produces: `GET /api/properties/sale-dm/campaigns/[id]/aggregate`。型ラベル付きの集計を `no-store` で返す。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-aggregate-route.test.ts`(Task 3 と同じ流儀。`prisma.dmCampaign.findUnique`/`dmRecipientDraft.findMany`/`dmVariant.findMany` をモック。`aggregateByVariant` は実物を使い数値を実挙動で検証):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmVariant: { findMany: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn() },
  },
}));

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/aggregate/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn> };
};
const ctx = (id = "c1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" } });
  pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "テスト" });
  pm.dmVariant.findMany.mockResolvedValue([
    { id: "vA", label: "A" },
    { id: "vB", label: "B" },
  ]);
});

describe("GET aggregate", () => {
  it("型別集計+型ラベルを返す・no-store", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([
      { variantId: "vA", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: null },
      { variantId: "vA", deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null },
      { variantId: "vB", deliveryStatus: "returned_undeliverable", lpFirstAccessAt: null, phoneInquiryAt: null },
    ]);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.total.sent).toBe(3);
    expect(json.total.delivered).toBe(2);
    expect(json.total.undeliverable).toBe(1);
    const vA = json.byVariant.find((v: { variantId: string }) => v.variantId === "vA");
    expect(vA.label).toBe("A");
    expect(vA.delivered).toBe(2);
    expect(vA.responseRate).toBeCloseTo(1 / 2, 5);
  });

  it("0件は total 全ゼロ・byVariant=[]", async () => {
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.byVariant).toEqual([]);
    expect(json.total.sent).toBe(0);
    expect(json.total.responseRate).toBeNull();
  });

  it("存在しない campaign は 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(404);
  });

  it("権限不足で 403", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await GET(new Request("http://x") as never, ctx());
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-route.test.ts`
Expected: FAIL(route 未実装)。

- [ ] **Step 3: route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { aggregateByVariant } from "@/lib/sale-dm-letter/aggregate";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!campaign) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    // 集計入力は反響シグナルの生値から計算する(outcome カラムに依存しない)。
    const [variants, drafts] = await Promise.all([
      prisma.dmVariant.findMany({
        where: { campaignId: id },
        select: { id: true, label: true },
      }),
      prisma.dmRecipientDraft.findMany({
        where: { campaignId: id },
        select: {
          variantId: true,
          deliveryStatus: true,
          lpFirstAccessAt: true,
          phoneInquiryAt: true,
        },
      }),
    ]);

    const aggregate = aggregateByVariant(drafts);
    const labelByVariantId = new Map(variants.map((v) => [v.id, v.label]));

    return NextResponse.json(
      {
        campaignId: campaign.id,
        campaignName: campaign.name,
        byVariant: aggregate.byVariant.map((v) => ({
          ...v,
          label: labelByVariantId.get(v.variantId) ?? v.variantId,
        })),
        total: aggregate.total,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-route.test.ts`
Expected: PASS(4 件)。

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/sale-dm/campaigns/[id]/aggregate/route.ts src/lib/__tests__/sale-dm-aggregate-route.test.ts
git commit -m "feat(sale-dm): add campaign aggregate route (by-variant + total + labels)"
```

---

### Task 7: 物件一覧の「宛先不明」バッジ + フィルタ(連動の可視化)

**Files:**
- Modify: `src/app/(dashboard)/properties/page.tsx`(`dmUndeliverableAt` バッジ + フィルタ UI)
- Modify: `src/lib/validators.ts`(`propertyListQuerySchema` に `undeliverable` フィルタを追加)
- Modify: `src/lib/property-list-query.ts`(`buildPropertyListWhere` で `undeliverable=1` を `dmUndeliverableAt: { not: null }` に変換)
- Test: `src/lib/__tests__/property-list-query-undeliverable.test.ts`

**Interfaces:**
- Consumes: 既存 `buildPropertyListWhere`/`propertyListQuerySchema`/物件一覧 UI(本リポジトリ)。
- Produces: 物件一覧クエリに `undeliverable` フィルタ(`buildPropertyListWhere` 拡張)、UI バッジ列。

> 実装メモ(必読): このタスクは既存ファイルの編集が中心。**着手前に `src/lib/validators.ts`(`propertyListQuerySchema` の定義)・`src/lib/property-list-query.ts`(`buildPropertyListWhere` が where を組み立てる箇所)・`src/app/(dashboard)/properties/page.tsx`(既存 `dmFilter` state・`dmStatusStyles`・一覧アイテムのバッジ描画・API 物件型の select)を Read し、既存の命名・where 構築・select 形に厳密に合わせること。** 下記コードは編集箇所の指針であり、実ファイルの記法に合わせて差し込む。

- [ ] **Step 1: where 構築の失敗テストを書く**

`src/lib/__tests__/property-list-query-undeliverable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。既存テストの session fixture に合わせること。
const adminSession = { id: "u1", role: "admin" } as never;

describe("buildPropertyListWhere undeliverable filter", () => {
  it("undeliverable=1 で dmUndeliverableAt: { not: null } を付ける", async () => {
    const query = propertyListQuerySchema.parse({ undeliverable: "1" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmUndeliverableAt).toEqual({ not: null });
  });

  it("undeliverable 未指定なら dmUndeliverableAt フィルタを付けない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmUndeliverableAt).toBeUndefined();
  });
});
```

> 注: `buildPropertyListWhere` の戻り値・session fixture・admin の絞り込み挙動は既存の `property-list-query` テストに合わせること。既存テストが無い/形が違う場合は、その既存テストの session fixture をコピーして使う。

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-undeliverable.test.ts`
Expected: FAIL(`undeliverable` がスキーマに無い / where に反映されない)。

- [ ] **Step 3: スキーマと where 構築を拡張**

`src/lib/validators.ts` の `propertyListQuerySchema` に光学的に追加(既存の任意フィルタと同じ書式で):

```ts
// 宛先不明(返送連動)で絞り込む。"1" のときだけ有効(他の一覧フィルタと同じ文字列クエリ規約)。
undeliverable: z.enum(["1"]).optional(),
```

`src/lib/property-list-query.ts` の `buildPropertyListWhere` 内、where を組み立てている箇所に追加(既存の `dmStatus` フィルタ等を付けている近く):

```ts
if (query.undeliverable === "1") {
  where.dmUndeliverableAt = { not: null };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-undeliverable.test.ts`
Expected: PASS(2 件)。

- [ ] **Step 5: 物件一覧 UI にバッジ + フィルタを追加**

`src/app/(dashboard)/properties/page.tsx`:

1. 物件一覧の取得型・select に `dmUndeliverableAt`(API レスポンス)を含める(一覧 API の物件 select を読み、必要なら `dmUndeliverableAt: true` を足す)。型(例 `PropertyListItem`)に `dmUndeliverableAt?: string | null` を追加。
2. 既存の DM ステータスバッジの近くに、`item.dmUndeliverableAt` が非 null のとき「宛先不明」バッジを足す(既存 `dmStatusStyles` と同じトーンのクラスを流用):

```tsx
{item.dmUndeliverableAt && (
  <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
    宛先不明
  </span>
)}
```

3. 既存の `dmFilter`(dmStatus)フィルタの近くに「宛先不明のみ」チェックボックスを追加し、`params.undeliverable = "1"` をクエリへ反映(既存 `if (dmFilter) params.dmStatus = dmFilter;` と同じ箇所・同じ規約で):

```tsx
const [undeliverableOnly, setUndeliverableOnly] = useState(() => sp.get("undeliverable") === "1");
// ...クエリ構築の箇所(params 構築)に:
if (undeliverableOnly) params.undeliverable = "1";
// ...URL 同期の箇所(URLSearchParams)に:
if (undeliverableOnly) params.set("undeliverable", "1");
// ...フィルタ UI に:
<label className="flex items-center gap-1 text-sm">
  <input
    type="checkbox"
    checked={undeliverableOnly}
    onChange={(e) => setUndeliverableOnly(e.target.checked)}
  />
  宛先不明のみ
</label>
```

> 実装メモ: 物件一覧 UI のフィルタ state・URL 同期・API クエリ構築は既存 `dmFilter` の取り回しを真似る(3 箇所: state 初期化 / fetch クエリ / URL 反映)。バッジは描画ループ内の DM バッジ近くに条件付きで足すだけ。新しい API は呼ばない(既存一覧 API の where が Step 3 で `undeliverable` を理解する)。

- [ ] **Step 6: 全テスト + lint + build を確認**

Run: `npm test` → 既存 + 新規すべて green。
Run: `npm run lint` → エラーなし。
Run: `npm run build` → 成功(新 route が manifest に出る)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/validators.ts src/lib/property-list-query.ts src/lib/__tests__/property-list-query-undeliverable.test.ts "src/app/(dashboard)/properties/page.tsx"
git commit -m "feat(sale-dm): add undeliverable badge + filter to property list"
```

---

## Self-Review(本プラン → 設計書の突合)

- (a) 配達結果(delivered/returned_undeliverable/returned_other)→ `deliveryStatus`+`returnedAt`、電話反響 → `phoneInquiryAt`、`outcome` は `deriveOutcome` で導出同期: Task 1,3 ✅
- (b) 宛先不明 → `Property.dmStatus=no_send`+`dmUndeliverableAt`(同一 tx・監査)+手動解除 route: Task 3,4 ✅(`dmStatus` の enum `send/hold/no_send` を schema で確認済み)
- (c) 集計 `aggregateByVariant`(型別 送付/到達/宛先不明/反響[LP・電話・both 内訳]/反響率[母数=到達]/宛先不明率[母数=送付])+ route: Task 2,6 ✅
- (d) 送付確定 `mark-sent`(`sentAt`+`PropertyDmLog` create・冪等・確定済み限定): Task 5 ✅
- 権限ゲートは `requireSaleDmAccess()` を全 route で使用・PII レスポンスは `no-store`・AuditLog は非PIIメタのみ(本文/宛名/住所/メモ不記載): Task 3,4,5,6 ✅
- 反響=LP∪電話 の単一定義を純関数化し route・集計の双方で共有(DRY): Task 1 を Task 2,3 が consume ✅
- raw SQL 不使用(Prisma `$transaction`/`update`/`findMany` のみ): 全 Task ✅
- **未カバー(意図的に他プラン)**: LP 追跡(`lpFirstAccessAt`/`lpAccessCount` の **書き込み**)と `/t/[token]`・proxy.ts 公開パスは Plan 5。本プランは LP 値を **読むだけ**(反響導出/集計)。CSV への配達/反響列追加は Plan 2(設定一式CSV)側で行い、本プランは集計 route(JSON)まで。作業画面 UI 全体は Plan 6(本プランは物件一覧バッジ/フィルタのみ)。
- Placeholder スキャン: なし(各 step に実コード/実コマンド。Task 7 のみ既存ファイル編集ゆえ「着手前 Read + 既存記法に合わせる」指示を明記)。
- 型整合: `deriveOutcome`/`DmOutcomeValue`(Task 1)、`AggregateDraftInput`/`VariantAggregate`/`CampaignAggregate`/`aggregateByVariant`(Task 2)を Task 3,6 で同名 consume。route は Plan 1 の `requireSaleDmAccess` 戻り(`{ session }`)・prisma モデル名(`dmRecipientDraft`/`dmCampaign`/`dmVariant`/`property`/`propertyDmLog`)に一致。

> 既知の実装時確認点(レビュアー向け): (1) `requireSaleDmAccess()` の戻り値が `{ session, permissions, ownerDisplayConfig }`(Plan 1 Task 7)であること—本プランは `session.id` のみ使用。(2) `PropertyDmLog.sentAt` は `@db.Date`—`new Date()` を渡せば Prisma が日付部分を保存する(既存 dm-logs と同方針)。(3) `buildPropertyListWhere` の戻り `where` 型に `dmUndeliverableAt` を代入できること(Prisma の `PropertyWhereInput` なら可。既存が緩い `Record` 型ならそのまま)。(4) 物件一覧 API の select に `dmUndeliverableAt` を足す必要があるか既存 route を確認(一覧 API ファイルは `src/app/api/properties/route.ts`)。
