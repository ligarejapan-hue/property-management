# 売却DMの手紙のイラスト Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「DMの種類」ごとに1枚のイラストを登録し、種類で作った発送の手紙の、本文の最初の【イラスト】の行に印刷する(印が無ければ本文の上に置く)。

**Architecture:**
- 台帳 `dm_scenarios` と発送の型 `dm_variants` に、写真ライブラリ `dm_lp_assets` を指す列を1本ずつ足す。台帳の値は、発送を作るときに型へ写し取る。
- 描画は既存の `renderLetterHtml` 1か所。純関数 `placeIllustration` で本文を【イラスト】の位置で分け、間に `<img src="/lp-assets/<publicId>">` を置く。
- 「使用中」の数え方は `asset-references.ts` に足すので、削除の禁止と公開口の404が同時に正しくなる。

**Tech Stack:** Next.js 16 route handlers, Prisma 7 (`@/generated/prisma`), PostgreSQL, React client components, vitest (env=node・SSR/走査テスト), zod.

**Spec:** `docs/superpowers/specs/2026-10-05-dm-letter-illustration-design.md`

## Global Constraints

- 作業場所は worktree `C:\Users\issin\Desktop\Claude\property-management-worktrees\dm-letter-illustration`(branch `feat/dm-letter-illustration`)。main で作業しない。
- migration は**追加のみ**(DROP/UPDATE/DELETE/ALTER COLUMN を書かない)。新しい依存・env は足さない。
- コードは Write/Edit で書く(bash の heredoc や python でソースを生成しない=`\n` がほどける事故の実績あり)。
- 画面の文言は平易な日本語。【イラスト】の行の判定は「行全体が【イラスト】(前後の半角/全角空白は可)」だけ。
- イラストの高さの上限は `max-height: 55mm`、幅は本文幅いっぱい、`object-fit: contain`。
- 画像の src は `/lp-assets/<publicId>` だけ(publicId は32桁の小文字16進)。それ以外は描かない。
- 「種類を使わない」発送(`scenarioId` が null の型)の指示文は1文字も変えない。
- 「緑」と言う前に `npx tsc --noEmit`・`npx vitest run`(全件)・変更ファイルの `npx eslint`・`npm run build` を実行し、終了コードで確かめる(`> out; echo exit=$?`)。

## Review Focus

1. 【イラスト】と文字が同じ行にある(例「【イラスト】ここに入れる」)→ 印ではないので、文字のまま残る。(Task 2 のテストで固定)
2. Windows から貼った CRLF の本文 → 印の判定と分割が LF と同じ結果になる。(Task 2)
3. 写真が削除済み/publicId が不正 → イラストは描かず、【イラスト】の文字も出さない。(Task 2)
4. 発送の画面で、種類から写した型の文面を貼り直す → 表示した指示文と保存時の照合が同じ関数を通る(食い違うと必ず PROMPT_STALE)。(Task 4 の走査テスト)
5. 種類を使わない発送の本文に【イラスト】が書かれていた → イラストは無し・印の行は消える。(Task 2)

---

### Task 1: スキーマと migration

**Files:**
- Modify: `prisma/schema.prisma`(model `DmVariant`・`DmLpAsset`・`DmScenario`)
- Create: `prisma/migrations/20261005100000_add_dm_letter_illustration/migration.sql`
- Test: `src/lib/__tests__/dm-letter-illustration-schema.test.ts`

**Interfaces:**
- Produces:
  - Prisma field `DmScenario.letterIllustrationAssetId: string | null` / relation `letterIllustrationAsset`
  - Prisma field `DmVariant.illustrationAssetId: string | null` / relation `illustrationAsset`
  - `DmLpAsset` back-relations `scenarioLetterIllustrations` / `variantIllustrations`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/dm-letter-illustration-schema.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const sql = read("prisma/migrations/20261005100000_add_dm_letter_illustration/migration.sql");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("手紙のイラストのスキーマ", () => {
  it("台帳と発送の型に写真への参照(Restrict)と索引", () => {
    const s = block("DmScenario");
    expect(s).toMatch(/letterIllustrationAssetId\s+String\?\s+@map\("letter_illustration_asset_id"\) @db\.Uuid/);
    expect(s).toMatch(/letterIllustrationAsset\s+DmLpAsset\?\s+@relation\("ScenarioLetterIllustration", fields: \[letterIllustrationAssetId\], references: \[id\], onDelete: Restrict\)/);
    expect(s).toMatch(/@@index\(\[letterIllustrationAssetId\]\)/);
    const v = block("DmVariant");
    expect(v).toMatch(/illustrationAssetId\s+String\?\s+@map\("illustration_asset_id"\) @db\.Uuid/);
    expect(v).toMatch(/illustrationAsset\s+DmLpAsset\?\s+@relation\("VariantIllustration", fields: \[illustrationAssetId\], references: \[id\], onDelete: Restrict\)/);
    expect(v).toMatch(/@@index\(\[illustrationAssetId\]\)/);
    const a = block("DmLpAsset");
    expect(a).toMatch(/scenarioLetterIllustrations\s+DmScenario\[\]\s+@relation\("ScenarioLetterIllustration"\)/);
    expect(a).toMatch(/variantIllustrations\s+DmVariant\[\]\s+@relation\("VariantIllustration"\)/);
  });

  it("migration は追加のみ", () => {
    expect(sql).toContain('ALTER TABLE "dm_scenarios" ADD COLUMN "letter_illustration_asset_id" UUID;');
    expect(sql).toContain('ALTER TABLE "dm_variants" ADD COLUMN "illustration_asset_id" UUID;');
    expect(sql).toContain('CREATE INDEX "dm_scenarios_letter_illustration_asset_id_idx" ON "dm_scenarios"("letter_illustration_asset_id");');
    expect(sql).toContain('CREATE INDEX "dm_variants_illustration_asset_id_idx" ON "dm_variants"("illustration_asset_id");');
    expect(sql).toMatch(/ADD CONSTRAINT "dm_scenarios_letter_illustration_asset_id_fkey" FOREIGN KEY \("letter_illustration_asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
    expect(sql).toMatch(/ADD CONSTRAINT "dm_variants_illustration_asset_id_fkey" FOREIGN KEY \("illustration_asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/dm-letter-illustration-schema.test.ts`
Expected: FAIL (ENOENT on migration.sql)

- [ ] **Step 3: Write the migration and schema**

`prisma/migrations/20261005100000_add_dm_letter_illustration/migration.sql`:

```sql
-- 売却DMの手紙のイラスト(設計 2026-10-05)。追加のみ。
-- 台帳(dm_scenarios)と発送の型(dm_variants)は数行~数十行=索引は通常の CREATE INDEX でよい。

-- DMの種類ごとの手紙のイラスト(LPの写真ライブラリの1枚)。
ALTER TABLE "dm_scenarios" ADD COLUMN "letter_illustration_asset_id" UUID;
CREATE INDEX "dm_scenarios_letter_illustration_asset_id_idx" ON "dm_scenarios"("letter_illustration_asset_id");
ALTER TABLE "dm_scenarios" ADD CONSTRAINT "dm_scenarios_letter_illustration_asset_id_fkey" FOREIGN KEY ("letter_illustration_asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 発送を作ったときに台帳から写し取ったイラスト(作成後に台帳を替えても変わらない)。
ALTER TABLE "dm_variants" ADD COLUMN "illustration_asset_id" UUID;
CREATE INDEX "dm_variants_illustration_asset_id_idx" ON "dm_variants"("illustration_asset_id");
ALTER TABLE "dm_variants" ADD CONSTRAINT "dm_variants_illustration_asset_id_fkey" FOREIGN KEY ("illustration_asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

`prisma/schema.prisma`:
- In `model DmVariant`, after the `templateFrozenAt` line, add:

```prisma
  /// 手紙のイラスト(設計 2026-10-05)。種類から写した型だけが持つ。作成時に台帳から写し取る。
  illustrationAssetId String? @map("illustration_asset_id") @db.Uuid
```

  After the `scenario` relation line, add:

```prisma
  illustrationAsset DmLpAsset? @relation("VariantIllustration", fields: [illustrationAssetId], references: [id], onDelete: Restrict)
```

  Before `@@map("dm_variants")`, add:

```prisma
  @@index([illustrationAssetId])
```

- In `model DmLpAsset`, after `scenarioMedia DmScenarioMedia[]`, add:

```prisma
  scenarioLetterIllustrations DmScenario[] @relation("ScenarioLetterIllustration")
  variantIllustrations        DmVariant[]  @relation("VariantIllustration")
```

- In `model DmScenario`, after the `lpFaqJson` line, add:

```prisma
  /// 手紙のイラスト(設計 2026-10-05)。本文の【イラスト】の行(無ければ本文の上)に入る。
  letterIllustrationAssetId String? @map("letter_illustration_asset_id") @db.Uuid
```

  After `lpVariants DmLpVariant[]`, add:

```prisma
  letterIllustrationAsset DmLpAsset? @relation("ScenarioLetterIllustration", fields: [letterIllustrationAssetId], references: [id], onDelete: Restrict)

  @@index([letterIllustrationAssetId])
```

- [ ] **Step 4: Regenerate and run tests**

Run: `npx prisma format && npx prisma generate && npx vitest run src/lib/__tests__/dm-letter-illustration-schema.test.ts`
Expected: PASS (2 tests). `prisma format` must not reorder anything else; check with `git diff --stat prisma/schema.prisma` (only these lines).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261005100000_add_dm_letter_illustration src/lib/__tests__/dm-letter-illustration-schema.test.ts
git commit -m "feat(dm-letter): 手紙のイラストの列(台帳と発送の型・追加のみ)"
```

---

### Task 2: 【イラスト】の位置で本文を分けて描く

**Files:**
- Create: `src/lib/sale-dm-letter/letter-illustration.ts`
- Modify: `src/lib/sale-dm-letter/templates/types.ts`
- Modify: `src/lib/sale-dm-letter/templates/index.ts:45-97`
- Test: `src/lib/sale-dm-letter/__tests__/letter-illustration.test.ts`

**Interfaces:**
- Produces (from `@/lib/sale-dm-letter/letter-illustration`, no server-only imports=画面からも使える):
  - `type LetterIllustration = { src: string; width: number; height: number }`
  - `placeIllustration(body: string): { before: string; after: string; stripped: string; hasMarker: boolean }`
  - `letterIllustrationFromAsset(a: { publicId: string; width: number; height: number; deletedAt: Date | string | null } | null | undefined): LetterIllustration | null`
  - `isSafeIllustrationSrc(src: string): boolean`
- Produces: `LetterRenderInput.illustration?: LetterIllustration | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sale-dm-letter/__tests__/letter-illustration.test.ts
import { describe, it, expect } from "vitest";
import { placeIllustration, letterIllustrationFromAsset, isSafeIllustrationSrc } from "../letter-illustration";
import { renderLetterHtml, renderLetterSheetHtml } from "../templates";

const PID = "0123456789abcdef0123456789abcdef";
const ILL = { src: `/lp-assets/${PID}`, width: 1200, height: 400 };
const base = {
  designTemplate: "formal",
  addresseeName: "山田 太郎",
  honorific: "様",
  recipientZip: "1560054",
  recipientAddress: "東京都世田谷区桜丘",
  senderName: "テスト不動産",
  senderContact: "03-0000-0000",
  trackingToken: "t1",
};

describe("placeIllustration(【イラスト】の行で分ける)", () => {
  it("印の行で前後に分け、印の行は消す", () => {
    expect(placeIllustration("一\n【イラスト】\n二\n三")).toEqual({ before: "一", after: "二\n三", stripped: "一\n二\n三", hasMarker: true });
  });
  it("印が無ければ before は空・after は本文そのまま", () => {
    expect(placeIllustration("一\n二")).toEqual({ before: "", after: "一\n二", stripped: "一\n二", hasMarker: false });
  });
  it("2つ目以降の印の行も消す", () => {
    expect(placeIllustration("一\n【イラスト】\n二\n【イラスト】\n三")).toEqual({ before: "一", after: "二\n三", stripped: "一\n二\n三", hasMarker: true });
  });
  it("前後の半角・全角空白は印として扱う", () => {
    expect(placeIllustration("一\n　 【イラスト】 　\n二").hasMarker).toBe(true);
  });
  it("同じ行に文字がある【イラスト】は印ではない(文字のまま残す)", () => {
    expect(placeIllustration("一\n【イラスト】ここに入れる\n二")).toEqual({ before: "", after: "一\n【イラスト】ここに入れる\n二", stripped: "一\n【イラスト】ここに入れる\n二", hasMarker: false });
  });
  it("CRLF / CR でも同じ結果", () => {
    expect(placeIllustration("一\r\n【イラスト】\r\n二")).toEqual(placeIllustration("一\n【イラスト】\n二"));
    expect(placeIllustration("一\r【イラスト】\r二")).toEqual(placeIllustration("一\n【イラスト】\n二"));
  });
  it("先頭行が印なら before は空", () => {
    expect(placeIllustration("【イラスト】\n一")).toEqual({ before: "", after: "一", stripped: "一", hasMarker: true });
  });
});

describe("letterIllustrationFromAsset", () => {
  it("削除されていない写真から src を作る", () => {
    expect(letterIllustrationFromAsset({ publicId: PID, width: 1200, height: 400, deletedAt: null })).toEqual(ILL);
  });
  it("未設定・削除済み・publicId が不正なら null", () => {
    expect(letterIllustrationFromAsset(null)).toBeNull();
    expect(letterIllustrationFromAsset(undefined)).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: PID, width: 1, height: 1, deletedAt: new Date() })).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: "../x", width: 1, height: 1, deletedAt: null })).toBeNull();
    expect(letterIllustrationFromAsset({ publicId: PID.toUpperCase(), width: 1, height: 1, deletedAt: null })).toBeNull();
  });
  it("isSafeIllustrationSrc は /lp-assets/<32桁16進> だけ", () => {
    expect(isSafeIllustrationSrc(`/lp-assets/${PID}`)).toBe(true);
    expect(isSafeIllustrationSrc(`https://evil/lp-assets/${PID}`)).toBe(false);
    expect(isSafeIllustrationSrc(`/lp-assets/${PID}" onerror="x`)).toBe(false);
  });
});

describe("renderLetterHtml とイラスト", () => {
  const count = (s: string, sub: string) => s.split(sub).length - 1;

  it("印の位置に img が1つだけ入り、【イラスト】の文字は出ない", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n【イラスト】\n続き\n【イラスト】\n結び", illustration: ILL });
    expect(count(html, "<img")).toBe(1);
    expect(html).not.toContain("【イラスト】");
    const i = html.indexOf("書き出し"), j = html.indexOf("<img"), k = html.indexOf("続き"), l = html.indexOf("結び");
    expect(i).toBeGreaterThan(-1);
    expect(i < j && j < k && k < l).toBe(true);
    expect(html).toContain(`src="/lp-assets/${PID}"`);
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="400"');
    expect(html).toContain("max-height: 55mm");
  });

  it("印が無ければ本文の上に入る", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n続き", illustration: ILL });
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("書き出し"));
    expect(html.indexOf("<img")).toBeGreaterThan(html.indexOf('class="letter-body"'));
  });

  it("イラスト無しなら img を出さず、印の行だけ消す", () => {
    const html = renderLetterHtml({ ...base, body: "書き出し\n【イラスト】\n続き" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("【イラスト】");
    expect(html).toContain("書き出し<br />\n続き");
  });

  it("src が安全でなければ描かない(印の行は消す)", () => {
    const html = renderLetterHtml({ ...base, body: "一\n【イラスト】\n二", illustration: { src: "javascript:alert(1)", width: 1, height: 1 } });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("【イラスト】");
  });

  it("本文は今までどおりエスケープされる(前後どちらも)", () => {
    const html = renderLetterHtml({ ...base, body: "<b>前</b>\n【イラスト】\n<i>後</i>", illustration: ILL });
    expect(html).toContain("&lt;b&gt;前&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;後&lt;/i&gt;");
  });

  it("イラストも印も無い本文は今までと同じ HTML", () => {
    const a = renderLetterHtml({ ...base, body: "一\n二" });
    const b = renderLetterHtml({ ...base, body: "一\n二", illustration: null });
    expect(a).toBe(b);
    expect(a).toContain('<div class="letter-body">一<br />\n二</div>');
  });

  it("まとめ印刷でも通ごとに入る", () => {
    const html = renderLetterSheetHtml("t", [{ ...base, body: "一", illustration: ILL }, { ...base, body: "二" }]);
    expect(count(html, "<img")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/letter-illustration.test.ts`
Expected: FAIL (Cannot find module '../letter-illustration')

- [ ] **Step 3: Write the implementation**

`src/lib/sale-dm-letter/letter-illustration.ts`:

```ts
/**
 * 売却DMの手紙のイラスト(設計 2026-10-05)。純関数だけ=画面(見本)と印刷 route の両方から使う。
 * 本文の【イラスト】の行(行全体が印・前後の空白は可)で前後に分け、最初の印の位置にイラストを置く。
 * 印が無ければ本文の上。2つ目以降の印・イラストが無いときの印は、行ごと消す(紙に【イラスト】を出さない)。
 */
export type LetterIllustration = { src: string; width: number; height: number };

const MARKER_LINE = /^[ \t\u3000]*【イラスト】[ \t\u3000]*$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SAFE_SRC = /^\/lp-assets\/[0-9a-f]{32}$/;

export function placeIllustration(body: string): { before: string; after: string; stripped: string; hasMarker: boolean } {
  const lines = body.split(/\r\n|\r|\n/);
  const first = lines.findIndex((l) => MARKER_LINE.test(l));
  const keep = (ls: string[]) => ls.filter((l) => !MARKER_LINE.test(l));
  const stripped = keep(lines).join("\n");
  if (first === -1) return { before: "", after: stripped, stripped, hasMarker: false };
  return {
    before: lines.slice(0, first).join("\n"),
    after: keep(lines.slice(first + 1)).join("\n"),
    stripped,
    hasMarker: true,
  };
}

export function isSafeIllustrationSrc(src: string): boolean {
  return SAFE_SRC.test(src);
}

/** 写真の行 → 描画用。未設定・削除済み・publicId が不正なら null(=イラスト無しで描く)。 */
export function letterIllustrationFromAsset(
  a: { publicId: string; width: number; height: number; deletedAt: Date | string | null } | null | undefined,
): LetterIllustration | null {
  if (!a || a.deletedAt) return null;
  if (!PUBLIC_ID.test(a.publicId)) return null;
  return { src: `/lp-assets/${a.publicId}`, width: a.width, height: a.height };
}
```

`src/lib/sale-dm-letter/templates/types.ts` — add before the closing `}`:

```ts
  // 手紙のイラスト(設計 2026-10-05)。本文の【イラスト】の行(無ければ本文の上)に入る。
  // null/未指定=イラスト無し(【イラスト】の行は消して描く)。src は /lp-assets/<publicId> だけ受け付ける。
  illustration?: import("../letter-illustration").LetterIllustration | null;
```

`src/lib/sale-dm-letter/templates/index.ts`:
- Add import at top: `import { placeIllustration, isSafeIllustrationSrc } from "../letter-illustration";`
- Add this function after `escapedBodyToHtml`:

```ts
// 本文の HTML。イラストがあれば最初の【イラスト】の行(無ければ本文の上)に <img> を置く。
// 本文の前後はそれぞれ escapedBodyToHtml を1回だけ通す(唯一の生 HTML は <br /> と、
// 検査済みの src・整数の寸法から組む <img> だけ)。
function bodyHtmlWithIllustration(body: string, illustration: LetterRenderInput["illustration"]): string {
  const placed = placeIllustration(body);
  if (!illustration || !isSafeIllustrationSrc(illustration.src)) {
    return escapedBodyToHtml(placed.stripped);
  }
  const w = Number.isInteger(illustration.width) && illustration.width > 0 ? ` width="${illustration.width}"` : "";
  const h = Number.isInteger(illustration.height) && illustration.height > 0 ? ` height="${illustration.height}"` : "";
  const img = `<div class="letter-illustration"><img src="${escapeHtml(illustration.src)}" alt=""${w}${h} loading="eager" decoding="sync" /></div>`;
  return `${escapedBodyToHtml(placed.before)}${img}${escapedBodyToHtml(placed.after)}`;
}
```

- In `renderLetterHtml`, replace `const bodyHtml = escapedBodyToHtml(input.body);` with:

```ts
  const bodyHtml = bodyHtmlWithIllustration(input.body, input.illustration);
```

- In the `<style>` block, after the `.letter-body` rule, add:

```ts
    .letter-page--${design} .letter-illustration { margin: 3mm 0; text-align: center; }
    .letter-page--${design} .letter-illustration img { display: block; width: 100%; height: auto; max-height: 55mm; object-fit: contain; }
```

Note: when there is no marker and no illustration, `placed.stripped === body` with newlines normalized to `\n`; `escapedBodyToHtml` already maps `\r\n|\r|\n` to `<br />\n`, so the output is byte-identical to before (the test "イラストも印も無い本文は今までと同じ HTML" pins this).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/letter-illustration.test.ts src/lib/__tests__/sale-dm-templates.test.ts`
Expected: PASS (all; the existing templates tests must stay green)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/letter-illustration.ts src/lib/sale-dm-letter/templates/types.ts src/lib/sale-dm-letter/templates/index.ts src/lib/sale-dm-letter/__tests__/letter-illustration.test.ts
git commit -m "feat(dm-letter): 【イラスト】の行にイラストを置いて手紙を描く"
```

---

### Task 3: 手紙のイラストも「使用中」に数える

**Files:**
- Modify: `src/lib/sale-dm-letter/asset-references.ts`
- Test: `src/lib/__tests__/sale-dm-asset-references.test.ts`

**Interfaces:**
- Consumes: Task 1 relations `scenarioLetterIllustrations`, `variantIllustrations`
- Produces: `isAssetReferenced(row: { _count: { media: number; scenarioMedia: number; scenarioLetterIllustrations?: number; variantIllustrations?: number } }): boolean`; `countAssetReferences(tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia" | "dmScenario" | "dmVariant">, assetId: string): Promise<number>`

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe` block of `src/lib/__tests__/sale-dm-asset-references.test.ts`, and replace the existing "countAssetReferences は両方を足す" test:

```ts
  it("手紙のイラスト(台帳・発送の型)で使われていても使用中", () => {
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 0, scenarioLetterIllustrations: 1, variantIllustrations: 0 } })).toBe(true);
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 0, scenarioLetterIllustrations: 0, variantIllustrations: 3 } })).toBe(true);
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 0, scenarioLetterIllustrations: 0, variantIllustrations: 0 } })).toBe(false);
  });
  it("削除済みの台帳の手紙のイラストは数えない(select の where)", () => {
    expect(ASSET_REFERENCE_COUNT_SELECT._count.select.scenarioLetterIllustrations).toEqual({ where: { deletedAt: null } });
    expect(ASSET_REFERENCE_COUNT_SELECT._count.select.variantIllustrations).toBe(true);
  });
  it("countAssetReferences は4つを足す", async () => {
    const tx = {
      dmLpVariantMedia: { count: vi.fn(async () => 1) },
      dmScenarioMedia: { count: vi.fn(async () => 2) },
      dmScenario: { count: vi.fn(async () => 4) },
      dmVariant: { count: vi.fn(async () => 8) },
    };
    await expect(countAssetReferences(tx as never, "a1")).resolves.toBe(15);
    expect(tx.dmScenarioMedia.count).toHaveBeenCalledWith({ where: { assetId: "a1", scenario: { deletedAt: null } } });
    expect(tx.dmScenario.count).toHaveBeenCalledWith({ where: { letterIllustrationAssetId: "a1", deletedAt: null } });
    expect(tx.dmVariant.count).toHaveBeenCalledWith({ where: { illustrationAssetId: "a1" } });
  });
```

(Delete the old `it("countAssetReferences は両方を足す", …)` test — it asserts the 2-term sum.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/sale-dm-asset-references.test.ts`
Expected: FAIL (3 new tests)

- [ ] **Step 3: Implement** — replace the body of `src/lib/sale-dm-letter/asset-references.ts` below the header comment with:

```ts
import type { PrismaClient } from "@/generated/prisma";

// 手紙のイラスト(設計 2026-10-05): 台帳(削除されていないもの)と、発送の型が参照していれば使用中。
export const ASSET_REFERENCE_COUNT_SELECT = {
  _count: {
    select: {
      media: true,
      scenarioMedia: { where: { scenario: { deletedAt: null } } },
      scenarioLetterIllustrations: { where: { deletedAt: null } },
      variantIllustrations: true,
    },
  },
} as const;

export function isAssetReferenced(row: {
  _count: { media: number; scenarioMedia: number; scenarioLetterIllustrations?: number; variantIllustrations?: number };
}): boolean {
  const c = row._count;
  return c.media > 0 || c.scenarioMedia > 0 || (c.scenarioLetterIllustrations ?? 0) > 0 || (c.variantIllustrations ?? 0) > 0;
}

export async function countAssetReferences(
  tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia" | "dmScenario" | "dmVariant">,
  assetId: string,
): Promise<number> {
  const [a, b, c, d] = await Promise.all([
    tx.dmLpVariantMedia.count({ where: { assetId } }),
    tx.dmScenarioMedia.count({ where: { assetId, scenario: { deletedAt: null } } }),
    tx.dmScenario.count({ where: { letterIllustrationAssetId: assetId, deletedAt: null } }),
    tx.dmVariant.count({ where: { illustrationAssetId: assetId } }),
  ]);
  return a + b + c + d;
}
```

Also update the header comment's first line to say: 「LP型の枠・台帳の枠・台帳の手紙のイラスト・発送の型の手紙のイラストのどれかから参照されているか」.

- [ ] **Step 4: Run the affected tests**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/__tests__/sale-dm-asset-references.test.ts src/lib/__tests__/sale-dm-scenario-media-route.test.ts src/lib/__tests__/sale-dm-lp-media-ui-scan.test.ts`
Expected: tsc=0, PASS. If a route test that calls `countAssetReferences` (the delete route `lp-assets/[assetId]`) fails because its prisma mock lacks `dmScenario.count` / `dmVariant.count`, add `count: vi.fn(async () => 0)` to those mocks in that test file (mock only; no behavior change). Find them with: `npx vitest run src/lib/__tests__ 2>&1 | grep -B2 "count is not a function"`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/asset-references.ts src/lib/__tests__/
git commit -m "feat(dm-letter): 手紙のイラストに使っている写真は消せない・公開口も返す"
```

---

### Task 4: 指示文に【イラスト】の一文(種類の手紙だけ)

**Files:**
- Modify: `src/lib/sale-dm-letter/external-prompt.ts`
- Modify: `src/app/api/properties/sale-dm/scenarios/[id]/prompt/route.ts:24-25`
- Modify: `src/app/api/properties/sale-dm/scenarios/[id]/template/route.ts:54`
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/prompt/route.ts:41-67`
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts` (the variant `select` and line 110)
- Test: `src/lib/sale-dm-letter/__tests__/illustration-prompt.test.ts`

**Interfaces:**
- Produces:
  - `ILLUSTRATION_PROMPT_LINE: string`
  - `buildExternalPrompt(options: ExternalPromptOptions, extra?: { illustrationMarker?: boolean }): string`
  - `scenarioLetterPrompt(options: ExternalPromptOptions): string` (always with the marker line)
  - `variantLetterPrompt(v: ExternalPromptOptions & { scenarioId: string | null }): string` (marker line only when `scenarioId` is set)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sale-dm-letter/__tests__/illustration-prompt.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildExternalPrompt, scenarioLetterPrompt, variantLetterPrompt, ILLUSTRATION_PROMPT_LINE } from "../external-prompt";

const OPTS = { tone: "polite", length: "standard", appeal: "inheritance", strength: "soft" };
const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("指示文の【イラスト】の一文", () => {
  it("既定(型A/B)は今までと1文字も変わらない", () => {
    expect(buildExternalPrompt(OPTS)).toBe(buildExternalPrompt(OPTS, { illustrationMarker: false }));
    expect(buildExternalPrompt(OPTS)).not.toContain("【イラスト】");
  });
  it("illustrationMarker のときだけ【必ず守ること】に一文が入る", () => {
    const p = buildExternalPrompt(OPTS, { illustrationMarker: true });
    expect(p).toContain(ILLUSTRATION_PROMPT_LINE);
    expect(ILLUSTRATION_PROMPT_LINE).toContain("【イラスト】とだけ書いた行を1行");
    const rules = p.slice(p.indexOf("【必ず守ること】"), p.indexOf("【場所や種別に触れたいとき】"));
    expect(rules).toContain(ILLUSTRATION_PROMPT_LINE);
  });
  it("台帳は常に一文あり・発送の型は種類から写したときだけ", () => {
    expect(scenarioLetterPrompt(OPTS)).toContain(ILLUSTRATION_PROMPT_LINE);
    expect(variantLetterPrompt({ ...OPTS, scenarioId: "s1" })).toBe(scenarioLetterPrompt(OPTS));
    expect(variantLetterPrompt({ ...OPTS, scenarioId: null })).toBe(buildExternalPrompt(OPTS));
  });
  it("走査: 表示と保存の照合が同じ関数を通る(食い違うと必ず PROMPT_STALE)", () => {
    for (const f of [
      "src/app/api/properties/sale-dm/scenarios/[id]/prompt/route.ts",
      "src/app/api/properties/sale-dm/scenarios/[id]/template/route.ts",
    ]) {
      expect(code(f), f).toMatch(/scenarioLetterPrompt\(/);
      expect(code(f), f).not.toMatch(/buildExternalPrompt\(/);
    }
    for (const f of [
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/prompt/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts",
    ]) {
      expect(code(f), f).toMatch(/variantLetterPrompt\(/);
      expect(code(f), f).not.toMatch(/buildExternalPrompt\(/);
      expect(code(f), f).toMatch(/scenarioId: true/);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/illustration-prompt.test.ts`
Expected: FAIL (scenarioLetterPrompt is not exported)

- [ ] **Step 3: Implement**

In `src/lib/sale-dm-letter/external-prompt.ts`:
- Change the signature and the `【必ず守ること】` list of `buildExternalPrompt`:

```ts
/** 手紙のイラストの位置を外部AIに決めさせる一文(設計 2026-10-05 §6)。種類の手紙だけに入れる。 */
export const ILLUSTRATION_PROMPT_LINE =
  "- 手紙の中でイラストを入れるとよい場所に、【イラスト】とだけ書いた行を1行入れてください。場所は文章の流れに合わせて選んでください。";

/** 型の設定から、そのまま外部AIへ貼れる日本語のプロンプトを作る。 */
export function buildExternalPrompt(options: ExternalPromptOptions, extra: { illustrationMarker?: boolean } = {}): string {
```

  and in the returned array, directly after the line `"- 出力は手紙の本文のみ。前置きや説明、マークダウン記法は付けない。",` insert:

```ts
    ...(extra.illustrationMarker ? [ILLUSTRATION_PROMPT_LINE] : []),
```

- Append after `buildExternalPrompt`:

```ts
/** 台帳(DMの種類)の手紙の指示文。表示(prompt)と保存時の照合(template)は必ずこれを通す。 */
export function scenarioLetterPrompt(options: ExternalPromptOptions): string {
  return buildExternalPrompt(options, { illustrationMarker: true });
}

/**
 * 発送の型の手紙の指示文。種類から写した型(scenarioId あり)だけ【イラスト】の一文が入る。
 * 表示(variants/[variantId]/prompt)と保存時の照合(.../template)は必ずこれを通す。
 */
export function variantLetterPrompt(v: ExternalPromptOptions & { scenarioId: string | null }): string {
  return buildExternalPrompt(v, { illustrationMarker: v.scenarioId !== null });
}
```

In `scenarios/[id]/prompt/route.ts`: change the import to `scenarioLetterPrompt, promptDigest, bodyTemplateDigest` and replace `const prompt = buildExternalPrompt(opts);` with `const prompt = scenarioLetterPrompt(opts);`.

In `scenarios/[id]/template/route.ts`: change the import of `buildExternalPrompt` to `scenarioLetterPrompt` and replace `const prompt = buildExternalPrompt(letterOptions(s));` with `const prompt = scenarioLetterPrompt(letterOptions(s));`.

In `campaigns/[id]/variants/[variantId]/prompt/route.ts`: change the import to `variantLetterPrompt, promptDigest, bodyTemplateDigest`, add `scenarioId: true,` to the `select` (after `strength: true,`), and replace `const prompt = buildExternalPrompt(variant);` with `const prompt = variantLetterPrompt(variant);`.

In `campaigns/[id]/variants/[variantId]/template/route.ts`: same three changes (import, `scenarioId: true,` in the variant `select` after `strength: true,`, and `const prompt = variantLetterPrompt(variant);`).

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/sale-dm-letter/__tests__ src/lib/__tests__/sale-dm-prompt-route.test.ts src/lib/__tests__/sale-dm-template-route.test.ts src/lib/__tests__/sale-dm-scenario-letter-route.test.ts src/lib/__tests__/sale-dm-prompt-sender.test.ts`
Expected: tsc=0, PASS. If an existing route test computes the expected digest with `buildExternalPrompt(...)` for a scenario route, change that expectation to `scenarioLetterPrompt(...)` (for variant routes with a mock variant lacking `scenarioId`, add `scenarioId: null` to the mock row so the prompt stays the 型A/B prompt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/external-prompt.ts src/app/api/properties/sale-dm/scenarios src/app/api/properties/sale-dm/campaigns src/lib/sale-dm-letter/__tests__/illustration-prompt.test.ts src/lib/__tests__/
git commit -m "feat(dm-letter): 種類の手紙の指示文に【イラスト】の一文"
```

---

### Task 5: 発送を作るときにイラストを写し取る

**Files:**
- Modify: `src/lib/sale-dm-letter/scenario-copy.ts` (`ScenarioFull`, `LETTER_COPY_MAP`, `SCENARIO_FULL_SELECT`)
- Test: `src/lib/__tests__/sale-dm-scenario-copy.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 field `DmScenario.letterIllustrationAssetId`, `DmVariant.illustrationAssetId`
- Produces: `ScenarioFull.letterIllustrationAssetId: string | null`; `letterVariantData(...)` now includes `illustrationAssetId`

- [ ] **Step 1: Write the failing test** — append to `src/lib/__tests__/sale-dm-scenario-copy.test.ts` (it already imports from `@/lib/sale-dm-letter/scenario-copy`; add `letterVariantData`, `LETTER_COPY_MAP` to that import if missing):

```ts
describe("手紙のイラストの写し取り(設計 2026-10-05 §7)", () => {
  const S = {
    id: "s1", name: "相続", autoKey: "inheritance", active: true, deletedAt: null,
    designTemplate: "formal", tone: "polite", length: "standard", appeal: "inheritance", strength: "soft",
    extraInstruction: null, letterPromptText: "p", letterBodyTemplate: "本文",
    lpTone: null, lpLength: null, lpAppeal: null, lpStrength: null, lpPromptText: null, lpRawTemplate: null,
    lpHeadline: null, lpLead: null, lpBodyText: null, lpFaqJson: null,
    letterIllustrationAssetId: "11111111-1111-4111-8111-111111111111",
  };
  it("台帳のイラストを型の illustrationAssetId へ写す", () => {
    expect(letterVariantData("c1", S as never)).toMatchObject({ illustrationAssetId: "11111111-1111-4111-8111-111111111111" });
  });
  it("未登録なら null のまま写す", () => {
    expect(letterVariantData("c1", { ...S, letterIllustrationAssetId: null } as never)).toMatchObject({ illustrationAssetId: null });
  });
  it("対応表に載っている(作成と種類を変えるの両方が同じ表を通る)", () => {
    expect(LETTER_COPY_MAP).toContainEqual(["letterIllustrationAssetId", "illustrationAssetId"]);
  });
  it("走査: 写す前の読み出しにもイラストの列が入っている", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/sale-dm-letter/scenario-copy.ts"), "utf8");
    const sel = src.slice(src.indexOf("const SCENARIO_FULL_SELECT"), src.indexOf("} as const;", src.indexOf("const SCENARIO_FULL_SELECT")));
    expect(sel).toContain("letterIllustrationAssetId: true");
  });
});
```

(If the file lacks `readFileSync`/`join` imports, add `import { readFileSync } from "node:fs";` and `import { join } from "node:path";`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/sale-dm-scenario-copy.test.ts`
Expected: FAIL (illustrationAssetId missing)

- [ ] **Step 3: Implement** in `src/lib/sale-dm-letter/scenario-copy.ts`:
- In `type ScenarioFull`, after `letterBodyTemplate: string | null;` add `letterIllustrationAssetId: string | null;`
- In `LETTER_COPY_MAP`, after `["letterBodyTemplate", "bodyTemplate"],` add:

```ts
  // 手紙のイラスト(設計 2026-10-05 §7)。写真の ID をそのまま写す(削除済みは描画側が隠す)。
  ["letterIllustrationAssetId", "illustrationAssetId"],
```

- In `SCENARIO_FULL_SELECT`, after `letterBodyTemplate: true,` add `letterIllustrationAssetId: true,`

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/__tests__/sale-dm-scenario-copy.test.ts src/lib/__tests__/sale-dm-scenarios-route.test.ts`
Expected: tsc=0, PASS. If an existing test asserts `letterVariantData(...)` with `toEqual` on the whole object, add `illustrationAssetId: <the fixture's value or undefined>` to that expectation (the fixture predates the column).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sale-dm-letter/scenario-copy.ts src/lib/__tests__/sale-dm-scenario-copy.test.ts
git commit -m "feat(dm-letter): 発送を作るときに手紙のイラストを写し取る"
```

---

### Task 6: 台帳でイラストを選ぶ・外す API と取得

**Files:**
- Create: `src/app/api/properties/sale-dm/scenarios/[id]/letter-illustration/route.ts`
- Modify: `src/app/api/properties/sale-dm/scenarios/[id]/route.ts` (GET)
- Modify: `src/lib/audit-log-detail-safety.ts` (after `sale_dm_scenario_media_update`)
- Modify: `src/lib/__tests__/sale-dm-lock-order-guard.test.ts` (`MUTATING_ROUTES`)
- Modify: `src/lib/__tests__/sale-dm-external-audit-visible.test.ts` (`CASES`)
- Test: `src/lib/__tests__/sale-dm-scenario-letter-illustration-route.test.ts`

**Interfaces:**
- Consumes: `letterIllustrationFromAsset` (Task 2), `requireScenarioAdmin`, `lockScenarioForUpdate` from `@/lib/sale-dm-letter/scenario-guard`
- Produces:
  - `PUT /api/properties/sale-dm/scenarios/[id]/letter-illustration` body `{ assetId: string | null }` → `{ letterIllustrationAssetId: string | null; letterIllustration: LetterIllustration | null }`
  - `GET /api/properties/sale-dm/scenarios/[id]` → `scenario` now also has `letterIllustrationAssetId: string | null` and `letterIllustration: LetterIllustration | null` (the relation object itself is not returned)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/sale-dm-scenario-letter-illustration-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: (e as { name?: string })?.name === "ZodError" ? "VALIDATION_ERROR" : "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: (e as { name?: string })?.name === "ZodError" ? 422 : 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmScenario: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(async () => ({})) },
    dmLpAsset: { findFirst: vi.fn() },
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { PUT } from "../../app/api/properties/sale-dm/scenarios/[id]/letter-illustration/route";
import { GET } from "../../app/api/properties/sale-dm/scenarios/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: { findFirst: Fn; findUniqueOrThrow: Fn; update: Fn };
  dmLpAsset: { findFirst: Fn };
  $queryRaw: Fn;
};
const SID = "44444444-4444-4444-8444-444444444444";
const AID = "11111111-1111-4111-8111-111111111111";
const PID = "0123456789abcdef0123456789abcdef";
const ctx = { params: Promise.resolve({ id: SID }) };
const put = (body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }) as never, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: null });
  pm.dmLpAsset.findFirst.mockResolvedValue({ publicId: PID, width: 1200, height: 400, deletedAt: null });
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
});

describe("PUT /scenarios/[id]/letter-illustration", () => {
  it("写真を選ぶ: 台帳→写真の順にロックし、保存して描画用の値を返す", async () => {
    const res = await put({ assetId: AID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ letterIllustrationAssetId: AID, letterIllustration: { src: `/lp-assets/${PID}`, width: 1200, height: 400 } });
    expect(pm.dmScenario.update).toHaveBeenCalledWith({ where: { id: SID }, data: { letterIllustrationAssetId: AID } });
    const sqls = pm.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    const iScenario = sqls.findIndex((s) => /dm_scenarios/.test(s));
    const iAsset = sqls.findIndex((s) => /FROM dm_lp_assets[\s\S]*FOR UPDATE/.test(s));
    expect(iScenario).toBeGreaterThan(-1);
    expect(iAsset).toBeGreaterThan(iScenario);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "sale_dm_scenario_letter_illustration_update", targetTable: "dm_scenarios", targetId: SID, detail: { hasIllustration: true } }));
  });

  it("外す: null を保存し、写真はロックしない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: AID });
    const res = await put({ assetId: null });
    expect(await res.json()).toEqual({ letterIllustrationAssetId: null, letterIllustration: null });
    expect(pm.dmScenario.update).toHaveBeenCalledWith({ where: { id: SID }, data: { letterIllustrationAssetId: null } });
    expect(pm.dmLpAsset.findFirst).not.toHaveBeenCalled();
    expect(writeAuditLog.mock.calls[0][0].detail).toEqual({ hasIllustration: false });
  });

  it("削除済みの写真は 400 ASSET_NOT_FOUND で何も書かない", async () => {
    pm.dmLpAsset.findFirst.mockResolvedValue(null);
    const res = await put({ assetId: AID });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ASSET_NOT_FOUND");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("同じ値なら書かない・監査も残さない", async () => {
    pm.dmScenario.findUniqueOrThrow.mockResolvedValue({ letterIllustrationAssetId: AID });
    const res = await put({ assetId: AID });
    expect(res.status).toBe(200);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("assetId が uuid でなければ 422", async () => {
    expect((await put({ assetId: "x" })).status).toBe(422);
  });

  it("管理者以外は 403", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u2", role: "office_staff" });
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await put({ assetId: AID })).status).toBe(403);
  });
});

describe("GET /scenarios/[id] は手紙のイラストを描画用の形で返す", () => {
  it("relation そのものは返さず letterIllustration を付ける", async () => {
    pm.dmScenario.findFirst.mockResolvedValue({ id: SID, name: "相続", letterIllustrationAssetId: AID, letterIllustrationAsset: { publicId: PID, width: 1200, height: 400, deletedAt: null } });
    const j = await (await GET(new Request("http://x"), ctx)).json();
    expect(j.scenario.letterIllustration).toEqual({ src: `/lp-assets/${PID}`, width: 1200, height: 400 });
    expect(j.scenario.letterIllustrationAssetId).toBe(AID);
    expect(j.scenario).not.toHaveProperty("letterIllustrationAsset");
  });
  it("未登録なら null", async () => {
    pm.dmScenario.findFirst.mockResolvedValue({ id: SID, name: "相続", letterIllustrationAssetId: null, letterIllustrationAsset: null });
    const j = await (await GET(new Request("http://x"), ctx)).json();
    expect(j.scenario.letterIllustration).toBeNull();
  });
});
```

Also:
- in `src/lib/__tests__/sale-dm-lock-order-guard.test.ts`, add to `MUTATING_ROUTES`:
  `"src/app/api/properties/sale-dm/scenarios/[id]/letter-illustration/route.ts", // PUT(手紙のイラスト)`
- in `src/lib/__tests__/sale-dm-external-audit-visible.test.ts`, add to `CASES` after the `sale_dm_scenario_media_update` entry:
  `{ action: "sale_dm_scenario_letter_illustration_update", detail: { hasIllustration: true } },`

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/sale-dm-scenario-letter-illustration-route.test.ts src/lib/__tests__/sale-dm-lock-order-guard.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts`
Expected: FAIL (route module not found; audit detail redacted)

- [ ] **Step 3: Implement**

`src/app/api/properties/sale-dm/scenarios/[id]/letter-illustration/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin, lockScenarioForUpdate } from "@/lib/sale-dm-letter/scenario-guard";
import { letterIllustrationFromAsset } from "@/lib/sale-dm-letter/letter-illustration";

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({ assetId: z.string().uuid().nullable() });

/**
 * 台帳の手紙のイラストを選ぶ/外す(設計 2026-10-05 §5)。管理者だけ。
 * ロック順序は dm_scenarios → dm_lp_assets(scenarios/[id]/media と同じ並び)。写真の削除
 * (lp-assets/[assetId] DELETE)も写真行を FOR UPDATE してから数えるので、選ぶと消すがすれ違わない。
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const { assetId } = putSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id }, select: { letterIllustrationAssetId: true } });
      let asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null = null;
      if (assetId) {
        await tx.$queryRaw`SELECT id FROM dm_lp_assets WHERE id = ${assetId}::uuid FOR UPDATE`;
        asset = await tx.dmLpAsset.findFirst({
          where: { id: assetId, deletedAt: null },
          select: { publicId: true, width: true, height: true, deletedAt: true },
        });
        if (!asset) throw new ApiError(400, "その写真は削除されています。選び直してください", "ASSET_NOT_FOUND");
      }
      if (s.letterIllustrationAssetId === assetId) return { changed: false, asset };
      await tx.dmScenario.update({ where: { id }, data: { letterIllustrationAssetId: assetId } });
      return { changed: true, asset };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_letter_illustration_update",
        targetTable: "dm_scenarios",
        targetId: id,
        // 非PII: 付いたか外れたかだけ。
        detail: { hasIllustration: assetId !== null },
      });
    }
    return NextResponse.json(
      { letterIllustrationAssetId: assetId, letterIllustration: letterIllustrationFromAsset(result.asset) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/app/api/properties/sale-dm/scenarios/[id]/route.ts` GET — replace the body of the `try` with:

```ts
    await requireScenarioAdmin();
    const { id } = await params;
    const row = await prisma.dmScenario.findFirst({
      where: { id, deletedAt: null },
      include: { letterIllustrationAsset: { select: { publicId: true, width: true, height: true, deletedAt: true } } },
    });
    if (!row) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    // 写真の行そのものは返さず、描画用の形(src・寸法)にして付ける(削除済みは null)。
    const { letterIllustrationAsset, ...scenario } = row;
    return NextResponse.json(
      { scenario: { ...scenario, letterIllustration: letterIllustrationFromAsset(letterIllustrationAsset) } },
      { headers: { "Cache-Control": "no-store" } },
    );
```

and add `import { letterIllustrationFromAsset } from "@/lib/sale-dm-letter/letter-illustration";`.

`src/lib/audit-log-detail-safety.ts` — after the `sale_dm_scenario_media_update` line add:

```ts
  // 台帳の手紙のイラストを選ぶ/外す(設計 2026-10-05)。付いたか外れたかだけ。
  sale_dm_scenario_letter_illustration_update: new Set(["hasIllustration"]),
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/__tests__/sale-dm-scenario-letter-illustration-route.test.ts src/lib/__tests__/sale-dm-lock-order-guard.test.ts src/lib/__tests__/sale-dm-external-audit-visible.test.ts src/lib/__tests__/sale-dm-scenarios-route.test.ts`
Expected: tsc=0, PASS. If `sale-dm-scenarios-route.test.ts` checks the GET response with `toEqual(row)`, change it to `toEqual({ ...row, letterIllustration: null })` and make its mock row include `letterIllustrationAsset: null` (the route now strips the relation and adds the derived field). If the 403 test's role/permissions shape differs from the existing media test, copy the 403 setup from `sale-dm-scenario-media-route.test.ts` ("管理者以外は 403").

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/properties/sale-dm/scenarios/[id]" src/lib/audit-log-detail-safety.ts src/lib/__tests__/
git commit -m "feat(dm-letter): 台帳で手紙のイラストを選ぶ・外す API"
```

---

### Task 7: 印刷とキャンペーン画面の見本にイラストを渡す

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts:47-52,182-195`
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/route.ts:14-16,92-94`
- Modify: `src/lib/api-client.ts` (`interface SaleDmVariant`)
- Modify: `src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx:85-100`
- Test: `src/lib/__tests__/sale-dm-letter-illustration-wiring.test.ts`

**Interfaces:**
- Consumes: `letterIllustrationFromAsset`, `LetterIllustration` (Task 2); `DmVariant.illustrationAsset` relation (Task 1)
- Produces: `SaleDmVariant.illustration?: { src: string; width: number; height: number } | null` in the campaign GET response

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/sale-dm-letter-illustration-wiring.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const SELECT = /illustrationAsset:\s*\{\s*select:\s*\{\s*publicId:\s*true,\s*width:\s*true,\s*height:\s*true,\s*deletedAt:\s*true\s*\}\s*\}/;

describe("手紙のイラストの配線(印刷と見本が同じ形を使う)", () => {
  it("印刷: 型のイラストを読み、letterIllustrationFromAsset で渡す", () => {
    const s = code("src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts");
    expect(s).toMatch(SELECT);
    expect(s).toMatch(/illustration:\s*letterIllustrationFromAsset\(d\.variant\.illustrationAsset\)/);
  });
  it("キャンペーン取得: 型ごとに illustration を付け、写真の行は返さない", () => {
    const s = code("src/app/api/properties/sale-dm/campaigns/[id]/route.ts");
    expect(s).toMatch(SELECT);
    expect(s).toMatch(/illustration:\s*letterIllustrationFromAsset\(illustrationAsset\)/);
  });
  it("見本: 選んだ型の illustration を renderLetterHtml へ渡す", () => {
    const s = code("src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx");
    expect(s).toMatch(/illustration:\s*selectedVariant\.illustration \?\? null/);
  });
  it("画面の型に illustration がある", () => {
    const s = code("src/lib/api-client.ts");
    const v = s.slice(s.indexOf("export interface SaleDmVariant {"), s.indexOf("}", s.indexOf("export interface SaleDmVariant {")));
    expect(v).toMatch(/illustration\?:\s*\{\s*src:\s*string;\s*width:\s*number;\s*height:\s*number\s*\}\s*\|\s*null/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/sale-dm-letter-illustration-wiring.test.ts`
Expected: FAIL (4 tests)

- [ ] **Step 3: Implement**

`print/route.ts`:
- add `import { letterIllustrationFromAsset } from "@/lib/sale-dm-letter/letter-illustration";`
- in the drafts `findMany`, change `include: { variant: true, …` to:

```ts
      include: { variant: { include: { illustrationAsset: { select: { publicId: true, width: true, height: true, deletedAt: true } } } }, property: { select: { createdBy: true, assignedTo: true } }, draftOwners: { select: { ownerId: true } } },
```

- in the object returned per letter (after `trackingToken: d.trackingToken,`), add:

```ts
            // 手紙のイラスト(設計 2026-10-05)。種類から写した型だけが持つ。削除済みは null(=イラスト無し)。
            illustration: letterIllustrationFromAsset(d.variant.illustrationAsset),
```

`campaigns/[id]/route.ts`:
- add the same import.
- change `variants: true,` to:

```ts
        variants: { include: { illustrationAsset: { select: { publicId: true, width: true, height: true, deletedAt: true } } } },
```

- change the response to:

```ts
    // 型ごとの手紙のイラスト(見本用)。写真の行そのものは返さず、描画用の形だけ付ける。
    const variants = campaign.variants.map(({ illustrationAsset, ...v }) => ({
      ...v,
      illustration: letterIllustrationFromAsset(illustrationAsset),
    }));
    return NextResponse.json(
      { campaign: { ...campaign, variants, recipients } },
      { headers: { "Cache-Control": "no-store" } },
    );
```

`src/lib/api-client.ts` — in `interface SaleDmVariant`, after `scenarioId: string | null;` add:

```ts
  // 手紙のイラスト(種類から写した型だけ・見本用)。src は /lp-assets/<publicId>。
  illustration?: { src: string; width: number; height: number } | null;
```

`[campaignId]/page.tsx` — in the `renderLetterHtml({ … })` call inside `previewHtml`, after `trackingToken: selected.id,` add:

```ts
      illustration: selectedVariant.illustration ?? null,
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/__tests__/sale-dm-letter-illustration-wiring.test.ts src/lib/__tests__/sale-dm-print-route.test.ts src/lib/__tests__/sale-dm-campaign-route.test.ts`
Expected: tsc=0, PASS. (If `sale-dm-campaign-route.test.ts` does not exist, run `npx vitest run src/lib/__tests__ -t "campaign"` instead.) If an existing print/campaign route test mocks variants without `illustrationAsset`, it still passes: `letterIllustrationFromAsset(undefined)` returns null. If an existing test asserts the campaign response with `toEqual` on `variants`, add `illustration: null` to each expected variant.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]" src/lib/api-client.ts "src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx" src/lib/__tests__/
git commit -m "feat(dm-letter): 印刷と見本に手紙のイラストを渡す"
```

---

### Task 8: 「DMの種類」の画面に「手紙のイラスト」の枠

**Files:**
- Create: `src/components/sale-dm/letter-illustration-panel.tsx`
- Modify: `src/lib/api-client.ts` (`SaleDmScenario` type, mock in `fetchSaleDmScenario`, new `saveSaleDmScenarioLetterIllustration`)
- Modify: `src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx:116`
- Test: `src/lib/__tests__/sale-dm-letter-illustration-panel.test.ts`

**Interfaces:**
- Consumes: `PUT /api/properties/sale-dm/scenarios/[id]/letter-illustration` (Task 6); `fetchSaleDmLpAssets`, `SaleDmLpAsset`, `LP_ASSET_URL` and `LpAssetLibrary` (existing)
- Produces:
  - `saveSaleDmScenarioLetterIllustration(id: string, assetId: string | null): Promise<{ letterIllustrationAssetId: string | null; letterIllustration: { src: string; width: number; height: number } | null }>`
  - `SaleDmScenario.letterIllustrationAssetId: string | null` and `letterIllustration: { src; width; height } | null`
  - default export `LetterIllustrationPanel({ scenarioId, illustration, onChanged }: { scenarioId: string; illustration: { src: string; width: number; height: number } | null; onChanged: () => void })`

- [ ] **Step 1: Write the failing test** (vitest env=node: SSR markup + source scan, as in other UI tests)

```ts
// src/lib/__tests__/sale-dm-letter-illustration-panel.test.ts
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/lib/api-client", () => ({
  fetchSaleDmLpAssets: vi.fn(async () => ({ assets: [] })),
  saveSaleDmScenarioLetterIllustration: vi.fn(),
  uploadSaleDmLpAsset: vi.fn(),
  LP_ASSET_URL: (p: string) => `/lp-assets/${p}`,
}));
import LetterIllustrationPanel from "@/components/sale-dm/letter-illustration-panel";

const PID = "0123456789abcdef0123456789abcdef";
const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("手紙のイラストの枠(台帳の画面)", () => {
  it("登録済みなら画像と「外す」、説明文が出る", () => {
    const html = renderToStaticMarkup(createElement(LetterIllustrationPanel, { scenarioId: "s1", illustration: { src: `/lp-assets/${PID}`, width: 1200, height: 400 }, onChanged: () => {} }));
    expect(html).toContain("手紙のイラスト");
    expect(html).toContain(`src="/lp-assets/${PID}"`);
    expect(html).toContain("イラストを選ぶ");
    expect(html).toContain("外す");
    expect(html).toContain("【イラスト】の行に入ります");
    expect(html).toContain("横長(約3:1)");
  });
  it("未登録なら画像も「外す」も出ない", () => {
    const html = renderToStaticMarkup(createElement(LetterIllustrationPanel, { scenarioId: "s1", illustration: null, onChanged: () => {} }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("外す");
    expect(html).toContain("まだ登録されていません");
  });
  it("走査: 台帳の画面に枠が置かれ、保存は専用 API を呼ぶ", () => {
    expect(code("src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx")).toMatch(/<LetterIllustrationPanel[\s\S]*?scenarioId=\{scenario\.id\}[\s\S]*?illustration=\{scenario\.letterIllustration\}/);
    const api = code("src/lib/api-client.ts");
    expect(api).toMatch(/export async function saveSaleDmScenarioLetterIllustration\(/);
    expect(api).toContain("/letter-illustration`");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/sale-dm-letter-illustration-panel.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

`src/lib/api-client.ts`:
- In `type SaleDmScenario`, after `lpBodyText: string | null;` add:

```ts
  // 手紙のイラスト(設計 2026-10-05)。描画用(src は /lp-assets/<publicId>)。
  letterIllustrationAssetId: string | null;
  letterIllustration: { src: string; width: number; height: number } | null;
```

- In the mock object returned by `fetchSaleDmScenario`, add `letterIllustrationAssetId: null, letterIllustration: null,` after `lpBodyText: null,`.
- After `fetchSaleDmScenarioPrompt`, add:

```ts
/** 台帳の手紙のイラストを選ぶ(assetId)/外す(null)。管理者だけ。 */
export async function saveSaleDmScenarioLetterIllustration(
  id: string,
  assetId: string | null,
): Promise<{ letterIllustrationAssetId: string | null; letterIllustration: { src: string; width: number; height: number } | null }> {
  if (USE_MOCK) { await mockDelay(); return { letterIllustrationAssetId: assetId, letterIllustration: null }; }
  return apiFetch(`${SCENARIO_BASE}/${id}/letter-illustration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId }),
  });
}
```

`src/components/sale-dm/letter-illustration-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Loader2, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import LpAssetLibrary from "@/components/sale-dm/lp-asset-library";
import { fetchSaleDmLpAssets, saveSaleDmScenarioLetterIllustration, type SaleDmLpAsset } from "@/lib/api-client";

/**
 * 台帳の「手紙のイラスト」(設計 2026-10-05 §5)。LPの写真と同じライブラリから1枚選ぶ/外す。
 * 手紙に入った姿は、キャンペーン画面の手紙の見本で確かめる(この画面に手紙の見本は無い)。
 */
export default function LetterIllustrationPanel({ scenarioId, illustration, onChanged }: {
  scenarioId: string;
  illustration: { src: string; width: number; height: number } | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<SaleDmLpAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAssets = async () => {
    try {
      setAssets((await fetchSaleDmLpAssets()).assets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "写真の一覧を読み込めませんでした");
    }
  };
  const openLibrary = async () => {
    setError(null);
    await loadAssets();
    setOpen(true);
  };
  const save = async (assetId: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSaleDmScenarioLetterIllustration(scenarioId, assetId);
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">手紙のイラスト</h2>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        手紙の本文の【イラスト】の行に入ります(無ければ本文の上)。横長(約3:1)がおすすめです。手紙に入った姿は、発送の画面の手紙の見本で確かめられます。
      </p>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        {illustration ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={illustration.src} alt="" width={illustration.width} height={illustration.height} className="h-auto max-h-32 w-64 rounded border border-gray-200 object-contain dark:border-gray-700" />
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">まだ登録されていません(登録するまで、手紙は今までの見た目で刷られます)。</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void openLibrary()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}イラストを選ぶ…
          </Button>
          {illustration && (
            <Button variant="secondary" size="sm" onClick={() => void save(null)} disabled={busy}>
              <X className="h-3.5 w-3.5" />外す
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <LpAssetLibrary
        open={open}
        onClose={() => setOpen(false)}
        onPick={(a) => void save(a.id)}
        assets={assets}
        onAssetsChanged={() => void loadAssets()}
      />
    </section>
  );
}
```

`src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx`:
- add `import LetterIllustrationPanel from "@/components/sale-dm/letter-illustration-panel";`
- directly after `<ScenarioTextEditor scenario={scenario} kind="letter" onChanged={() => void reloadContent()} />` add:

```tsx
      <LetterIllustrationPanel scenarioId={scenario.id} illustration={scenario.letterIllustration} onChanged={() => void reloadContent()} />
```

- [ ] **Step 4: Run tests and lint**

Run: `npx tsc --noEmit; echo tsc=$?; npx vitest run src/lib/__tests__/sale-dm-letter-illustration-panel.test.ts src/lib/__tests__/sale-dm-scenario-ui-scan.test.ts; npx eslint src/components/sale-dm/letter-illustration-panel.tsx "src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx"; echo lint=$?`
Expected: tsc=0, PASS, lint=0. (If `@next/next/no-img-element` is not configured in this repo's eslint, remove the disable comment; follow how `lp-media-panel.tsx` renders its thumbnails.)

- [ ] **Step 5: Commit**

```bash
git add src/components/sale-dm/letter-illustration-panel.tsx src/lib/api-client.ts "src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx" src/lib/__tests__/sale-dm-letter-illustration-panel.test.ts
git commit -m "feat(dm-letter): DMの種類の画面に「手紙のイラスト」の枠"
```

---

### Task 9: 使い方ガイド/マニュアルと全ゲート

**Files:**
- Modify: `public/docs/guide.html` (the「DMの種類」note in 営業支援)
- Modify: `public/docs/manual.html` (§9 営業のお手紙 — the DMの種類 paragraph or tip box)
- Test: `src/lib/__tests__/deploy-doc-mail.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `src/lib/__tests__/deploy-doc-mail.test.ts`:

```ts
describe("手紙のイラスト(2026-10)の説明", () => {
  it.each([
    ["guide", () => guideSrc],
    ["manual", () => manualSrc],
  ])("%s.html に手紙のイラストと【イラスト】の行の説明がある", (_n, src) => {
    expect(src()).toContain("手紙のイラスト");
    expect(src()).toContain("【イラスト】");
    expect(src()).toContain("本文の上");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/deploy-doc-mail.test.ts`
Expected: FAIL (2)

- [ ] **Step 3: Write the docs**

In `public/docs/guide.html`, inside the `<div class="note"><b>「DMの種類」ごとに、手紙とご案内ページを組で付けられます（2026-09）</b>…</div>` note, append before its closing `</div>`:

```html
<br><b>手紙のイラスト（2026-10）</b>：「DMの種類」の画面の<b>「手紙のイラスト」</b>で、種類ごとに1枚、LPの写真と同じライブラリからイラストを選べます（横長・約3:1がおすすめ）。指示文には「イラストを入れたい所に【イラスト】と1行書く」が入るので、外部AIが手紙の流れに合う場所を選びます。刷るときは<b>最初の【イラスト】の行</b>にイラストが入り、【イラスト】が無い文面では<b>本文の上</b>に入ります（【イラスト】の文字は紙に出ません）。イラストが未登録の種類は今までの見た目のままです。発送を作った時点のイラストを写し取るので、あとで台帳のイラストを替えても作成済みの発送は変わりません。使っているイラストはライブラリから消せません。「種類を使わない」で作った発送には入りません。
```

In `public/docs/manual.html`, in §9 (`<section id="s9">`), add a new tip box right after the `<div class="tip box">` that starts with `<span class="lbl">💡</span><b>ご案内ページから無料査定を申し込めます（2026-09）</b>`:

```html
    <div class="tip box"><span class="lbl">💡</span><b>手紙にイラストを入れる（2026-10・DMの種類で作る発送）</b>：管理者が「DMの種類」の画面の<b>「手紙のイラスト」</b>で <span class="btn">イラストを選ぶ…</span> を押し、LPの写真と同じライブラリから1枚選びます（横長・約3:1がおすすめ。外すときは <span class="btn">外す</span>）。外部AIへの指示文に「イラストを入れたい所に【イラスト】と1行書く」が入るので、返ってきた文面の<b>最初の【イラスト】の行</b>にイラストが入ります。【イラスト】が無い文面では<b>本文の上</b>に入り、【イラスト】の文字は紙に出ません。入った姿は発送の画面の手紙の見本で確かめられます。発送を作った時点のイラストを写し取るため、あとで台帳を替えても作成済みの発送は変わりません。</div>
```

- [ ] **Step 4: Run all gates**

```bash
npx tsc --noEmit > /tmp/tsc.txt 2>&1; echo tsc=$?
npx vitest run > /tmp/vitest.txt 2>&1; echo vitest=$?; grep -E "Test Files|Tests " /tmp/vitest.txt
npx eslint $(git diff --name-only origin/main -- '*.ts' '*.tsx') > /tmp/eslint.txt 2>&1; echo eslint=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.txt 2>&1; echo build=$?; grep -E "letter-illustration" /tmp/build.txt
```

Expected: tsc=0, vitest=0 (all files pass), eslint=0, build=0 with the new route `/api/properties/sale-dm/scenarios/[id]/letter-illustration` listed. A 5-second timeout in an unrelated heavy test (PDF/Excel) is load flakiness: re-run that file alone and report it as such.

- [ ] **Step 5: Commit**

```bash
git add public/docs/guide.html public/docs/manual.html src/lib/__tests__/deploy-doc-mail.test.ts
git commit -m "docs(guide): 手紙のイラスト(DMの種類ごと・【イラスト】の行)"
```
