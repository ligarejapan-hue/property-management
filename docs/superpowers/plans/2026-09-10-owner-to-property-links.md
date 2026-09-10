# 段1: 所有者から物件へのリンク Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有者補正候補と所有者詳細から、その所有者の物件の基本情報へ辿り着けるようにする。

**Architecture:** 物件一覧の where 組み立て（`buildPropertyListWhere`・一覧とCSV出力の単一定義元）に `ownerId` 条件を1つ足し、画面側はその1本の絞り込みに乗る。「件数からどのリンク先になるか」の分岐は純関数 `resolveOwnerPropertyLink` に隔離し、画面は結果を表示するだけにする。新しいAPIエンドポイントは作らない。

**Tech Stack:** Next.js 16 (App Router) / TypeScript / Prisma / zod / vitest（env=node・jsdomなし＝画面はソース走査型テストで検証する既存慣行に従う）

**Spec:** `docs/superpowers/specs/2026-09-10-source-pdf-access-design.md` の §4（段1）

## Global Constraints

- **担当者スコープを壊さない。** `ownerId` 絞り込みは `where.OR`（keyword条件）ではなく `where.AND` に足す。OR に混ぜると「keyword に一致すれば担当外の物件も返る」穴になる。`propertyVisibilityScopeWhere`（field_staff スコープ）と同時に効くこと。
- **URLに載せてよいのは所有者IDだけ。** 氏名・住所・法人番号・externalLinkKey は URL にもリンク文字列にも絶対に入れない（既存の明文ルール）。
- **判定は純関数へ隔離する。** 件数とIDの分岐を画面のJSXに書かない。走査型（文字列）テストでは分岐の網羅を守れないため。
- **走査型テストは改行をLFに正規化してから比較する。** 手元（CRLF）とCIで判定が変わる既知の罠。
- **新しいAPIエンドポイントを作らない。** 所有者詳細の物件一覧も既存の `/api/properties` に `ownerId` を付けて呼ぶ（権限・担当者スコープを自動的に継承させるため）。
- **専用の作業用フォルダ（worktree）で作業する。** 1タスク1worktree。
- 完了と言う前に **フルのテストスイート**（`npx vitest run`）が緑であることを確認する。

---

### Task 1: 物件一覧に `ownerId` 絞り込みを足す

**Files:**
- Modify: `src/lib/validators.ts:65-115`（`propertyListQuerySchema`）
- Modify: `src/lib/property-list-query.ts:70-87`（destructure）と `:196` 付近（`resendOnly` ブロックの直後）
- Test: `src/lib/__tests__/property-list-query-owner.test.ts`（新規）

**Interfaces:**
- Consumes: 既存 `buildPropertyListWhere(query, session, client?)` / `propertyListQuerySchema`
- Produces: クエリパラメータ `ownerId`（UUID文字列）。`where.AND` に `{ propertyOwners: { some: { ownerId } } }` が入る。後続タスクはこの1本に乗る。

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/lib/__tests__/property-list-query-owner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。
const adminSession = { id: "u1", role: "admin" } as never;
const fieldSession = { id: "u9", role: "field_staff" } as never;
const OWNER = "11111111-1111-4111-8111-111111111111";

describe("buildPropertyListWhere ownerId フィルタ", () => {
  it("ownerId 指定で propertyOwners.some.ownerId を AND に足す", async () => {
    const query = propertyListQuerySchema.parse({ ownerId: OWNER });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
  });

  it("ownerId 未指定なら所有者条件を足さない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(JSON.stringify(where.AND ?? [])).not.toContain("propertyOwners");
  });

  it("keyword と併用しても OR ではなく AND に入る(担当外の物件が漏れない)", async () => {
    const query = propertyListQuerySchema.parse({
      ownerId: OWNER,
      keyword: "世田谷",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(JSON.stringify(where.OR ?? [])).not.toContain("propertyOwners");
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
  });

  it("field_staff のスコープと同時に効く(片方に置き換わらない)", async () => {
    const query = propertyListQuerySchema.parse({ ownerId: OWNER });
    const { where } = await buildPropertyListWhere(query, fieldSession);
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
    expect(where.AND).toContainEqual({
      OR: [{ createdBy: "u9" }, { assignedTo: "u9" }],
    });
  });

  it("UUID でない ownerId は schema が弾く", () => {
    expect(() =>
      propertyListQuerySchema.parse({ ownerId: "'; drop table--" }),
    ).toThrow();
  });

  it("空文字の ownerId は schema が弾く(絞り込み無しに化けさせない)", () => {
    expect(() => propertyListQuerySchema.parse({ ownerId: "" })).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run src/lib/__tests__/property-list-query-owner.test.ts`
Expected: FAIL。`where.AND` に `propertyOwners` が無い（`ownerId` が schema で落とされて未定義のまま）。

- [ ] **Step 3: schema に `ownerId` を足す**

`src/lib/validators.ts` の `propertyListQuerySchema` 内、`assignedTo: z.string().uuid().optional(),` の直後に追加:

```ts
  // 所有者で絞り込む。所有者詳細・所有者補正候補からのリンク専用で、一覧画面に入力欄は無い。
  // ⚠UUID 以外は schema で弾く＝where に入るのは検証済みの値だけ。空文字は
  //   「絞り込み無し」に化けると別人の物件を見せてしまうため通さない。
  ownerId: z.string().uuid().optional(),
```

- [ ] **Step 4: where 組み立てに条件を足す**

`src/lib/property-list-query.ts` の destructure（`assignedTo,` の直後）に追加:

```ts
    ownerId,
```

同ファイルの `resendOnly === "1"` ブロックの直後（`return {` の手前）に追加:

```ts
  // 所有者で絞り込む(所有者詳細・所有者補正候補からのリンク)。
  // ⚠where.OR(keyword 条件)と混ぜず AND に足す。OR に入れると
  //   「keyword に一致すれば別の所有者の物件まで返る」穴になる
  //   (field_staff スコープを AND にしているのと同じ理由)。
  if (ownerId) {
    where.AND = [
      ...(where.AND ?? []),
      { propertyOwners: { some: { ownerId } } },
    ];
  }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run src/lib/__tests__/property-list-query-owner.test.ts`
Expected: PASS（6件）

- [ ] **Step 6: CSV出力側が壊れていないことを確認する**

Run: `npx vitest run src/lib/__tests__/property-list-query-undeliverable.test.ts src/lib/__tests__/property-list-query-resend.test.ts src/lib/__tests__/property-list-query-property-types.test.ts src/lib/__tests__/property-list-query-dm-send-count.test.ts src/lib/__tests__/property-list-query-date-tz.test.ts`
Expected: すべて PASS（既存の絞り込みに影響していないこと）

- [ ] **Step 7: コミット**

```bash
git add src/lib/validators.ts src/lib/property-list-query.ts src/lib/__tests__/property-list-query-owner.test.ts
git commit -m "feat(properties): 物件一覧に所有者での絞り込みを追加"
```

---

### Task 2: リンク先を決める純関数

**Files:**
- Create: `src/lib/owner-property-link.ts`
- Test: `src/lib/__tests__/owner-property-link.test.ts`（新規）

**Interfaces:**
- Consumes: なし（他に依存しない純関数）
- Produces:
  - `type OwnerPropertyLink = { kind: "none" } | { kind: "single"; href: string } | { kind: "many"; href: string }`
  - `resolveOwnerPropertyLink(input: { ownerId: string; propertyOwnerCount: number; singlePropertyId: string | null }): OwnerPropertyLink`
  - `pickSinglePropertyId(rows: ReadonlyArray<{ propertyId: string }>): string | null`

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/lib/__tests__/owner-property-link.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveOwnerPropertyLink,
  pickSinglePropertyId,
} from "../owner-property-link";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROP = "22222222-2222-4222-8222-222222222222";

describe("resolveOwnerPropertyLink", () => {
  // 件数 × 物件IDの有無 を総当たりで固定する。
  // 画面側に分岐を書くと壊れたリンク(/properties/undefined)が出るため、
  // ここで全組み合わせの結論を決めきる。
  const counts = [-1, 0, 1, 2, 3, 999];
  const ids: Array<string | null> = [null, PROP];

  it("すべての組み合わせで kind と href が矛盾しない", () => {
    for (const propertyOwnerCount of counts) {
      for (const singlePropertyId of ids) {
        const r = resolveOwnerPropertyLink({
          ownerId: OWNER,
          propertyOwnerCount,
          singlePropertyId,
        });
        if (propertyOwnerCount <= 0) {
          expect(r).toEqual({ kind: "none" });
          continue;
        }
        if (propertyOwnerCount === 1 && singlePropertyId !== null) {
          expect(r).toEqual({ kind: "single", href: `/properties/${PROP}` });
          continue;
        }
        expect(r.kind).toBe("many");
        expect((r as { href: string }).href).toBe(
          `/properties?ownerId=${OWNER}`,
        );
      }
    }
  });

  it("1件でも物件IDが分からなければ一覧へ逃がす(壊れたリンクを作らない)", () => {
    const r = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 1,
      singlePropertyId: null,
    });
    expect(r.kind).toBe("many");
  });

  it("0件はリンクにしない", () => {
    expect(
      resolveOwnerPropertyLink({
        ownerId: OWNER,
        propertyOwnerCount: 0,
        singlePropertyId: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("ownerId が空なら none(空の絞り込みで全件を見せない)", () => {
    expect(
      resolveOwnerPropertyLink({
        ownerId: "",
        propertyOwnerCount: 3,
        singlePropertyId: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("href に含まれるのは所有者IDと物件IDだけ(氏名・住所を載せない)", () => {
    const many = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 5,
      singlePropertyId: null,
    }) as { href: string };
    const single = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 1,
      singlePropertyId: PROP,
    }) as { href: string };
    expect(many.href).toBe(`/properties?ownerId=${OWNER}`);
    expect(single.href).toBe(`/properties/${PROP}`);
  });
});

describe("pickSinglePropertyId", () => {
  it("ちょうど1件のときだけ物件IDを返す", () => {
    expect(pickSinglePropertyId([])).toBeNull();
    expect(pickSinglePropertyId([{ propertyId: PROP }])).toBe(PROP);
    expect(
      pickSinglePropertyId([{ propertyId: PROP }, { propertyId: "x" }]),
    ).toBeNull();
    expect(
      pickSinglePropertyId([
        { propertyId: PROP },
        { propertyId: "x" },
        { propertyId: "y" },
      ]),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run src/lib/__tests__/owner-property-link.test.ts`
Expected: FAIL（`Cannot find module '../owner-property-link'`）

- [ ] **Step 3: 純関数を実装する**

新規ファイル `src/lib/owner-property-link.ts`:

```ts
/**
 * 所有者から物件へのリンク先を決める純関数。
 *
 * 画面(所有者補正候補・所有者詳細)は結果を表示するだけにし、分岐はここに集約する。
 * 3通りしかないが、**件数と物件IDが食い違う場合**を画面側で場当たりに扱うと
 * `/properties/undefined` のような壊れたリンクが出る。判定を1箇所に閉じ込める。
 *
 * href に載せてよいのは所有者ID・物件IDだけ。氏名/住所/法人番号/externalLinkKey は
 * URL に絶対に入れない(既存の明文ルール)。
 */

export type OwnerPropertyLink =
  | { kind: "none" }
  | { kind: "single"; href: string }
  | { kind: "many"; href: string };

export interface OwnerPropertyLinkInput {
  ownerId: string;
  propertyOwnerCount: number;
  /** 紐づきがちょうど1件のときの物件ID。分からなければ null。 */
  singlePropertyId: string | null;
}

export function resolveOwnerPropertyLink(
  input: OwnerPropertyLinkInput,
): OwnerPropertyLink {
  const { ownerId, propertyOwnerCount, singlePropertyId } = input;
  // ownerId が空だと `?ownerId=` になり、絞り込み無しの全件一覧を
  // 「この所有者の物件」として見せてしまう。リンクにしない。
  if (ownerId === "") return { kind: "none" };
  if (propertyOwnerCount <= 0) return { kind: "none" };
  if (propertyOwnerCount === 1 && singlePropertyId !== null) {
    return { kind: "single", href: `/properties/${singlePropertyId}` };
  }
  // 1件なのに物件IDが分からない場合もここに落とす(担当外で読めない等)。
  // 壊れたリンクを出すより、絞り込んだ一覧へ逃がす方が安全。
  return {
    kind: "many",
    href: `/properties?ownerId=${encodeURIComponent(ownerId)}`,
  };
}

/**
 * 紐づき物件が「ちょうど1件」のときだけ物件IDを返す。
 * 呼び出し側は `take: 2` で2件だけ読めば足りる(1件か2件以上かの判別に十分)。
 */
export function pickSinglePropertyId(
  rows: ReadonlyArray<{ propertyId: string }>,
): string | null {
  return rows.length === 1 ? rows[0].propertyId : null;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run src/lib/__tests__/owner-property-link.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: コミット**

```bash
git add src/lib/owner-property-link.ts src/lib/__tests__/owner-property-link.test.ts
git commit -m "feat(owners): 所有者から物件へのリンク先を決める純関数を追加"
```

---

### Task 3: 物件一覧ページが `ownerId` を受け取って絞り込み中だと示す

**Files:**
- Modify: `src/app/(dashboard)/properties/page.tsx`（`sp.get` 群・`buildFilterParams`:362-382・URL同期 useEffect:585-605・絞り込み表示部）
- Modify: `src/lib/api-client.ts:72-100`（mock 分岐）
- Test: `src/app/(dashboard)/properties/__tests__/owner-filter.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: Task 1 の `ownerId` クエリパラメータ
- Produces: `/properties?ownerId=<uuid>` が「その所有者の物件だけ」を表示し、解除ボタンで全件に戻る。Task 4・Task 5 のリンク先がこれ。

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/app/(dashboard)/properties/__tests__/owner-filter.test.ts`:

```ts
/**
 * 物件一覧の「所有者で絞り込み」の配線テスト。
 * vitest は env=node(jsdom なし)のため、リポ慣行に従いソース文字列で検証する。
 * ⚠改行を LF に正規化してから比較する(手元 CRLF と CI で判定が変わるため)。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

describe("物件一覧の所有者絞り込み", () => {
  it("URL の ownerId を初期値として読む", () => {
    expect(src).toContain('sp.get("ownerId")');
  });

  it("API へ渡す条件に ownerId を載せる", () => {
    const build = src.match(
      /const buildFilterParams = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    );
    expect(build).not.toBeNull();
    expect(build![0]).toContain("params.ownerId = ownerFilter");
  });

  it("URL 同期にも ownerId を載せる(再読み込みで絞り込みが消えない)", () => {
    expect(src).toContain('params.set("ownerId", ownerFilter)');
  });

  it("絞り込み中であることを画面に出し、解除できる", () => {
    expect(src).toContain("この所有者の物件だけを表示しています");
    expect(src).toContain("絞り込みを解除");
  });

  it("所有者の氏名・住所を URL にも画面の絞り込み表示にも出さない", () => {
    const chip = src.slice(
      src.indexOf("この所有者の物件だけを表示しています") - 400,
      src.indexOf("この所有者の物件だけを表示しています") + 400,
    );
    expect(chip).not.toContain("ownerName");
    expect(chip).not.toContain("ownerAddress");
  });
});

describe("mock モードの所有者絞り込み", () => {
  const client = readFileSync(
    resolve(__dirname, "../../../../lib/api-client.ts"),
    "utf-8",
  ).replace(/\r\n/g, "\n");

  it("mock データには所有者の紐づきが無いので空を返す(全件を他人の物件として見せない)", () => {
    expect(client).toContain("if (params.ownerId)");
    expect(client).toContain("filtered = [];");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run "src/app/(dashboard)/properties/__tests__/owner-filter.test.ts"`
Expected: FAIL（`sp.get("ownerId")` が無い）

- [ ] **Step 3: 一覧ページに状態を足す**

`src/app/(dashboard)/properties/page.tsx`、`const [assigneeFilter, setAssigneeFilter] = useState(() => sp.get("assignedTo") ?? "");`（155行目付近）の直後に追加:

```ts
  // 所有者での絞り込み。所有者詳細・所有者補正候補からのリンクで入ってくる値で、
  // この画面に入力欄は無い(解除だけできる)。
  const [ownerFilter, setOwnerFilter] = useState(() => sp.get("ownerId") ?? "");
```

- [ ] **Step 4: 条件の組み立てとURL同期に足す**

`buildFilterParams` の中（`if (assigneeFilter) params.assignedTo = assigneeFilter;` の直後）に追加し、依存配列にも `ownerFilter` を足す:

```ts
    if (ownerFilter) params.ownerId = ownerFilter;
```

URL同期の `useEffect`（`if (assigneeFilter) params.set("assignedTo", assigneeFilter);` の直後）に追加し、依存配列にも `ownerFilter` を足す:

```ts
    if (ownerFilter) params.set("ownerId", ownerFilter);
```

- [ ] **Step 5: 絞り込み中の表示と解除ボタンを足す**

一覧のヘッダ直下（検索欄より前・`<FilterPanel` の手前）に追加:

```tsx
      {ownerFilter && (
        <div
          data-testid="owner-filter-notice"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>この所有者の物件だけを表示しています</span>
          <button
            type="button"
            onClick={() => {
              setOwnerFilter("");
              setPage(1);
            }}
            className="rounded-md border border-blue-300 px-2 py-1 text-xs hover:bg-blue-100 dark:border-blue-800 dark:hover:bg-blue-900/40"
          >
            絞り込みを解除
          </button>
        </div>
      )}
```

- [ ] **Step 6: mock モードで嘘をつかないようにする**

`src/lib/api-client.ts` の `fetchProperties` の mock 分岐、`let filtered = [...MOCK_PROPERTIES];` の直後に追加:

```ts
    // mock データは所有者との紐づきを持たない。ここで全件を返すと
    // 「この所有者の物件」として無関係な物件を見せてしまうので空にする。
    if (params.ownerId) {
      filtered = [];
    }
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `npx vitest run "src/app/(dashboard)/properties/__tests__/owner-filter.test.ts"`
Expected: PASS（6件）

- [ ] **Step 8: 既存の一覧テストが壊れていないことを確認する**

Run: `npx vitest run "src/app/(dashboard)/properties/__tests__"`
Expected: すべて PASS

- [ ] **Step 9: コミット**

```bash
git add "src/app/(dashboard)/properties/page.tsx" src/lib/api-client.ts "src/app/(dashboard)/properties/__tests__/owner-filter.test.ts"
git commit -m "feat(properties): 一覧を所有者で絞り込めるようにし解除できるようにする"
```

---

### Task 4: 補正候補APIが「紐づきが1件のときの物件ID」を返す

**Files:**
- Modify: `src/app/api/admin/owners/correction-candidates/route.ts:30-55`（`Candidate` 型）・`:119-130`（select）・`:192-278`（候補の組み立て）
- Test: `src/app/api/admin/owners/correction-candidates/__tests__/single-property-id.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: Task 2 の `pickSinglePropertyId`
- Produces: 補正候補APIのレスポンス各件に `singlePropertyId: string | null` が付く。Task 5 が使う。

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/app/api/admin/owners/correction-candidates/__tests__/single-property-id.test.ts`:

```ts
/**
 * 補正候補APIが「紐づきがちょうど1件のときの物件ID」を返す配線テスト。
 * 判定そのものは pickSinglePropertyId の単体テストが担保する(owner-property-link.test.ts)。
 * ここでは *配線* だけを見る。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../route.ts"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

describe("補正候補APIの singlePropertyId", () => {
  it("Candidate 型に singlePropertyId がある", () => {
    expect(src).toContain("singlePropertyId: string | null;");
  });

  it("物件の紐づきを2件だけ読む(1件か2件以上かの判別に十分・全件読まない)", () => {
    expect(src).toContain(
      "propertyOwners: { select: { propertyId: true }, take: 2 }",
    );
  });

  it("判定は純関数 pickSinglePropertyId に任せる(route に分岐を書かない)", () => {
    expect(src).toContain(
      'import { pickSinglePropertyId } from "@/lib/owner-property-link"',
    );
    expect(src).toContain("pickSinglePropertyId(owner.propertyOwners)");
  });

  it("レスポンスに singlePropertyId を載せる", () => {
    expect(src).toContain("singlePropertyId,");
  });

  it("物件の住所など物件の中身は読まない(IDだけ)", () => {
    const sel = src.match(/propertyOwners: \{ select: \{[^}]*\}/);
    expect(sel).not.toBeNull();
    expect(sel![0]).not.toContain("address");
    expect(sel![0]).not.toContain("property:");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run "src/app/api/admin/owners/correction-candidates/__tests__/single-property-id.test.ts"`
Expected: FAIL（`singlePropertyId` が無い）

- [ ] **Step 3: 型に足す**

`src/app/api/admin/owners/correction-candidates/route.ts` の `type Candidate` 内、`propertyOwnerCount: number;` の直後に追加:

```ts
  /**
   * 紐づき物件がちょうど1件のときの物件ID。0件・2件以上は null。
   * 画面はこの値をリンク先の判定(resolveOwnerPropertyLink)に渡すだけで、
   * 物件の住所などの中身はここでは一切返さない。
   */
  singlePropertyId: string | null;
```

- [ ] **Step 4: import と select を足す**

同ファイルの import 群に追加:

```ts
import { pickSinglePropertyId } from "@/lib/owner-property-link";
```

owners の `select` 内、`_count: { select: { propertyOwners: true } },` の直後に追加:

```ts
        // 紐づきがちょうど1件のときだけ物件IDを返すため、2件だけ読む。
        // (1件か2件以上かの判別にはこれで足りる。全件読むと重い)
        propertyOwners: { select: { propertyId: true }, take: 2 },
```

- [ ] **Step 5: 候補の組み立てに足す**

`const candidates: Candidate[] = owners.map((owner): Candidate => {` の中、`const propertyOwnerCount = owner._count.propertyOwners;` の直後に追加:

```ts
      const singlePropertyId = pickSinglePropertyId(owner.propertyOwners);
```

同関数の `return {` の中、`propertyOwnerCount,` の直後に追加:

```ts
        singlePropertyId,
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx vitest run "src/app/api/admin/owners/correction-candidates/__tests__/single-property-id.test.ts"`
Expected: PASS（5件）

- [ ] **Step 7: 型検査を通す**

Run: `npx tsc --noEmit`
Expected: エラーなし（`Candidate` を組み立てている箇所がすべて `singlePropertyId` を持つこと）

- [ ] **Step 8: コミット**

```bash
git add src/app/api/admin/owners/correction-candidates/route.ts "src/app/api/admin/owners/correction-candidates/__tests__/single-property-id.test.ts"
git commit -m "feat(owners): 補正候補APIが紐づき1件のときの物件IDを返す"
```

---

### Task 5: 補正候補画面の「物件」列を押せるようにする

**Files:**
- Create: `src/components/owners/owner-property-count-cell.tsx`
- Modify: `src/app/(dashboard)/admin/owners/correction/page.tsx:488-497`（住所なしタブの表）と `:857`（重複グループの表）
- Test: `src/app/(dashboard)/admin/owners/correction/__tests__/property-link.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: Task 2 の `resolveOwnerPropertyLink`、Task 4 の `singlePropertyId`、Task 3 の `/properties?ownerId=`
- Produces: `OwnerPropertyCountCell` コンポーネント（`ownerId` / `count` / `singlePropertyId` / `zeroClassName` を受け取る）

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/app/(dashboard)/admin/owners/correction/__tests__/property-link.test.ts`:

```ts
/**
 * 補正候補画面の「物件」列がリンクになっていることの配線テスト。
 * 件数からリンク先を決める判定は resolveOwnerPropertyLink の単体テストが担保する。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const page = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);
const cell = readFileSync(
  resolve(__dirname, "../../../../../../components/owners/owner-property-count-cell.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("補正候補画面の物件リンク", () => {
  it("物件件数のセルを共通部品にしている(2箇所とも)", () => {
    const uses = page.match(/<OwnerPropertyCountCell/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("部品を import している", () => {
    expect(page).toContain(
      'import { OwnerPropertyCountCell } from "@/components/owners/owner-property-count-cell"',
    );
  });

  it("生の件数だけを描く箇所が残っていない", () => {
    expect(page).not.toContain("{m.propertyOwnerCount}");
    expect(page).not.toContain("{c.propertyOwnerCount}");
  });

  it("住所なしタブの 0 件は今までどおり橙色で目立たせる", () => {
    expect(page).toContain('zeroClassName="font-medium text-orange-600"');
  });
});

describe("物件件数セルの部品", () => {
  it("リンク先の判定は純関数に任せる", () => {
    expect(cell).toContain(
      'import { resolveOwnerPropertyLink } from "@/lib/owner-property-link"',
    );
    expect(cell).toContain("resolveOwnerPropertyLink(");
  });

  it("none のときはリンクにしない", () => {
    expect(cell).toContain('link.kind === "none"');
  });

  it("行き先が分かる説明を付ける(平易な日本語)", () => {
    expect(cell).toContain("この物件の基本情報を開く");
    expect(cell).toContain("この所有者の物件を一覧で見る");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run "src/app/(dashboard)/admin/owners/correction/__tests__/property-link.test.ts"`
Expected: FAIL（部品ファイルが無い）

- [ ] **Step 3: 共通部品を作る**

新規ファイル `src/components/owners/owner-property-count-cell.tsx`:

```tsx
"use client";

import Link from "next/link";
import { resolveOwnerPropertyLink } from "@/lib/owner-property-link";

/**
 * 所有者の「紐づき物件数」を、行き先のあるリンクとして描く。
 *
 * 0件のときはリンクにしない。1件ならその物件の基本情報へ、2件以上なら
 * その所有者で絞り込んだ物件一覧へ。分岐は resolveOwnerPropertyLink が決める。
 */
export function OwnerPropertyCountCell({
  ownerId,
  count,
  singlePropertyId,
  zeroClassName,
}: {
  ownerId: string;
  count: number;
  singlePropertyId: string | null;
  /** 0件のときの見た目。指定が無ければ通常色。 */
  zeroClassName?: string;
}) {
  const link = resolveOwnerPropertyLink({
    ownerId,
    propertyOwnerCount: count,
    singlePropertyId,
  });

  if (link.kind === "none") {
    return (
      <span className={zeroClassName ?? "text-gray-700 dark:text-gray-200"}>
        {count}
      </span>
    );
  }

  return (
    <Link
      href={link.href}
      title={
        link.kind === "single"
          ? "この物件の基本情報を開く"
          : "この所有者の物件を一覧で見る"
      }
      className="text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
    >
      {count}
    </Link>
  );
}
```

- [ ] **Step 4: 住所なしタブの表を差し替える**

`src/app/(dashboard)/admin/owners/correction/page.tsx` の 488-497 行付近を次に置き換える:

```tsx
                      <td className="px-3 py-2 text-center">
                        <OwnerPropertyCountCell
                          ownerId={c.id}
                          count={c.propertyOwnerCount}
                          singlePropertyId={c.singlePropertyId}
                          zeroClassName="font-medium text-orange-600"
                        />
                      </td>
```

- [ ] **Step 5: 重複グループの表を差し替える**

同ファイルの 857 行付近を次に置き換える:

```tsx
              <td className="px-2 py-1 text-center">
                <OwnerPropertyCountCell
                  ownerId={m.id}
                  count={m.propertyOwnerCount}
                  singlePropertyId={m.singlePropertyId}
                />
              </td>
```

同ファイルの import 群に追加:

```tsx
import { OwnerPropertyCountCell } from "@/components/owners/owner-property-count-cell";
```

画面側の候補の型（`propertyOwnerCount: number;` を持つ型定義）にも追加:

```ts
  singlePropertyId: string | null;
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx vitest run "src/app/(dashboard)/admin/owners/correction/__tests__/property-link.test.ts"`
Expected: PASS（7件）

- [ ] **Step 7: 既存の補正候補画面テストが壊れていないことを確認する**

Run: `npx vitest run "src/app/(dashboard)/admin/owners/correction/__tests__"` と `npx tsc --noEmit`
Expected: すべて PASS / 型エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/components/owners/owner-property-count-cell.tsx "src/app/(dashboard)/admin/owners/correction/page.tsx" "src/app/(dashboard)/admin/owners/correction/__tests__/property-link.test.ts"
git commit -m "feat(owners): 補正候補の物件件数から物件へ飛べるようにする"
```

---

### Task 6: 所有者詳細に紐づく物件の一覧を出す

**Files:**
- Modify: `src/app/(dashboard)/admin/owners/[id]/page.tsx:270-278`（「紐づき物件数」の直後）
- Test: `src/app/(dashboard)/admin/owners/__tests__/owner-detail-properties.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: Task 1 の `ownerId` パラメータ、Task 3 の `/properties?ownerId=`、既存 `fetchProperties(params)`（`{ data, pagination: { total } }` を返す）
- Produces: なし（画面の末端）

- [ ] **Step 1: 失敗するテストを書く**

新規ファイル `src/app/(dashboard)/admin/owners/__tests__/owner-detail-properties.test.ts`:

```ts
/**
 * 所有者詳細に「紐づく物件」の一覧が出ることの配線テスト。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  resolve(__dirname, "../[id]/page.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("所有者詳細の紐づく物件一覧", () => {
  it("専用APIを作らず既存の物件一覧APIを所有者で絞って呼ぶ(権限とスコープを継承する)", () => {
    expect(src).toContain('fetchProperties({ ownerId, limit: "20" })');
    expect(src).not.toContain("/api/admin/owners/${ownerId}/properties");
  });

  it("20件を超えたら物件一覧へ逃がす導線を出す", () => {
    expect(src).toContain("すべて見る");
    expect(src).toContain("/properties?ownerId=");
  });

  it("見出しは平易な日本語にする", () => {
    expect(src).toContain("紐づく物件");
  });

  it("0件のときに何も無いと分かる文言を出す", () => {
    expect(src).toContain("紐づく物件はありません");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run "src/app/(dashboard)/admin/owners/__tests__/owner-detail-properties.test.ts"`
Expected: FAIL（`fetchProperties` を呼んでいない）

- [ ] **Step 3: 取得の配線を足す**

`src/app/(dashboard)/admin/owners/[id]/page.tsx:21-25` の既存 import ブロックに `fetchProperties` を足す（新しい import 行を作らない）:

```ts
import {
  fetchAdminOwnerCorporateCandidate,
  fetchProperties,
  type AdminOwnerCorporateCandidateResponse,
} from "@/lib/api-client";
```

`Link` / `useState` / `useEffect` はこのファイルで既に import 済み（17-19行目）なので追加不要。

同ファイルのコンポーネント本体、`const ownerId = params?.id ?? "";`（58行目）より後ろの state 宣言のあとに追加:

```tsx
  // 紐づく物件。専用APIは作らず物件一覧APIを所有者で絞って呼ぶ＝
  // 担当者スコープと権限をそのまま継承する(見えない物件がここだけ見える、を防ぐ)。
  const [linkedProperties, setLinkedProperties] = useState<
    Array<{ id: string; address: string; lotNumber: string | null }>
  >([]);
  const [linkedTotal, setLinkedTotal] = useState(0);
  const [linkedLoaded, setLinkedLoaded] = useState(false);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchProperties({ ownerId, limit: "20" });
        if (cancelled) return;
        setLinkedProperties(
          (res.data as Array<{ id: string; address: string; lotNumber: string | null }>) ?? [],
        );
        setLinkedTotal(
          (res.pagination as { total?: number } | undefined)?.total ?? 0,
        );
      } catch {
        // 一覧が出ないだけで所有者詳細そのものは使える(best-effort)。
        if (!cancelled) {
          setLinkedProperties([]);
          setLinkedTotal(0);
        }
      } finally {
        if (!cancelled) setLinkedLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId]);
```

- [ ] **Step 4: 表示を足す**

`<Field label="紐づき物件数" ... />` を含む `</dl>` の直後（同じ `<section>` の中）に追加:

```tsx
            <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
              <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
                紐づく物件
              </h3>
              {!linkedLoaded ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  読み込んでいます…
                </p>
              ) : linkedProperties.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  紐づく物件はありません
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {linkedProperties.map((p) => (
                    <li key={p.id} className="text-xs">
                      <Link
                        href={`/properties/${p.id}`}
                        className="text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
                      >
                        {p.address}
                        {p.lotNumber ? ` ${p.lotNumber}` : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {linkedTotal > linkedProperties.length && (
                <Link
                  href={`/properties?ownerId=${encodeURIComponent(ownerId)}`}
                  className="mt-2 inline-block text-xs text-blue-700 underline underline-offset-2 dark:text-blue-300"
                >
                  すべて見る（{linkedTotal}件）
                </Link>
              )}
            </div>
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run "src/app/(dashboard)/admin/owners/__tests__/owner-detail-properties.test.ts"`
Expected: PASS（4件）

- [ ] **Step 6: 型検査を通す**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add "src/app/(dashboard)/admin/owners/[id]/page.tsx" "src/app/(dashboard)/admin/owners/__tests__/owner-detail-properties.test.ts"
git commit -m "feat(owners): 所有者詳細に紐づく物件の一覧を出す"
```

---

### Task 7: 全体の確認とレビュー提出

**Files:**
- なし（確認のみ）

**Interfaces:**
- Consumes: Task 1-6 すべて
- Produces: レビューに出せる状態のブランチ

- [ ] **Step 1: フルのテストスイートを走らせる**

Run: `npx vitest run`
Expected: すべて PASS。失敗が1件でもあれば、そこで止めて直す（部分実行の結果を「緑」と呼ばない）。

- [ ] **Step 2: 型検査とビルドを通す**

Run: `npx tsc --noEmit` のあと `npx next build`
Expected: どちらもエラーなし

- [ ] **Step 3: 生成物に制御文字が混ざっていないことを確認する**

Run: `git diff --stat main...HEAD`
Expected: `Bin` と表示されるファイルが無い（NUL混入で git がバイナリ扱いするとレビューの死角になる）

- [ ] **Step 4: 権限の抜けを自分で洗う**

次を目で確認する（1箇所直して終わりにしない・全呼び出し元を見る）:

Run: `grep -rn "ownerId" src/lib/property-list-query.ts src/lib/validators.ts src/app/api/properties/`
Expected: `ownerId` を使うのは `buildPropertyListWhere` の AND 追加のみ。`where.OR` 側や、担当者スコープを飛ばす経路に現れないこと。

- [ ] **Step 5: 実機で1往復する**

ローカルを起動し（`npm run build` → `npm start`。`npm run dev` は起動に失敗する既知の問題がある）、次を通す:

1. 所有者補正候補を開き、物件件数が 1 の行を押す → その物件の基本情報が開く
2. 物件件数が 2 以上の行を押す → 物件一覧が「この所有者の物件だけを表示しています」で開く
3. 「絞り込みを解除」を押す → 全件に戻り、URL から `ownerId` が消える
4. 所有者詳細を開く → 紐づく物件が並び、押すと基本情報が開く
5. 物件件数が 0 の行はリンクになっていない

- [ ] **Step 6: レビューへ出す**

`ship` スキルの流れに乗せる（提出前の自己点検 → PR作成 → `@codex review` → 到着監視は専用の Monitor ツールで張る）。

