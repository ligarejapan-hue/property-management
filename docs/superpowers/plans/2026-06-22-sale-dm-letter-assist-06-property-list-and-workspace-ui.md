# 売却促進DM 作成 — Plan 6: 物件一覧反映 + 作業画面UI(レイアウトA)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件一覧に「宛先不明」バッジ列+絞り込みフィルタ(`Property.dmUndeliverableAt`)と「売却DMを作成」導線を追加し、3分割の作業画面(レイアウトA: 左=調整パネル / 中央=手紙プレビュー / 右=宛先リスト)+ 型別の反響率・宛先不明率の集計ビューを実装する。UI ロジックは純関数/小コンポーネントに切り出して単体テスト可能にする。

**Architecture:** Plan 1(基盤)で用意済みの Prisma(`DmCampaign`/`DmVariant`/`DmRecipientDraft`・`Property.dmUndeliverableAt`)・lib(`src/lib/sale-dm-letter/*`)・route(`/api/properties/sale-dm/*`)に乗る。本プランは「(a) 一覧クエリ/フィルタ拡張(`property-list-query`/`validators` への小追加)+一覧UIの宛先不明列・DM作成導線、(b) 作業画面の新ページ群(`src/app/(dashboard)/properties/sale-dm/[campaignId]/`)、(c) 集計ビュー(Plan 4 の `aggregateCampaign` 結果を表示)」を追加する。プレビューは Plan 2 の `renderLetterHtml` を再利用し本プランでは HTML 生成を再実装しない。表示・出し分け・トグルのロジックは純関数/小コンポーネントへ切り出し、`src/lib/__tests__/*.test.ts` で分岐を検証する(E2E は対象外)。

**Tech Stack:** Next.js 16 (App Router・client component) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4 / React(既存の `"use client"` + hooks + Tailwind 様式。フォームは既存物件モーダルと同様の制御コンポーネント方式)。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`(上位)。Plan 1: `...-01-foundation.md`(土台・本プランが乗る)。
- 実装は**専用 git worktree** で行う(`superpowers:using-git-worktrees` を実行時に使用)。base = `main`・branch = `feat/sale-dm-letter-assist`(Plan 1 と同一ブランチ上に積む)。
- **Plan 1 の土台を再定義しない**。`DmCampaign`/`DmVariant`/`DmRecipientDraft`・enum・`Property.dmUndeliverableAt`・`src/lib/sale-dm-letter/*`・`/api/properties/sale-dm/*` route・`requireSaleDmAccess()` は既に存在する前提で参照のみ行う。
- **Plan 2/Plan 4 の成果物を consume する**(本プランでは実装しない):
  - Plan 2: `renderLetterHtml(draft, variant, options): string`(`src/lib/sale-dm-letter/templates/` ないし `render.ts`)— 手紙プレビューHTML。
  - Plan 4: `aggregateCampaign(campaign): CampaignAggregate`(`src/lib/sale-dm-letter/aggregate.ts`)+ 配達結果/反響を更新する `PATCH /api/properties/sale-dm/drafts/[id]/outcome` route。
  - これらが未実装の段階で本プランを着手する場合は、Task 2(プレビュー)/Task 6-7(集計・反響入力)を **mock した import で TDD し、実体マージ後に結線**する(各 Task に明記)。
- 秘密はサーバー側のみ・`NEXT_PUBLIC_*` 露出禁止・client から外部API直叩き禁止(すべて `/api/properties/sale-dm/*` route 経由)。fail-closed: 生成未設定は route が 503 を返し、UI は「未設定」を表示するだけ(client は env を読まない)。
- PII(本文・宛名・住所)を含むレスポンスは route 側で `Cache-Control: no-store`(Plan 1 で実装済)。UI はこれらをローカルストレージ等に保存しない。
- 権限ゲートはサーバー側 `requireSaleDmAccess()`(4権限+PII生値)が単一の真実。UI の出し分けは既存 `canExportDm` 相当(`csv_export` + `csv_export_personal` + `owner` の read)を `useScreenProtection()` の配布権限から導出する**表示制御のみ**(セキュリティ境界はサーバー)。
- 一覧クエリ拡張は既存の単一定義元 `src/lib/property-list-query.ts` / `src/lib/validators.ts` に**最小追加**する(一覧 API と CSV export の条件ズレを生まない既存方針を踏襲)。raw SQL を入れない。
- テストは `src/lib/__tests__/*.test.ts`。実行: `npm test`(= `vitest run`)。単体は `npx vitest run <file>`。route/where のテストは Plan 1 / dm-export route test と同じ `vi.mock` 流儀。
- DRY / YAGNI / TDD(失敗テスト→失敗確認→最小実装→成功確認→コミット)/ こまめにコミット。
- 本プランは UI 中心ゆえ、テストは「フィルタの where 構築」「表示出し分けの純関数」「反響/配達トグルのイベント→API 呼び出し形」に重点を置く。ページ全体の E2E は対象外。

---

### Task 1: 一覧クエリ拡張(`dmUndeliverable` フィルタ + where 構築)

**Files:**
- Modify: `src/lib/validators.ts`(`propertyListQuerySchema` に `dmUndeliverable` を追加)
- Modify: `src/lib/property-list-query.ts`(`buildPropertyListWhere` に `dmUndeliverableAt` 条件を追加)
- Test: `src/lib/__tests__/property-list-query-dm-undeliverable.test.ts`

**Interfaces:**
- Consumes: `propertyListQuerySchema`(既存)、`buildPropertyListWhere`(既存)。
- Produces: query キー `dmUndeliverable?: boolean`、`buildPropertyListWhere` の where に `dmUndeliverableAt: { not: null }`(true 時)を付与。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/property-list-query-dm-undeliverable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

const session = { id: "u1", role: "admin" };

describe("buildPropertyListWhere — dmUndeliverable フィルタ", () => {
  it("dmUndeliverable=true で where.dmUndeliverableAt={ not: null } を付ける", async () => {
    const query = propertyListQuerySchema.parse({ dmUndeliverable: "true" });
    const { where } = await buildPropertyListWhere(query, session);
    expect(where.dmUndeliverableAt).toEqual({ not: null });
  });

  it("未指定なら dmUndeliverableAt 条件を付けない(従来挙動)", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, session);
    expect(where.dmUndeliverableAt).toBeUndefined();
  });

  it("dmUndeliverable=false でも条件を付けない", async () => {
    const query = propertyListQuerySchema.parse({ dmUndeliverable: "false" });
    const { where } = await buildPropertyListWhere(query, session);
    expect(where.dmUndeliverableAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-dm-undeliverable.test.ts`
Expected: FAIL(`dmUndeliverable` が schema になく `where.dmUndeliverableAt` が常に undefined)。

- [ ] **Step 3: schema に追加**

`src/lib/validators.ts` の `propertyListQuerySchema` に、`hasWarning` と同じ string→boolean 変換で追加(`sortBy` の手前):

```ts
  // 宛先不明(DM返送で send 不可になった物件)のみに絞る。
  // 互換: 未指定なら従来通り全件。"true" のときのみ true。
  dmUndeliverable: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
```

- [ ] **Step 4: where 構築に追加**

`src/lib/property-list-query.ts` の `buildPropertyListWhere` 内、分割代入に `dmUndeliverable` を加え、`hasWarning` ブロックの直前(可視性スコープより後・既存 where 条件群の近く)に追加:

分割代入に追加:

```ts
    includeArchived,
    hasWarning,
    dmUndeliverable,
```

条件を追加(`hasWarning` の if ブロックの直前):

```ts
  // 宛先不明(返送で送付不可になった)物件のみに絞る。
  // Property.dmUndeliverableAt が立っている = 宛先不明。null は除外。
  if (dmUndeliverable === true) {
    where.dmUndeliverableAt = { not: null };
  }
```

> 注: `dmUndeliverableAt` は `where` の直接プロパティに置く(`AND` 配列ではなく)。`hasWarning` の `OR` とは独立な単純等値条件のため。`PropertyListQuery` 型は `z.infer` で自動更新されるので型定義の手当ては不要。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-dm-undeliverable.test.ts`
Expected: PASS(3 件)。既存の `properties-route-mgmt-id.test.ts` 等が緑のままであること(`npx vitest run src/lib/__tests__/property-list-query` で関連テストを確認)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/validators.ts src/lib/property-list-query.ts src/lib/__tests__/property-list-query-dm-undeliverable.test.ts
git commit -m "feat(sale-dm): add dmUndeliverable filter to property list query"
```

---

### Task 2: 一覧 API レスポンスに `dmUndeliverableAt` を含める

**Files:**
- Modify: `src/app/api/properties/route.ts`(GET の `select` に `dmUndeliverableAt` を追加・map 結果に通す)
- Test: `src/lib/__tests__/properties-route-dm-undeliverable.test.ts`

**Interfaces:**
- Produces: 一覧 GET の各 item に `dmUndeliverableAt: string | null`(ISO。Prisma の Date は JSON 化で文字列になる)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/properties-route-dm-undeliverable.test.ts`(既存 `properties-route-*.test.ts` の `vi.mock` 流儀を流用。`prisma.property.findMany`/`count`・`getApiSession`/`getUserPermissions`/`getOwnerDisplayConfig`/`writeAuditLog` を mock):

```ts
import { vi } from "vitest";
vi.mock("@/lib/prisma", () => ({
  default: { property: { findMany: vi.fn(), count: vi.fn() } },
}));
vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { describe, it, expect, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/route";

const pm = prisma as never as { property: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
    { resource: "property", action: "read", granted: true },
  ]);
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full" });
});

describe("GET /api/properties — dmUndeliverableAt", () => {
  it("レスポンス item に dmUndeliverableAt を含める", async () => {
    const ts = new Date("2026-06-20T00:00:00.000Z");
    pm.property.findMany.mockResolvedValue([
      { id: "p1", propertyType: "land", address: "A", lotNumber: null, buildingNumber: null, realEstateNumber: null, registryStatus: "obtained", dmStatus: "no_send", caseStatus: "new_case", introductionRoute: null, isArchived: false, updatedAt: ts, assignedTo: null, gpsLat: null, gpsLng: null, investigationConfirmedAt: null, dmUndeliverableAt: ts, assignee: null, propertyOwners: [] },
    ]);
    pm.property.count.mockResolvedValue(1);
    const res = await GET(new Request("http://x/api/properties") as never);
    const json = await res.json();
    expect(json.data[0].dmUndeliverableAt).toBeTruthy();
  });

  it("dmUndeliverableAt が null の物件はそのまま null", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: "p2", propertyType: "land", address: "B", lotNumber: null, buildingNumber: null, realEstateNumber: null, registryStatus: "obtained", dmStatus: "send", caseStatus: "new_case", introductionRoute: null, isArchived: false, updatedAt: new Date(), assignedTo: null, gpsLat: null, gpsLng: null, investigationConfirmedAt: null, dmUndeliverableAt: null, assignee: null, propertyOwners: [] },
    ]);
    pm.property.count.mockResolvedValue(1);
    const res = await GET(new Request("http://x/api/properties") as never);
    const json = await res.json();
    expect(json.data[0].dmUndeliverableAt).toBeNull();
  });
});
```

> 注: 既存 `properties-route-*.test.ts` の mock の形(特に `getUserPermissions` の戻りと `hasPermission` の引数)に厳密一致させること。合わない場合は既存テストの fixture/ヘルパをコピーして使う。

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/properties-route-dm-undeliverable.test.ts`
Expected: FAIL(`dmUndeliverableAt` が select に無く `data[0].dmUndeliverableAt` が undefined)。

- [ ] **Step 3: 実装**

`src/app/api/properties/route.ts` の GET `select`(`investigationConfirmedAt: true,` の近く)に追加:

```ts
            investigationConfirmedAt: true,
            dmUndeliverableAt: true,
```

`data` の map は `{ propertyOwners, ...property }` で残りプロパティをそのまま展開しているため、`dmUndeliverableAt` は自動でレスポンスに含まれる(追加の map 変更は不要)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/properties-route-dm-undeliverable.test.ts`
Expected: PASS(2 件)。

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/route.ts src/lib/__tests__/properties-route-dm-undeliverable.test.ts
git commit -m "feat(sale-dm): expose dmUndeliverableAt in property list response"
```

---

### Task 3: 一覧 UI の表示ロジック純関数(宛先不明バッジ・DM作成可否)

**Files:**
- Create: `src/lib/sale-dm-letter/list-ui.ts`(純関数)
- Test: `src/lib/__tests__/sale-dm-list-ui.test.ts`

**Interfaces:**
- Produces:
  - `isDmUndeliverable(dmUndeliverableAt: string | null | undefined): boolean`
  - `canCreateSaleDm(perms: { resource: string; action: string; granted: boolean }[] | null): boolean`(= `csv_export` + `csv_export_personal` + `owner` の read。`canExportDm` と同条件)
  - `dmUndeliverableBadgeLabel = "宛先不明"`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-list-ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isDmUndeliverable, canCreateSaleDm } from "../sale-dm-letter/list-ui";

const perm = (resource: string) => ({ resource, action: "read", granted: true });

describe("isDmUndeliverable", () => {
  it("日時文字列があれば true", () => {
    expect(isDmUndeliverable("2026-06-20T00:00:00.000Z")).toBe(true);
  });
  it("null/undefined/空文字は false", () => {
    expect(isDmUndeliverable(null)).toBe(false);
    expect(isDmUndeliverable(undefined)).toBe(false);
    expect(isDmUndeliverable("")).toBe(false);
  });
});

describe("canCreateSaleDm", () => {
  it("csv_export + csv_export_personal + owner が揃えば true", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal"), perm("owner")])).toBe(true);
  });
  it("owner が欠けたら false", () => {
    expect(canCreateSaleDm([perm("csv_export"), perm("csv_export_personal")])).toBe(false);
  });
  it("granted=false は数えない", () => {
    expect(canCreateSaleDm([{ resource: "owner", action: "read", granted: false }, perm("csv_export"), perm("csv_export_personal")])).toBe(false);
  });
  it("null(取得失敗)は false(fail-safe)", () => {
    expect(canCreateSaleDm(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-list-ui.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/list-ui.ts`:

```ts
export const dmUndeliverableBadgeLabel = "宛先不明";

export function isDmUndeliverable(
  dmUndeliverableAt: string | null | undefined,
): boolean {
  return typeof dmUndeliverableAt === "string" && dmUndeliverableAt.length > 0;
}

type PermissionLike = { resource: string; action: string; granted: boolean };

// 売却DM作成の表示可否。既存 canExportDm と同条件
// (csv_export + csv_export_personal + owner の read)。
// permissions=null(未取得・取得失敗)は fail-safe で false。
export function canCreateSaleDm(perms: PermissionLike[] | null): boolean {
  if (!perms) return false;
  const has = (resource: string) =>
    perms.some((p) => p.resource === resource && p.action === "read" && p.granted);
  return has("csv_export") && has("csv_export_personal") && has("owner");
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-list-ui.test.ts`
Expected: PASS(6 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/list-ui.ts src/lib/__tests__/sale-dm-list-ui.test.ts
git commit -m "feat(sale-dm): add list-ui pure helpers (undeliverable badge / create gate)"
```

---

### Task 4: 物件一覧 UI に「宛先不明」列・フィルタ・「売却DMを作成」導線を結線

**Files:**
- Modify: `src/lib/api-client.ts`(`createSaleDmCampaign` を追加・`fetchProperties` の item 型に `dmUndeliverableAt` を許容)
- Modify: `src/app/(dashboard)/properties/page.tsx`(列・フィルタ・導線・state)
- Test: 主要分岐は Task 3 の純関数でカバー済み。本 Task は結線(手動確認 + build)。

**Interfaces:**
- Consumes: `isDmUndeliverable`/`canCreateSaleDm`/`dmUndeliverableBadgeLabel`(Task 3)、`createSaleDmCampaign`(本 Task)。
- Produces: `createSaleDmCampaign(body): Promise<{ campaignId: string; generated: number; failed: number; truncated: boolean }>`。

- [ ] **Step 1: api-client に作成関数を追加**

`src/lib/api-client.ts`(既存 `apiFetch` ヘルパを使用。USE_MOCK 分岐は他関数に倣い、mock では決定的に `{ campaignId: "mock-campaign" , ... }` を返す):

```ts
export interface CreateSaleDmCampaignBody {
  name: string;
  options: {
    designTemplate: string;
    tone: string;
    length: string;
    appeal: string;
    strength: string;
    senderName: string;
    senderContact: string;
    extraInstruction?: string;
  };
  filters?: Record<string, string>;
}

export async function createSaleDmCampaign(body: CreateSaleDmCampaignBody) {
  if (USE_MOCK) {
    await mockDelay();
    return { campaignId: "mock-campaign", generated: 0, failed: 0, truncated: false };
  }
  return apiFetch<{ campaignId: string; generated: number; failed: number; truncated: boolean }>(
    "/api/properties/sale-dm/campaigns",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
```

`ApiProperty`(properties/page.tsx 側のローカル型)に `dmUndeliverableAt?: string | null;` を追加(api-client の `fetchProperties` は型を緩く返すため、ここでの型追加で十分)。

- [ ] **Step 2: 一覧 UI に宛先不明フィルタを追加**

`src/app/(dashboard)/properties/page.tsx`:

1) `ApiProperty` interface に `dmUndeliverableAt?: string | null;` を追加(Step 1)。

2) state を追加(`warningOnly` の近く):

```ts
  const [undeliverableOnly, setUndeliverableOnly] = useState(() => sp.get("dmUndeliverable") === "true");
```

3) `buildFilterParams` に追加(`warningOnly` の直後):

```ts
    if (undeliverableOnly) params.dmUndeliverable = "true";
```

`buildFilterParams` の `useCallback` 依存配列に `undeliverableOnly` を追加。

4) URL 同期 effect に追加(`if (warningOnly) ...` の直後):

```ts
    if (undeliverableOnly) params.set("dmUndeliverable", "true");
```

その effect の依存配列に `undeliverableOnly` を追加。

5) `handleResetFilters` に `setUndeliverableOnly(false);` を追加。`hasActiveFilter` の判定式に `|| undeliverableOnly` を追加。

6) フィルタバーに「警告ありのみ」チップと同じ様式で追加(`warningOnly` の `<label>` の直後):

```tsx
        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <input
            type="checkbox"
            checked={undeliverableOnly}
            onChange={(e) => {
              setUndeliverableOnly(e.target.checked);
              setPage(1);
            }}
            className="rounded border-red-300"
          />
          {dmUndeliverableBadgeLabel}のみ
        </label>
```

`dmUndeliverableBadgeLabel` を import:

```ts
import { isDmUndeliverable, canCreateSaleDm, dmUndeliverableBadgeLabel } from "@/lib/sale-dm-letter/list-ui";
```

- [ ] **Step 3: テーブルに宛先不明バッジを表示**

住所セル(`<td className="px-4 py-3">` 内、警告バッジの隣)に、宛先不明なら赤バッジを表示:

```tsx
                    {isDmUndeliverable(property.dmUndeliverableAt) && (
                      <span
                        title="DM返送(宛先不明)により送付不可に連動"
                        className={`mr-2 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold align-middle ${badgeIntentClass("error")}`}
                      >
                        {dmUndeliverableBadgeLabel}
                      </span>
                    )}
```

(`badgeIntentClass` は既に import 済み。)

- [ ] **Step 4: 「売却DMを作成」導線を追加**

権限導出を `canCreateSaleDm` で行う。`useMemo` の `canExportDm` の隣で同条件のため、既存の `effectivePermissions` をそのまま使い `canCreateSaleDm` で算出する:

```ts
  const canCreateDm = useMemo(() => {
    const effectivePermissions =
      permissionsRefreshPending || permissionsLoading ? [] : (mePermissions ?? []);
    return canCreateSaleDm(effectivePermissions);
  }, [permissionsRefreshPending, permissionsLoading, mePermissions]);
```

ハンドラを追加(現在の検索条件を `filters` として渡す。生成オプションは初版は既定値で作成し、調整は作業画面で行う):

```ts
  const [creatingDm, setCreatingDm] = useState(false);

  const handleCreateSaleDm = async () => {
    if (creatingDm) return;
    setCreatingDm(true);
    setError(null);
    try {
      const res = await createSaleDmCampaign({
        name: `売却DM ${new Date().toLocaleDateString("ja-JP")}`,
        options: {
          designTemplate: "formal",
          tone: "formal",
          length: "medium",
          appeal: "price",
          strength: "low",
          senderName: "",
          senderContact: "",
        },
        filters: buildFilterParams(),
      });
      router.push(`/properties/sale-dm/${res.campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "売却DMの作成に失敗しました");
    } finally {
      setCreatingDm(false);
    }
  };
```

`createSaleDmCampaign` を import に追加(`fetchProperties as apiFetchProperties, ...` の行)。

アクション行(`{canExportDm && ...}` の隣・「新規物件登録」ボタンの前)にボタンを追加:

```tsx
        {canCreateDm && (
          <button
            type="button"
            onClick={handleCreateSaleDm}
            disabled={creatingDm}
            className="inline-flex items-center gap-2 rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="現在の検索条件で送付可の物件から売却DM下書きを作成"
          >
            {creatingDm ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            売却DMを作成
          </button>
        )}
```

(`Loader2` / `Plus` は import 済み。)

> 注: `senderName`/`senderContact` は Plan 1 の zod で `min(1)` 必須。初版で空のまま POST すると 400 になる。Plan 1 の Self-Review/メモにある通り **env 既定 `SALE_DM_SENDER_NAME`/`SALE_DM_SENDER_CONTACT` を route 側で補完する** 方針(`resolveSender`)が前提。本 Task 着手時に Plan 1 側の `saleDmOptionsSchema` が sender を optional 化済み(env 既定補完)であることを確認し、未対応なら本 Task の `options` に暫定の差出人プレースホルダ文字列(例 `senderName: "（差出人未設定）"`)を入れて 400 を避け、TODO ではなく実値で通す。作業画面(Task 5)で差出人を編集できるようにする。

- [ ] **Step 5: build + lint で結線を確認**

Run: `npm run lint`(エラーなし)
Run: `npm run build`(成功・型エラーなし)

- [ ] **Step 6: コミット**

```bash
git add src/lib/api-client.ts "src/app/(dashboard)/properties/page.tsx"
git commit -m "feat(sale-dm): wire undeliverable badge/filter + create-DM CTA in property list"
```

---

### Task 5: 作業画面(レイアウトA)— ページ骨格 + 取得 + 3分割レイアウト

**Files:**
- Create: `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`(client・骨格 + データ取得 + 3分割)
- Modify: `src/lib/api-client.ts`(`fetchSaleDmCampaign` を追加)
- Test: 取得・分割は手動 + build。表示ロジックの分岐は Task 6 の純関数でカバー。

**Interfaces:**
- Consumes: `GET /api/properties/sale-dm/campaigns/[id]`(Plan 1)、`renderLetterHtml`(Plan 2)。
- Produces: `fetchSaleDmCampaign(id): Promise<{ campaign: SaleDmCampaign }>`、作業画面ページ。

- [ ] **Step 1: api-client に取得関数を追加**

`src/lib/api-client.ts`:

```ts
export interface SaleDmDraft {
  id: string;
  variantId: string;
  propertyId: string;
  recipientName: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  honorific: string;
  body: string;
  status: string;
  outcome: string;
  deliveryStatus: string;
  lpFirstAccessAt: string | null;
  phoneInquiryAt: string | null;
}

export interface SaleDmVariant {
  id: string;
  label: string;
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
}

export interface SaleDmCampaign {
  id: string;
  name: string;
  status: string;
  variants: SaleDmVariant[];
  recipients: SaleDmDraft[];
}

export async function fetchSaleDmCampaign(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { campaign: { id, name: "モック売却DM", status: "draft", variants: [], recipients: [] } as SaleDmCampaign };
  }
  return apiFetch<{ campaign: SaleDmCampaign }>(`/api/properties/sale-dm/campaigns/${id}`);
}
```

- [ ] **Step 2: ページ骨格(3分割)を実装**

`src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx`(`"use client"`・`useParams` で campaignId 取得・初回 fetch・3カラム grid。中央プレビューは Plan 2 `renderLetterHtml` を `dangerouslySetInnerHTML` で描画。選択中 draft を state で保持):

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { fetchSaleDmCampaign, type SaleDmCampaign, type SaleDmDraft } from "@/lib/api-client";
import { renderLetterHtml } from "@/lib/sale-dm-letter/render";
import SaleDmAdjustPanel from "@/components/sale-dm/adjust-panel";
import SaleDmRecipientList from "@/components/sale-dm/recipient-list";
import SaleDmAggregateView from "@/components/sale-dm/aggregate-view";

export default function SaleDmWorkspacePage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId;

  const [campaign, setCampaign] = useState<SaleDmCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { campaign } = await fetchSaleDmCampaign(campaignId);
      setCampaign(campaign);
      setSelectedId((prev) => prev ?? campaign.recipients[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "キャンペーンの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const selected: SaleDmDraft | null = useMemo(
    () => campaign?.recipients.find((r) => r.id === selectedId) ?? null,
    [campaign, selectedId],
  );
  const selectedVariant = useMemo(
    () => campaign?.variants.find((v) => v.id === selected?.variantId) ?? campaign?.variants[0] ?? null,
    [campaign, selected],
  );

  const previewHtml = useMemo(() => {
    if (!selected || !selectedVariant) return "";
    return renderLetterHtml(selected, selectedVariant);
  }, [selected, selectedVariant]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error ?? "キャンペーンが見つかりません"}
        <button onClick={load} className="ml-2 underline hover:no-underline">再試行</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">{campaign.name}</h2>
        <span className="text-sm text-gray-500">{campaign.recipients.length} 通</span>
      </div>

      <SaleDmAggregateView campaign={campaign} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
        {/* 左: 調整パネル */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <SaleDmAdjustPanel
            campaign={campaign}
            selected={selected}
            onChanged={load}
          />
        </div>

        {/* 中央: 手紙プレビュー */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          {selected ? (
            <div
              className="sale-dm-preview mx-auto max-w-[640px]"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <p className="py-12 text-center text-sm text-gray-500">宛先を選択してください</p>
          )}
        </div>

        {/* 右: 宛先リスト */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <SaleDmRecipientList
            campaign={campaign}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChanged={load}
          />
        </div>
      </div>
    </div>
  );
}
```

> 実装メモ: `renderLetterHtml` の正確な引数(Plan 2)は実装後に合わせる。Plan 2 が `renderLetterHtml(draft, variant, options?)` を export する想定。Plan 2 未マージで本 Task を着手する場合は、`src/lib/sale-dm-letter/render.ts` に**最小スタブ**(`export function renderLetterHtml(d: { body: string; recipientName: string; honorific: string }): string { return \`<div>\${d.recipientName} \${d.honorific}</div><pre>\${d.body}</pre>\`; }`)を置いて UI を成立させ、Plan 2 マージ時に本実装へ差し替える(スタブはコミットメッセージで明示)。`dangerouslySetInnerHTML` に渡す HTML は Plan 2 側でサニタイズ/エスケープ責任を持つ(本文は server 生成・宛名は自社 DB 由来)。

- [ ] **Step 3: build で骨格を確認(子コンポーネントは次 Task。仮の空実装で通す)**

Task 6 で `adjust-panel` / `recipient-list` / `aggregate-view` を実装するまで build が通らないため、本 Step では3コンポーネントの**空シェル**を先に作成してから build する:

`src/components/sale-dm/aggregate-view.tsx`:

```tsx
"use client";
import type { SaleDmCampaign } from "@/lib/api-client";
export default function SaleDmAggregateView({ campaign: _campaign }: { campaign: SaleDmCampaign }) {
  return null;
}
```

`src/components/sale-dm/adjust-panel.tsx`:

```tsx
"use client";
import type { SaleDmCampaign, SaleDmDraft } from "@/lib/api-client";
export default function SaleDmAdjustPanel(_props: { campaign: SaleDmCampaign; selected: SaleDmDraft | null; onChanged: () => void }) {
  return <p className="text-sm text-gray-500">調整パネル(次のタスクで実装)</p>;
}
```

`src/components/sale-dm/recipient-list.tsx`:

```tsx
"use client";
import type { SaleDmCampaign } from "@/lib/api-client";
export default function SaleDmRecipientList(_props: { campaign: SaleDmCampaign; selectedId: string | null; onSelect: (id: string) => void; onChanged: () => void }) {
  return <p className="text-sm text-gray-500">宛先リスト(次のタスクで実装)</p>;
}
```

Run: `npm run build`(成功)。

- [ ] **Step 4: コミット**

```bash
git add src/lib/api-client.ts "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx" src/components/sale-dm
git commit -m "feat(sale-dm): add workspace page skeleton (layout A 3-pane) + campaign fetch"
```

---

### Task 6: 宛先リスト(型バッジ + 配達結果/反響入力トグル)+ イベント純関数

**Files:**
- Create: `src/lib/sale-dm-letter/recipient-actions.ts`(純関数: バッジ/反響表示の導出 + outcome PATCH ペイロード組立)
- Modify: `src/components/sale-dm/recipient-list.tsx`(実装)
- Modify: `src/lib/api-client.ts`(`updateSaleDmOutcome` を追加)
- Test: `src/lib/__tests__/sale-dm-recipient-actions.test.ts`

**Interfaces:**
- Consumes: `PATCH /api/properties/sale-dm/drafts/[id]/outcome`(Plan 4)、`SaleDmDraft`/`SaleDmVariant`(Task 5)。
- Produces:
  - `variantLabel(variants, variantId): string`
  - `isInquiry(draft): boolean`(= `lpFirstAccessAt` か `phoneInquiryAt` があれば true)
  - `buildOutcomePayload(input): { deliveryStatus?: string; phoneInquiry?: boolean }`
  - `updateSaleDmOutcome(id, payload)`(api-client)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-recipient-actions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { variantLabel, isInquiry, buildOutcomePayload } from "../sale-dm-letter/recipient-actions";
import type { SaleDmDraft, SaleDmVariant } from "@/lib/api-client";

const variants: SaleDmVariant[] = [
  { id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  { id: "v2", label: "B", designTemplate: "impact", tone: "soft", length: "short", appeal: "buyer", strength: "high", extraInstruction: null },
];

const baseDraft: SaleDmDraft = {
  id: "r1", variantId: "v1", propertyId: "p1", recipientName: "田中 一郎", recipientZip: null,
  recipientAddress: null, honorific: "様", body: "本文", status: "draft", outcome: "none",
  deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
};

describe("variantLabel", () => {
  it("variantId に対応する label を返す", () => {
    expect(variantLabel(variants, "v2")).toBe("B");
  });
  it("見つからなければ '-' を返す", () => {
    expect(variantLabel(variants, "zzz")).toBe("-");
  });
});

describe("isInquiry", () => {
  it("lpFirstAccessAt があれば true", () => {
    expect(isInquiry({ ...baseDraft, lpFirstAccessAt: "2026-06-20T00:00:00Z" })).toBe(true);
  });
  it("phoneInquiryAt があれば true", () => {
    expect(isInquiry({ ...baseDraft, phoneInquiryAt: "2026-06-20T00:00:00Z" })).toBe(true);
  });
  it("どちらも無ければ false", () => {
    expect(isInquiry(baseDraft)).toBe(false);
  });
});

describe("buildOutcomePayload", () => {
  it("配達結果のみ", () => {
    expect(buildOutcomePayload({ deliveryStatus: "delivered" })).toEqual({ deliveryStatus: "delivered" });
  });
  it("電話問い合わせトグル true", () => {
    expect(buildOutcomePayload({ phoneInquiry: true })).toEqual({ phoneInquiry: true });
  });
  it("両方指定", () => {
    expect(buildOutcomePayload({ deliveryStatus: "returned_undeliverable", phoneInquiry: false }))
      .toEqual({ deliveryStatus: "returned_undeliverable", phoneInquiry: false });
  });
  it("未指定キーは payload に入れない", () => {
    expect(buildOutcomePayload({})).toEqual({});
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-recipient-actions.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 純関数を実装**

`src/lib/sale-dm-letter/recipient-actions.ts`:

```ts
import type { SaleDmDraft, SaleDmVariant } from "@/lib/api-client";

export function variantLabel(variants: SaleDmVariant[], variantId: string): string {
  return variants.find((v) => v.id === variantId)?.label ?? "-";
}

export function isInquiry(draft: Pick<SaleDmDraft, "lpFirstAccessAt" | "phoneInquiryAt">): boolean {
  return Boolean(draft.lpFirstAccessAt) || Boolean(draft.phoneInquiryAt);
}

export interface OutcomeInput {
  deliveryStatus?: string;
  phoneInquiry?: boolean;
}

// 未指定キーを落として PATCH ペイロードを作る(部分更新)。
export function buildOutcomePayload(input: OutcomeInput): OutcomeInput {
  const payload: OutcomeInput = {};
  if (input.deliveryStatus !== undefined) payload.deliveryStatus = input.deliveryStatus;
  if (input.phoneInquiry !== undefined) payload.phoneInquiry = input.phoneInquiry;
  return payload;
}
```

- [ ] **Step 4: api-client に outcome 更新を追加**

`src/lib/api-client.ts`:

```ts
import type { OutcomeInput } from "@/lib/sale-dm-letter/recipient-actions";

export async function updateSaleDmOutcome(id: string, payload: OutcomeInput) {
  if (USE_MOCK) {
    await mockDelay();
    return { id };
  }
  return apiFetch<{ id: string }>(`/api/properties/sale-dm/drafts/${id}/outcome`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
```

> 注: `OutcomeInput` の import が循環参照にならないことを確認(api-client → recipient-actions → api-client(type-only))。type-only import なので実行時循環は起きないが、ビルドで問題があれば `OutcomeInput` を api-client 内に重複定義せず、payload 形を直接 `{ deliveryStatus?: string; phoneInquiry?: boolean }` とインライン型にして循環を断つ。`PATCH .../outcome` の正確なボディ契約(Plan 4)に合わせること(`phoneInquiry` ではなく別キーなら本 Task の純関数・型を Plan 4 のキーに合わせて修正)。

- [ ] **Step 5: 宛先リストを実装**

`src/components/sale-dm/recipient-list.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { SaleDmCampaign } from "@/lib/api-client";
import { updateSaleDmOutcome } from "@/lib/api-client";
import { variantLabel, isInquiry, buildOutcomePayload } from "@/lib/sale-dm-letter/recipient-actions";

const DELIVERY_OPTIONS = [
  { value: "unknown", label: "未確認" },
  { value: "delivered", label: "届いた" },
  { value: "returned_undeliverable", label: "宛先不明で返送" },
  { value: "returned_other", label: "その他返送" },
];

export default function SaleDmRecipientList({
  campaign,
  selectedId,
  onSelect,
  onChanged,
}: {
  campaign: SaleDmCampaign;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const patchOutcome = async (id: string, input: { deliveryStatus?: string; phoneInquiry?: boolean }) => {
    setBusyId(id);
    try {
      await updateSaleDmOutcome(id, buildOutcomePayload(input));
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-700">宛先リスト</h3>
      <ul className="divide-y divide-gray-100">
        {campaign.recipients.map((r) => {
          const inquiry = isInquiry(r);
          const isSent = r.status === "sent";
          return (
            <li
              key={r.id}
              className={`cursor-pointer rounded-md p-2 ${r.id === selectedId ? "bg-indigo-50" : "hover:bg-gray-50"}`}
              onClick={() => onSelect(r.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span data-pii-protected data-pii-surface="owner" className="flex-1 truncate text-sm text-gray-800">
                  {r.recipientName} {r.honorific}
                </span>
                <span className="shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700">
                  型 {variantLabel(campaign.variants, r.variantId)}
                </span>
                {inquiry && (
                  <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                    反響あり
                  </span>
                )}
              </div>

              {/* 配達結果/反響は確定(sent)後のみ入力可 */}
              {isSent && (
                <div className="mt-1 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={r.deliveryStatus}
                    disabled={busyId === r.id}
                    onChange={(e) => patchOutcome(r.id, { deliveryStatus: e.target.value })}
                    className="rounded-md border border-gray-300 px-1.5 py-1 text-xs"
                  >
                    {DELIVERY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={Boolean(r.phoneInquiryAt)}
                      disabled={busyId === r.id}
                      onChange={(e) => patchOutcome(r.id, { phoneInquiry: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    電話問い合わせ
                  </label>
                </div>
              )}
            </li>
          );
        })}
        {campaign.recipients.length === 0 && (
          <li className="py-6 text-center text-sm text-gray-500">宛先がありません</li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 6: テスト + build を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-recipient-actions.test.ts`(PASS・10 件)
Run: `npm run build`(成功)

- [ ] **Step 7: コミット**

```bash
git add src/lib/sale-dm-letter/recipient-actions.ts src/components/sale-dm/recipient-list.tsx src/lib/api-client.ts src/lib/__tests__/sale-dm-recipient-actions.test.ts
git commit -m "feat(sale-dm): recipient list with variant badge + delivery/outcome toggles"
```

---

### Task 7: 集計ビュー(型別 反響率/宛先不明率)+ 表示純関数

**Files:**
- Create: `src/lib/sale-dm-letter/aggregate-view-model.ts`(純関数: 集計→表示行への整形 + 率の整形)
- Modify: `src/components/sale-dm/aggregate-view.tsx`(実装)
- Test: `src/lib/__tests__/sale-dm-aggregate-view-model.test.ts`

**Interfaces:**
- Consumes: `aggregateCampaign(campaign): CampaignAggregate`(Plan 4)。本 Task は **client 側で `campaign.recipients`/`variants` から直接集計**する(GET レスポンスに集計が含まれない場合の自給)。Plan 4 が GET に `aggregate` を載せるなら、その値を優先して使う。
- Produces:
  - `formatRate(numerator, denominator): string`(0除算は "—")
  - `buildVariantRows(campaign): VariantRow[]`(型別 送付数/到達数/宛先不明数/反響数/反響率/宛先不明率)

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-aggregate-view-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatRate, buildVariantRows } from "../sale-dm-letter/aggregate-view-model";
import type { SaleDmCampaign } from "@/lib/api-client";

function draft(over: Partial<SaleDmCampaign["recipients"][number]>): SaleDmCampaign["recipients"][number] {
  return {
    id: Math.random().toString(36), variantId: "v1", propertyId: "p", recipientName: "x", recipientZip: null,
    recipientAddress: null, honorific: "様", body: "", status: "sent", outcome: "none",
    deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null, ...over,
  };
}

const campaign: SaleDmCampaign = {
  id: "c1", name: "x", status: "sent",
  variants: [
    { id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  ],
  recipients: [
    draft({ deliveryStatus: "delivered", lpFirstAccessAt: "2026-06-20T00:00:00Z" }), // 到達+反響
    draft({ deliveryStatus: "delivered" }),                                          // 到達のみ
    draft({ deliveryStatus: "returned_undeliverable" }),                             // 宛先不明
  ],
};

describe("formatRate", () => {
  it("分母>0 なら百分率1桁", () => {
    expect(formatRate(1, 2)).toBe("50.0%");
  });
  it("分母0 は '—'", () => {
    expect(formatRate(0, 0)).toBe("—");
  });
});

describe("buildVariantRows", () => {
  it("型別に 送付/到達/宛先不明/反響/反響率(母数=到達)/宛先不明率 を集計", () => {
    const rows = buildVariantRows(campaign);
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.label).toBe("A");
    expect(a.sent).toBe(3);
    expect(a.delivered).toBe(2);
    expect(a.undeliverable).toBe(1);
    expect(a.inquiries).toBe(1);
    expect(a.inquiryRate).toBe("50.0%");        // 反響1 / 到達2
    expect(a.undeliverableRate).toBe("33.3%");  // 宛先不明1 / 送付3
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-view-model.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 純関数を実装**

`src/lib/sale-dm-letter/aggregate-view-model.ts`:

```ts
import type { SaleDmCampaign } from "@/lib/api-client";
import { isInquiry } from "./recipient-actions";

export function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export interface VariantRow {
  variantId: string;
  label: string;
  sent: number;          // 送付数(= その型に割当たった宛先数)
  delivered: number;     // 到達数(deliveryStatus=delivered)
  undeliverable: number; // 宛先不明数(deliveryStatus=returned_undeliverable)
  inquiries: number;     // 反響数(LP∪電話)
  inquiryRate: string;   // 反響 / 到達
  undeliverableRate: string; // 宛先不明 / 送付
}

// 集計の母数: 反響率=到達数 / 宛先不明率=送付数(設計書の定義に一致)。
export function buildVariantRows(campaign: SaleDmCampaign): VariantRow[] {
  return campaign.variants.map((v) => {
    const drafts = campaign.recipients.filter((r) => r.variantId === v.id);
    const sent = drafts.length;
    const delivered = drafts.filter((r) => r.deliveryStatus === "delivered").length;
    const undeliverable = drafts.filter((r) => r.deliveryStatus === "returned_undeliverable").length;
    const inquiries = drafts.filter((r) => isInquiry(r)).length;
    return {
      variantId: v.id,
      label: v.label,
      sent,
      delivered,
      undeliverable,
      inquiries,
      inquiryRate: formatRate(inquiries, delivered),
      undeliverableRate: formatRate(undeliverable, sent),
    };
  });
}
```

> 注: 設計書では「反響率の母数=到達数(宛先不明を除く)」。`delivered` を母数にする。Plan 4 が GET レスポンスに公式集計(`aggregateCampaign`)を載せている場合は、表示の単一定義元として Plan 4 の値を優先し、本 view-model は GET に集計が無いときのクライアント自給フォールバックとして残す(両者の母数定義を一致させること)。

- [ ] **Step 4: 集計ビューを実装**

`src/components/sale-dm/aggregate-view.tsx`:

```tsx
"use client";

import type { SaleDmCampaign } from "@/lib/api-client";
import { buildVariantRows } from "@/lib/sale-dm-letter/aggregate-view-model";

export default function SaleDmAggregateView({ campaign }: { campaign: SaleDmCampaign }) {
  const rows = buildVariantRows(campaign);
  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-3 py-2 font-medium text-gray-600">型</th>
            <th className="px-3 py-2 font-medium text-gray-600">送付</th>
            <th className="px-3 py-2 font-medium text-gray-600">到達</th>
            <th className="px-3 py-2 font-medium text-gray-600">宛先不明</th>
            <th className="px-3 py-2 font-medium text-gray-600">反響</th>
            <th className="px-3 py-2 font-medium text-gray-600">反響率</th>
            <th className="px-3 py-2 font-medium text-gray-600">宛先不明率</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.variantId}>
              <td className="px-3 py-2 font-semibold">型 {r.label}</td>
              <td className="px-3 py-2">{r.sent}</td>
              <td className="px-3 py-2">{r.delivered}</td>
              <td className="px-3 py-2">{r.undeliverable}</td>
              <td className="px-3 py-2">{r.inquiries}</td>
              <td className="px-3 py-2 font-medium text-indigo-700">{r.inquiryRate}</td>
              <td className="px-3 py-2 font-medium text-red-700">{r.undeliverableRate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: テスト + build を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-aggregate-view-model.test.ts`(PASS・4 件)
Run: `npm run build`(成功)

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/aggregate-view-model.ts src/components/sale-dm/aggregate-view.tsx src/lib/__tests__/sale-dm-aggregate-view-model.test.ts
git commit -m "feat(sale-dm): variant aggregate view (inquiry/undeliverable rates)"
```

---

### Task 8: 調整パネル(全体/この通タブ + デザイン/トーン/長さ/訴求/強さ + 型A/B割当)+ 適用ロジック

**Files:**
- Create: `src/lib/sale-dm-letter/adjust-model.ts`(純関数: タブ切替の対象解決 + PATCH ペイロード組立 + 選択肢定義)
- Modify: `src/components/sale-dm/adjust-panel.tsx`(実装)
- Modify: `src/lib/api-client.ts`(`patchSaleDmDraft`(本文/型変更)・`regenerateSaleDmDraft` を追加)
- Test: `src/lib/__tests__/sale-dm-adjust-model.test.ts`

**Interfaces:**
- Consumes: `PATCH /api/properties/sale-dm/drafts/[id]`(Plan 1: 本文/型変更)、`POST /api/properties/sale-dm/drafts/[id]/regenerate`(Plan 1)。
- Produces:
  - 選択肢定数 `DESIGN_OPTIONS`/`TONE_OPTIONS`/`LENGTH_OPTIONS`/`APPEAL_OPTIONS`/`STRENGTH_OPTIONS`(label 付き)
  - `resolveAdjustTarget(tab, selected): { scope: "campaign" | "draft"; draftId: string | null }`
  - `buildDraftPatch(input): { body?: string; variantId?: string }`
  - api-client: `patchSaleDmDraft`/`regenerateSaleDmDraft`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-adjust-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveAdjustTarget, buildDraftPatch, DESIGN_OPTIONS, APPEAL_OPTIONS } from "../sale-dm-letter/adjust-model";

describe("選択肢定数", () => {
  it("デザインは formal/soft/impact の3種", () => {
    expect(DESIGN_OPTIONS.map((o) => o.value)).toEqual(["formal", "soft", "impact"]);
  });
  it("訴求軸は price/inheritance/vacant/buyer の4種", () => {
    expect(APPEAL_OPTIONS.map((o) => o.value)).toEqual(["price", "inheritance", "vacant", "buyer"]);
  });
});

describe("resolveAdjustTarget", () => {
  it("全体タブは campaign スコープ", () => {
    expect(resolveAdjustTarget("campaign", { id: "r1" } as never)).toEqual({ scope: "campaign", draftId: null });
  });
  it("この通タブで selected があれば draft スコープ", () => {
    expect(resolveAdjustTarget("draft", { id: "r1" } as never)).toEqual({ scope: "draft", draftId: "r1" });
  });
  it("この通タブで selected が null なら draftId は null", () => {
    expect(resolveAdjustTarget("draft", null)).toEqual({ scope: "draft", draftId: null });
  });
});

describe("buildDraftPatch", () => {
  it("body のみ", () => {
    expect(buildDraftPatch({ body: "編集後" })).toEqual({ body: "編集後" });
  });
  it("型変更(variantId)のみ", () => {
    expect(buildDraftPatch({ variantId: "v2" })).toEqual({ variantId: "v2" });
  });
  it("未指定キーは入れない", () => {
    expect(buildDraftPatch({})).toEqual({});
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-adjust-model.test.ts`
Expected: FAIL(モジュール未解決)。

- [ ] **Step 3: 純関数を実装**

`src/lib/sale-dm-letter/adjust-model.ts`:

```ts
import type { SaleDmDraft } from "@/lib/api-client";

export const DESIGN_OPTIONS = [
  { value: "formal", label: "信頼" },
  { value: "soft", label: "やわらか" },
  { value: "impact", label: "インパクト" },
] as const;

export const TONE_OPTIONS = [
  { value: "formal", label: "フォーマル" },
  { value: "standard", label: "標準" },
  { value: "soft", label: "やわらか" },
] as const;

export const LENGTH_OPTIONS = [
  { value: "short", label: "短い" },
  { value: "medium", label: "中" },
  { value: "long", label: "長い" },
] as const;

export const APPEAL_OPTIONS = [
  { value: "price", label: "好条件での売却" },
  { value: "inheritance", label: "相続・税" },
  { value: "vacant", label: "空き家・管理負担" },
  { value: "buyer", label: "購入希望者あり" },
] as const;

export const STRENGTH_OPTIONS = [
  { value: "low", label: "控えめ" },
  { value: "medium", label: "標準" },
  { value: "high", label: "積極的" },
] as const;

export type AdjustTab = "campaign" | "draft";

export function resolveAdjustTarget(
  tab: AdjustTab,
  selected: Pick<SaleDmDraft, "id"> | null,
): { scope: "campaign" | "draft"; draftId: string | null } {
  if (tab === "draft") return { scope: "draft", draftId: selected?.id ?? null };
  return { scope: "campaign", draftId: null };
}

export interface DraftPatchInput {
  body?: string;
  variantId?: string;
}

export function buildDraftPatch(input: DraftPatchInput): DraftPatchInput {
  const patch: DraftPatchInput = {};
  if (input.body !== undefined) patch.body = input.body;
  if (input.variantId !== undefined) patch.variantId = input.variantId;
  return patch;
}
```

- [ ] **Step 4: api-client に PATCH/再生成を追加**

`src/lib/api-client.ts`:

```ts
export async function patchSaleDmDraft(id: string, patch: { body?: string; variantId?: string }) {
  if (USE_MOCK) {
    await mockDelay();
    return { id };
  }
  return apiFetch<{ id: string }>(`/api/properties/sale-dm/drafts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function regenerateSaleDmDraft(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, body: "（mock再生成）本文" };
  }
  return apiFetch<{ id: string; body: string }>(`/api/properties/sale-dm/drafts/${id}/regenerate`, {
    method: "POST",
  });
}
```

> 注: Plan 1 の `PATCH /drafts/[id]` は本文(`body`)更新のみを実装している。型変更(`variantId`)の受け入れは Plan 3(A/B割当)が拡張する想定。Plan 3 未マージの段階では調整パネルの「型変更」UI を `disabled` にし、本文編集・再生成・全体設定の再生成導線のみ有効化する(`variantId` を送らない)。Plan 3 マージ後に型変更を有効化する。

- [ ] **Step 5: 調整パネルを実装**

`src/components/sale-dm/adjust-panel.tsx`(全体/この通タブ。全体タブ=キャンペーン既定型の表示(読取)+「この通」タブ=選択中 draft の本文編集+再生成。デザイン/トーン/長さ/訴求/強さは select で表示し、変更は再生成 API へ反映する。Plan 3 前は「型割当」を read-only バッジで表示):

```tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import type { SaleDmCampaign, SaleDmDraft } from "@/lib/api-client";
import { patchSaleDmDraft, regenerateSaleDmDraft } from "@/lib/api-client";
import {
  resolveAdjustTarget,
  buildDraftPatch,
  DESIGN_OPTIONS,
  TONE_OPTIONS,
  LENGTH_OPTIONS,
  APPEAL_OPTIONS,
  STRENGTH_OPTIONS,
  type AdjustTab,
} from "@/lib/sale-dm-letter/adjust-model";

const labelOf = (opts: readonly { value: string; label: string }[], value: string) =>
  opts.find((o) => o.value === value)?.label ?? value;

export default function SaleDmAdjustPanel({
  campaign,
  selected,
  onChanged,
}: {
  campaign: SaleDmCampaign;
  selected: SaleDmDraft | null;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<AdjustTab>("campaign");
  const [bodyDraft, setBodyDraft] = useState(selected?.body ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBodyDraft(selected?.body ?? "");
  }, [selected?.id, selected?.body]);

  const variant =
    campaign.variants.find((v) => v.id === selected?.variantId) ?? campaign.variants[0] ?? null;
  const target = resolveAdjustTarget(tab, selected);

  const saveBody = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await patchSaleDmDraft(selected.id, buildDraftPatch({ body: bodyDraft }));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await regenerateSaleDmDraft(selected.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex rounded-md border border-gray-200 p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setTab("campaign")}
          className={`flex-1 rounded px-2 py-1 ${tab === "campaign" ? "bg-indigo-600 text-white" : "text-gray-600"}`}
        >
          全体
        </button>
        <button
          type="button"
          onClick={() => setTab("draft")}
          className={`flex-1 rounded px-2 py-1 ${tab === "draft" ? "bg-indigo-600 text-white" : "text-gray-600"}`}
        >
          この通
        </button>
      </div>

      {variant && (
        <dl className="space-y-1 text-xs text-gray-600">
          <Row k="デザイン" v={labelOf(DESIGN_OPTIONS, variant.designTemplate)} />
          <Row k="トーン" v={labelOf(TONE_OPTIONS, variant.tone)} />
          <Row k="長さ" v={labelOf(LENGTH_OPTIONS, variant.length)} />
          <Row k="訴求" v={labelOf(APPEAL_OPTIONS, variant.appeal)} />
          <Row k="強さ" v={labelOf(STRENGTH_OPTIONS, variant.strength)} />
          <Row k="型" v={variant.label} />
        </dl>
      )}

      {target.scope === "draft" && selected ? (
        <div className="space-y-2">
          <textarea
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-gray-300 p-2 text-sm"
            data-pii-protected
            data-pii-surface="owner"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveBody}
              disabled={busy || bodyDraft === selected.body}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              この通を保存
            </button>
            <button
              type="button"
              onClick={regenerate}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              再生成
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          全体の型(デザイン・トーン等)はキャンペーン作成時の設定です。個別調整は「この通」タブで行います。
        </p>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-400">{k}</dt>
      <dd className="font-medium text-gray-700">{v}</dd>
    </div>
  );
}
```

> 注: 全体一括の「型編集→全通再生成」と複数型(A/B)の割当 UI は Plan 3(A/B割当 route)に依存する。Plan 3 未マージの段階では、本パネルは「この通」の本文編集・再生成と全体型の read-only 表示までを提供する(設計書のレイアウトAを満たす最小)。Plan 3 マージ後に「全体タブでの型編集→一括再生成」「型A/B割当 select」を追加する(本 Task の `resolveAdjustTarget`/`buildDraftPatch` をそのまま使える)。

- [ ] **Step 6: テスト + build を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-adjust-model.test.ts`(PASS・8 件)
Run: `npm run build`(成功)

- [ ] **Step 7: コミット**

```bash
git add src/lib/sale-dm-letter/adjust-model.ts src/components/sale-dm/adjust-panel.tsx src/lib/api-client.ts src/lib/__tests__/sale-dm-adjust-model.test.ts
git commit -m "feat(sale-dm): adjust panel (overall/this-letter tabs + body edit/regenerate)"
```

---

### Task 9: 全テスト + lint + build + プラン横断の整合確認

**Files:** なし(検証のみ)

- [ ] **Step 1: フルスイート**

Run: `npm test` → 既存 + 新規すべて green(本プランの新規: property-list-query-dm-undeliverable / properties-route-dm-undeliverable / sale-dm-list-ui / sale-dm-recipient-actions / sale-dm-aggregate-view-model / sale-dm-adjust-model)。

- [ ] **Step 2: lint + build**

Run: `npm run lint`(エラーなし)
Run: `npm run build`(成功・新ページ `/(dashboard)/properties/sale-dm/[campaignId]` が route manifest に出る)

- [ ] **Step 3: Plan 2/4 結線の確認(該当時)**

Plan 2(`renderLetterHtml`)/Plan 4(`aggregateCampaign` + `PATCH .../outcome`)がマージ済なら、Task 5 のスタブ import / Task 6 の outcome キー / Task 7 の集計母数定義を実体に合わせ、差分があれば修正コミット。未マージなら本プランは「スタブ/クライアント自給」で成立しており、後続マージ時に結線する旨を PR 説明に明記。

- [ ] **Step 4: コミット(必要時)**

```bash
git add -A
git commit -m "chore(sale-dm): align workspace UI with Plan 2/4 interfaces"
```

---

## Self-Review(本プラン → 設計書 / スコープ突合)

- (a) 物件一覧「宛先不明」バッジ列 + フィルタ(`Property.dmUndeliverableAt` 参照): Task 1(where)+ Task 2(API レスポンス)+ Task 3(純関数)+ Task 4(UI 結線)✅。フィルタは既存単一定義元 `property-list-query`/`validators` に最小追加(条件ズレ回避)。
- (a) 「売却DMを作成」導線(選択 → POST campaigns)+ 権限(`canExportDm` 相当)で出し分け: Task 3 `canCreateSaleDm` + Task 4 CTA ✅。表示制御のみでセキュリティ境界はサーバー `requireSaleDmAccess()`。
- (b) 作業画面レイアウトA(左=調整パネル(全体/この通タブ・デザイン/トーン/長さ/訴求/強さ)/中央=プレビュー(`renderLetterHtml`)/右=宛先リスト(型バッジ・配達結果/反響入力)): Task 5(骨格)+ Task 6(宛先リスト)+ Task 8(調整パネル)✅。新ページ `src/app/(dashboard)/properties/sale-dm/[campaignId]/`。
- (c) 集計ビュー(型別 反響率/宛先不明率): Task 7 ✅。母数=設計書定義(反響率=到達 / 宛先不明率=送付)。
- テスト重点(フィルタ where / 表示出し分け純関数 / 反響・配達トグル→API 呼び出し形): Task 1/3/6/7/8 の純関数テストで担保 ✅。E2E は対象外(明記)。
- PII / no-store / 秘密非露出: route 側(Plan 1)で `no-store`・client は env 非読取・PII セルに `data-pii-protected` 付与 ✅。
- DRY/YAGNI: 一覧クエリは単一定義元に追加・プレビューは Plan 2 再利用・集計は純関数 + Plan 4 優先のフォールバック ✅。raw SQL なし。
- **依存(他プラン)**: Plan 1(土台・必須・既存前提)/ Plan 2(`renderLetterHtml`・プレビュー)/ Plan 3(A/B 型割当・調整パネルの型編集は後続有効化)/ Plan 4(`aggregateCampaign` + `outcome` route・集計と反響入力)。未マージ時の暫定(スタブ / read-only / クライアント自給)を各 Task に明記。
- Placeholder スキャン: なし(各 step に実コード/実コマンド。Plan 2 未マージ時の `render.ts` スタブは「動く実コード」かつ差し替え前提を明記)。
- 命名整合: lib は `src/lib/sale-dm-letter/*`(list-ui / recipient-actions / aggregate-view-model / adjust-model)・コンポーネントは `src/components/sale-dm/*`・route は Plan 1 の `/api/properties/sale-dm/*` を consume(本プランで route 新設なし)✅。

> 既知の実装時確認点(レビュアー向け): (1) Plan 2 `renderLetterHtml` の正確な引数(draft/variant/options)と HTML サニタイズ責任。(2) Plan 4 `PATCH .../outcome` のボディキー(`phoneInquiry`/`deliveryStatus` の正確な名前)と集計母数定義 → Task 6/7 を一致させる。(3) Plan 1 `saleDmOptionsSchema` の `senderName`/`senderContact` 必須 → env 既定補完(`resolveSender`)が入っているか。未対応なら Task 4 の作成 CTA で 400 にならない実値を渡す。(4) `useScreenProtection()` の配布権限 shape(`{ resource, action, granted }[]`)が `canCreateSaleDm` の引数と一致すること(既存 `canExportDm` と同一導出で確認済)。
