# 売却促進DM 作成 — Plan 3: A/Bテスト(型の複数定義 + 割当 + 個別上書き)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1 の「1キャンペーン=既定型1つ」を一般化し、1キャンペーンに**複数の型(A/B/C…=設定一式 DmVariant)** を作成・更新・削除でき、対象の宛先下書きへ**自動均等割り(ランダム/順番)**または**手動指定**で型を割り当て、**1通だけの調整差分(`overrideJson`)** を保存し、生成/再生成が割り当てられた型を使うよう連携する。集計の A/B 純度のため「割り当てられた `variantId` 基準」を保つ。

**Architecture:** Plan 1 の層(`src/lib/sale-dm-letter/`)に**純関数 `assignVariantsEvenly`(割当ロジック)** と**個別上書きの差分マージ純関数 `resolveDraftOptions`** を追加し、その上に薄い route 層(型 CRUD・割当・個別上書き)を載せる。型の設定一式は Plan 1 の `saleDmOptions(schema)` を再利用して検証する。route は既存 `requireSaleDmAccess()`(Plan 1)で権限・PII ゲートし、PII レスポンスは `no-store`、AuditLog は非PIIメタのみ。DB 書込は Plan 1 の Prisma モデル(`DmCampaign`/`DmVariant`/`DmRecipientDraft`)を使い、raw SQL は入れない。

**Tech Stack:** Next.js 16 (App Router) / Prisma 7 / PostgreSQL / next-auth v5 / zod 4 / vitest 4。新規依存なし。

## Global Constraints

- 設計書: `docs/superpowers/specs/2026-06-22-sale-dm-letter-assist-design.md`。土台: `docs/superpowers/plans/2026-06-22-sale-dm-letter-assist-01-foundation.md`(Plan 1)。**Plan 1 が先に完了している前提**(モデル・lib・route・`requireSaleDmAccess`・`saleDmOptionsSchema` が存在する)。
- 実装は**専用 git worktree**(`superpowers:using-git-worktrees`)。base = `main`・branch = `feat/sale-dm-letter-assist`(Plan 1 と同一ブランチに積む。worktree が既にあればそれを使う)。
- 既存資産を**再定義しない**。Plan 1 が用意した次を**そのまま import** する:
  - `@/lib/sale-dm-letter/types`: `LetterOptions` / `LetterRecipient` / `SaleDmError`。
  - `@/lib/sale-dm-letter`(index): `generateLetters` / `resolveProvider` / `isSaleDmConfigured` / `MAX_GENERATE_ITEMS` / `GeneratedDraft`。
  - `@/lib/sale-dm-letter/route-guard`: `requireSaleDmAccess()` → `{ session, permissions, ownerDisplayConfig }`。
  - `@/lib/sale-dm-letter/recipients`: `buildRecipientsFromProperties` / `RecipientMeta`。
  - `@/lib/validators-sale-dm`: `saleDmOptionsSchema` / `saleDmCampaignBodySchema`。
- 既存共通ヘルパ(再実装しない): `@/lib/prisma`(default), `@/lib/api-helpers`(`getApiSession`/`getUserPermissions`/`getOwnerDisplayConfig`/`ApiError`/`handleApiError`/`parseJsonBody`/`OwnerDisplayConfig`/`PermissionEntry`), `@/lib/permissions`(`hasPermission`/`maskValue`), `@/lib/audit`(`writeAuditLog`)。
- **dm-export の実シグネチャに厳密一致**(Plan 1 のメモは概念図): `groupPropertyOwnersByAddress(propertyOwners)` は `{ groups: DmRowPropertyOwner[][]; skippedAddressCount }` を返す(`groups[i]` は **DmRowPropertyOwner の配列**)。代表者は `selectGroupRepresentative(group)`。敬称は `honorificForOwner(name, hasCorporateNumber)`(2引数)。`isPlainOwnerLevel(level)`。これらは `@/lib/dm-export` から import。
- 権限ゲートは**必ず `requireSaleDmAccess()`** を使う(4権限 + PII 生値レベル)。不可なら 403・**副作用なし**。
- 秘密はサーバー側のみ・`NEXT_PUBLIC_*` 露出禁止・client 直叩き禁止。env 未設定(生成系)は**fail-closed→503**。型 CRUD/割当/上書きは生成 API を呼ばない純 DB 操作なので env gate 不要(ただし PII を返す GET は `no-store`)。
- PII(本文・宛名・住所)を返すレスポンスは `Cache-Control: no-store`。型(DmVariant)・割当結果(count/variantId)・モデル名は**非PII**。AuditLog に本文/宛名/住所を入れない(非PIIメタのみ)。
- **A/B 純度**: 集計は常に**割り当てられた `variantId` 基準**(`overrideJson` は本文の微修正用途で、型の帰属は変えない)。`overrideJson` は「この通だけの調整差分」(部分 `LetterOptions`)を保持し、再生成時に variant 設定へ shallow merge して適用する。
- TDD / DRY / YAGNI / こまめにコミット。テストは `src/lib/__tests__/*.test.ts`、実行 `npm test`(= `vitest run`)、単体 `npx vitest run <file>`。route テストは Plan 1 / dm-export route test と同じ `vi.mock("next/server" | "@/lib/api-helpers" | "@/lib/audit" | "@/lib/prisma")` 流儀。
- 本プランのスコープ外(後続): 配達/反響/宛先不明連動/集計ビュー(P4)・LP追跡/`/t/[token]`(P5)・作業画面UI(P6)・デザイン/印刷/CSV(P2)。本プランは**型の複数化と割当**まで。

---

### Task 1: 割当の純関数 `assignVariantsEvenly`

**Files:**
- Create: `src/lib/sale-dm-letter/assign.ts`
- Test: `src/lib/__tests__/sale-dm-assign.test.ts`

**Interfaces:**
- Produces(後続が依存):
  - `assignVariantsEvenly(recipientIds: string[], variantIds: string[], opts?: { order?: "sequential" | "random"; rng?: () => number }): Map<string, string>`
  - `applyManualAssignment(recipientIds: string[], variantIds: string[], assignments: { recipientId: string; variantId: string }[]): Map<string, string>`

**割当の規約(端数の扱いを明確化):**
- **順番(sequential)**: `recipientIds[i]` を `variantIds[i % variantIds.length]` に割り当てる。端数(`recipientIds.length` が `variantIds.length` の倍数でない場合)は**先頭の型から順に1つずつ多く**配られる(ラウンドロビン)。例 5人×2型(A,B)→ A,B,A,B,A(A=3, B=2)。
- **ランダム(random)**: まず sequential と同じ「均等な型ラベルの配列」(各型の本数差が最大1)を作り、それを `rng`(既定 `Math.random`)で Fisher–Yates シャッフルしてから `recipientIds` 順に対応させる。**各型の本数分布は sequential と同一**(=均等)で、並びだけランダム。`rng` 注入でテスト決定化。
- 空入力: `variantIds` が空なら**空 Map**(割当不能)。`recipientIds` が空なら**空 Map**。
- `recipientIds` の重複は呼び出し側責務(本関数は最後の割当で上書きされる Map をそのまま返す)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-assign.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignVariantsEvenly, applyManualAssignment } from "../sale-dm-letter/assign";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i + 1}`);

function countByVariant(map: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of map.values()) out[v] = (out[v] ?? 0) + 1;
  return out;
}

describe("assignVariantsEvenly (sequential)", () => {
  it("割り切れるときは完全均等", () => {
    const map = assignVariantsEvenly(ids(4), ["A", "B"], { order: "sequential" });
    expect(map.size).toBe(4);
    expect(countByVariant(map)).toEqual({ A: 2, B: 2 });
  });

  it("端数は先頭の型から1つずつ多く(ラウンドロビン)", () => {
    const map = assignVariantsEvenly(ids(5), ["A", "B"], { order: "sequential" });
    expect(map.get("r1")).toBe("A");
    expect(map.get("r2")).toBe("B");
    expect(map.get("r3")).toBe("A");
    expect(map.get("r4")).toBe("B");
    expect(map.get("r5")).toBe("A");
    expect(countByVariant(map)).toEqual({ A: 3, B: 2 });
  });

  it("3型7人でも各型の差は最大1", () => {
    const map = assignVariantsEvenly(ids(7), ["A", "B", "C"], { order: "sequential" });
    const counts = Object.values(countByVariant(map));
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(map.size).toBe(7);
  });
});

describe("assignVariantsEvenly (random)", () => {
  it("rng 注入で決定的・分布は sequential と同じ(均等)", () => {
    // rng=()=>0 は Fisher-Yates で各位置を先頭要素と入れ替える(決定的)
    const map = assignVariantsEvenly(ids(5), ["A", "B"], { order: "random", rng: () => 0 });
    expect(map.size).toBe(5);
    expect(countByVariant(map)).toEqual({ A: 3, B: 2 }); // 並びは違っても本数は均等
  });
});

describe("空入力", () => {
  it("型が空なら空 Map", () => {
    expect(assignVariantsEvenly(ids(3), []).size).toBe(0);
  });
  it("宛先が空なら空 Map", () => {
    expect(assignVariantsEvenly([], ["A", "B"]).size).toBe(0);
  });
});

describe("applyManualAssignment", () => {
  it("指定された recipient だけ上書き・未指定は残す(既定 = 先頭型)", () => {
    // ベースは sequential 均等割り → 一部を手動上書き
    const map = applyManualAssignment(ids(3), ["A", "B"], [{ recipientId: "r2", variantId: "B" }]);
    expect(map.get("r2")).toBe("B");
    expect(map.size).toBe(3);
    // 手動指定外の r1/r3 も型を持つ(空にしない)
    expect(map.get("r1")).toBeTruthy();
    expect(map.get("r3")).toBeTruthy();
  });

  it("対象 recipientIds に無い id の指定は無視する", () => {
    const map = applyManualAssignment(ids(2), ["A", "B"], [{ recipientId: "zzz", variantId: "A" }]);
    expect(map.has("zzz")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("対象 variantIds に無い variant の指定は無視する", () => {
    const map = applyManualAssignment(ids(2), ["A", "B"], [{ recipientId: "r1", variantId: "ZZZ" }]);
    expect(map.get("r1")).not.toBe("ZZZ");
    expect(["A", "B"]).toContain(map.get("r1"));
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-assign.test.ts`
Expected: FAIL(`assignVariantsEvenly` / `applyManualAssignment` 未定義)。

- [ ] **Step 3: 実装**

`src/lib/sale-dm-letter/assign.ts`:

```ts
export interface AssignOptions {
  order?: "sequential" | "random";
  rng?: () => number;
}

export interface ManualAssignment {
  recipientId: string;
  variantId: string;
}

// 各型の本数差が最大1になる「型ラベル列」を recipientIds と同じ長さで作る(ラウンドロビン)。
function evenVariantSequence(count: number, variantIds: string[]): string[] {
  const seq: string[] = [];
  for (let i = 0; i < count; i++) {
    seq.push(variantIds[i % variantIds.length]);
  }
  return seq;
}

// Fisher–Yates(rng 注入可)。入力配列を破壊しないようコピーを返す。
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const k = j > i ? i : j; // rng が 1 を返しても範囲外にしない保険
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

/**
 * 対象宛先を型へ均等割りする。
 *  - sequential: recipientIds[i] → variantIds[i % n]。端数は先頭型から1つずつ多い。
 *  - random: 本数分布は sequential と同一(均等)のまま、型ラベルの並びだけシャッフル。
 *  - variantIds か recipientIds が空なら空 Map。
 */
export function assignVariantsEvenly(
  recipientIds: string[],
  variantIds: string[],
  opts?: AssignOptions,
): Map<string, string> {
  const map = new Map<string, string>();
  if (variantIds.length === 0 || recipientIds.length === 0) return map;

  let seq = evenVariantSequence(recipientIds.length, variantIds);
  if (opts?.order === "random") {
    seq = shuffle(seq, opts.rng ?? Math.random);
  }
  recipientIds.forEach((rid, i) => map.set(rid, seq[i]));
  return map;
}

/**
 * 手動割当: まず均等割り(sequential)をベースにし、指定された (recipientId→variantId) で上書きする。
 * 対象 recipientIds / variantIds の集合外の指定は無視する(不正 id を取り込まない)。
 */
export function applyManualAssignment(
  recipientIds: string[],
  variantIds: string[],
  assignments: ManualAssignment[],
): Map<string, string> {
  const map = assignVariantsEvenly(recipientIds, variantIds, { order: "sequential" });
  const recipientSet = new Set(recipientIds);
  const variantSet = new Set(variantIds);
  for (const a of assignments) {
    if (recipientSet.has(a.recipientId) && variantSet.has(a.variantId)) {
      map.set(a.recipientId, a.variantId);
    }
  }
  return map;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-assign.test.ts`
Expected: PASS(11 件)。

- [ ] **Step 5: コミット**

```bash
git add src/lib/sale-dm-letter/assign.ts src/lib/__tests__/sale-dm-assign.test.ts
git commit -m "feat(sale-dm): add variant assignment pure functions (even/random/manual)"
```

---

### Task 2: 個別上書き差分の純関数 `resolveDraftOptions` + 上書きスキーマ

**Files:**
- Create: `src/lib/sale-dm-letter/override.ts`
- Modify: `src/lib/validators-sale-dm.ts`(`saleDmOptionsOverrideSchema` を追加)
- Test: `src/lib/__tests__/sale-dm-override.test.ts`

**Interfaces:**
- Consumes: `LetterOptions`(`@/lib/sale-dm-letter/types`)、`saleDmOptionsSchema`(`@/lib/validators-sale-dm`)。
- Produces:
  - `saleDmOptionsOverrideSchema`(`saleDmOptionsSchema.partial()` 相当・各キー任意)
  - `DraftOverride`(= `Partial<LetterOptions>` 互換の上書き差分型)
  - `resolveDraftOptions(variant: VariantOptionFields, override: DraftOverride | null | undefined, sender: { senderName: string; senderContact: string }): LetterOptions`

> 設計上の判断: `overrideJson` は **`LetterOptions` の部分集合**(designTemplate/tone/length/appeal/strength/extraInstruction のうち任意のキー)。`senderName`/`senderContact` は上書き対象外(差出人は型や個別調整の範囲外で、再生成は env/キャンペーン由来の sender を使う)。集計は variant 基準なので override は本文の微修正だけに使う。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-override.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveDraftOptions } from "../sale-dm-letter/override";
import { saleDmOptionsOverrideSchema } from "../validators-sale-dm";

const variant = {
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  extraInstruction: null as string | null,
};
const sender = { senderName: "△△不動産", senderContact: "000-000-0000" };

describe("resolveDraftOptions", () => {
  it("override 無しなら variant 設定 + sender をそのまま LetterOptions にする", () => {
    const o = resolveDraftOptions(variant, null, sender);
    expect(o.tone).toBe("formal");
    expect(o.strength).toBe("low");
    expect(o.senderName).toBe("△△不動産");
    expect(o.extraInstruction).toBeUndefined(); // null → undefined に正規化
  });

  it("override のキーだけ variant を上書きする(shallow merge)", () => {
    const o = resolveDraftOptions(variant, { tone: "soft", strength: "high" }, sender);
    expect(o.tone).toBe("soft");
    expect(o.strength).toBe("high");
    expect(o.appeal).toBe("price"); // 未指定は variant 維持
    expect(o.senderName).toBe("△△不動産"); // sender は override 対象外
  });

  it("override の extraInstruction を反映する", () => {
    const o = resolveDraftOptions(variant, { extraInstruction: "成約事例にも触れて" }, sender);
    expect(o.extraInstruction).toBe("成約事例にも触れて");
  });

  it("override に sender を含めても無視する(差出人は変えない)", () => {
    const o = resolveDraftOptions(variant, { senderName: "悪意" } as never, sender);
    expect(o.senderName).toBe("△△不動産");
  });
});

describe("saleDmOptionsOverrideSchema", () => {
  it("部分指定を許可する", () => {
    const r = saleDmOptionsOverrideSchema.safeParse({ tone: "soft" });
    expect(r.success).toBe(true);
  });
  it("空オブジェクトを許可する", () => {
    expect(saleDmOptionsOverrideSchema.safeParse({}).success).toBe(true);
  });
  it("不正な enum 値は拒否する", () => {
    expect(saleDmOptionsOverrideSchema.safeParse({ tone: "loud" }).success).toBe(false);
  });
  it("sender 等の余剰キーは無視される(部分 options のみ)", () => {
    const r = saleDmOptionsOverrideSchema.safeParse({ tone: "soft", senderName: "x" });
    expect(r.success).toBe(true);
    expect("senderName" in (r.success ? r.data : {})).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-override.test.ts`
Expected: FAIL(モジュール/スキーマ未定義)。

- [ ] **Step 3: スキーマを追加**

`src/lib/validators-sale-dm.ts` の末尾に追記(`saleDmOptionsSchema` は Plan 1 で定義済み):

```ts
// 個別上書き(overrideJson)用: options の部分集合のみ許可する。
// designTemplate/tone/length/appeal/strength/extraInstruction を任意指定可能。
// senderName/senderContact は上書き対象外なので omit する(余剰キーは無視)。
export const saleDmOptionsOverrideSchema = saleDmOptionsSchema
  .omit({ senderName: true, senderContact: true })
  .partial();

export type SaleDmOptionsOverride = z.infer<typeof saleDmOptionsOverrideSchema>;
```

> 注: `saleDmOptionsSchema` が `z.object({...})` であること(Plan 1 Task 6 で定義)を前提に `.omit().partial()` を使う。`z` の import は Plan 1 で既にファイル冒頭にある(なければ `import { z } from "zod";` を追加)。

- [ ] **Step 4: マージ純関数を実装**

`src/lib/sale-dm-letter/override.ts`:

```ts
import type { LetterOptions } from "./types";

// variant が持つ options 相当のフィールド(sender は含まない)。
export interface VariantOptionFields {
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
}

// この通だけの調整差分(LetterOptions の部分集合・sender は対象外)。
export type DraftOverride = Partial<{
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
}>;

// override のうち上書きを許す安全なキー(sender 等の混入を防ぐ allowlist)。
const OVERRIDABLE_KEYS = [
  "designTemplate",
  "tone",
  "length",
  "appeal",
  "strength",
  "extraInstruction",
] as const;

/**
 * variant 設定に「この通だけの上書き(override)」を shallow merge し、
 * 差出人を足して LetterOptions を組み立てる(再生成・プレビューで使う)。
 *  - override の許可キーのみ反映(sender 等は無視)。
 *  - extraInstruction の null は undefined に正規化(prompt builder の任意項目に合わせる)。
 */
export function resolveDraftOptions(
  variant: VariantOptionFields,
  override: DraftOverride | null | undefined,
  sender: { senderName: string; senderContact: string },
): LetterOptions {
  const merged: VariantOptionFields = { ...variant };
  if (override) {
    for (const key of OVERRIDABLE_KEYS) {
      if (override[key] !== undefined) {
        // 許可キーのみ反映する(allowlist)。
        (merged as Record<string, unknown>)[key] = override[key];
      }
    }
  }
  return {
    designTemplate: merged.designTemplate,
    tone: merged.tone,
    length: merged.length,
    appeal: merged.appeal,
    strength: merged.strength,
    senderName: sender.senderName,
    senderContact: sender.senderContact,
    extraInstruction: merged.extraInstruction ?? undefined,
  };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-override.test.ts`
Expected: PASS(8 件)。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/override.ts src/lib/validators-sale-dm.ts src/lib/__tests__/sale-dm-override.test.ts
git commit -m "feat(sale-dm): add per-draft override merge + override schema"
```

---

### Task 3: 型 CRUD route(設定一式の作成 / 更新 / 削除 / 一覧)

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts`(GET=一覧 / POST=作成)
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts`(PATCH=更新 / DELETE=削除)
- Modify: `src/lib/validators-sale-dm.ts`(`saleDmVariantCreateSchema` / `saleDmVariantUpdateSchema` 追加)
- Test: `src/lib/__tests__/sale-dm-variants-route.test.ts`

**Interfaces:**
- Consumes: `requireSaleDmAccess`(`@/lib/sale-dm-letter/route-guard`)、`saleDmOptionsSchema`(`@/lib/validators-sale-dm`)、`prisma`、`writeAuditLog`、`handleApiError`/`ApiError`/`parseJsonBody`。
- Produces:
  - route `GET/POST /api/properties/sale-dm/campaigns/[id]/variants`
  - route `PATCH/DELETE /api/properties/sale-dm/campaigns/[id]/variants/[variantId]`
  - `saleDmVariantCreateSchema`(label + options 一式)/ `saleDmVariantUpdateSchema`(部分更新)

**規約:**
- 型は**設定一式(designTemplate/tone/length/appeal/strength/extraInstruction)+ label**。`saleDmOptionsSchema` から `senderName`/`senderContact` を除いた `omit` を再利用(DRY)。
- **削除ガード**: その型に割り当て済みの `DmRecipientDraft` が1件でもあれば削除を拒否(409・`VARIANT_IN_USE`)。A/B 純度を壊さないため。割当を別型へ移してから削除する運用。
- variant は当該 campaign に属することを where で必ず縛る(`campaignId` 一致)。他キャンペーンの variant を触らせない。

- [ ] **Step 1: スキーマ + route テストを書く(失敗)**

`src/lib/__tests__/sale-dm-variants-route.test.ts`(Plan 1 / dm-export route test と同じ `vi.mock` 流儀):

```ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findUnique: vi.fn() },
    dmVariant: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findFirst: vi.fn() },
    dmRecipientDraft: { count: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET as listVariants, POST as createVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/route";
import { PATCH as updateVariant, DELETE as deleteVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { count: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    keys.map((k) => ({ resource: k, action: "read", granted: true })),
  );
const optionFields = { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" };
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const ctxV = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
});

describe("GET variants", () => {
  it("権限ありで 200・no-store・型一覧を返す", async () => {
    pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A", ...optionFields }]);
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.variants).toHaveLength(1);
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(403);
  });
});

describe("POST variant (作成)", () => {
  it("label + options 一式で作成し 200", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "B", ...optionFields });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.create).toHaveBeenCalled();
    const arg = pm.dmVariant.create.mock.calls[0][0];
    expect(arg.data.campaignId).toBe("c1");
    expect(arg.data.label).toBe("B");
    expect(arg.data.tone).toBe("formal");
  });
  it("存在しない campaign で 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(404);
  });
  it("不正な options で 422(zod)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1" });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: { ...optionFields, tone: "loud" } }) }) as never, ctxC);
    expect(res.status).toBe(422);
  });
});

describe("PATCH variant (更新)", () => {
  it("設定一式の部分更新で 200・campaignId で縛る", async () => {
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2", options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
    const arg = pm.dmVariant.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "v1", campaignId: "c1" });
    expect(arg.data.tone).toBe("soft");
    expect(arg.data.label).toBe("A2");
  });
});

describe("DELETE variant (削除ガード)", () => {
  it("割当済みドラフトが無ければ削除し 200", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.delete.mockResolvedValue({ id: "v1" });
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.delete).toHaveBeenCalledWith({ where: { id: "v1", campaignId: "c1" } });
  });
  it("割当済みドラフトがあれば 409・削除しない", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(3);
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmVariant.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-variants-route.test.ts`
Expected: FAIL(route/スキーマ未実装)。

- [ ] **Step 3: スキーマを追加**

`src/lib/validators-sale-dm.ts` に追記:

```ts
// 型(DmVariant)= 設定一式。sender は型に持たせない(差出人はキャンペーン/env 既定)。
const variantOptionsSchema = saleDmOptionsSchema.omit({ senderName: true, senderContact: true });

export const saleDmVariantCreateSchema = z.object({
  label: z.string().min(1).max(40),
  options: variantOptionsSchema,
});

// 更新は label・options をそれぞれ任意指定(部分更新)。
export const saleDmVariantUpdateSchema = z.object({
  label: z.string().min(1).max(40).optional(),
  options: variantOptionsSchema.partial().optional(),
});

export type SaleDmVariantCreate = z.infer<typeof saleDmVariantCreateSchema>;
export type SaleDmVariantUpdate = z.infer<typeof saleDmVariantUpdateSchema>;
```

- [ ] **Step 4: 一覧 + 作成 route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantCreateSchema } from "@/lib/validators-sale-dm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;
    const variants = await prisma.dmVariant.findMany({
      where: { campaignId: id },
      orderBy: { label: "asc" },
    });
    return NextResponse.json({ variants }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const { label, options } = saleDmVariantCreateSchema.parse(await parseJsonBody(request));

    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true } });
    if (!campaign) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    const variant = await prisma.dmVariant.create({
      data: {
        campaignId: id,
        label,
        designTemplate: options.designTemplate,
        tone: options.tone,
        length: options.length,
        appeal: options.appeal,
        strength: options.strength,
        extraInstruction: options.extraInstruction ?? null,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_create",
      targetTable: "dm_variants",
      targetId: variant.id,
      detail: { campaignId: id, label, createdAt: new Date().toISOString() },
    });

    return NextResponse.json({ variant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 更新 + 削除 route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantUpdateSchema } from "@/lib/validators-sale-dm";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    const parsed = saleDmVariantUpdateSchema.parse(await parseJsonBody(request));

    const data: Prisma.DmVariantUpdateInput = {};
    if (parsed.label !== undefined) data.label = parsed.label;
    if (parsed.options) {
      const o = parsed.options;
      if (o.designTemplate !== undefined) data.designTemplate = o.designTemplate;
      if (o.tone !== undefined) data.tone = o.tone;
      if (o.length !== undefined) data.length = o.length;
      if (o.appeal !== undefined) data.appeal = o.appeal;
      if (o.strength !== undefined) data.strength = o.strength;
      if (o.extraInstruction !== undefined) data.extraInstruction = o.extraInstruction ?? null;
    }

    // campaignId で縛り、他キャンペーンの型を更新させない。
    const result = await prisma.dmVariant.update({
      where: { id: variantId, campaignId: id },
      data,
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_update",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ variant: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;

    // A/B 純度: 割当済みの下書きがある型は削除できない(別型へ移してから)。
    const inUse = await prisma.dmRecipientDraft.count({ where: { campaignId: id, variantId } });
    if (inUse > 0) {
      throw new ApiError(409, "この型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");
    }

    await prisma.dmVariant.delete({ where: { id: variantId, campaignId: id } });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_delete",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, deletedAt: new Date().toISOString() },
    });

    return NextResponse.json({ deleted: variantId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

> 注: `prisma.dmVariant.update`/`delete` の `where` に複合条件(`id` + `campaignId`)を渡すには、`id` が unique であれば Prisma の `where` で追加フィルタを併記できる(Prisma 5+ は unique where に非unique フィールドの追加条件を許容)。本リポジトリの Prisma バージョンで型エラーになる場合は、`updateMany`/`deleteMany`(`where: { id, campaignId }`)+ `count===0→404` 判定に置き換える(テストは `update`/`delete` 呼び出しを `updateMany`/`deleteMany` に読み替え)。**実装時に `npm run build` で型を確認し、エラーなら updateMany/deleteMany 版を採用すること。**

- [ ] **Step 6: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-variants-route.test.ts`
Expected: PASS(GET 2 + POST 3 + PATCH 1 + DELETE 2)。

- [ ] **Step 7: コミット**

```bash
git add src/lib/validators-sale-dm.ts "src/app/api/properties/sale-dm/campaigns/[id]/variants" src/lib/__tests__/sale-dm-variants-route.test.ts
git commit -m "feat(sale-dm): add variant CRUD routes (create/update/delete/list) with in-use guard"
```

---

### Task 4: 割当 route(自動均等 / 手動)`POST campaigns/[id]/assign`

**Files:**
- Create: `src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts`
- Modify: `src/lib/validators-sale-dm.ts`(`saleDmAssignSchema` 追加)
- Test: `src/lib/__tests__/sale-dm-assign-route.test.ts`

**Interfaces:**
- Consumes: `assignVariantsEvenly` / `applyManualAssignment`(Task 1)、`requireSaleDmAccess`、`prisma`、`writeAuditLog`。
- Produces: route `POST /api/properties/sale-dm/campaigns/[id]/assign`、`saleDmAssignSchema`。

**規約:**
- body: `{ mode: "auto" | "manual"; order?: "sequential" | "random"; assignments?: { recipientId, variantId }[] }`。
- 対象 = 当該 campaign の **全 `DmRecipientDraft`**(id 昇順=作成順)。型 = 当該 campaign の全 `DmVariant`。
- 型が0件なら 409(`NO_VARIANTS`・割当不能)。
- auto: `assignVariantsEvenly(recipientIds, variantIds, { order })`。manual: `applyManualAssignment(recipientIds, variantIds, assignments)`。
- 反映: 算出 Map を `variantId` ごとにまとめ、**型ごとに `updateMany`**(`where: { id: { in: idsForThatVariant }, campaignId }`)で `variantId` を一括更新(N+1 を避ける)。
- AuditLog は非PIIメタのみ(mode/order/件数/型別件数)。割当は本文・宛名を触らない。

- [ ] **Step 1: スキーマ + route テストを書く(失敗)**

`src/lib/__tests__/sale-dm-assign-route.test.ts`(Task 3 と同じ `vi.mock` ブロックを流用。prisma mock に `dmVariant.findMany` / `dmRecipientDraft.findMany` / `dmRecipientDraft.updateMany` を持たせる):

```ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmVariant: { findMany: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as assign } from "../../app/api/properties/sale-dm/campaigns/[id]/assign/route";

const pm = prismaMock as never as {
  dmVariant: { findMany: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(keys.map((k) => ({ resource: k, action: "read", granted: true })));
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const post = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  pm.dmVariant.findMany.mockResolvedValue([{ id: "vA" }, { id: "vB" }]);
  pm.dmRecipientDraft.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }]);
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 2 });
});

describe("POST assign (auto)", () => {
  it("自動均等割りで型ごとに updateMany を呼び 200", async () => {
    const res = await assign(post({ mode: "auto", order: "sequential" }) as never, ctxC);
    expect(res.status).toBe(200);
    // 2型なので updateMany は最大2回(型ごと)
    expect(pm.dmRecipientDraft.updateMany.mock.calls.length).toBeGreaterThanOrEqual(1);
    const allUpdates = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    // すべて campaignId で縛る
    for (const u of allUpdates) expect(u.where.campaignId).toBe("c1");
    const json = await res.json();
    expect(json.assigned).toBe(4);
  });

  it("権限不足で 403・更新しない", async () => {
    grant("property");
    const res = await assign(post({ mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("型が0件なら 409・更新しない", async () => {
    pm.dmVariant.findMany.mockResolvedValue([]);
    const res = await assign(post({ mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST assign (manual)", () => {
  it("手動指定を反映し 200", async () => {
    const res = await assign(post({ mode: "manual", assignments: [{ recipientId: "r1", variantId: "vB" }] }) as never, ctxC);
    expect(res.status).toBe(200);
    // vB に r1 を含む updateMany が呼ばれる
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    const vBcall = calls.find((c) => c.data.variantId === "vB");
    expect(vBcall.where.id.in).toContain("r1");
  });

  it("不正な variant の手動指定は無視される(均等割りの型になる)", async () => {
    const res = await assign(post({ mode: "manual", assignments: [{ recipientId: "r1", variantId: "ZZZ" }] }) as never, ctxC);
    expect(res.status).toBe(200);
    const calls = pm.dmRecipientDraft.updateMany.mock.calls.map((c) => c[0]);
    // ZZZ への更新は発行されない
    expect(calls.find((c) => c.data.variantId === "ZZZ")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-assign-route.test.ts`
Expected: FAIL(route/スキーマ未実装)。

- [ ] **Step 3: スキーマを追加**

`src/lib/validators-sale-dm.ts` に追記:

```ts
export const saleDmAssignSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  order: z.enum(["sequential", "random"]).optional(),
  assignments: z
    .array(z.object({ recipientId: z.string().uuid(), variantId: z.string().uuid() }))
    .optional(),
});

export type SaleDmAssign = z.infer<typeof saleDmAssignSchema>;
```

- [ ] **Step 4: 割当 route を実装**

`src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmAssignSchema } from "@/lib/validators-sale-dm";
import { assignVariantsEvenly, applyManualAssignment } from "@/lib/sale-dm-letter/assign";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const body = saleDmAssignSchema.parse(await parseJsonBody(request));

    const [variants, recipients] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { id: "asc" } }),
    ]);

    if (variants.length === 0) {
      throw new ApiError(409, "割り当てる型がありません(先に型を作成してください)", "NO_VARIANTS");
    }

    const variantIds = variants.map((v) => v.id);
    const recipientIds = recipients.map((r) => r.id);

    const assignment =
      body.mode === "manual"
        ? applyManualAssignment(recipientIds, variantIds, body.assignments ?? [])
        : assignVariantsEvenly(recipientIds, variantIds, { order: body.order ?? "sequential" });

    // variantId ごとに recipient id をまとめ、型ごとに 1 回の updateMany で反映(N+1 回避)。
    const byVariant = new Map<string, string[]>();
    for (const [recipientId, variantId] of assignment) {
      const bucket = byVariant.get(variantId);
      if (bucket) bucket.push(recipientId);
      else byVariant.set(variantId, [recipientId]);
    }

    let assigned = 0;
    const perVariant: Record<string, number> = {};
    for (const [variantId, ids] of byVariant) {
      if (ids.length === 0) continue;
      const result = await prisma.dmRecipientDraft.updateMany({
        where: { id: { in: ids }, campaignId: id },
        data: { variantId },
      });
      assigned += result.count;
      perVariant[variantId] = result.count;
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_assign_variants",
      targetTable: "dm_recipient_drafts",
      detail: { campaignId: id, mode: body.mode, order: body.order ?? null, assigned, perVariant, assignedAt: new Date().toISOString() },
    });

    return NextResponse.json({ assigned, perVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-assign-route.test.ts`
Expected: PASS(auto 3 + manual 2)。

- [ ] **Step 6: コミット**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/assign" src/lib/validators-sale-dm.ts src/lib/__tests__/sale-dm-assign-route.test.ts
git commit -m "feat(sale-dm): add variant assignment route (auto even / random / manual)"
```

---

### Task 5: 個別上書き `overrideJson` の保存(PATCH drafts/[id] を拡張)

**Files:**
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/route.ts`(Plan 1 の PATCH を拡張: `variantId` の付け替え + `overrideJson` の保存に対応)
- Test: `src/lib/__tests__/sale-dm-draft-override-route.test.ts`(新規。Plan 1 の review-routes test は変更しない)

**Interfaces:**
- Consumes: `saleDmOptionsOverrideSchema`(Task 2)、`requireSaleDmAccess`、`prisma`。
- Produces: 拡張された PATCH(`{ body?, variantId?, override? }` を受ける)。

**規約:**
- Plan 1 の PATCH は `{ body }` のみ必須だった。これを `{ body?, variantId?, override? }` の**部分更新**に拡張する(3つとも任意・少なくとも1つ必要)。
- `variantId` 指定時は**当該 campaign 配下の型であること**を検証(他キャンペーンの型を割り当てさせない)。`override` は `saleDmOptionsOverrideSchema` で検証し `overrideJson` に保存(`null` で消去可)。
- **A/B 純度**: `variantId` の付け替え(=割当変更)は許すが、集計は割当られた `variantId` 基準のまま。`override` は本文の微修正用差分で**型の帰属を変えない**(集計には影響しない)。
- `body` は本文(PII)。レスポンスは `no-store`。AuditLog は非PIIメタ(更新フィールド名のみ・本文/override 内容は残さない)。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-draft-override-route.test.ts`(Task 3 と同じ `vi.mock` 流儀。prisma mock に `dmRecipientDraft.findUnique/update` と `dmVariant.findFirst` を持たせる):

```ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn() },
    dmVariant: { findFirst: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  dmVariant: { findFirst: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(keys.map((k) => ({ resource: k, action: "read", granted: true })));
const ctx = { params: Promise.resolve({ id: "r1" }) };
const patch = (b: unknown) => new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1" });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
});

describe("PATCH draft (拡張)", () => {
  it("body だけ更新できる(Plan 1 互換)", async () => {
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data.body).toBe("編集後");
  });

  it("override を保存できる", async () => {
    const res = await patchDraft(patch({ override: { tone: "soft" } }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data.overrideJson).toEqual({ tone: "soft" });
  });

  it("override: null で上書きを消去できる", async () => {
    const res = await patchDraft(patch({ override: null }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data.overrideJson).toBeNull();
  });

  it("variantId 付け替えは当該 campaign の型のみ許可(検証 OK で 200)", async () => {
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await patchDraft(patch({ variantId: "11111111-1111-1111-1111-111111111111" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.findFirst).toHaveBeenCalled();
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data.variantId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("他キャンペーンの variantId は 404/400(更新しない)", async () => {
    pm.dmVariant.findFirst.mockResolvedValue(null);
    const res = await patchDraft(patch({ variantId: "11111111-1111-1111-1111-111111111111" }) as never, ctx);
    expect([400, 404]).toContain(res.status);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("空 body(更新フィールドなし)で 400", async () => {
    const res = await patchDraft(patch({}) as never, ctx);
    expect(res.status).toBe(400);
  });

  it("存在しない draft で 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-draft-override-route.test.ts`
Expected: FAIL(Plan 1 の PATCH は `{ body }` 必須で override/variantId 未対応)。

- [ ] **Step 3: PATCH を拡張(Plan 1 のファイルを置き換え)**

`src/app/api/properties/sale-dm/drafts/[id]/route.ts` を次に置き換える(Plan 1 の `{ body }` 専用版を、部分更新版に拡張):

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmOptionsOverrideSchema } from "@/lib/validators-sale-dm";

// body / variantId / override の部分更新。最低1フィールドは必須。
const patchSchema = z
  .object({
    body: z.string().min(1).optional(),
    variantId: z.string().uuid().optional(),
    override: saleDmOptionsOverrideSchema.nullable().optional(),
  })
  .refine(
    (v) => v.body !== undefined || v.variantId !== undefined || v.override !== undefined,
    { message: "更新する項目がありません(body / variantId / override のいずれかが必要です)" },
  );

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const parsed = patchSchema.parse(await parseJsonBody(request));

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: { id: true, campaignId: true },
    });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    const data: {
      body?: string;
      variantId?: string;
      overrideJson?: z.infer<typeof saleDmOptionsOverrideSchema> | null;
    } = {};

    if (parsed.body !== undefined) data.body = parsed.body;

    if (parsed.variantId !== undefined) {
      // 付け替え先は同一 campaign の型に限る(他キャンペーンの型を割り当てさせない)。
      const variant = await prisma.dmVariant.findFirst({
        where: { id: parsed.variantId, campaignId: draft.campaignId },
        select: { id: true },
      });
      if (!variant) throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
      data.variantId = parsed.variantId;
    }

    // override は明示 null で消去、object で保存。undefined は不変。
    if (parsed.override !== undefined) data.overrideJson = parsed.override;

    const updated = await prisma.dmRecipientDraft.update({ where: { id }, data });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      // 非PII: 何を更新したかのキー名のみ(本文・override 内容は残さない)。
      detail: { campaignId: draft.campaignId, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ id: updated.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

> 注: Plan 1 の review-routes test(`sale-dm-review-routes.test.ts`)は `{ body: "編集後" }` の PATCH を検証している。本拡張は `body` 単独も引き続き 200 になる(後方互換)。Step 5 で Plan 1 のテストも再実行して緑を確認すること。`prisma` mock を持つ Plan 1 テスト側に `dmRecipientDraft.findUnique` が無い場合は、そのテストの prisma mock に `findUnique: vi.fn().mockResolvedValue({ id, campaignId: "c1" })` を追加する(Plan 1 のテストファイルを最小修正)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-draft-override-route.test.ts`
Expected: PASS(7 件)。

- [ ] **Step 5: Plan 1 の review-routes テストも緑を確認(後方互換)**

Run: `npx vitest run src/lib/__tests__/sale-dm-review-routes.test.ts`
Expected: PASS(必要なら prisma mock に `dmRecipientDraft.findUnique` を追加して緑にする)。

- [ ] **Step 6: コミット**

```bash
git add "src/app/api/properties/sale-dm/drafts/[id]/route.ts" src/lib/__tests__/sale-dm-draft-override-route.test.ts src/lib/__tests__/sale-dm-review-routes.test.ts
git commit -m "feat(sale-dm): extend draft PATCH for variant reassignment + override save"
```

---

### Task 6: 生成 / 再生成を「割り当てられた型 + 個別上書き」で動かす連携

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/route.ts`(生成 route: 既定型1つ前提を「型が0件なら既定A型を作る・既定型へ均等割り」へ一般化。**複数型の作り分けは Task 3 の variant CRUD で行い、生成 route は割当済み variant を使う前提に拡張**)
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts`(再生成: variant 設定 + `overrideJson` を `resolveDraftOptions` で合成して使う)
- Test: `src/lib/__tests__/sale-dm-regenerate-override-route.test.ts`(再生成が override を反映することを検証)

**Interfaces:**
- Consumes: `resolveDraftOptions`(Task 2)、`generateLetters`(Plan 1)、`assignVariantsEvenly`(Task 1)。
- Produces: 生成 route の「型1つ前提」を「型 N の均等割り」に拡張する方針の実装。再生成が override 反映。

**生成 route の複数型対応方針(設計の明記):**
- Plan 1 の生成 route は「キャンペーン作成時に label="A" の既定型を1つ作り、全宛先をその型に割り当てる」。本タスクではこれを次に一般化する:
  1. キャンペーン作成時、**body.options から既定型 A を1つ作る**点は維持(初期状態で必ず1型ある=後で `assign` できる)。
  2. 生成は**型ごとの設定を使う**よう、宛先ごとに `assignVariantsEvenly(recipientIds, [variantA.id])`(初期は1型)で割り当て、各下書きへ `variantId` を保存(Plan 1 で既に variantA を全件に付けているので**挙動は不変**=この時点ではリファクタのみ)。
  3. **追加の型(B/C)と再割当は Task 3(variant CRUD)+ Task 4(assign)で行う。** 生成 route 自体は「初期1型・均等割り済み」を保証するだけにとどめ、複数型生成の責務を持たない(YAGNI: 初版は「作成→型追加→割当→再生成」の流れで複数型に対応)。
- したがって生成 route の変更は**最小**(既存の variant 作成 + 全件割当をそのまま維持。コメントで「複数型は variants/assign route 経由」と明記)。**新規の振る舞い変更が無いなら、この Task では生成 route を実質変更しない**(コメント追記のみ)。判断: 生成 route に手を入れる必要があるのは「再生成が override/variant を見る」点のみ。

- [ ] **Step 1: 再生成が override を反映するテストを書く(失敗)**

`src/lib/__tests__/sale-dm-regenerate-override-route.test.ts`:

```ts
import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async () => ({})),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn() } },
}));
// generateLetters を spy して、resolveDraftOptions の結果(override 反映済み options)が渡ることを検証する。
const generateSpy = vi.fn(async () => ({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false }));
vi.mock("@/lib/sale-dm-letter", () => ({
  generateLetters: (...args: unknown[]) => generateSpy(...args),
  isSaleDmConfigured: () => true,
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST as regenerate } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(keys.map((k) => ({ resource: k, action: "read", granted: true })));
const ctx = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1", body: "再生成本文" });
});

describe("POST regenerate (override 反映)", () => {
  it("variant 設定に overrideJson を merge した options で生成する", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", recipientName: "田中 一郎", honorific: "様",
      overrideJson: { tone: "soft" },
      variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    });
    const res = await regenerate(new Request("http://x", { method: "POST" }) as never, ctx);
    expect(res.status).toBe(200);
    const passed = generateSpy.mock.calls[0][0] as { recipient: unknown; options: { tone: string; appeal: string } }[];
    // override の tone=soft が反映され、未指定 appeal は variant の price のまま
    expect(passed[0].options.tone).toBe("soft");
    expect(passed[0].options.appeal).toBe("price");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-regenerate-override-route.test.ts`
Expected: FAIL(Plan 1 の再生成は variant 設定のみで override を見ない)。

- [ ] **Step 3: 再生成 route を override 対応に修正**

`src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts` の生成 options 構築部を `resolveDraftOptions` 経由に置き換える。`findUnique` の `include` に `overrideJson` が含まれるよう(`select` を使っている場合は `overrideJson: true` を追加)し、options を次のように作る:

```ts
import { resolveDraftOptions } from "@/lib/sale-dm-letter/override";
import { resolveSender } from "@/lib/sale-dm-letter/recipients"; // Plan 1 の sender 既定ヘルパ(env 既定)。無ければ下記注を参照。

// ... requireSaleDmAccess / isSaleDmConfigured / findUnique(draft) は Plan 1 のまま ...
// draft は { recipientName, honorific, overrideJson, variant: {...}, property: { address, propertyType, roomNo } } を含む。

const options = resolveDraftOptions(
  {
    designTemplate: draft.variant.designTemplate,
    tone: draft.variant.tone,
    length: draft.variant.length,
    appeal: draft.variant.appeal,
    strength: draft.variant.strength,
    extraInstruction: draft.variant.extraInstruction,
  },
  draft.overrideJson as Parameters<typeof resolveDraftOptions>[1],
  resolveSender(),
);

const { drafts } = await generateLetters([
  {
    recipient: {
      representativeName: draft.recipientName,
      honorific: draft.honorific,
      coOwnerCount: 1,
      propertyAddress: draft.property.address,
      propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType,
      roomNo: draft.property.roomNo,
    },
    options,
  },
]);
```

> 注(sender の扱い): Plan 1 Task 7 のメモで `resolveSender()`(env `SALE_DM_SENDER_NAME`/`SALE_DM_SENDER_CONTACT` 既定を読む小ヘルパ)を `recipients.ts` 隣に置く方針が示されている。**もし Plan 1 で `resolveSender` が未実装なら、本タスクで `src/lib/sale-dm-letter/recipients.ts` に次を追加する**(DRY・生成 route も将来これを使う):
>
> ```ts
> export function resolveSender(): { senderName: string; senderContact: string } {
>   return {
>     senderName: process.env.SALE_DM_SENDER_NAME ?? "（差出人名・未設定）",
>     senderContact: process.env.SALE_DM_SENDER_CONTACT ?? "",
>   };
> }
> ```
>
> その場合 Global Constraints の env に `SALE_DM_SENDER_NAME`/`SALE_DM_SENDER_CONTACT`(任意)を追記する旨をコミットメッセージに記す。`findUnique` の `include: { variant: true }` を使えば `overrideJson` は draft 本体の列として既に取得される(別途 select 追加不要)。明示 `select` を使っている場合のみ `overrideJson: true` を足す。

- [ ] **Step 4: 生成 route のコメント追記(複数型対応の方針を明示)**

`src/app/api/properties/sale-dm/campaigns/route.ts` の variant 作成箇所付近に、振る舞いを変えないコメントを追加:

```ts
// 初期型 A を1つ作り全宛先に割り当てる。複数型(B/C)の追加と再割当は
// POST /campaigns/[id]/variants(型 CRUD)+ POST /campaigns/[id]/assign(割当)で行う。
// 生成 route は「初期1型・均等割り済み」を保証するのみ(A/B 純度は variantId 基準)。
```

(振る舞い変更なし=テスト不要。コミットに含める。)

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-regenerate-override-route.test.ts`
Expected: PASS(1 件)。

- [ ] **Step 6: コミット**

```bash
git add "src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts" "src/app/api/properties/sale-dm/campaigns/route.ts" src/lib/sale-dm-letter/recipients.ts src/lib/__tests__/sale-dm-regenerate-override-route.test.ts
git commit -m "feat(sale-dm): regenerate uses assigned variant + per-draft override"
```

---

### Task 7: 全体検証(テスト + lint + build)

**Files:** なし(検証のみ)

- [ ] **Step 1: 全テスト**

Run: `npm test`
Expected: 既存 + 本プラン新規(assign 11 / override 8 / variants route 8 / assign route 5 / draft override route 7 / regenerate override 1)すべて green。Plan 1 のテストも緑のまま。

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: エラーなし。

- [ ] **Step 3: build**

Run: `npm run build`
Expected: 成功。新 route(`variants` / `variants/[variantId]` / `assign`)が manifest に出る。Task 3 注の Prisma 複合 where が型エラーなら `updateMany`/`deleteMany` 版へ切替済みであること。

- [ ] **Step 4: コミット(必要なら)**

```bash
git add -A
git commit -m "test(sale-dm): A/B variants + assignment + override green (lint/build pass)"
```

---

## Self-Review(本プラン → 設計書 / Plan 1 の突合)

- **(a) 型 CRUD**: Task 3 で `GET/POST/PATCH/DELETE variants` を実装。設定一式は `saleDmOptionsSchema` を `omit(sender).partial()` で再利用(DRY)。削除は割当済みドラフトがあれば 409(A/B 純度保護)✅
- **(b) 割当**: Task 1 純関数 `assignVariantsEvenly`(sequential=ラウンドロビン端数明確 / random=分布均等・並びのみシャッフル・rng 注入で決定化)+ `applyManualAssignment`(均等ベース + 手動上書き・不正 id 無視)。Task 4 route `POST assign`(型ごと updateMany で N+1 回避・型0件 409)✅
- **(c) 個別上書き `overrideJson`**: Task 2 `resolveDraftOptions`(allowlist shallow merge・sender 不変・null 正規化)+ `saleDmOptionsOverrideSchema`。Task 5 PATCH 拡張(body/variantId/override 部分更新・variantId は同一 campaign のみ・override 内容は AuditLog 非記録)。集計は variantId 基準を維持 ✅
- **(d) 生成/再生成の連携**: Task 6 で再生成が `resolveDraftOptions(variant, overrideJson, sender)` を使い override 反映。生成 route は「初期1型・均等割り済み」を保証するのみで複数型は variants+assign 経由(YAGNI・振る舞い不変)✅
- **権限/PII/no-store/AuditLog 非PII**: 全 route で `requireSaleDmAccess()`・PII レスポンス `no-store`・AuditLog は件数/フィールド名/mode 等の非PIIメタのみ ✅
- **既存シグネチャ整合**: `getUserPermissions`→`PermissionEntry[]`(grant ヘルパは配列で mock)・`hasPermission(perm, res, act)`・`parseJsonBody`・`requireSaleDmAccess` 戻り `{session,...}`・Plan 1 の `LetterOptions`/`GeneratedDraft`/`generateLetters` を再利用 ✅
- **raw SQL なし / 新規依存なし / TDD / 専用 worktree / branch=feat/sale-dm-letter-assist** ✅
- **スコープ外(後続)**: 配達/反響/宛先不明連動/集計(P4)・LP/`/t/[token]`/proxy.ts(P5)・UI 作業画面(P6)・デザイン/印刷/CSV(P2)。本プランは型の複数化と割当・個別上書きまで ✅
- **Placeholder スキャン**: なし(各 step に実コード/実コマンド)。Task 3 の Prisma 複合 where と Task 6 の `resolveSender` 有無は「ビルドで確認し代替実装へ切替」と明示済み(TODO ではなく分岐指示)✅
- **実装時確認点(レビュアー向け)**: (1) Plan 1 の `saleDmOptionsSchema` が `z.object` で `.omit/.partial` 可能なこと。(2) Plan 1 の再生成 route が `include: { variant: true }` で draft 本体の `overrideJson` を取得していること(明示 select なら `overrideJson: true` 追加)。(3) Plan 1 で `resolveSender` 未実装なら Task 6 で `recipients.ts` に追加し env 2件を追記。(4) Prisma の unique `where` への `campaignId` 併記が型 OK か(NG なら updateMany/deleteMany 版)。
