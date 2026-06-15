# 法人番号 混入除去(local cleanup)実装 Plan (21-D タスク11 / P1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 法人所有者の `name` / `address` / `note` に混入した 13桁法人番号を、**NTA非依存**で「該当列(空きのみ)へ移送 + 文字列から除去」する preview→確定(明示apply)フローを新設し、本番NTA未設定でも混入を解消できるようにする(タスク11の G1 解消)。

**Architecture:** 純関数(検出済み番号を文字列から除去する `removeCorporateNumbersFromText` を既存 `corporate-number.ts` に additive 追加 + 除去/移送/空化ガードを判定する新lib `corporate-number-cleanup.ts`)→ preview(GET dry-run)/apply(POST 明示確定)の2 route → 管理者の所有者詳細に導線パネル。既存 `corporate-apply` の安全規律(owner:write + field-level write + display-level raw-visible gate + version 楽観ロック + 確定必須 + AuditLog 非PII)を踏襲。`decideCorporateImport`(none/save/noop/multi/conflict)を移送判定の単一 source として再利用。

**Tech Stack:** Next.js App Router(route handler / RSC+client component)/ Prisma / Zod / Vitest / React Testing Library。

---

## 確定スコープ・製品既定(ユーザー承認 2026-06-13)

- **スコープ = P1 のみ**。P2(prefill+一括)/ P3(NTA社名検索=別承認)/ P4(テスト補強)は**据え置き**(本Planに含めない)。
- **製品既定**:
  - 除去した番号は **空き `corporateNumber` 列のみ移送**(`decideCorporateImport` の `action="save"` のときだけ)。
  - **conflict 時(既存列と別番号が混入)は移送せず、混入文字列の除去のみ**。
  - **multi 時(複数番号検出)は手動フラグ**(自動除去/移送しない)。
  - **空化ガード**: 除去すると `name` が(非空→)空になる行は **除去せず手動フラグ**(`address`/`note` は空になったら null 化=許容)。
- **安全規律(corporate-apply 踏襲)**: `owner:write` + 変更フィールドの field-level `hasExplicitWritePerm` + display-level raw-visible gate(masked/partial/hidden 由来は検出・除去しない=bypass防止)+ `version` 楽観ロック + 明示 apply(自動上書き禁止)+ AuditLog 非PII。
- **NTA 非依存**(env 不要・fail-closed 対象外)。

## 衝突回避(厳守)

- **新規ファイル主体**。既存編集は以下の**最小・additive のみ**:
  1. `src/lib/corporate-number.ts` — 純関数 `removeCorporateNumbersFromText` を **1つ追加**(既存 regex を同一ファイル内で再利用・既存 export/挙動は不変)。
  2. `src/app/(dashboard)/admin/owners/[id]/page.tsx` — クリーンアップ・パネルの **マウント追加**(additive)。
- **`src/lib/api-helpers.ts` は編集しない**(`getApiSession`/`getUserPermissions`/`getOwnerDisplayConfig`/`hasExplicitWritePerm`/`maskValue` は **import のみ**)。→ **タスク24(F6 perf)非衝突**。
- **schema / migration / env / package.json / package-lock.json 変更なし**。既存 `name/address/note/corporateNumber/version` 列のみ利用。
- worktree `feat/corporate-number-cleanup`・base `b792b64`。
- もし上記以外の既存ファイル編集が必要になったら**実装を止めて報告**する。

## File Structure

| ファイル | 役割 | 操作 |
|---|---|---|
| `src/lib/corporate-number.ts` | `removeCorporateNumbersFromText`(検出済み番号を name/address/note から除去・整形) | **既存に additive 追加** |
| `src/lib/corporate-number-cleanup.ts` | `decideOwnerCorporateCleanup`(除去/移送/空化ガード/手動フラグ判定の純関数) | **新規** |
| `src/app/api/owners/[id]/corporate-cleanup/route.ts` | `GET`=preview(dry-run) / `POST`=apply(明示確定) | **新規** |
| `src/components/owners/corporate-cleanup-panel.tsx` | 混入除去パネル(preview→確定 UI・lookup panel と併存) | **新規** |
| `src/app/(dashboard)/admin/owners/[id]/page.tsx` | パネルのマウント | **既存に additive 追加** |
| `src/lib/__tests__/corporate-number-cleanup.test.ts` | `decideOwnerCorporateCleanup` 単体 | **新規** |
| `src/lib/__tests__/corporate-number-remove.test.ts` | `removeCorporateNumbersFromText` 単体 | **新規** |
| `src/lib/__tests__/corporate-cleanup-route.test.ts` | preview/apply route 統合 | **新規** |
| `src/lib/__tests__/corporate-cleanup-ui.test.ts` | パネル UI | **新規** |

import のみの既存ファイル(無改変): `@/lib/api-helpers`, `@/lib/permissions`, `@/lib/audit`, `@/lib/change-log`, `@/lib/property-field-constants`(OWNER_TRACKED_FIELDS), `@/lib/owner-corporate-import`(decideCorporateImport), `@/lib/display-level`(maskCorporateNumber), `@/lib/prisma`。

## preview / apply 契約

### `GET /api/owners/[id]/corporate-cleanup`(preview・DB 無変更)
- **権限**: `owner:read`。`owner_corporate_number` 表示レベルが `hidden` → 403。
- **raw-visible gate**: `name`/`address`/`note` のうち表示レベルが raw-visible(full/read/edit)のフィールドのみ検出・除去対象に渡す(classify と同方針)。
- **レスポンス**(PII はマスク):
  ```jsonc
  {
    "cleanup": {
      "action": "none" | "cleanup" | "manual",
      "manualReason": "multi" | "name_would_be_empty" | null,
      "importAction": "none" | "save" | "noop" | "multi" | "conflict",
      "detectedIn": ["name" | "address" | "note"],
      "changedFields": ["name" | "address" | "note" | "corporateNumber"],
      "version": 3,
      // 変更プレビュー(表示レベルに従いマスク。raw-visible のみ意味を持つ)
      "before": { "nameMasked": "...", "addressMasked": "...", "noteMasked": "..." },
      "after":  { "nameMasked": "...", "addressMasked": "...", "noteMasked": "..." },
      "corporateNumberToSetMasked": "1234***" | null
    }
  }
  ```
- **AuditLog**: `action="owner_corporate_cleanup_preview"`・detail = `{ action, manualReason, importAction, detectedInCount, changedFieldsCount }`(生値・会社名・住所・番号は入れない)。
- **archived owner** → 404。

### `POST /api/owners/[id]/corporate-cleanup`(apply・明示確定)
- **権限**: `owner:write` + 変更する各フィールドの field-level `hasExplicitWritePerm`(`name`→`owner_name` / `address`→`owner_address` / `note`→`owner_note` / `corporateNumber`→`owner_corporate_number`)。
- **body**:
  ```jsonc
  { "version": 3, "apply": { "name": true, "address": false, "note": false, "corporateNumber": true } }
  ```
  `apply` の各 true は **サーバ再計算した `changedFields` の部分集合**でなければならない。
- **サーバ再計算**: owner を取得し raw-visible gate 後 `decideOwnerCorporateCleanup` を再実行(client 値を信用しない)。
  - `action !== "cleanup"`(none/manual)→ **409 `CLEANUP_NOT_AVAILABLE`**。
  - `apply` が全 false → 400。`apply` の true が `changedFields` に含まれない → 400 `APPLY_FIELD_MISMATCH`。
- **更新**: `prisma.owner.updateMany({ where: { id, version }, data: { ...選択フィールドの cleaned 値, version: { increment: 1 } } })`。`count===0` → 409 `CONFLICT`(楽観ロック=staleness 兼用)。
- `recordChanges`(OWNER_TRACKED_FIELDS)+ AuditLog `action="owner_corporate_cleanup_apply"`・detail = `{ applied, importAction, result, httpStatus }`(非PII)。
- **レスポンス**: `{ ok: true, owner: { id, version } }`(PII 返さない)。

### エッジ期待値(decideOwnerCorporateCleanup)

| ケース | importAction | action | corporateNumberToSet | name/address/note |
|---|---|---|---|---|
| 検出なし | none | `none` | null | 変更なし |
| 列空・1候補(name に混入) | save | `cleanup` | 候補13桁 | name から番号除去 |
| 列=候補と同一(text にも混入) | noop | `cleanup` | null(列は既に保持) | text から番号除去 |
| 列=別番号・text に別番号混入 | conflict | `cleanup` | null(移送しない) | text から検出番号のみ除去 |
| 複数番号検出 | multi | `manual`(multi) | null | 変更なし |
| 除去すると name が空 | save/noop/conflict | `manual`(name_would_be_empty) | null | 変更なし |

---

## Task 1: `removeCorporateNumbersFromText`(corporate-number.ts に additive)

**Files:**
- Modify: `src/lib/corporate-number.ts`(末尾に export 関数を1つ追加。既存 regex `LABELED_CORPORATE_NUMBER_RE`/`BARE_CORPORATE_NUMBER_RE`/`normalizeCorporateNumber` を同一ファイル内で再利用)
- Test: `src/lib/__tests__/corporate-number-remove.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/corporate-number-remove.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { removeCorporateNumbersFromText } from "../corporate-number";

const N = "1234567890123";

describe("removeCorporateNumbersFromText", () => {
  it("裸13桁を除去し前後の余白を整える", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [N])).toBe("株式会社○○");
  });
  it("ラベル付き(ラベル+区切り+番号)をまとめて除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ 法人番号:${N} 備考`, [N])).toBe(
      "株式会社○○ 備考",
    );
  });
  it("全角数字の混入も除去(normalize一致)", () => {
    expect(removeCorporateNumbersFromText("株式会社○○ １２３４５６７８９０１２３", [N])).toBe(
      "株式会社○○",
    );
  });
  it("ラベル付きハイフン区切りも除去", () => {
    expect(removeCorporateNumbersFromText(`法人番号: 1234-56-7890123`, [N])).toBe("");
  });
  it("対象外の番号は残す(部分削除)", () => {
    // 9999999999999 は対象外
    expect(removeCorporateNumbersFromText(`${N} 9999999999999`, [N])).toBe("9999999999999");
  });
  it("先頭/末尾の孤立区切りを除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○、${N}`, [N])).toBe("株式会社○○");
  });
  it("numbers が空なら入力をそのまま返す", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [])).toBe(`株式会社○○ ${N}`);
  });
  it("null 入力は null", () => {
    expect(removeCorporateNumbersFromText(null, [N])).toBeNull();
    expect(removeCorporateNumbersFromText(undefined, [N])).toBeNull();
  });
  it("番号のみの文字列は空文字になる", () => {
    expect(removeCorporateNumbersFromText(N, [N])).toBe("");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd ../property-management-worktrees/corporate-number-cleanup && npx vitest run src/lib/__tests__/corporate-number-remove.test.ts`
Expected: FAIL(`removeCorporateNumbersFromText` is not exported / not a function)

- [ ] **Step 3: 最小実装を書く**

`src/lib/corporate-number.ts` の**末尾**に追加(既存コードは一切変更しない):

```typescript
/**
 * tidy: 除去後の文字列を整える。
 *  - 連続する空白(半角/全角/タブ)を半角1つへ畳む
 *  - 先頭/末尾の孤立した区切り(、,／/・)と周囲の空白を除去
 *  - 前後 trim
 */
function tidyAfterCorporateRemoval(s: string): string {
  let r = s.replace(/[ 　\t]+/g, " ");
  r = r.replace(/^\s*[、,／/・]\s*/u, "");
  r = r.replace(/\s*[、,／/・]\s*$/u, "");
  return r.trim();
}

/**
 * テキストから「指定した 13桁法人番号」の混入を除去する。
 *  - ラベル付き(法人番号: など)はラベルごと、裸 13桁はその数列を除去する。
 *  - 除去対象は normalize 後の値が numbersToRemove に含まれるものだけ
 *    (extractCorporateNumbersFromText と同じ regex を使うため検出と除去の対象が一致する)。
 *  - 除去後は tidyAfterCorporateRemoval で空白・孤立区切りを整える。
 *  - input が null/undefined → null。numbersToRemove が空 → input をそのまま返す。
 */
export function removeCorporateNumbersFromText(
  input: string | null | undefined,
  numbersToRemove: string[],
): string | null {
  if (input == null) return null;
  if (numbersToRemove.length === 0) return input;
  const targets = new Set(numbersToRemove);

  // 1. ラベル付き(ラベル+区切り+番号)を除去
  let result = input.replace(LABELED_CORPORATE_NUMBER_RE, (full, num: string) => {
    const normalized = normalizeCorporateNumber(num);
    return normalized && targets.has(normalized) ? "" : full;
  });
  // 2. 裸 13桁を除去
  result = result.replace(BARE_CORPORATE_NUMBER_RE, (full, num: string) => {
    const normalized = normalizeCorporateNumber(num);
    return normalized && targets.has(normalized) ? "" : full;
  });
  return tidyAfterCorporateRemoval(result);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/corporate-number-remove.test.ts`
Expected: PASS(全 9 ケース)。
**注意**: 既存 `src/lib/__tests__/corporate-number.test.ts` も実行し、回帰がないこと(既存 export 無改変)を確認: `npx vitest run src/lib/__tests__/corporate-number.test.ts`

- [ ] **Step 5: コミット**

```bash
git add src/lib/corporate-number.ts src/lib/__tests__/corporate-number-remove.test.ts
git commit -m "feat(corporate-cleanup): add removeCorporateNumbersFromText pure helper"
```

---

## Task 2: `decideOwnerCorporateCleanup`(新lib)

**Files:**
- Create: `src/lib/corporate-number-cleanup.ts`
- Test: `src/lib/__tests__/corporate-number-cleanup.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/corporate-number-cleanup.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decideOwnerCorporateCleanup } from "../corporate-number-cleanup";

const N = "1234567890123";
const M = "9876543210987";

describe("decideOwnerCorporateCleanup", () => {
  it("検出なし → action none", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
  });

  it("列空・name に1候補 → cleanup・列へ移送・name除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("save");
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name", "corporateNumber"]);
  });

  it("列=候補と同一・text にも混入 → cleanup・移送なし・text除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: N });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("noop");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("列=別番号・text に別番号混入(conflict)→ cleanup・移送なし・検出番号のみ除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: M });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("conflict");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("複数番号検出 → manual(multi)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: `${N} ${M}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("multi");
    expect(p.changedFields).toEqual([]);
  });

  it("空化ガード: name が番号のみ → manual(name_would_be_empty)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: N, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("name_would_be_empty");
    expect(p.changedFields).toEqual([]);
  });

  it("address に混入 → address除去・空になれば null 化", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: N, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBeNull(); // 番号のみの住所は除去で空→null
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.changedFields).toEqual(["address", "corporateNumber"]);
  });

  it("raw-visible でないフィールドは呼び出し側で null を渡す前提(note=null は検出されない)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/__tests__/corporate-number-cleanup.test.ts`
Expected: FAIL(`Cannot find module '../corporate-number-cleanup'`)

- [ ] **Step 3: 最小実装を書く**

`src/lib/corporate-number-cleanup.ts`:

```typescript
// 法人番号の混入除去(local cleanup)判定の純関数(I/O なし)。
//
// 製品既定(21-D タスク11 / P1):
//  - 除去番号は decideCorporateImport の action="save"(列が空・1候補)のときだけ列へ移送する。
//  - noop(列=候補)/ conflict(列=別番号)は移送せず、混入文字列の除去のみ。
//  - multi(複数候補)は手動フラグ(自動除去/移送しない)。
//  - 空化ガード: 除去で name が(非空→)空になる行は手動フラグ(除去しない)。
//    address / note が空になる場合は null 化(nullable のため許容)。
//
// raw-visible gate は route 側で行う(検出させたくないフィールドは null を渡す)。
import {
  detectCorporateNumberInOwnerLike,
  removeCorporateNumbersFromText,
} from "./corporate-number";
import {
  decideCorporateImport,
  type CorporateImportAction,
} from "./owner-corporate-import";

export type CorporateCleanupAction = "none" | "cleanup" | "manual";
export type CorporateCleanupManualReason = "multi" | "name_would_be_empty" | null;

export interface OwnerCleanupInput {
  name: string | null;
  address: string | null;
  note: string | null;
  corporateNumber: string | null;
}

export interface CorporateCleanupProposal {
  action: CorporateCleanupAction;
  manualReason: CorporateCleanupManualReason;
  importAction: CorporateImportAction;
  detectedIn: Array<"name" | "address" | "note">;
  cleanedName: string | null;
  cleanedAddress: string | null;
  cleanedNote: string | null;
  corporateNumberToSet: string | null;
  changedFields: Array<"name" | "address" | "note" | "corporateNumber">;
}

function emptyToNull(s: string | null): string | null {
  if (s == null) return null;
  return s.trim() === "" ? null : s;
}

export function decideOwnerCorporateCleanup(
  owner: OwnerCleanupInput,
): CorporateCleanupProposal {
  const detect = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  const importDecision = decideCorporateImport(
    { name: owner.name, address: owner.address, note: owner.note },
    owner.corporateNumber,
  );

  const unchanged: CorporateCleanupProposal = {
    action: "none",
    manualReason: null,
    importAction: importDecision.action,
    detectedIn: detect.detectedIn,
    cleanedName: owner.name,
    cleanedAddress: owner.address,
    cleanedNote: owner.note,
    corporateNumberToSet: null,
    changedFields: [],
  };

  if (detect.candidates.length === 0) return unchanged;
  if (importDecision.action === "multi") {
    return { ...unchanged, action: "manual", manualReason: "multi" };
  }

  // 除去対象: save/noop は採用候補、conflict は検出された候補(列値とは別)
  const numbersToRemove =
    importDecision.action === "conflict"
      ? detect.candidates
      : [importDecision.corporateNumber as string];

  const cleanedName = removeCorporateNumbersFromText(owner.name, numbersToRemove);
  const cleanedAddress = emptyToNull(
    removeCorporateNumbersFromText(owner.address, numbersToRemove),
  );
  const cleanedNote = emptyToNull(
    removeCorporateNumbersFromText(owner.note, numbersToRemove),
  );

  // 空化ガード(name のみ)
  const nameWasNonEmpty = (owner.name ?? "").trim() !== "";
  const nameWouldBeEmpty = nameWasNonEmpty && (cleanedName ?? "").trim() === "";
  if (nameWouldBeEmpty) {
    return { ...unchanged, action: "manual", manualReason: "name_would_be_empty" };
  }

  const corporateNumberToSet =
    importDecision.action === "save" ? importDecision.corporateNumber : null;

  const changedFields: CorporateCleanupProposal["changedFields"] = [];
  if (cleanedName !== owner.name) changedFields.push("name");
  if (cleanedAddress !== owner.address) changedFields.push("address");
  if (cleanedNote !== owner.note) changedFields.push("note");
  if (corporateNumberToSet !== null) changedFields.push("corporateNumber");

  if (changedFields.length === 0) return unchanged;

  return {
    action: "cleanup",
    manualReason: null,
    importAction: importDecision.action,
    detectedIn: detect.detectedIn,
    cleanedName,
    cleanedAddress,
    cleanedNote,
    corporateNumberToSet,
    changedFields,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/corporate-number-cleanup.test.ts`
Expected: PASS(全 8 ケース)

- [ ] **Step 5: コミット**

```bash
git add src/lib/corporate-number-cleanup.ts src/lib/__tests__/corporate-number-cleanup.test.ts
git commit -m "feat(corporate-cleanup): add decideOwnerCorporateCleanup decision helper"
```

---

## Task 3: preview/apply route

**Files:**
- Create: `src/app/api/owners/[id]/corporate-cleanup/route.ts`
- Test: `src/lib/__tests__/corporate-cleanup-route.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/corporate-cleanup-route.test.ts`(主要ケース。mock 方針は corporate-candidate/corporate-apply テストと同型):

```typescript
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    apiResponse: (data: unknown, status = 200) => Response.json(data, { status }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      return Response.json({ error: { message: "Server error", code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn(), OWNER_TRACKED_FIELDS: ["name", "address", "note", "corporateNumber"] }));
vi.mock("@/lib/prisma", () => ({ default: { owner: { findUnique: vi.fn(), updateMany: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import { GET, POST } from "../../app/api/owners/[id]/corporate-cleanup/route";

const pm = prisma as unknown as { owner: { findUnique: Mock; updateMany: Mock } };
const N = "1234567890123";

const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "edit", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
  { resource: "owner_corporate_number", action: "edit", granted: true },
];
const FULL_DISPLAY = { name: "full", nameKana: "full", phone: "full", zip: "full", address: "full", note: "full", email: "full", corporateNumber: "full" };

function ctx(id = "o1") { return { params: Promise.resolve({ id }) }; }
function getReq() { return new Request("http://localhost/api/owners/o1/corporate-cleanup") as any; }
function postReq(body: unknown) { return new Request("http://localhost/api/owners/o1/corporate-cleanup", { method: "POST", body: JSON.stringify(body) }) as any; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({ id: "u1", email: "a@a", name: "A", role: "admin" });
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY);
  pm.owner.findUnique.mockResolvedValue({ id: "o1", name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: null, version: 2, isArchived: false });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/owners/[id]/corporate-cleanup (preview)", () => {
  it("検出ありで action=cleanup・changedFields・version を返す(DB無変更)", async () => {
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.action).toBe("cleanup");
    expect(body.cleanup.importAction).toBe("save");
    expect(body.cleanup.changedFields).toContain("name");
    expect(body.cleanup.changedFields).toContain("corporateNumber");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_corporate_number=hidden は 403", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, corporateNumber: "hidden" });
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(403);
  });

  it("owner:read 欠如は 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => !(p.resource === "owner" && p.action === "read")));
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });

  it("archived owner は 404", async () => {
    pm.owner.findUnique.mockResolvedValue({ id: "o1", name: "x", address: null, note: null, corporateNumber: null, version: 1, isArchived: true });
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(404);
  });

  it("raw-visible でない name は検出対象外(action=none)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, name: "masked" });
    const res = await GET(getReq(), ctx());
    const body = await res.json();
    expect(body.cleanup.action).toBe("none"); // name に番号があっても masked では検出しない
  });

  it("AuditLog に PII を残さない", async () => {
    await GET(getReq(), ctx());
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as any;
    expect(audit.action).toBe("owner_corporate_cleanup_preview");
    const s = JSON.stringify(audit.detail);
    expect(s).not.toContain(N);
    expect(s).not.toContain("株式会社○○");
  });
});

describe("POST /api/owners/[id]/corporate-cleanup (apply)", () => {
  it("name+corporateNumber を確定し version 楽観ロックで更新", async () => {
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.owner.version).toBe(3);
    const call = pm.owner.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "o1", version: 2 });
    expect(call.data.name).toBe("株式会社○○");
    expect(call.data.corporateNumber).toBe(N);
    expect(call.data.version).toEqual({ increment: 1 });
    expect(recordChanges).toHaveBeenCalled();
  });

  it("owner:write 欠如は 403(更新なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => !(p.resource === "owner" && p.action === "write")));
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_name field-level write 欠如で name 適用は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL.filter((p) => p.resource !== "owner_name"));
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version 不一致は 409 CONFLICT", async () => {
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postReq({ version: 1, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("manual(空化ガード)は 409 CLEANUP_NOT_AVAILABLE", async () => {
    pm.owner.findUnique.mockResolvedValue({ id: "o1", name: N, address: null, note: null, corporateNumber: null, version: 2, isArchived: false });
    const res = await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CLEANUP_NOT_AVAILABLE");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("apply が changedFields に無いフィールドを指定したら 400", async () => {
    // proposal.changedFields は [name, corporateNumber] のみ。address=true は不整合。
    const res = await POST(postReq({ version: 2, apply: { name: false, address: true, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("APPLY_FIELD_MISMATCH");
  });

  it("apply 全 false は 400", async () => {
    const res = await POST(postReq({ version: 2, apply: { name: false, address: false, note: false, corporateNumber: false } }), ctx());
    expect(res.status).toBe(400);
  });

  it("AuditLog に PII を残さない", async () => {
    await POST(postReq({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } }), ctx());
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as any;
    expect(audit.action).toBe("owner_corporate_cleanup_apply");
    const s = JSON.stringify(audit.detail);
    expect(s).not.toContain(N);
    expect(s).not.toContain("株式会社○○");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/__tests__/corporate-cleanup-route.test.ts`
Expected: FAIL(`Cannot find module '../../app/api/owners/[id]/corporate-cleanup/route'`)

- [ ] **Step 3: route 実装を書く**

`src/app/api/owners/[id]/corporate-cleanup/route.ts`:

```typescript
// GET  /api/owners/[id]/corporate-cleanup  … preview(dry-run・DB 無変更)
// POST /api/owners/[id]/corporate-cleanup  … apply(明示確定)
//
// 設計上の不変条件(corporate-apply 踏襲):
// - 自動上書きしない(POST で apply.* を明示)。サーバ側で proposal を再計算し client 値を信用しない。
// - owner:write + 変更フィールドの field-level write(hasExplicitWritePerm)を厳格に要求。
// - display-level raw-visible(full/read/edit)のフィールドのみ検出・除去対象に渡す(bypass 防止)。
// - version 楽観ロック(staleness 兼用)。
// - AuditLog detail に法人番号生値・会社名・住所・note 本文を一切含めない。
import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm, maskValue } from "@/lib/permissions";
import { maskCorporateNumber } from "@/lib/display-level";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import {
  decideOwnerCorporateCleanup,
  type OwnerCleanupInput,
} from "@/lib/corporate-number-cleanup";

type Level = "hidden" | "masked" | "partial" | "full" | "read" | "edit";
function isRawVisible(level: Level): boolean {
  return level === "full" || level === "read" || level === "edit";
}

// raw-visible のフィールドだけ検出入力に渡す(masked/partial/hidden は null)。
function gatedInput(
  owner: { name: string; address: string | null; note: string | null; corporateNumber: string | null },
  cfg: { name: Level; address: Level; note: Level },
): OwnerCleanupInput {
  return {
    name: isRawVisible(cfg.name) ? owner.name : null,
    address: isRawVisible(cfg.address) ? owner.address : null,
    note: isRawVisible(cfg.note) ? owner.note : null,
    corporateNumber: owner.corporateNumber,
  };
}

function maskCnToSet(value: string | null, level: Level): string | null {
  if (value == null) return null;
  return level === "full" ? value : maskCorporateNumber(value);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    const cfg = await getOwnerDisplayConfig(session.id, perms);
    if (cfg.corporateNumber === "hidden") {
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, name: true, address: true, note: true, corporateNumber: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideOwnerCorporateCleanup(gatedInput(owner, cfg));

    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_cleanup_preview",
      targetTable: "owners",
      targetId: id,
      detail: {
        action: proposal.action,
        manualReason: proposal.manualReason,
        importAction: proposal.importAction,
        detectedInCount: proposal.detectedIn.length,
        changedFieldsCount: proposal.changedFields.length,
      },
    });

    return apiResponse({
      cleanup: {
        action: proposal.action,
        manualReason: proposal.manualReason,
        importAction: proposal.importAction,
        detectedIn: proposal.detectedIn,
        changedFields: proposal.changedFields,
        version: owner.version,
        before: {
          nameMasked: maskValue(owner.name, cfg.name),
          addressMasked: maskValue(owner.address, cfg.address),
          noteMasked: maskValue(owner.note, cfg.note),
        },
        after: {
          nameMasked: maskValue(proposal.cleanedName, cfg.name),
          addressMasked: maskValue(proposal.cleanedAddress, cfg.address),
          noteMasked: maskValue(proposal.cleanedNote, cfg.note),
        },
        corporateNumberToSetMasked: maskCnToSet(proposal.corporateNumberToSet, cfg.corporateNumber),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const applySchema = z.object({
  version: z.number().int(),
  apply: z.object({
    name: z.boolean(),
    address: z.boolean(),
    note: z.boolean(),
    corporateNumber: z.boolean(),
  }),
});

const FIELD_PERM: Record<"name" | "address" | "note" | "corporateNumber", string> = {
  name: "owner_name",
  address: "owner_address",
  note: "owner_note",
  corporateNumber: "owner_corporate_number",
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let auditUserId: string | null = null;
  let auditOwnerId: string | null = null;
  let auditApplied: Record<string, boolean> | null = null;
  let auditImportAction: string | null = null;
  let auditResult = "validation_error";
  let auditHttpStatus: number | null = null;
  try {
    const { id } = await params;
    auditOwnerId = id;
    const session = await getApiSession();
    auditUserId = session.id;
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "owner", "write")) {
      auditResult = "forbidden";
      throw new ApiError(403, "所有者を更新する権限がありません", "FORBIDDEN");
    }

    const raw = (await request.json().catch(() => ({}))) as unknown;
    const parsed = applySchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, "リクエスト形式が不正です", "VALIDATION_ERROR");
    const body = parsed.data;
    auditApplied = body.apply;

    const anyApply = body.apply.name || body.apply.address || body.apply.note || body.apply.corporateNumber;
    if (!anyApply) throw new ApiError(400, "反映対象が1つも指定されていません", "VALIDATION_ERROR");

    // field-level write perm(要求された field だけ厳格に・DB アクセス前)
    for (const f of ["name", "address", "note", "corporateNumber"] as const) {
      if (body.apply[f] && !hasExplicitWritePerm(perms, FIELD_PERM[f])) {
        auditResult = "forbidden";
        throw new ApiError(403, `${f} を更新する権限がありません`, "FORBIDDEN");
      }
    }

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    if (cfg.corporateNumber === "hidden") {
      auditResult = "forbidden";
      throw new ApiError(403, "法人番号の閲覧権限がありません", "FORBIDDEN");
    }

    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, name: true, address: true, note: true, corporateNumber: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      auditResult = "not_found";
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const proposal = decideOwnerCorporateCleanup(gatedInput(owner, cfg));
    auditImportAction = proposal.importAction;
    if (proposal.action !== "cleanup") {
      auditResult = "not_available";
      throw new ApiError(409, "自動で適用できる混入除去がありません", "CLEANUP_NOT_AVAILABLE");
    }

    // apply の true は proposal.changedFields の部分集合でなければならない
    for (const f of ["name", "address", "note", "corporateNumber"] as const) {
      if (body.apply[f] && !proposal.changedFields.includes(f)) {
        throw new ApiError(400, "適用対象が提案と一致しません", "APPLY_FIELD_MISMATCH");
      }
    }

    const updateFields: Record<string, unknown> = {};
    if (body.apply.name) updateFields.name = proposal.cleanedName;
    if (body.apply.address) updateFields.address = proposal.cleanedAddress;
    if (body.apply.note) updateFields.note = proposal.cleanedNote;
    if (body.apply.corporateNumber) updateFields.corporateNumber = proposal.corporateNumberToSet;

    const result = await prisma.owner.updateMany({
      where: { id, version: body.version },
      data: { ...updateFields, version: { increment: 1 } },
    });
    if (result.count === 0) {
      auditResult = "version_conflict";
      throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
    }

    await recordChanges({
      targetTable: "owners",
      targetId: id,
      changedBy: session.id,
      oldValues: owner as unknown as Record<string, unknown>,
      newValues: updateFields,
      trackedFields: OWNER_TRACKED_FIELDS,
    });

    auditResult = "applied";
    auditHttpStatus = 200;
    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_cleanup_apply",
      targetTable: "owners",
      targetId: id,
      detail: { applied: body.apply, importAction: auditImportAction, result: auditResult, httpStatus: auditHttpStatus },
    });

    return apiResponse({ ok: true, owner: { id, version: body.version + 1 } });
  } catch (error) {
    if (auditUserId && auditOwnerId && error instanceof ApiError) {
      auditHttpStatus = error.status;
      try {
        await writeAuditLog({
          userId: auditUserId,
          action: "owner_corporate_cleanup_apply",
          targetTable: "owners",
          targetId: auditOwnerId,
          detail: {
            applied: auditApplied ?? { name: false, address: false, note: false, corporateNumber: false },
            importAction: auditImportAction,
            result: auditResult,
            httpStatus: auditHttpStatus,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない
      }
    }
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/corporate-cleanup-route.test.ts`
Expected: PASS(全ケース)

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/owners/[id]/corporate-cleanup/route.ts" src/lib/__tests__/corporate-cleanup-route.test.ts
git commit -m "feat(corporate-cleanup): add preview/apply route with optimistic lock + non-PII audit"
```

---

## Task 4: api-client wrapper(任意・UI から呼ぶ薄い fetch ラッパ)

**Files:**
- Create: `src/lib/corporate-cleanup-client.ts`(api-client.ts を編集しないため独立した薄い関数として新設)
- Test: `src/lib/__tests__/corporate-cleanup-client.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/corporate-cleanup-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCorporateCleanupPreview, applyCorporateCleanup } from "../corporate-cleanup-client";

beforeEach(() => { vi.restoreAllMocks(); });

describe("corporate-cleanup-client", () => {
  it("preview は GET し cleanup を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cleanup: { action: "cleanup" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchCorporateCleanupPreview("o1");
    expect(fetchMock).toHaveBeenCalledWith("/api/owners/o1/corporate-cleanup", expect.objectContaining({ method: "GET" }));
    expect(r.action).toBe("cleanup");
  });

  it("apply は POST し body に version/apply を載せる", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, owner: { id: "o1", version: 3 } }) });
    vi.stubGlobal("fetch", fetchMock);
    const r = await applyCorporateCleanup("o1", { version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/owners/o1/corporate-cleanup");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body).version).toBe(2);
    expect(r.owner.version).toBe(3);
  });

  it("非OK は error.code を投げる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { code: "CONFLICT", message: "x" } }) }));
    await expect(applyCorporateCleanup("o1", { version: 1, apply: { name: true, address: false, note: false, corporateNumber: false } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });
});
```

- [ ] **Step 2: 失敗確認** → Run: `npx vitest run src/lib/__tests__/corporate-cleanup-client.test.ts` Expected: FAIL(module 無し)

- [ ] **Step 3: 実装**

`src/lib/corporate-cleanup-client.ts`:

```typescript
// 法人番号 混入除去 API の薄い client ラッパ(api-client.ts を編集しないため独立)。
export interface CorporateCleanupPreview {
  action: "none" | "cleanup" | "manual";
  manualReason: "multi" | "name_would_be_empty" | null;
  importAction: "none" | "save" | "noop" | "multi" | "conflict";
  detectedIn: Array<"name" | "address" | "note">;
  changedFields: Array<"name" | "address" | "note" | "corporateNumber">;
  version: number;
  before: { nameMasked: string | null; addressMasked: string | null; noteMasked: string | null };
  after: { nameMasked: string | null; addressMasked: string | null; noteMasked: string | null };
  corporateNumberToSetMasked: string | null;
}
export interface CorporateCleanupApplyBody {
  version: number;
  apply: { name: boolean; address: boolean; note: boolean; corporateNumber: boolean };
}
export class CorporateCleanupClientError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

async function parseError(res: Response): Promise<never> {
  let code = "ERROR", message = "エラーが発生しました";
  try { const b = await res.json(); code = b?.error?.code ?? code; message = b?.error?.message ?? message; } catch { /* noop */ }
  throw new CorporateCleanupClientError(code, message);
}

export async function fetchCorporateCleanupPreview(ownerId: string): Promise<CorporateCleanupPreview> {
  const res = await fetch(`/api/owners/${ownerId}/corporate-cleanup`, { method: "GET" });
  if (!res.ok) return parseError(res);
  const body = await res.json();
  return body.cleanup as CorporateCleanupPreview;
}

export async function applyCorporateCleanup(
  ownerId: string,
  body: CorporateCleanupApplyBody,
): Promise<{ ok: true; owner: { id: string; version: number } }> {
  const res = await fetch(`/api/owners/${ownerId}/corporate-cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return parseError(res);
  return res.json();
}
```

- [ ] **Step 4: 通過確認** → Run: `npx vitest run src/lib/__tests__/corporate-cleanup-client.test.ts` Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/corporate-cleanup-client.ts src/lib/__tests__/corporate-cleanup-client.test.ts
git commit -m "feat(corporate-cleanup): add thin api client wrapper"
```

---

## Task 5: 混入除去パネル(UI)+ マウント

**Files:**
- Create: `src/components/owners/corporate-cleanup-panel.tsx`
- Modify: `src/app/(dashboard)/admin/owners/[id]/page.tsx`(CorporateLookupPanel の隣に additive マウント。`page.tsx:24` の import 群と `page.tsx:350` 付近のレンダリングに追記)
- Test: `src/lib/__tests__/corporate-cleanup-ui.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/corporate-cleanup-ui.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CorporateCleanupPanel from "../../components/owners/corporate-cleanup-panel";
import * as client from "../corporate-cleanup-client";

beforeEach(() => { vi.restoreAllMocks(); });

const previewCleanup: client.CorporateCleanupPreview = {
  action: "cleanup", manualReason: null, importAction: "save",
  detectedIn: ["name"], changedFields: ["name", "corporateNumber"], version: 2,
  before: { nameMasked: "株式会社○○ 1234567890123", addressMasked: null, noteMasked: null },
  after: { nameMasked: "株式会社○○", addressMasked: null, noteMasked: null },
  corporateNumberToSetMasked: "1234567890123",
};

describe("CorporateCleanupPanel", () => {
  it("プレビューで before/after と変更フィールドを表示", async () => {
    vi.spyOn(client, "fetchCorporateCleanupPreview").mockResolvedValue(previewCleanup);
    render(<CorporateCleanupPanel ownerId="o1" onApplied={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /混入をチェック/ }));
    await waitFor(() => expect(screen.getByText(/株式会社○○$/)).toBeInTheDocument());
    expect(screen.getByText(/法人番号/)).toBeInTheDocument();
  });

  it("manual(空化ガード)は確定ボタンを出さず理由を表示", async () => {
    vi.spyOn(client, "fetchCorporateCleanupPreview").mockResolvedValue({ ...previewCleanup, action: "manual", manualReason: "name_would_be_empty", changedFields: [] });
    render(<CorporateCleanupPanel ownerId="o1" onApplied={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /混入をチェック/ }));
    await waitFor(() => expect(screen.getByText(/手動/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /選択した項目を反映/ })).toBeNull();
  });

  it("確定で applyCorporateCleanup を選択フラグ付きで呼ぶ", async () => {
    vi.spyOn(client, "fetchCorporateCleanupPreview").mockResolvedValue(previewCleanup);
    const applySpy = vi.spyOn(client, "applyCorporateCleanup").mockResolvedValue({ ok: true, owner: { id: "o1", version: 3 } });
    const onApplied = vi.fn();
    render(<CorporateCleanupPanel ownerId="o1" onApplied={onApplied} />);
    fireEvent.click(screen.getByRole("button", { name: /混入をチェック/ }));
    await waitFor(() => screen.getByRole("button", { name: /選択した項目を反映/ }));
    fireEvent.click(screen.getByRole("button", { name: /選択した項目を反映/ }));
    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    expect(applySpy.mock.calls[0][1]).toEqual({ version: 2, apply: { name: true, address: false, note: false, corporateNumber: true } });
    expect(onApplied).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗確認** → Run: `npx vitest run src/lib/__tests__/corporate-cleanup-ui.test.ts` Expected: FAIL(component 無し)

- [ ] **Step 3: 実装**

`src/components/owners/corporate-cleanup-panel.tsx`(初期チェックは changedFields に基づく。confirm=明示ボタン押下):

```tsx
"use client";
import { useState } from "react";
import {
  fetchCorporateCleanupPreview,
  applyCorporateCleanup,
  type CorporateCleanupPreview,
} from "@/lib/corporate-cleanup-client";

interface Props {
  ownerId: string;
  onApplied: () => void;
}

type Field = "name" | "address" | "note" | "corporateNumber";
const FIELD_LABEL: Record<Field, string> = {
  name: "氏名", address: "住所", note: "備考", corporateNumber: "法人番号(列へ移送)",
};

export default function CorporateCleanupPanel({ ownerId, onApplied }: Props) {
  const [preview, setPreview] = useState<CorporateCleanupPreview | null>(null);
  const [checked, setChecked] = useState<Record<Field, boolean>>({ name: false, address: false, note: false, corporateNumber: false });
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onCheck() {
    setLoading(true); setError(null); setDone(false); setPreview(null);
    try {
      const p = await fetchCorporateCleanupPreview(ownerId);
      setPreview(p);
      const init = { name: false, address: false, note: false, corporateNumber: false } as Record<Field, boolean>;
      for (const f of p.changedFields) init[f] = true; // 既定で変更フィールドを選択
      setChecked(init);
    } catch (e) {
      setError(e instanceof Error ? e.message : "チェックに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function onApply() {
    if (!preview) return;
    setApplying(true); setError(null);
    try {
      await applyCorporateCleanup(ownerId, { version: preview.version, apply: checked });
      setDone(true); setPreview(null); onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "反映に失敗しました");
    } finally {
      setApplying(false);
    }
  }

  const anyChecked = checked.name || checked.address || checked.note || checked.corporateNumber;

  return (
    <div className="rounded border p-3 text-sm">
      <button type="button" onClick={onCheck} disabled={loading} className="rounded bg-slate-100 px-3 py-1">
        {loading ? "確認中…" : "法人番号の混入をチェック"}
      </button>
      {done && <p className="mt-2 text-emerald-700">混入を除去しました</p>}
      {error && <p className="mt-2 text-red-600">{error}</p>}

      {preview && preview.action === "none" && <p className="mt-2 text-slate-500">混入は検出されませんでした</p>}

      {preview && preview.action === "manual" && (
        <p className="mt-2 text-amber-700">
          自動除去できません(手動対応が必要):{preview.manualReason === "multi" ? "複数候補" : "氏名が空になるため"}
        </p>
      )}

      {preview && preview.action === "cleanup" && (
        <div className="mt-2 space-y-2">
          <div className="text-slate-600">
            <div>変更前: {preview.before.nameMasked}</div>
            <div>変更後: {preview.after.nameMasked}</div>
            {preview.corporateNumberToSetMasked && <div>法人番号 → {preview.corporateNumberToSetMasked}</div>}
          </div>
          {preview.changedFields.map((f) => (
            <label key={f} className="block">
              <input type="checkbox" checked={checked[f]} onChange={() => setChecked((c) => ({ ...c, [f]: !c[f] }))} />
              <span className="ml-1">{FIELD_LABEL[f]}</span>
            </label>
          ))}
          <button type="button" onClick={onApply} disabled={applying || !anyChecked} className="rounded bg-blue-600 px-3 py-1 text-white">
            {applying ? "反映中…" : "選択した項目を反映"}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: マウント追加(additive)**

`src/app/(dashboard)/admin/owners/[id]/page.tsx` に追記(既存 `CorporateLookupPanel` import の直後に import、`CorporateLookupPanel` レンダリングブロックの直後にマウント):

```tsx
// import 群(page.tsx:24 付近・CorporateLookupPanel import の隣)
import CorporateCleanupPanel from "@/components/owners/corporate-cleanup-panel";

// レンダリング(page.tsx:350 の CorporateLookupPanel ブロック直後)
<CorporateCleanupPanel ownerId={owner.id} onApplied={refreshOwner} />
```
※ `refreshOwner` は当該ページが CorporateLookupPanel の `onApplied` に渡している既存の owner 再取得関数を流用する(名称はページ実装に合わせる。無ければ既存 lookup panel の onApplied と同じハンドラを渡す)。**owner 表示・取得ロジックや api-helpers.ts には触れない**。

- [ ] **Step 5: テストが通ることを確認 + コミット**

Run: `npx vitest run src/lib/__tests__/corporate-cleanup-ui.test.ts`
Expected: PASS

```bash
git add src/components/owners/corporate-cleanup-panel.tsx "src/app/(dashboard)/admin/owners/[id]/page.tsx" src/lib/__tests__/corporate-cleanup-ui.test.ts
git commit -m "feat(corporate-cleanup): add cleanup panel UI and mount in admin owner detail"
```

---

## Task 6: 検証(tsc / eslint / 全テスト / build / diff / guards)

**Files:** なし(検証のみ)

- [ ] **Step 1: prisma generate(tsc 前に必須・worktree 新規ゆえ)**

Run: `npx prisma generate`
Expected: 成功(`@/generated/prisma` 生成)

- [ ] **Step 2: 型チェック** Run: `npx tsc --noEmit` Expected: エラー 0

- [ ] **Step 3: lint(本体=テスト以外の新規/変更ファイル)**

Run: `npx eslint src/lib/corporate-number.ts src/lib/corporate-number-cleanup.ts src/lib/corporate-cleanup-client.ts "src/app/api/owners/[id]/corporate-cleanup/route.ts" src/components/owners/corporate-cleanup-panel.tsx "src/app/(dashboard)/admin/owners/[id]/page.tsx"`
Expected: エラー 0(テストファイルの `as any` モックは既存規約に準拠=本体0が有効指標)

- [ ] **Step 4: 関連テスト + 全テスト**

Run: `npx vitest run src/lib/__tests__/corporate-number-remove.test.ts src/lib/__tests__/corporate-number-cleanup.test.ts src/lib/__tests__/corporate-cleanup-route.test.ts src/lib/__tests__/corporate-cleanup-client.test.ts src/lib/__tests__/corporate-cleanup-ui.test.ts`
Expected: 全 green
Run: `npx vitest run`
Expected: 全 green(既存 corporate-number.test.ts 等への回帰なし)

- [ ] **Step 5: build** Run: `npm run build` Expected: 成功。route manifest に `/api/owners/[id]/corporate-cleanup` 出現。

- [ ] **Step 6: diff / 禁止パス / api-helpers 無改変 guard**

Run: `git diff --stat b792b64 HEAD`
Expected: 変更は本Plan記載のファイルのみ(新規6 + 既存additive 2[`corporate-number.ts`/`admin/owners/[id]/page.tsx`] + plan doc)。
Run: `git diff --name-only b792b64 HEAD | grep -E 'schema\.prisma|migrations/|package\.json|package-lock\.json|api-helpers\.ts'`
Expected: **何も出ない**(schema/migration/package/lock/api-helpers すべて無改変=タスク24非衝突)。

---

## Self-Review(spec coverage)

| spec 要件 | 対応 |
|---|---|
| 混入除去(local strip・NTA非依存) | Task1 `removeCorporateNumbersFromText` + Task2 `decideOwnerCorporateCleanup` |
| 空き列のみ移送・conflict は移送せず除去のみ・multi/空化は手動 | Task2 ロジック + エッジ表 + unit tests |
| 空化ガード(name が空→手動フラグ) | Task2 `name_would_be_empty` + test |
| preview→確定(明示apply・自動上書き禁止) | Task3 GET=dry-run / POST=明示apply・サーバ再計算 |
| owner:write + field-level write + display raw-visible gate + version 楽観ロック + AuditLog非PII | Task3 route + tests(403/409/PII) |
| api-helpers.ts 非編集(import のみ)→タスク24非衝突 | File Structure + Task6 Step6 guard |
| schema/migration/env/package/lock 変更なし | File Structure + Task6 Step6 guard |
| UI 導線(lookup panel と併存) | Task5 panel + admin owner detail マウント |

**Type consistency:** `CorporateCleanupProposal` / `OwnerCleanupInput` / `CorporateCleanupAction`("none"|"cleanup"|"manual") / `CorporateCleanupManualReason`("multi"|"name_would_be_empty"|null) を Task2 で定義し Task3(route)・Task4(client)・Task5(UI)が同名参照。`changedFields`/`corporateNumberToSet`/`importAction` の名称は全 Task 一致。route の error code(`CLEANUP_NOT_AVAILABLE`/`APPLY_FIELD_MISMATCH`/`CONFLICT`)は route と client/UI テストで一致。

## スコープ外(本Plan で実装しない=据え置き)

- P2(検出値→lookup prefill / 一括反映)、P3(NTA社名あいまい検索=env・schema 要・**別承認**)、P4(network/XML/廃止法人/bypass のテスト補強)。
- `properties/[id]/page.tsx` への同パネル展開(P1 は admin owner detail のみ。必要なら後続)。
- VPS 反映(導線あり=別承認)。
