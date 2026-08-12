# 謄本取得の「地番を人が確認して入れるポップアップ」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 地番も家屋番号も無い物件で謄本を取ろうとしたとき、地番検索サービスで人が確認した地番を入れて保存できるようにし、あわせて「何を取りに行くか（土地/建物）」を必ず見せ、番号が無い・読めない・途中で変わった物件が実サイトへ行かないようにする。

**Architecture:** 判定はすべて**純関数1本**に寄せ（`chiban-input.ts` / `registry-target.ts`）、それを**画面・共通の検索入口・一括の処理時・取得の直前**の4か所から呼ぶ。ポップアップは `PATCH /api/properties/[id]` で `lotNumber` を保存するだけで、検索は既存の確認パネルから始まる（課金の確認を飛ばさない）。一括は**人を待たない**（対象外にして理由を出す）。

**Tech Stack:** Next.js App Router / Prisma / vitest（env=node・jsdom無し）/ Playwright（provider 側・本計画では触らない）

## 正本

- **設計書**: `docs/superpowers/specs/2026-08-12-registry-chiban-popup-design.md`（main にマージ済み・@codex 16巡）
- 迷ったら設計書が勝つ。設計書に無いことを足さない。

## Global Constraints

- **地番は秘匿情報**。log / AuditLog / error response / 実況パネルに**値を出さない**（件数と分類コードのみ）。`src/lib/registry-fetch/types.ts:110,168` に明文の規約がある。
- **課金の経路を新設しない**。入力した地番は必ず「検索 → 候補 → `locationCandidate`」の既存経路へ合流させる（設計 §5）。
- **`buildingNumber` はこの導線から保存しない**（地図が返すのは地番であって家屋番号ではない）。
- **新しい正規化関数を作らない**。`normalizeChibanForDialog`（`src/lib/registry-fetch/auto-fetch.ts:1038`）に寄せる。⚠ 同名の `normalizeLotNumber` が `src/lib/registry-fetch/purchase-safety.ts:108`（鍵用・非export）と `src/lib/address-normalizer.ts:140`（重複候補用・export）に**別実装で2つある**。取り違えない。
- **種別（`propertyType`）で実行を止めない**（発注者判断 2026-08-12）。種別は**警告の材料**にしか使わない。
- **`ambiguous_type` という理由コードは作らない**（同上）。
- **migration を足さない**。`RegistryFetchJobItem.propertyFingerprintHash`（`prisma/schema.prisma:1315`）は**既に存在して未使用**なので、これを使う。
- テストは `npx vitest run`（フル）で緑にする。UI は `readFileSync` によるソース走査か `renderToStaticMarkup`（jsdom は無い）。

## 分割（2つの PR で出す）

| PR | タスク | 単独で成立するか |
|---|---|---|
| **PR-A サーバー側の安全** | Task 1〜6 | ✅ する。画面が無くても「番号が無い/読めない/変わった物件が実サイトへ行かない」が成立する |
| **PR-B 画面** | Task 7〜11 | PR-A の理由コードと分類関数を使う |

⚠ PR-A を先に出してマージしてから PR-B を書く。PR-A のインターフェース（下の各 **Produces**）が PR-B の前提になる。

## File Structure

| ファイル | 責任 |
|---|---|
| `src/lib/registry-fetch/chiban-input.ts`（新規） | 地番/家屋番号の**書式の正本**。受理する文字クラスと `isReadableChiban()` |
| `src/lib/registry-fetch/registry-target.ts`（新規） | 「何を取りに行くか（土地/建物/決められない）」と警告文の**分類の正本**（純関数） |
| `src/lib/registry-fetch/search-request.ts` | 共通の入口。理由コードを2つ足し、**渡す番号を1つに絞る** |
| `src/lib/registry-fetch/auto-fetch.ts` | `normalizeChibanForDialog` を chiban-input の文字クラスから導く／取得の直前の検査 |
| `src/lib/registry-fetch/bulk/jobs.ts` | 作成時に**指紋を控える** |
| `src/lib/registry-fetch/bulk/process.ts` | 処理時に**指紋を照合**して skip |
| `src/app/api/properties/[id]/registry/search/route.ts` | 新しい理由なら **422** |
| `src/app/api/registry-fetch/preflight/route.ts` | 分類を返す |
| `src/components/properties/registry-chiban-popup.tsx`（新規） | ポップアップ本体（土地の入力欄／建物の2つの道） |
| `src/components/properties/registry-location-search-button.tsx` | ポップアップの差し込み・分類の表示・fail closed |
| `src/components/properties/registry-preflight-warnings.tsx` | 分類だけ **fail closed**（失敗時に実行ボタンを戻さない） |
| `src/app/(dashboard)/properties/[id]/page.tsx` | 謄本ボタンへ `version` を渡す |
| `src/app/(dashboard)/properties/registry-fetch/[jobId]/page.tsx` | 一括の**除外理由を件数つきで出す** |

---

# PR-A サーバー側の安全

## Task 1: 地番の書式検査（純関数）

**Files:**
- Create: `src/lib/registry-fetch/chiban-input.ts`
- Modify: `src/lib/registry-fetch/auto-fetch.ts:1038-1047`
- Test: `src/lib/registry-fetch/__tests__/chiban-input.test.ts`

**Interfaces:**
- Produces:
  - `CHIBAN_SEPARATOR_RE: RegExp` — 区切りとして受理する表記（`番地|番|の|ノ`）
  - `CHIBAN_DASH_RE: RegExp` — ハイフンへ寄せるダッシュ類
  - `isReadableChiban(raw: string | null | undefined): boolean`
- Consumes: なし

**背景（実測）**: `normalizeChibanForDialog`（`auto-fetch.ts:1038`）は数字とハイフン以外を**全部削除**するので、`abc1x2` も `1号2` も同じ `12` になる。`12` は別の筆を指し得るうえ、一括は候補が1件なら自動で買う（`bulk/process.ts:258`）。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-fetch/__tests__/chiban-input.test.ts`:

```ts
/**
 * 地番/家屋番号の「読める形か」の判定（設計 §4.3）。
 *
 * ⚠受理する範囲は normalizeChibanForDialog が扱える表記に合わせる。
 *   狭めると、既に保存されている物件や取込済みのCSVが新しい検査で落ちる
 *   （今まで取れていたものが取れなくなる）。
 */
import { describe, it, expect } from "vitest";
import { isReadableChiban } from "@/lib/registry-fetch/chiban-input";

describe("受理する（既存データを落とさない）", () => {
  it.each([
    ["数字だけ", "69"],
    ["ハイフン区切り", "69-2"],
    ["3段", "1-1-1"],
    ["番地", "1番地2"],
    ["番", "69番2"],
    ["の", "69の2"],
    ["ノ", "1ノ2"],
    ["ダッシュ", "69‐2"],
    ["長音記号", "69ー2"],
    ["全角ハイフン", "69－2"],
    ["全角数字", "６９－２"],
    ["前後の空白", "  69-2  "],
  ])("%s: %s", (_label, raw) => {
    expect(isReadableChiban(raw)).toBe(true);
  });
});

describe("⚠拒否する（通すと別の筆を買う）", () => {
  it.each([
    ["英字が混じる", "abc1x2"],
    ["未対応の文字が数字と同居", "1x2"],
    ["説明文がくっついている", "69-2 の隣"],
    ["号は区切りとして扱わない", "1号2"],
    ["数字が無い", "あ番"],
    ["空", ""],
    ["空白のみ", "   "],
  ])("%s: %s", (_label, raw) => {
    expect(isReadableChiban(raw)).toBe(false);
  });

  it("null / undefined も false", () => {
    expect(isReadableChiban(null)).toBe(false);
    expect(isReadableChiban(undefined)).toBe(false);
  });
});

describe("正規化と判定が同じ文字クラスから導かれている", () => {
  it("受理した値は正規化後に必ず数字を含む", async () => {
    const { normalizeChibanForDialog } = await import(
      "@/lib/registry-fetch/auto-fetch"
    );
    for (const raw of ["69", "1番地2", "1ノ2", "６９－２"]) {
      expect(isReadableChiban(raw)).toBe(true);
      expect(normalizeChibanForDialog(raw)).toMatch(/\d/);
    }
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/registry-fetch/__tests__/chiban-input.test.ts`
Expected: FAIL（`Failed to load .../chiban-input`）

⚠ `auto-fetch.ts` を import するテストは prisma / api-helpers を巻き込むので、失敗が「モジュールが無い」以外なら `vi.mock` が要る（`src/lib/registry-fetch/__tests__/location-rejected.test.ts:12` に実例がある）。3つ目の describe が別の理由で落ちるなら、その describe だけ `vi.mock("@/lib/prisma", () => ({ default: {} }))` を先頭に足す。

- [ ] **Step 3: 実装する**

`src/lib/registry-fetch/chiban-input.ts`:

```ts
/**
 * 地番/家屋番号の「読める形か」の判定（設計 §4.3）。
 *
 * ## なぜ必要か
 * `normalizeChibanForDialog` は数字とハイフン以外を**全部削除する**ので、
 * `abc1x2` も `1号2` も同じ `12` になる。`12` は**別の筆**を指し得るうえ、
 * 一括取得は候補が1件なら自動で買うので、**誤った登記を買って添付・取込まで進む**。
 *
 * ## 文字クラスはここが正本
 * ⚠ `normalizeChibanForDialog` もここの正規表現を使う。
 * 2か所に書くと、片方に表記が足されたときにずれる（表を人手で写した allowlist にしない）。
 */

/** 区切りとして受理する表記。⚠「号」は入れない（別の意味を持つため）。 */
export const CHIBAN_SEPARATOR_RE = /番地|番|の|ノ/g;

/** ハイフンへ寄せるダッシュ・長音記号。 */
export const CHIBAN_DASH_RE = /[‐‑‒–—―−ー－]/g;

/** 全角数字→半角。 */
export const CHIBAN_FULLWIDTH_DIGIT_RE = /[０-９]/g;

/** 全角数字を半角へ寄せる（正規化と判定で共用）。 */
export function toHalfWidthDigits(input: string): string {
  return input.replace(CHIBAN_FULLWIDTH_DIGIT_RE, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 「正規化してみて、元の文字が全部説明できるか」で判定する。
 *
 * 元の文字のうち、次のいずれでもない文字が1つでもあれば **読めない形**:
 *  - 数字（全角を半角へ寄せた後）
 *  - 区切り（番地 / 番 / の / ノ）
 *  - ハイフン・ダッシュ・長音記号
 *  - 前後の空白（trim で落ちるぶんだけ）
 *
 * さらに、**数字が1つも残らない**値も読めない形とする（`あ番` → 空）。
 */
export function isReadableChiban(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;

  // 説明できる文字をすべて取り除いた残りが空なら「全部説明できた」。
  const rest = toHalfWidthDigits(trimmed)
    .replace(CHIBAN_SEPARATOR_RE, "")
    .replace(CHIBAN_DASH_RE, "")
    .replace(/[0-9-]/g, "");
  if (rest !== "") return false;

  // 数字が残らない値は宛先にならない。
  return /\d/.test(toHalfWidthDigits(trimmed));
}
```

- [ ] **Step 4: `normalizeChibanForDialog` を同じ文字クラスから導く**

`src/lib/registry-fetch/auto-fetch.ts:1038-1047` を差し替える（jsdoc は残す）:

```ts
export function normalizeChibanForDialog(raw: string): string {
  // ⚠文字クラスの正本は chiban-input.ts。ここで別の表記を足さない
  //   （入力の検査と正規化がずれると、通ったのに別の筆を探すことになる）。
  return toHalfWidthDigits(raw.trim())
    .replace(CHIBAN_SEPARATOR_RE, "-")
    .replace(CHIBAN_DASH_RE, "-")
    .replace(/[^0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

`auto-fetch.ts` の import 群へ追加:

```ts
import {
  CHIBAN_DASH_RE,
  CHIBAN_SEPARATOR_RE,
  toHalfWidthDigits,
} from "./chiban-input";
```

⚠ `CHIBAN_SEPARATOR_RE` / `CHIBAN_DASH_RE` / `CHIBAN_FULLWIDTH_DIGIT_RE` は `g` フラグ付きなので `lastIndex` を持つ。`String.prototype.replace` は毎回 0 から走るので共有して安全だが、**`.test()` には使わない**（`toHalfWidthDigits` の中では `replace` のみ）。

- [ ] **Step 5: 通ることを確認する**

Run: `npx vitest run src/lib/registry-fetch/__tests__/chiban-input.test.ts src/lib/registry-fetch/__tests__/shozai-dialog.test.ts`
Expected: PASS（既存の `normalizeChibanForDialog` のテストも緑のまま）

- [ ] **Step 6: commit**

```bash
git add src/lib/registry-fetch/chiban-input.ts src/lib/registry-fetch/auto-fetch.ts src/lib/registry-fetch/__tests__/chiban-input.test.ts
git commit -m "feat(registry): 地番の「読める形か」を判定する純関数（文字クラスは1か所）"
```

---

## Task 2: 共通の入口に理由を足し、渡す番号を1つに絞る

**Files:**
- Modify: `src/lib/registry-fetch/search-request.ts:38-77`
- Modify: `src/lib/api-client.ts:1776`
- Test: `src/lib/registry-fetch/__tests__/search-request.test.ts`

**Interfaces:**
- Consumes: `isReadableChiban`（Task 1）
- Produces:
  - `BuildRegistrySearchResult` の `reason` に `"missing_identifier" | "malformed_identifier"` を追加
  - `searchable: true` のとき、`request.lotNumber` と `request.buildingNumber` の**どちらか一方だけ**が非 null

**背景（実測）**: 現在 `buildRegistrySearchRequest`（`search-request.ts:55`）は**住所さえあれば searchable** で、地番の有無も形式も見ていない。また `searchable:true` のとき**両方の番号を渡す**ため、土地の物件に家屋番号が残っていると provider が建物として検索する（`auto-fetch.ts` の `isBuilding` 判定）。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-fetch/__tests__/search-request.test.ts` の末尾に追記:

```ts
describe("番号が無い/読めない（設計 §4.4）", () => {
  const base = {
    address: "神奈川県横浜市南区井土ケ谷中町",
    realEstateNumber: null,
    ref: "p1",
  };

  it("⚠地番も家屋番号も無ければ missing_identifier", () => {
    expect(
      buildRegistrySearchRequest({ ...base, lotNumber: null, buildingNumber: null }),
    ).toEqual({ searchable: false, reason: "missing_identifier" });
  });

  it("⚠読めない形なら malformed_identifier（別の筆を探させない）", () => {
    expect(
      buildRegistrySearchRequest({ ...base, lotNumber: "abc1x2", buildingNumber: null }),
    ).toEqual({ searchable: false, reason: "malformed_identifier" });
  });

  it("既存の表記（1番地2）は今までどおり通る", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      lotNumber: "1番地2",
      buildingNumber: null,
    });
    expect(r.searchable).toBe(true);
  });

  it("住所が無いときは従来どおり insufficient_location（番号より先に出す）", () => {
    expect(
      buildRegistrySearchRequest({
        ...base,
        address: null,
        lotNumber: null,
        buildingNumber: null,
      }),
    ).toEqual({ searchable: false, reason: "insufficient_location" });
  });

  it("不動産番号があるときは番号の検査をしない（従来どおり has_real_estate_number）", () => {
    expect(
      buildRegistrySearchRequest({
        ...base,
        realEstateNumber: "1234567890123",
        lotNumber: "abc1x2",
        buildingNumber: null,
      }),
    ).toEqual({ searchable: false, reason: "has_real_estate_number" });
  });
});

describe("渡す番号は1つだけ（設計 §3.1.2）", () => {
  const base = {
    address: "神奈川県横浜市南区井土ケ谷中町",
    realEstateNumber: null,
    ref: "p1",
  };

  it("家屋番号があれば家屋番号だけを渡す（建物として検索させる）", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      lotNumber: "69-2",
      buildingNumber: "12-3",
    });
    expect(r).toEqual({
      searchable: true,
      request: {
        address: base.address,
        lotNumber: null,
        buildingNumber: "12-3",
        ref: "p1",
      },
    });
  });

  it("家屋番号が無ければ地番だけを渡す（土地として検索させる）", () => {
    const r = buildRegistrySearchRequest({
      ...base,
      lotNumber: "69-2",
      buildingNumber: null,
    });
    expect(r).toEqual({
      searchable: true,
      request: {
        address: base.address,
        lotNumber: "69-2",
        buildingNumber: null,
        ref: "p1",
      },
    });
  });

  it("⚠読めない家屋番号があるとき、地番があっても malformed_identifier", () => {
    // 家屋番号が優先されるので、優先された側の形式で判定する。
    // ここで地番へ勝手に落とすと、利用者が意図しない土地の登記を買う。
    expect(
      buildRegistrySearchRequest({
        ...base,
        lotNumber: "69-2",
        buildingNumber: "abc",
      }),
    ).toEqual({ searchable: false, reason: "malformed_identifier" });
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/registry-fetch/__tests__/search-request.test.ts`
Expected: FAIL（`missing_identifier` が返らず `searchable:true` になる／両方の番号が入っている）

- [ ] **Step 3: 実装する**

`src/lib/registry-fetch/search-request.ts` の型と関数を差し替える:

```ts
import { isReadableChiban } from "./chiban-input";

/**
 * 所在検索が可能かの判別結果。
 *  - searchable:true  … request で所在検索できる
 *  - searchable:false … 検索しない（reason で理由を区別）
 *      has_real_estate_number … 不動産番号があるので番号取得を優先（検索不要）
 *      insufficient_location  … 所在が無く検索キーを満たさない（検索不能）
 *      missing_identifier     … 地番も家屋番号も無い（サイトに渡すものが無い）
 *      malformed_identifier   … 番号が読めない形（正規化すると別の筆を指す）
 *
 * ⚠ `ambiguous_type` は作らない。種別では止めない（発注者判断 2026-08-12）。
 */
export type BuildRegistrySearchResult =
  | { searchable: true; request: RegistrySearchRequest }
  | {
      searchable: false;
      reason:
        | "has_real_estate_number"
        | "insufficient_location"
        | "missing_identifier"
        | "malformed_identifier";
    };

/**
 * Property の検索キーから所在検索入力を組む純関数。
 *  1. realEstateNumber があれば検索不要（has_real_estate_number）
 *  2. address が無ければ検索不能（insufficient_location）
 *  3. 地番も家屋番号も無ければ検索不能（missing_identifier）
 *  4. 使う番号が読めない形なら検索不能（malformed_identifier）
 *  5. それ以外は所在検索可能（request を返す）
 *
 * ⚠ 使う番号は**家屋番号が優先**（＝建物の登記）。決まらなかった方は渡さない。
 *   両方渡すと provider の土地/建物の判定と呼び出し側の意図が二重管理になる（設計 §3.1.2）。
 */
export function buildRegistrySearchRequest(
  source: RegistrySearchSource,
): BuildRegistrySearchResult {
  const realEstateNumber = trimToNull(source.realEstateNumber);
  if (realEstateNumber) {
    return { searchable: false, reason: "has_real_estate_number" };
  }

  const address = trimToNull(source.address);
  if (!address) {
    return { searchable: false, reason: "insufficient_location" };
  }

  const lotNumber = trimToNull(source.lotNumber);
  const buildingNumber = trimToNull(source.buildingNumber);
  // 家屋番号が優先（建物の登記）。無ければ地番（土地の登記）。
  const effective = buildingNumber ?? lotNumber;
  if (!effective) {
    return { searchable: false, reason: "missing_identifier" };
  }
  if (!isReadableChiban(effective)) {
    return { searchable: false, reason: "malformed_identifier" };
  }

  return {
    searchable: true,
    request: {
      address,
      // ⚠決まった方だけを渡す。
      lotNumber: buildingNumber ? null : lotNumber,
      buildingNumber,
      ref: trimToNull(source.ref ?? null),
    },
  };
}
```

- [ ] **Step 4: API クライアントの型を合わせる**

`src/lib/api-client.ts:1776` の reason のリテラル union に2つ足す:

```ts
        reason?:
          | "has_real_estate_number"
          | "insufficient_location"
          | "missing_identifier"
          | "malformed_identifier";
```

- [ ] **Step 5: 通ることを確認する**

Run: `npx vitest run src/lib/registry-fetch/ && npx tsc --noEmit`
Expected: PASS / tsc 0

⚠ 既存の `search-request.test.ts` が「両方の番号を渡す」を固定しているなら、それは**意図した挙動変更**として期待値を直し、理由をコメントに書く。

- [ ] **Step 6: commit**

```bash
git add src/lib/registry-fetch/search-request.ts src/lib/api-client.ts src/lib/registry-fetch/__tests__/search-request.test.ts
git commit -m "feat(registry): 番号が無い/読めないを共通の入口で判定し、渡す番号を1つに絞る"
```

---

## Task 3: 呼び出し側で止め方を変える（422 / 除外 / skip）

**Files:**
- Modify: `src/app/api/properties/[id]/registry/search/route.ts:121`
- Test: `src/lib/__tests__/registry-search-identifier-gate.test.ts`（新規）

**Interfaces:**
- Consumes: Task 2 の理由コード
- Produces: 単発の検索 API が新しい理由のとき **422**（`REGISTRY_SEARCH_IDENTIFIER_INVALID`）で返す

**背景（実測）**: `runRegistrySearch`（`search.ts:129`）は検索できない結果を**すべて 200 で返す**。一括のジョブ作成（`bulk/jobs.ts:207`）は `reason` をそのまま `item.errorCode` に入れて `skipped` にするので**変更不要**。一括の処理時（`bulk/process.ts:247`）も同様に**変更不要**。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/registry-search-identifier-gate.test.ts`:

```ts
/**
 * 単発の検索 API は、番号が無い/読めない物件を **実サイトへ行かせない**（設計 §4.4）。
 * 一括は同じ理由コードを「除外」「skip」に読み替えるので、止め方は呼び出し側で違う。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u1", role: "admin" })),
    getUserPermissions: vi.fn(async () => [
      { resource: "registry", action: "auto_fetch", granted: true },
      { resource: "property", action: "read", granted: true },
    ]),
    handleApiError: vi.fn((e: unknown) => {
      const x = e as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: x?.message ?? "", code: x?.code ?? "INTERNAL" } },
        { status: x?.status ?? 500 },
      );
    }),
    apiResponse: vi.fn((d: unknown, s = 200) => Response.json(d, { status: s })),
  };
});

vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/registry-fetch/search", () => ({
  runRegistrySearch: vi.fn(),
  resolveRegistryCandidate: vi.fn(),
}));

import { runRegistrySearch } from "@/lib/registry-fetch/search";
import { POST } from "../../app/api/properties/[id]/registry/search/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";

function call() {
  return POST(
    { json: async () => ({ confirmed: true }) } as never,
    { params: Promise.resolve({ id: PROPERTY_ID }) },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("番号の問題は 422 で止める", () => {
  it.each(["missing_identifier", "malformed_identifier"])(
    "%s は 422（実サイトへ行かない）",
    async (reason) => {
      (runRegistrySearch as Mock).mockResolvedValue({ searchable: false, reason });
      const res = await call();
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("REGISTRY_SEARCH_IDENTIFIER_INVALID");
    },
  );

  it("既存の理由は今までどおり 200 で返す（画面が案内を出す）", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: false,
      reason: "has_real_estate_number",
    });
    const res = await call();
    expect(res.status).toBe(200);
  });

  it("検索できるときは今までどおり 200", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [],
    });
    const res = await call();
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/__tests__/registry-search-identifier-gate.test.ts`
Expected: FAIL（422 にならず 200 が返る）

⚠ route の実引数の形（`params` が Promise か・body の読み方）は `src/app/api/properties/[id]/registry/search/route.ts` の実装に合わせる。合わなければテスト側を実装に寄せる（実装を曲げない）。

- [ ] **Step 3: 実装する**

`src/app/api/properties/[id]/registry/search/route.ts` の `runRegistrySearch` の戻り値を返す直前に挟む:

```ts
    const result = await runRegistrySearch({ /* 既存の引数のまま */ });

    // ⚠番号が無い/読めないのは**入力の問題**なので 422 で止める（設計 §4.4）。
    //   200 で返すと、画面は「対象外です」と出すだけで、利用者は何を直せばよいか分からない。
    //   一括は同じ理由コードを「除外」「skip」に読み替えるので、止め方はここでだけ決める。
    if (
      result &&
      (result as { searchable?: boolean }).searchable === false &&
      ((result as { reason?: string }).reason === "missing_identifier" ||
        (result as { reason?: string }).reason === "malformed_identifier")
    ) {
      throw new ApiError(
        422,
        (result as { reason?: string }).reason === "missing_identifier"
          ? "地番（建物は家屋番号）を入力してから実行してください"
          : "地番の書き方が読み取れません。地図に表示されたとおりに入力してください",
        "REGISTRY_SEARCH_IDENTIFIER_INVALID",
      );
    }

    return apiResponse(result);
```

- [ ] **Step 4: 通ることを確認する**

Run: `npx vitest run src/lib/__tests__/registry-search-identifier-gate.test.ts src/lib/registry-fetch/bulk/`
Expected: PASS（一括側は無変更で緑のまま）

- [ ] **Step 5: commit**

```bash
git add src/app/api/properties/[id]/registry/search/route.ts src/lib/__tests__/registry-search-identifier-gate.test.ts
git commit -m "feat(registry): 番号の問題は単発の検索を422で止める（一括は除外/skipのまま）"
```

---

## Task 4: 取得の直前にも同じ検査を入れる

**Files:**
- Modify: `src/lib/registry-fetch/auto-fetch.ts:2844-2856`
- Test: `src/lib/__tests__/registry-auto-fetch-api.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `isReadableChiban`（Task 1）
- Produces: 有料取得の直前で、使う番号が読めない形なら **422**（`REGISTRY_OBTAIN_IDENTIFIER_INVALID`）

**背景（実測）**: `auto-fetch.ts:2849` に「地番/家屋番号と物件 address のどちらかが空なら 409」の検査は**既にある**が、**形式は見ていない**。取得は検索とは別の入口（`POST /api/properties/[id]/registry/auto-fetch`）なので、検索側だけ塞いでも素通りする。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/registry-auto-fetch-api.test.ts` の「段階②: 地番候補の有料取得」describe に追記:

```ts
  it("⚠読めない形の地番では課金前に 422 で止まる（実サイトに触れない）", async () => {
    // 編集画面・PATCH API・CSV取込から入った値は検索の検査を通っていない。
    // ここを塞がないと、正規化で潰れた別の筆を買う。
    setCandidate({ lotNumber: "abc1x2", buildingNumber: null });
    const res = await POST(makeRequest({ confirmed: true }), makeParams());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_OBTAIN_IDENTIFIER_INVALID");
    expect(providerMock.fetchRegistryPdf).not.toHaveBeenCalled();
  });

  it("既存の表記（1番地2）は今までどおり取得できる", async () => {
    setCandidate({ lotNumber: "1番地2", buildingNumber: null });
    const res = await POST(makeRequest({ confirmed: true }), makeParams());
    expect(res.status).toBe(200);
  });
```

⚠ `setCandidate` / `providerMock` / `makeRequest` / `makeParams` は**その describe の既存ヘルパー名に合わせる**（`src/lib/__tests__/registry-auto-fetch-api.test.ts:832` 以降を読んでから書く）。無ければ同 describe の他テストと同じ組み立て方をコピーする。

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/__tests__/registry-auto-fetch-api.test.ts -t "読めない形の地番"`
Expected: FAIL（422 にならず provider が呼ばれる）

- [ ] **Step 3: 実装する**

`src/lib/registry-fetch/auto-fetch.ts` の既存の「地番/所在が空なら 409」の検査（2849 行付近）の**直後**に足す:

```ts
    // ⚠形式まで見る（設計 §4.4）。空でないことだけを見ると、`abc1x2` のような値が
    //   normalizeChibanForDialog で `12` に潰され、**別の筆**を買うところまで進む。
    //   検索の入口と同じ判定関数を使う（2か所に書くとずれる）。
    const effectiveIdentifier =
      trimToNull(locationCandidate.buildingNumber) ??
      trimToNull(locationCandidate.lotNumber);
    if (!isReadableChiban(effectiveIdentifier)) {
      throw new ApiError(
        422,
        "地番の書き方が読み取れません。地図に表示されたとおりに入力してください",
        "REGISTRY_OBTAIN_IDENTIFIER_INVALID",
      );
    }
```

import を追加:

```ts
import { isReadableChiban } from "./chiban-input";
```

⚠ `trimToNull` が `auto-fetch.ts` に無ければ、その場で `(v?: string | null) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)` をローカル関数として置く（新しい共有ヘルパーを増やさない）。

⚠ **この検査は課金スイッチ（501）と二重課金台帳（409）より前**に置く。実サイトに触れないことが目的なので、**最も手前**でよい。ただし**不動産番号がある物件はこのブロックに入らない**（`auto-fetch.ts:2830` の分岐）ので、番号取得の経路は影響を受けない。

- [ ] **Step 4: 通ることを確認する**

Run: `npx vitest run src/lib/__tests__/registry-auto-fetch-api.test.ts`
Expected: PASS（既存の課金安全のテストも緑のまま）

- [ ] **Step 5: commit**

```bash
git add src/lib/registry-fetch/auto-fetch.ts src/lib/__tests__/registry-auto-fetch-api.test.ts
git commit -m "feat(registry): 取得の直前にも地番の形式を検査する（検索とは別の入口を塞ぐ）"
```

---

## Task 5: 一括は作成時の「検索に渡すもの」を固定する

**Files:**
- Modify: `src/lib/registry-fetch/bulk/jobs.ts:207-245`
- Modify: `src/lib/registry-fetch/bulk/process.ts:132-180`
- Test: `src/lib/registry-fetch/bulk/__tests__/jobs.test.ts` / `process.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `fingerprintProperty`（`src/lib/registry-fetch/candidate-cache.ts:62`・既存）
- Produces: `registry_fetch_job_items.property_fingerprint_hash` に作成時点の指紋のハッシュが入り、処理時に一致しなければ `skipped` / `errorCode="identifier_changed"`

**背景（実測）**:
- `RegistryFetchJobItem.propertyFingerprintHash` は **schema に既にあって未使用**（`prisma/schema.prisma:1315`）→ **migration 不要**。
- `fingerprintProperty` の材料は `[address, lotNumber, buildingNumber, realEstateNumber]`（`candidate-cache.ts:62`）＝設計 §3.1.0.1 が要求する「住所・番号の種類・値」を**すべて含む**（同じ数字が地番⇔家屋番号へ移れば配列が変わる）。**新しい指紋を作らない**。
- 処理時は `runRegistrySearch` の中で物件を読み直している（`search.ts:95`）＝作成時の値は誰も覚えていない。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-fetch/bulk/__tests__/jobs.test.ts` に追記:

```ts
  it("⚠作成時に指紋を控える（あとで書き換わったことに気づけるように）", async () => {
    // 控えないと、順番待ちの間に住所や地番が書き換わっても検査を素通りし、
    // 候補が1件なら**確認したのと別の筆**を自動で買う。
    await createBulkFetchJob({ /* 既存テストと同じ引数 */ } as never);
    const created = pm.registryFetchJobItem.createMany.mock.calls[0][0].data;
    expect(created[0].propertyFingerprintHash).toEqual(expect.any(String));
    expect(created[0].propertyFingerprintHash.length).toBeGreaterThan(0);
  });

  it("住所だけ違う物件は違う指紋になる", async () => {
    // 番号が同じでも、処理時は住所も使って検索するので別の場所を探すことになる。
    // （fingerprintProperty の材料に address が入っていることの確認）
    const { fingerprintProperty } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const a = fingerprintProperty({
      address: "横浜市南区井土ケ谷中町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    } as never);
    const b = fingerprintProperty({
      address: "横浜市南区別の町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    } as never);
    expect(a).not.toBe(b);
  });

  it("同じ数字が地番から家屋番号へ移ると違う指紋になる（取りに行くものが変わる）", async () => {
    const { fingerprintProperty } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const land = fingerprintProperty({
      address: "A",
      lotNumber: "1-2",
      buildingNumber: null,
      realEstateNumber: null,
    } as never);
    const building = fingerprintProperty({
      address: "A",
      lotNumber: null,
      buildingNumber: "1-2",
      realEstateNumber: null,
    } as never);
    expect(land).not.toBe(building);
  });
```

`src/lib/registry-fetch/bulk/__tests__/process.test.ts` に追記:

```ts
  it("⚠指紋が変わっていたら skip する（黙って新しい番号で買わない）", async () => {
    setupPendingItem({
      propertyFingerprintHash: "hash-at-creation",
      property: { id: PROPERTY_ID, createdBy: "u1", assignedTo: null },
    });
    // いまの物件から作る指紋は別物
    fingerprintMock.mockReturnValue("hash-now-different");

    await processNextBulkItem({ /* 既存テストと同じ引数 */ } as never);

    const update = pm._tx.registryFetchJobItem.update.mock.calls.at(-1)![0];
    expect(update.data.status).toBe("skipped");
    expect(update.data.errorCode).toBe("identifier_changed");
    expect(runRegistrySearchMock).not.toHaveBeenCalled();
  });

  it("指紋が同じなら今までどおり進む", async () => {
    setupPendingItem({ propertyFingerprintHash: "same" });
    fingerprintMock.mockReturnValue("same");
    await processNextBulkItem({ /* 既存テストと同じ引数 */ } as never);
    expect(runRegistrySearchMock).toHaveBeenCalled();
  });

  it("指紋を持たない古いジョブは今までどおり進む（後方互換）", async () => {
    setupPendingItem({ propertyFingerprintHash: null });
    await processNextBulkItem({ /* 既存テストと同じ引数 */ } as never);
    expect(runRegistrySearchMock).toHaveBeenCalled();
  });
```

⚠ `setupPendingItem` / `fingerprintMock` / `runRegistrySearchMock` は**その file の既存ヘルパー名に合わせる**（`process.test.ts:85` 付近の $transaction モックの作り方を踏襲）。無ければ既存テストと同じ形で組む。

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/registry-fetch/bulk/`
Expected: FAIL（`propertyFingerprintHash` が undefined／skip されない）

- [ ] **Step 3: 作成時に指紋を控える**

`src/lib/registry-fetch/bulk/jobs.ts` の物件取得 select に4項目が入っていることを確認し（`address` / `lotNumber` / `buildingNumber` / `realEstateNumber`）、`itemsData` の組み立てへ足す:

```ts
import { createHash } from "node:crypto";
import { fingerprintProperty } from "@/lib/registry-fetch/candidate-cache";

// …itemsData を作るループの中で…
      // ⚠作成時点の「検索に渡すもの一式」を控える（設計 §3.1.0.1）。
      //   材料は住所・地番・家屋番号・不動産番号＝処理時に検索へ渡るものと同じ。
      //   ⚠地番は秘匿情報なので**値は残さない**（sha256 の先頭32桁だけ）。
      propertyFingerprintHash: createHash("sha256")
        .update(fingerprintProperty(p))
        .digest("hex")
        .slice(0, 32),
```

`createMany` の `data` へ `propertyFingerprintHash: i.propertyFingerprintHash` を足す（`jobs.ts:237` の map）。

- [ ] **Step 4: 処理時に照合する**

`src/lib/registry-fetch/bulk/process.ts` の item 取得（`process.ts:132`）の select に列を足す:

```ts
    const item = await prisma.registryFetchJobItem.findFirst({
      where: { jobId, status: "pending" },
      orderBy: { createdAt: "asc" },
      include: {
        property: {
          select: {
            id: true,
            createdBy: true,
            assignedTo: true,
            // ⚠指紋の照合に使う（作成時と同じ材料で作り直す）。
            address: true,
            lotNumber: true,
            buildingNumber: true,
            realEstateNumber: true,
          },
        },
      },
    });
```

`property_unavailable` の判定（`process.ts:170`）の**直後**に足す:

```ts
      // ⚠順番待ちの間に「検索に渡すもの」が変わっていたら止める（設計 §3.1.0.1）。
      //   番号が消えた・読めなくなったのは既存の検査で拾えるが、**別の正しい値へ
      //   書き換わった**場合は素通りし、候補1件で自動購入まで進む。
      //   利用者が確認したのは書き換え前の内容なので、黙って買わない。
      if (item.propertyFingerprintHash) {
        const now = createHash("sha256")
          .update(fingerprintProperty(item.property))
          .digest("hex")
          .slice(0, 32);
        if (now !== item.propertyFingerprintHash) {
          await prisma.registryFetchJobItem.update({
            where: { id: item.id },
            data: {
              status: "skipped",
              // ⚠「消えた」とは別のコードにする（利用者のやることが違う＝
              //   前者はもう一度選ぶ・後者は番号を入れる）。
              errorCode: "identifier_changed",
              processedAt: new Date(),
            },
          });
          return { status: "skipped" as const };
        }
      }
```

⚠ 戻り値の形は**その関数の既存の return と揃える**（`process.ts` の他の skip 経路をコピーする）。ロック（`activeItemId`）を取った後なら**必ず解除する**（既存の finalize 経路を通す方が安全）。

- [ ] **Step 5: 通ることを確認する**

Run: `npx vitest run src/lib/registry-fetch/bulk/ && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 6: commit**

```bash
git add src/lib/registry-fetch/bulk/jobs.ts src/lib/registry-fetch/bulk/process.ts src/lib/registry-fetch/bulk/__tests__/
git commit -m "feat(registry): 一括は作成時の内容を指紋で固定し、変わっていたら買わずに止める"
```

---

## Task 6: 「何を取りに行くか」の分類（純関数）と preflight への配線

**Files:**
- Create: `src/lib/registry-fetch/registry-target.ts`
- Modify: `src/app/api/registry-fetch/preflight/route.ts:26-95`
- Test: `src/lib/registry-fetch/__tests__/registry-target.test.ts`

**Interfaces:**
- Consumes: Task 1 の `isReadableChiban`
- Produces:
  ```ts
  export type RegistryTargetKind = "land" | "building" | "none";
  export interface RegistryTarget {
    kind: RegistryTargetKind;
    /** 種別と食い違うときの警告文（止めない）。食い違わない・決められない種別なら null */
    mismatchWarning: string | null;
  }
  export function classifyRegistryTarget(input: {
    propertyType: string;
    lotNumber: string | null;
    buildingNumber: string | null;
  }): RegistryTarget;
  ```
  preflight の応答は `data[]` の**各要素に `target: RegistryTarget` が増える**
  （既存の `flagsById` と同じく、画面側が `data` から Map を組む。
  ⚠上位に別の map を足すと同じ情報が2か所に出て、片方だけ更新される）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/registry-fetch/__tests__/registry-target.test.ts`:

```ts
/**
 * 「何を取りに行くか」の分類（設計 §3.1.1 / §3.1.2）。
 *
 * ⚠種別では**止めない**（発注者判断 2026-08-12）。建物でも地番があれば土地の謄本は取れる。
 *   種別は警告の材料にしか使わない。
 */
import { describe, it, expect } from "vitest";
import { classifyRegistryTarget } from "@/lib/registry-fetch/registry-target";

const t = (
  propertyType: string,
  lotNumber: string | null,
  buildingNumber: string | null,
) => classifyRegistryTarget({ propertyType, lotNumber, buildingNumber });

describe("土地か建物かは持っている番号で決まる", () => {
  it("家屋番号があれば建物", () => {
    expect(t("house", "69-2", "12-3").kind).toBe("building");
  });

  it("家屋番号が無く地番があれば土地", () => {
    expect(t("land", "69-2", null).kind).toBe("land");
  });

  it("どちらも無ければ決められない", () => {
    expect(t("land", null, null).kind).toBe("none");
  });

  it("⚠読めない形の番号は「持っていない」と同じ扱い", () => {
    expect(t("land", "abc1x2", null).kind).toBe("none");
  });
});

describe("種別と食い違えば警告する（止めない）", () => {
  it("土地の物件に家屋番号が残っている → 建物を取る警告", () => {
    const r = t("land", "69-2", "12-3");
    expect(r.kind).toBe("building");
    expect(r.mismatchWarning).toContain("土地");
    expect(r.mismatchWarning).toContain("建物");
  });

  it("建物の物件で家屋番号が無い → 土地を取る警告", () => {
    const r = t("house", "69-2", null);
    expect(r.kind).toBe("land");
    expect(r.mismatchWarning).toContain("家屋番号");
  });

  it.each(["apartment_unit", "apartment_building", "apartment_block", "store", "office", "warehouse", "factory", "building", "unit"])(
    "%s も建物として扱う",
    (pt) => {
      expect(t(pt, "69-2", null).mismatchWarning).not.toBeNull();
    },
  );

  it("食い違わなければ警告は出ない", () => {
    expect(t("land", "69-2", null).mismatchWarning).toBeNull();
    expect(t("house", null, "12-3").mismatchWarning).toBeNull();
  });

  it.each(["parking", "other", "unknown"])(
    "%s は決められないので警告を出さない（何を取りに行くかは kind で分かる）",
    (pt) => {
      const r = t(pt, "69-2", null);
      expect(r.kind).toBe("land");
      expect(r.mismatchWarning).toBeNull();
    },
  );
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/registry-fetch/__tests__/registry-target.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

`src/lib/registry-fetch/registry-target.ts`:

```ts
/**
 * 「この物件で、いま何を取りに行くのか（土地/建物）」の分類。
 *
 * 設計: docs/superpowers/specs/2026-08-12-registry-chiban-popup-design.md §3.1.1 / §3.1.2
 *
 * ## 決め方
 * **持っている番号**で決まる（provider の判定と同じ）。物件の種別では決めない。
 *  - 家屋番号がある → 建物の登記
 *  - 家屋番号が無く地番がある → 土地の登記
 *  - どちらも無い（読めない形も含む）→ 決められない
 *
 * ## 種別は警告の材料
 * ⚠**止めない**（発注者判断 2026-08-12）。建物の物件でも、地番があれば土地の謄本は取れる。
 * 止めると「使えていたものが使えなくなる」。食い違うときに**見せて、それでも実行できる**。
 */
import { isReadableChiban } from "./chiban-input";

export type RegistryTargetKind = "land" | "building" | "none";

export interface RegistryTarget {
  kind: RegistryTargetKind;
  /** 種別と食い違うときの警告文。食い違わない／決められない種別なら null。 */
  mismatchWarning: string | null;
}

/** 建物として期待される種別。 */
const BUILDING_TYPES = new Set([
  "house",
  "apartment_unit",
  "apartment_building",
  "apartment_block",
  "store",
  "office",
  "warehouse",
  "factory",
  "building",
  "unit",
]);

/** 土地として期待される種別。 */
const LAND_TYPES = new Set(["land"]);

export function classifyRegistryTarget(input: {
  propertyType: string;
  lotNumber: string | null;
  buildingNumber: string | null;
}): RegistryTarget {
  const building = isReadableChiban(input.buildingNumber)
    ? input.buildingNumber
    : null;
  const lot = isReadableChiban(input.lotNumber) ? input.lotNumber : null;

  const kind: RegistryTargetKind = building ? "building" : lot ? "land" : "none";
  if (kind === "none") return { kind, mismatchWarning: null };

  if (kind === "building" && LAND_TYPES.has(input.propertyType)) {
    return {
      kind,
      mismatchWarning:
        "この物件は土地ですが、建物の登記を取得します（家屋番号が入っているため）",
    };
  }
  if (kind === "land" && BUILDING_TYPES.has(input.propertyType)) {
    return {
      kind,
      mismatchWarning:
        "この物件は建物ですが、土地の登記を取得します（建物の謄本には家屋番号が必要です）",
    };
  }
  // 駐車場・その他・不明はどちらもあり得るので警告を出さない。
  return { kind, mismatchWarning: null };
}
```

- [ ] **Step 4: preflight に載せる**

`src/app/api/registry-fetch/preflight/route.ts` の物件取得の select へ `propertyType` / `lotNumber` / `buildingNumber` を足し、**`data[]` の各要素へ `target` を追加**する（⚠上位に別の map を足さない＝同じ情報が2か所に出て片方だけ更新される）:

```ts
import { classifyRegistryTarget } from "@/lib/registry-fetch/registry-target";

// …物件取得の select へ propertyType / lotNumber / buildingNumber を足したうえで…
    const data = visible.map((p) => ({
      propertyId: p.id,
      registryObtained: p.registryStatus === "obtained",
      hasRegistryAttachment: attachedSet.has(p.id),
      hasOwners: p._count.propertyOwners > 0,
      // ⚠これは参考情報ではなく**買う対象そのもの**。画面はこれが読めるまで
      //   実行させない(fail closed・設計 §3.1.1)。
      //   ⚠返すのは分類と警告文だけ。地番の値そのものは返さない(秘匿)。
      target: classifyRegistryTarget({
        propertyType: p.propertyType,
        lotNumber: p.lotNumber,
        buildingNumber: p.buildingNumber,
      }),
    }));
```

⚠ **地番の値そのものは返さない**（分類と警告文だけ）。画面側は `flagsById` を組むのと同じループで `targetsById` を組む（Task 7）。

- [ ] **Step 5: 通ることを確認する**

Run: `npx vitest run src/lib/registry-fetch/__tests__/registry-target.test.ts src/lib/__tests__/registry-preflight-route.test.ts && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 6: PR-A の全ゲート**

```bash
npx tsc --noEmit
npx vitest run
npx eslint <変更ファイル>
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
```

- [ ] **Step 7: commit**

```bash
git add src/lib/registry-fetch/registry-target.ts src/app/api/registry-fetch/preflight/route.ts src/lib/registry-fetch/__tests__/registry-target.test.ts
git commit -m "feat(registry): 何を取りに行くか（土地/建物）の分類を preflight で返す"
```

---

# PR-B 画面

⚠ PR-A をマージしてから着手する。

## Task 7: 分類だけ fail closed にする

**Files:**
- Modify: `src/components/properties/registry-preflight-warnings.tsx:15-75`
- Test: `src/lib/__tests__/registry-preflight-ui.test.ts`（既存に追記）

**Interfaces:**
- Consumes: preflight の `data[].target`（Task 6）
- Produces: `RegistryPreflightState` に `targetsById: Map<string, RegistryTarget>` と `targetsUnavailable: boolean` が増える
  （`flagsById` を組むのと同じループで `targetsById` も組む）

**背景（実測）**: 既存は **preflight が失敗しても `settledKey` を確定させて実行ボタンを戻す**（`registry-preflight-warnings.tsx:57`）。これは「取得済み・所有者あり」のような参考情報なら妥当だが、**分類は買う対象そのもの**なので同じ扱いにできない。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/registry-preflight-ui.test.ts` に追記:

```ts
describe("⚠分類だけは fail closed（設計 §3.1.1）", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/properties/registry-preflight-warnings.tsx"),
    "utf8",
  );

  it("分類が取れていないことを表す state を持つ", () => {
    expect(src).toContain("targetsUnavailable");
  });

  it("失敗時に settledKey を確定させる経路でも、分類は「取れていない」ままにする", () => {
    // 取得済み・所有者ありは参考情報なので従来どおり戻してよいが、
    // 「土地と建物のどちらを買うのか」は分からないまま実行させない。
    expect(src).toMatch(/targetsUnavailable[\s\S]{0,200}true/);
  });

  it("分類を画面へ渡す", () => {
    expect(src).toContain("targetsById");
  });
});

describe("⚠分類が取れないと実行できない", () => {
  it.each([
    "src/components/properties/registry-location-search-button.tsx",
    "src/components/properties/registry-bulk-fetch-button.tsx",
  ])("%s の実行ボタンが targetsUnavailable でも disabled になる", (rel) => {
    const s = readFileSync(join(process.cwd(), rel), "utf8");
    expect(s).toContain("preflight.targetsUnavailable");
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/__tests__/registry-preflight-ui.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`registry-preflight-warnings.tsx`:

```ts
export interface RegistryPreflightState {
  flagsById: Map<string, RegistryPreflightFlags>;
  /** ⚠「何を取りに行くか」。参考情報ではなく買う対象そのもの。 */
  targetsById: Map<string, RegistryTarget>;
  failed: boolean;
  pending: boolean;
  /**
   * ⚠分類が取れていない。true の間は実行ボタンを押せないままにする（fail closed）。
   *   failed とは別に持つ理由: 取得済み・所有者ありのような参考情報の失敗は
   *   従来どおり「注意書きを出して実行できる」ままにしたいため。
   */
  targetsUnavailable: boolean;
}
```

成功時に `targetsById` を詰めて `targetsUnavailable=false`、失敗時（catch）に `targetsById` を空のまま `targetsUnavailable=true` にする。⚠ `settledKey` の扱いは**変えない**（pending の意味を壊さない）。

`active` が false→true になったときは `targetsUnavailable` を **true から始める**（`settledKey=null` と同じ扱い）。

- [ ] **Step 4: 実行ボタンへ配線する**

`registry-location-search-button.tsx:357` の `confirmObtain` の「取得する」:

```tsx
disabled={preflight.pending || preflight.targetsUnavailable}
```

`registry-bulk-fetch-button.tsx:161` の実行ボタンの disabled 条件へ `|| preflight.targetsUnavailable` を足す。

どちらも、`targetsUnavailable` のときは近くに一文を出す:

```tsx
{preflight.targetsUnavailable && (
  <p className="text-[11px] text-amber-700 dark:text-amber-300">
    何を取りに行くか確認できませんでした。もう一度お試しください。
  </p>
)}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npx vitest run src/lib/__tests__/registry-preflight-ui.test.ts && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 6: commit**

```bash
git add src/components/properties/registry-preflight-warnings.tsx src/components/properties/registry-location-search-button.tsx src/components/properties/registry-bulk-fetch-button.tsx src/lib/__tests__/registry-preflight-ui.test.ts
git commit -m "feat(registry): 何を取りに行くかが分からないうちは実行させない（fail closed）"
```

---

## Task 8: 分類と警告を確認パネルに出す

**Files:**
- Modify: `src/components/properties/registry-location-search-button.tsx:210, 357`
- Test: `src/components/properties/__tests__/registry-location-search-button.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `preflight.targetsById`（Task 7）

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("何を取りに行くかを見せる（設計 §3.1.1）", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/properties/registry-location-search-button.tsx"),
    "utf8",
  );

  it("取りに行くもの（土地/建物）を確認パネルに出す", () => {
    expect(src).toContain("土地の登記を取得します");
    expect(src).toContain("建物の登記を取得します");
  });

  it("種別と食い違う警告を出す（止めない）", () => {
    expect(src).toContain("mismatchWarning");
  });

  it("⚠警告は見せるだけで、ボタンを止める条件には使わない", () => {
    // 止めるのは pending と targetsUnavailable の2つだけ。
    expect(src).not.toMatch(/disabled=\{[^}]*mismatchWarning/);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/components/properties/__tests__/registry-location-search-button.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`confirmSearch`（210行付近）と `confirmObtain`（357行付近）の両方に差し込む:

```tsx
{(() => {
  const target = preflight.targetsById.get(propertyId);
  if (!target) return null;
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] text-blue-800 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300">
      {target.kind === "building"
        ? "建物の登記を取得します"
        : target.kind === "land"
          ? "土地の登記を取得します"
          : "取得する登記を決められません（地番か家屋番号が必要です）"}
      {/* ⚠警告は見せるだけ。止めない（発注者判断 2026-08-12）。 */}
      {target.mismatchWarning && (
        <span className="mt-1 block text-amber-700 dark:text-amber-300">
          ⚠ {target.mismatchWarning}
        </span>
      )}
    </div>
  );
})()}
```

⚠ `confirmSearch` には既存の disabled が無い（`registry-location-search-button.tsx:210`）。**そこは変えない**（検索は無料で、止めるのは取得の側）。

- [ ] **Step 4: 通ることを確認する**

Run: `npx vitest run src/components/properties/__tests__/ && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 5: commit**

```bash
git add src/components/properties/registry-location-search-button.tsx src/components/properties/__tests__/registry-location-search-button.test.ts
git commit -m "feat(registry): 何を取りに行くかと、種別との食い違いを確認パネルに出す"
```

---

## Task 9: ポップアップ本体（土地の入力欄）

**Files:**
- Create: `src/components/properties/registry-chiban-popup.tsx`
- Modify: `src/app/(dashboard)/properties/[id]/page.tsx:566`（`version` を渡す）
- Modify: `src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts`（新しい直接 fetch を許可リストへ）
- Test: `src/components/properties/__tests__/registry-chiban-popup.test.ts`

**Interfaces:**
- Consumes: `isReadableChiban`（Task 1）/ `RegistryTarget`（Task 6）
- Produces:
  ```tsx
  export function RegistryChibanPopup(props: {
    propertyId: string;
    propertyAddress: string;
    propertyVersion: number;
    gpsLat: number | null;
    gpsLng: number | null;
    canWriteProperty: boolean;
    /** 建物系の種別なら true（2つの道を出す） */
    isBuildingType: boolean;
    onSaved: () => void;
    onClose: () => void;
  }): JSX.Element
  ```

**背景（実測）**:
- 物件本体の PATCH を呼ぶ **api-client のラッパーは無い**（`src/lib/api-client.ts:128`）。既存は編集フォームが**素の fetch** で呼んでいる（`property-edit-form.tsx:247`）。⚠ 直接 fetch の call site は**走査型ガード**（`src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts:42`）で固定されているので、**許可リストへ追記が要る**。
- `updatePropertySchema` は **version が必須**（`src/lib/validators.ts:217`）。地番だけ送るときも `version` を同梱する。
- 謄本ボタンには現在 `version` を渡していない（`page.tsx:566`）。
- 409 は `VERSION_CONFLICT`（`route.ts:217`）で、**最新 version は返らない**（`api-helpers.ts:322`）→ 画面は「もう一度開き直してください」と案内する。

- [ ] **Step 1: 失敗するテストを書く**

`src/components/properties/__tests__/registry-chiban-popup.test.ts`:

```ts
/**
 * 地番を人が確認して入れるポップアップ（設計 §3.2 / §3.3 / §4.1 / §4.3）。
 *
 * jsdom が無いのでソース走査で固定する（このリポの UI テストの主流）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/components/properties/registry-chiban-popup.tsx"),
  "utf8",
);

describe("地図サービスへの導線", () => {
  it("座標があればその位置を開く（ズーム18）", () => {
    expect(src).toContain("minji-houmu.rmp.glbs.jp/view/chiban_search/map/#18/");
  });

  it("座標が無ければサービスのトップを開く（住所は渡さない）", () => {
    expect(src).toContain("minji-houmu.rmp.glbs.jp/view/chiban_search/map/");
  });

  it("⚠rel=noopener noreferrer（物件詳細のURLを外部へ渡さない）", () => {
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).toContain('target="_blank"');
  });

  it("⚠位置を外部へ渡すことを画面に書く（「送信されない」とは書かない）", () => {
    expect(src).toContain("地図サービスへ渡して開きます");
    expect(src).not.toContain("送信されません");
  });

  it("⚠中心の地番を写さないよう「該当の筆をクリック」と書く", () => {
    expect(src).toContain("該当の筆をクリック");
  });
});

describe("費用の書き分け（設計 §3.2）", () => {
  it("この画面では課金されないこと・課金は次の取得であることを書く", () => {
    expect(src).toContain("この画面の操作では課金されません");
    expect(src).toContain("課金は次の取得のとき");
  });
});

describe("保存（設計 §4.1）", () => {
  it("保存するのは lotNumber だけ（家屋番号を保存する口を作らない）", () => {
    expect(src).toContain("lotNumber");
    expect(src).not.toContain("buildingNumber:");
  });

  it("version を必ず同梱する（更新スキーマの必須項目）", () => {
    expect(src).toContain("version");
  });

  it("⚠保存しただけでは検索APIを呼ばない（確認パネルを経由する）", () => {
    expect(src).not.toContain("/registry/search");
    expect(src).toContain("onSaved");
  });

  it("409 は「開き直してください」と案内する（最新versionは返らない）", () => {
    expect(src).toContain("VERSION_CONFLICT");
  });
});

describe("入力の検査（設計 §4.3）", () => {
  it("同じ判定関数を使う（画面独自の正規表現を書かない）", () => {
    expect(src).toContain("isReadableChiban");
  });
});

describe("権限（設計 §4.1）", () => {
  it("地番を保存できない利用者には入力欄を出さず案内する", () => {
    expect(src).toContain("canWriteProperty");
    expect(src).toContain("地番の編集権限");
  });
});

describe("建物のとき（設計 §3.3）", () => {
  it("2つの道を出す", () => {
    expect(src).toContain("建物の登記を取る");
    expect(src).toContain("土地の登記を取る");
  });

  it("⚠建物の側は案内だけ（入力欄も保存も無い）", () => {
    expect(src).toContain("地番検索サービスの地図では分かりません");
  });
});

describe("秘匿（設計 §5）", () => {
  it("入力した地番を console へ出さない", () => {
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*chiban/i);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/components/properties/__tests__/registry-chiban-popup.test.ts`
Expected: FAIL（ファイルが無い）

- [ ] **Step 3: 実装する**

`src/components/properties/registry-chiban-popup.tsx` を作る。要点だけ抜粋（全体は上のテストが要求する文言をすべて含めること）:

```tsx
"use client";

import { useState } from "react";
import { isReadableChiban } from "@/lib/registry-fetch/chiban-input";

const CHIBAN_MAP_BASE = "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/";

/** ⚠ズーム18は筆界と地番が見える倍率（発注者の実機画面で確認済み・#15では出ない）。 */
function mapUrl(lat: number | null, lng: number | null): string {
  if (lat == null || lng == null) return CHIBAN_MAP_BASE;
  return `${CHIBAN_MAP_BASE}#18/${lat.toFixed(6)}/${lng.toFixed(6)}`;
}

export function RegistryChibanPopup({
  propertyId,
  propertyAddress,
  propertyVersion,
  gpsLat,
  gpsLng,
  canWriteProperty,
  isBuildingType,
  onSaved,
  onClose,
}: {
  propertyId: string;
  propertyAddress: string;
  propertyVersion: number;
  gpsLat: number | null;
  gpsLng: number | null;
  canWriteProperty: boolean;
  isBuildingType: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  // 建物系は「どちらを取るか」を先に選ばせる（設計 §3.3）。
  const [route, setRoute] = useState<"choose" | "land">(
    isBuildingType ? "choose" : "land",
  );
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = canWriteProperty && isReadableChiban(value) && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // ⚠物件本体の PATCH を呼ぶ共通ラッパーはこのリポに無い（編集フォームも素の fetch）。
      //   直接 fetch の call site は走査型ガードで固定されているので許可リストにも足すこと。
      const res = await fetch(`/api/properties/${propertyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // ⚠version は更新スキーマの必須項目。地番だけ送るときも必ず入れる。
        body: JSON.stringify({ version: propertyVersion, lotNumber: value.trim() }),
      });
      if (res.ok) {
        // ⚠ここで検索を投げない。既存の確認パネル（料金の確認）を必ず経由する。
        onSaved();
        return;
      }
      const body = await res.json().catch(() => null);
      const code = body?.error?.code;
      setError(
        code === "VERSION_CONFLICT"
          ? "他の担当者が先に更新しました。画面を開き直してからやり直してください。"
          : "保存できませんでした。入力を確認してもう一度お試しください。",
      );
    } catch {
      setError("保存できませんでした。通信の状態を確認してください。");
    } finally {
      setSaving(false);
    }
  }
  // …描画（テストが要求する文言をすべて含める）…
}
```

⚠ **描画に必ず入れる文言**（テストが固定する）:
- 「謄本は『地番』でしか取れません。住所の番号（住居表示）とは別のものです。」
- 物件の住所と**コピー**ボタン
- 「**この物件の位置を地図サービスへ渡して開きます**（法務省の無料サービス）」
- 「開いたら住所で検索 → 地図を拡大 → **該当の筆をクリック** → 出てきた地番をここへ入れてください」
- 「**この画面の操作では課金されません**（地番検索サービスは無料）。**課金は次の取得のとき**です」
- 権限が無いとき: 「地番を入力してから実行してください（**地番の編集権限**が必要です）」
- 建物系の「建物の登記を取る」: 「⚠家屋番号は**地番検索サービスの地図では分かりません**（地図が示すのは土地の地番です）。権利証・固定資産税の通知・過去の謄本などでご確認のうえ、物件の『家屋番号』欄に入力してから実行してください。」

- [ ] **Step 4: 走査型ガードの許可リストへ足す**

`src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts` の許可リストに
`src/components/properties/registry-chiban-popup.tsx` を追記し、**理由をコメントで書く**:

```ts
  // 物件本体の PATCH は共通ラッパーが無く、編集フォームも素の fetch で呼んでいる。
  // ポップアップも同じ形に揃える（新しいラッパーだけ1つ増やすと二重管理になる）。
  "src/components/properties/registry-chiban-popup.tsx",
```

- [ ] **Step 5: 物件詳細から version を渡す**

`src/app/(dashboard)/properties/[id]/page.tsx:566` の謄本ボタンへ `propertyVersion={property.version}` と `propertyAddress` / `gpsLat` / `gpsLng` / `canWriteProperty` を渡す。

⚠ 保存が成功したら **`fetchProperty()` を呼んで version を取り直す**（同じ画面で2回保存すると2回目が必ず 409 になるため）。

- [ ] **Step 6: 通ることを確認する**

Run: `npx vitest run src/components/properties/__tests__/registry-chiban-popup.test.ts src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 7: commit**

```bash
git add src/components/properties/registry-chiban-popup.tsx src/app/\(dashboard\)/properties/\[id\]/page.tsx src/lib/__tests__/permissions-direct-fetch-allowlist.test.ts src/components/properties/__tests__/registry-chiban-popup.test.ts
git commit -m "feat(registry): 地番を人が確認して入れるポップアップ"
```

---

## Task 10: ポップアップを所在検索の導線へ差し込む

**Files:**
- Modify: `src/components/properties/registry-location-search-button.tsx:35-100`
- Test: `src/components/properties/__tests__/registry-location-search-button.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `RegistryChibanPopup`（Task 9）/ `preflight.targetsById`（Task 6）

**背景（実測）**: 状態機械は `idle→confirmSearch→searching→results→confirmObtain→obtaining→done`＋`cancelled/error` の9状態（`registry-location-search-button.tsx:35`）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("ポップアップの出し方（設計 §3.1 / §7）", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/properties/registry-location-search-button.tsx"),
    "utf8",
  );

  it("番号が無いときだけ出す（kind === none）", () => {
    expect(src).toContain('=== "none"');
    expect(src).toContain("RegistryChibanPopup");
  });

  it("⚠保存したら確認パネルへ進む（検索を直接投げない）", () => {
    expect(src).toMatch(/onSaved[\s\S]{0,200}confirmSearch/);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/components/properties/__tests__/registry-location-search-button.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

起動ボタンの `onClick` で、`preflight.targetsById.get(propertyId)?.kind === "none"` なら
`setState("chibanPopup")` にし、そうでなければ従来どおり `setState("confirmSearch")` にする。

```tsx
{state === "chibanPopup" && (
  <RegistryChibanPopup
    propertyId={propertyId}
    propertyAddress={propertyAddress}
    propertyVersion={propertyVersion}
    gpsLat={gpsLat}
    gpsLng={gpsLng}
    canWriteProperty={canWriteProperty}
    isBuildingType={isBuildingType}
    onSaved={() => {
      // ⚠ここで検索を投げない。料金の確認を必ず経由する（設計 §4.1）。
      onPropertyRefresh();
      setState("confirmSearch");
    }}
    onClose={() => setState("idle")}
  />
)}
```

⚠ 状態を1つ足すので、**preflight の active 条件**（`registry-location-search-button.tsx:72`）を見直す。`chibanPopup` では preflight を active にしない（まだ買う段階ではない）。

- [ ] **Step 4: 通ることを確認する**

Run: `npx vitest run src/components/properties/__tests__/ src/lib/__tests__/registry-preflight-ui.test.ts && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 5: commit**

```bash
git add src/components/properties/registry-location-search-button.tsx src/components/properties/__tests__/registry-location-search-button.test.ts
git commit -m "feat(registry): 番号が無い物件ではポップアップを先に出す"
```

---

## Task 11: 一括の除外理由を画面に出す + 全ゲート

**Files:**
- Modify: `src/app/(dashboard)/properties/registry-fetch/[jobId]/page.tsx:227-290`
- Test: `src/lib/__tests__/registry-bulk-progress-reasons.test.ts`（新規）

**背景（実測）**: 進捗 API は `items[]` を `errorCode` 付きで**既に返している**（`bulk/jobs.ts:337`）が、進捗画面は `counts` のタイル5つしか描画しておらず **`progress.items` を一度も参照していない**（`[jobId]/page.tsx:227`）＝どの物件がなぜ対象外になったか出ていない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
/**
 * 一括で外れた物件を「黙って減らさない」（設計 §3.1.0）。
 * 理由によって利用者のやることが違うので、すべてを「地番が未入力」と書かない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/properties/registry-fetch/[jobId]/page.tsx"),
  "utf8",
);

describe("除外理由の内訳", () => {
  it("items を参照する（件数タイルだけにしない）", () => {
    expect(src).toContain("progress.items");
  });

  it.each([
    ["missing_identifier", "地番・家屋番号が未入力"],
    ["malformed_identifier", "地番/家屋番号の書き方"],
    ["insufficient_location", "住所が未入力"],
    ["has_real_estate_number", "所在検索の対象外"],
    ["identifier_changed", "内容が変わりました"],
    ["ambiguous_candidate", "候補が複数"],
    ["no_candidate", "候補が見つかりません"],
  ])("%s の理由文言を持つ", (_code, label) => {
    expect(src).toContain(label);
  });

  it("⚠不動産番号は「入力の不備」ではなく「対象外」として書く", () => {
    expect(src).toContain("所在検索の対象外");
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run src/lib/__tests__/registry-bulk-progress-reasons.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

進捗画面に理由の対応表と内訳の描画を足す:

```tsx
/** ⚠理由によって利用者のやることが違う。すべてを「地番が未入力」と書かない（設計 §3.1.0）。 */
const ITEM_REASON_LABEL: Record<string, string> = {
  missing_identifier: "地番・家屋番号が未入力",
  malformed_identifier: "地番/家屋番号の書き方",
  insufficient_location: "住所が未入力",
  has_real_estate_number: "所在検索の対象外",
  identifier_changed: "内容が変わりました（確認して選び直してください）",
  ambiguous_candidate: "候補が複数（手動で選んでください）",
  no_candidate: "候補が見つかりません",
  property_unavailable: "物件を参照できません",
};

// …描画…
{(() => {
  const counts = new Map<string, number>();
  for (const it of progress.items ?? []) {
    if (it.status !== "skipped" || !it.errorCode) continue;
    counts.set(it.errorCode, (counts.get(it.errorCode) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-300">
      {[...counts.entries()].map(([code, n]) => (
        <li key={code}>
          {ITEM_REASON_LABEL[code] ?? code}: {n}件
        </li>
      ))}
    </ul>
  );
})()}
```

⚠ **物件の住所や地番は出さない**（秘匿・設計 §5）。件数と理由だけ。

- [ ] **Step 4: 全ゲート**

```bash
npx tsc --noEmit
npx vitest run
npx eslint <変更ファイル>
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
```

- [ ] **Step 5: 提出前レビュー**

`feature-dev:code-reviewer` にホットスポットを明示して依頼:
**課金の経路（`locationCandidate` 合流・二重課金台帳・501）／判定関数が1本になっているか／fail closed の抜け／秘匿情報の漏れ（log・監査・実況・画面）／一括で人を待たないこと／既存データが新しい検査で落ちないこと**

- [ ] **Step 6: commit + PR**

```bash
git add -A
git commit -m "feat(registry): 一括で外れた物件の理由を内訳で出す"
```

---

## Self-Review（この計画を書いたあとの確認）

**1. 設計書の各節に対応するタスク**

| 設計書 | タスク |
|---|---|
| §3.1.0 一括ではポップアップを出さない | Task 11（除外理由の表示）+ 既存挙動（変更なし） |
| §3.1.0.1 作成時に指紋を固定 | Task 5 |
| §3.1.1 何を取りに行くか + 警告 + fail closed | Task 6・7・8 |
| §3.1.2 番号で土地/建物を決める・渡すのは1つ | Task 2 |
| §3.2 ポップアップの中身 | Task 9 |
| §3.3 建物の2つの道 | Task 9 |
| §4.1 保存してから検索 | Task 9・10 |
| §4.2 その場限りの地番を渡さない | 設計どおり**何も作らない**（Task 9 は PATCH のみ） |
| §4.3 入力の検査 | Task 1 |
| §4.4 サーバー側でも同じ検査 | Task 2・3・4 |
| §5 壊してはいけない安全装置 | Task 4（課金の手前で止める）・Task 11 のレビュー観点 |
| §6 文言の整合 | Task 3（422 の文言）+ Task 9 |
| §7 テスト方針 | 各タスクの Step 1 |

**2. 埋めていない穴**: 無し（「TBD」「適切に」の類は使っていない）。

**3. 型の一貫性**: `isReadableChiban` / `classifyRegistryTarget` / `RegistryTarget` / `targetsById` / `targetsUnavailable` / `identifier_changed` は Task 1・6・7・5 で定義したものを後続でそのまま使っている。

## ⚠実装中に必ず確認すること（実測で分かった落とし穴）

1. **`normalizeLotNumber` は3つある**。`purchase-safety.ts:108`（鍵用・非export）/ `address-normalizer.ts:140`（重複候補用・export）/ そして今回触る `normalizeChibanForDialog`。**取り違えると鍵が変わって二重課金ガードが壊れる**。
2. **候補キャッシュは TTL 10分・プロセス内 Map**（`candidate-cache.ts:141`）。ポップアップで地番を保存すると**指紋が変わって候補が無効化される**（`search.ts:354` で 409）。だから「保存 → 検索 → 候補 → 取得」の順でなければならない。
3. **一括の進捗は画面駆動のループ**（`[jobId]/page.tsx:60`）。サーバー常駐は無い。人を待つ仕組みを足さない。
4. **`confirmSearch` には preflight も disabled も無い**（`registry-location-search-button.tsx:210`）。ここを勝手に止めない（検索は無料）。
5. **ChangeLog には地番の生値が入る**（`api/properties/[id]/change-logs/route.ts:24`）。これは既存の仕様で、秘匿の規約は log / AuditLog / error response が対象。**変更しない**。
6. **`updatePropertySchema` は version 必須**（`validators.ts:217`）。地番だけ送るときも入れる。
7. **一括の item に `purchaseKeyHash` という未使用列もある**（`schema.prisma:1315`）。⚠ **AuditLog detail の同名キーとは別物**。今回は触らない。
