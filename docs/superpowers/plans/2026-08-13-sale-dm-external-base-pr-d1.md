# 売却DM 外部AI方式の土台（PR-D1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部AI方式（PR-D2）が乗る土台として、売却DMの**既存挙動を変えずに**安全側だけを固める — 型テーブルへの列追加（expand）、本文検証の1本化、ロック順序の統一、確定処理の競合封じ、書き込み権限の統一。

**Architecture:** 設計書 `2026-08-08-sale-dm-external-paste-design.md` のうち、**外部AI機能そのものに触れない部分**だけを取り出す。列は追加するが書き手は作らない（expand→contract の expand 段）。本文検証は新しい純関数1本に集約し、既存の下書き編集から通す。ロックは全 route で「Owner → variant → 物件親行 → 子行」の一方向に揃える。

**Tech Stack:** Next.js App Router / TypeScript / Prisma(PostgreSQL) / Vitest / zod

## Global Constraints

- 設計の正本 = `docs/superpowers/specs/2026-08-08-sale-dm-external-paste-design.md`。本計画は**その一部**（外部AIモード本体は PR-D2）。
- **既存の動きを変えない**。売却DMは本番で休眠中（AI設定未投入で 503）だが、それに依存せず「設定が入っていても挙動が変わらない」ことを保証する。⚠例外は2つだけで、どちらも**塞ぐ方向**: ①空白のみの本文が保存できなくなる ②`{{` を含む本文が保存できなくなる。
- **migration は列追加のみ**（`prompt_text` / `body_template` / `template_frozen_at`）。**backfill しない・書き手も作らない**（設計 §2.4 の @codex R21: 列を埋めるのは PR-D2 の照合スクリプトを restart 後に流すときだけ）。
- **新しい permission slug を作らない**。既存の `property:write` を要求する route を増やすだけ（設計 §2.5）。
- 新しい依存パッケージを入れない。新しい env を作らない。
- ロック順序の全体規約（設計 §2.3）: **Owner（代表所有者） → variant → 物件親行 → 子行**。各 tx は必要なものだけを、常にこの順で取る。
- コミットは日本語 conventional commits。**amend しない**。
- 作業 worktree = `property-management-worktrees/sale-dm-external-base` / branch `feat/sale-dm-external-base`。

---

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `prisma/migrations/20260813000000_add_dm_variant_template/migration.sql` | `dm_variants` に3列追加（additive・書き手は PR-D2） |
| `src/lib/sale-dm-letter/body-validation.ts` | 手紙本文の検証の**単一定義元**（trim 非空・`{{` 拒否）。DBに触れない純関数 |
| `src/lib/sale-dm-letter/__tests__/body-validation.test.ts` | 上の振る舞いテスト |
| `src/lib/__tests__/sale-dm-write-permission-guard.test.ts` | **走査型ガード**: sale-dm 配下で書き込みを行う全 route が `property:write` を要求することを、route 名を手で並べずに検査 |

**変更**

| ファイル | 変更内容 |
|---|---|
| `prisma/schema.prisma` | `DmVariant` に3列（コメントで「PR-D2 で使う」を明記） |
| `src/lib/sale-dm-letter/route-guard.ts` | `requireSaleDmWriteAccess()` を追加（`requireSaleDmAccess` + `property:write`） |
| `src/app/api/properties/sale-dm/drafts/[id]/route.ts` | 本文検証を通す + 書込権限 |
| `src/app/api/properties/sale-dm/drafts/confirm/route.ts` | variant 行ロック + field_staff の物件親行ロック + 書込権限 |
| `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts` | ロック順序を variant→親→draft へ + 書込権限 |
| `src/app/api/properties/sale-dm/campaigns/route.ts` / `variants/route.ts` / `[id]/assign/route.ts` | 書込権限 |

---

### Task 1: 型テーブルへの列追加（expand のみ）

**Files:**
- Modify: `prisma/schema.prisma`（`model DmVariant`）
- Create: `prisma/migrations/20260813000000_add_dm_variant_template/migration.sql`

**Interfaces:**
- Consumes: なし
- Produces: `DmVariant.promptText` / `DmVariant.bodyTemplate` / `DmVariant.templateFrozenAt`（**PR-D2 が書く**。本 PR では誰も書かない）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-variant-template-columns.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR-D2(外部AI方式)が使う列を先に足しておく(expand)。この PR では書き手を作らない。
const schema = readFileSync(
  path.resolve(process.cwd(), "prisma/schema.prisma"),
  "utf-8",
);
const model = schema.slice(
  schema.indexOf("model DmVariant {"),
  schema.indexOf("model DmRecipientDraft {"),
);

describe("DmVariant: 外部AI方式の列(PR-D2で使用)", () => {
  it("promptText / bodyTemplate / templateFrozenAt をすべて持つ", () => {
    expect(model).toMatch(/promptText\s+String\?\s+@map\("prompt_text"\)/);
    expect(model).toMatch(/bodyTemplate\s+String\?\s+@map\("body_template"\)/);
    expect(model).toMatch(
      /templateFrozenAt\s+DateTime\?\s+@map\("template_frozen_at"\)/,
    );
  });

  it("すべて nullable(既存行を壊さない・バックフィルしない)", () => {
    for (const col of ["promptText", "bodyTemplate", "templateFrozenAt"]) {
      const line = model.split("\n").find((l) => l.includes(col));
      expect(line, `${col} の行が無い`).toBeDefined();
      expect(line).toMatch(/\?/);
      expect(line).not.toMatch(/@default/);
    }
  });

  it("migration は ADD COLUMN だけ(UPDATE/backfill を含まない)", () => {
    const sql = readFileSync(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260813000000_add_dm_variant_template/migration.sql",
      ),
      "utf-8",
    );
    expect(sql).toMatch(/ADD COLUMN "prompt_text"/);
    expect(sql).toMatch(/ADD COLUMN "body_template"/);
    expect(sql).toMatch(/ADD COLUMN "template_frozen_at"/);
    expect(sql).not.toMatch(/UPDATE|DELETE|NOT NULL|DROP/i);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-variant-template-columns.test.ts`
Expected: FAIL（`promptText` が schema に無い / migration ファイルが無い）

- [ ] **Step 3: schema に3列を足す**

`prisma/schema.prisma` の `model DmVariant` 内、`lpUrl` の直後に追加:

```prisma
  /// 外部AI方式(PR-D2)で表示したプロンプトの控え。⚠この PR では書き手が居ない(expand のみ)。
  promptText       String?   @map("prompt_text")
  /// 外部AI方式(PR-D2)で貼り付けた本文の原本(drafts への適用元)。同上。
  bodyTemplate     String?   @map("body_template")
  /// 型の凍結印。null=未凍結・一度立てたら解除しない。判定は「この列 OR 配下に confirmed/sent」の
  /// 二重判定(設計 §2.4)。⚠立てるのは PR-D2。この PR では常に null のまま。
  templateFrozenAt DateTime? @map("template_frozen_at")
```

- [ ] **Step 4: migration を書く**

`prisma/migrations/20260813000000_add_dm_variant_template/migration.sql` を新規作成:

```sql
-- 外部AI方式(プロンプト出力→貼り付け)で使う列を先に足す(expand)。
-- ⚠この migration では**書き手を作らない・バックフィルもしない**(設計 §2.4 @codex R21)。
--   列を埋めるのは PR-D2 の照合スクリプトを restart 後に流すときだけ。
--   migration 内で埋めると migrate→restart の窓で旧ルートが凍結済み型を書き換え・削除できる。
-- 既存行はすべて NULL = 従来どおりの動作。
ALTER TABLE "dm_variants" ADD COLUMN "prompt_text" TEXT;
ALTER TABLE "dm_variants" ADD COLUMN "body_template" TEXT;
ALTER TABLE "dm_variants" ADD COLUMN "template_frozen_at" TIMESTAMP(3);
```

- [ ] **Step 5: 生成し直してテストが通ることを確認**

Run: `npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-variant-template-columns.test.ts`
Expected: PASS（3件）

Run: `npx tsc --noEmit`
Expected: エラー 0

- [ ] **Step 6: コミット**

```bash
git add prisma/schema.prisma prisma/migrations/20260813000000_add_dm_variant_template src/lib/__tests__/sale-dm-variant-template-columns.test.ts
git commit -m "feat(sale-dm): 外部AI方式で使う列を先に足す(expand・書き手はPR-D2)"
```

---

### Task 2: 本文検証を1本に集約し、既存の下書き編集に通す

**Files:**
- Create: `src/lib/sale-dm-letter/body-validation.ts`
- Create: `src/lib/sale-dm-letter/__tests__/body-validation.test.ts`
- Modify: `src/app/api/properties/sale-dm/drafts/[id]/route.ts:11-20`（schema）と `:61-67`（body の反映）
- Test: `src/lib/__tests__/sale-dm-draft-patch-body-validation.test.ts`（新規・route の振る舞い）

**Interfaces:**
- Consumes: なし
- Produces（PR-D2 が貼り付け・一括適用でも同じものを使う）:
  - `LETTER_BODY_MAX_LENGTH: number`
  - `type LetterBodyIssue = "empty" | "unknown_tag" | "too_long"`
  - `validateLetterBody(body: string): LetterBodyIssue | null`
  - `letterBodyIssueMessage(issue: LetterBodyIssue): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sale-dm-letter/__tests__/body-validation.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import {
  LETTER_BODY_MAX_LENGTH,
  letterBodyIssueMessage,
  validateLetterBody,
} from "../body-validation";

describe("validateLetterBody", () => {
  it("ふつうの本文は通る", () => {
    expect(validateLetterBody("拝啓 時下ますますご清祥のこととお喜び申し上げます。")).toBeNull();
  });

  it("空・空白のみ・改行のみは弾く(白紙の手紙が確定・印刷まで通るのを防ぐ)", () => {
    for (const body of ["", " ", "　", "\n", " \n\t 　\n"]) {
      expect(validateLetterBody(body)).toBe("empty");
    }
  });

  it("差込タグの書き方が残っている本文は弾く(プレースホルダのまま郵送されるのを防ぐ)", () => {
    expect(validateLetterBody("{{所有者名}} 様へ")).toBe("unknown_tag");
    expect(validateLetterBody("本文\n{{物件所在}}\n本文")).toBe("unknown_tag");
  });

  it("上限を超える本文は弾く", () => {
    expect(validateLetterBody("あ".repeat(LETTER_BODY_MAX_LENGTH))).toBeNull();
    expect(validateLetterBody("あ".repeat(LETTER_BODY_MAX_LENGTH + 1))).toBe("too_long");
  });

  it("検査の順番は 空→長さ→タグ(空文字に長さやタグの理由を出さない)", () => {
    expect(validateLetterBody("   ")).toBe("empty");
  });

  it("理由ごとに日本語の説明が出る(そのまま画面に出せる)", () => {
    for (const issue of ["empty", "unknown_tag", "too_long"] as const) {
      const msg = letterBodyIssueMessage(issue);
      expect(msg.length).toBeGreaterThan(5);
      expect(msg).not.toMatch(/[A-Za-z_]{6,}/); // 内部識別子をそのまま出さない
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/body-validation.test.ts`
Expected: FAIL（`Failed to resolve import "../body-validation"`）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/sale-dm-letter/body-validation.ts` を新規作成:

```ts
/**
 * 売却DM 手紙本文の検証（設計 2026-08-08-sale-dm-external-paste-design.md §2.3）。
 *
 * **単一定義元**。本 PR では個別の下書き編集から通し、PR-D2 で
 * 「貼り付け保存」「全宛先に適用」も同じ関数に通す（同じ結果を生む全経路に同じ門）。
 * DB を触らない純関数のみ。HTTP ステータス化は呼び出し側 route の責務。
 *
 * ⚠差込タグ（`{{...}}`）は **PR-D2 で導入する**。この PR の時点では正規のタグが
 * 存在しないので、`{{` を含む本文はすべて弾く（未知タグ＝プレースホルダのまま
 * 郵送される事故を先に塞ぐ）。PR-D2 で許可タグ（物件所在／物件種別）を
 * この関数に足し、許可タグだけを通す形へ広げる。
 */

/** 貼り付け・編集で受け付ける本文の上限。印刷レイアウトの最大想定に対して十分な余裕（設計 §2.3）。 */
export const LETTER_BODY_MAX_LENGTH = 20_000;

export type LetterBodyIssue = "empty" | "unknown_tag" | "too_long";

/** 問題があればその種類を、無ければ null を返す。 */
export function validateLetterBody(body: string): LetterBodyIssue | null {
  // 空判定を最初に（空文字に「長すぎ」「タグ」の理由を出さない）。
  if (body.trim().length === 0) return "empty";
  if (body.length > LETTER_BODY_MAX_LENGTH) return "too_long";
  if (body.includes("{{")) return "unknown_tag";
  return null;
}

/** 画面にそのまま出せる日本語の説明（内部識別子を露出させない）。 */
export function letterBodyIssueMessage(issue: LetterBodyIssue): string {
  switch (issue) {
    case "empty":
      return "本文が空です。空白や改行だけの本文は保存できません";
    case "too_long":
      return `本文が長すぎます（${LETTER_BODY_MAX_LENGTH.toLocaleString()}字まで）`;
    case "unknown_tag":
      return "本文に差し込みの記号（{{ }}）が残っています。そのまま印刷されてしまうため保存できません";
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/body-validation.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: route の振る舞いテストを書く（失敗を確認）**

`src/lib/__tests__/sale-dm-draft-patch-body-validation.test.ts` を新規作成。
⚠既存の sale-dm route テスト（`src/lib/__tests__/` 配下で `sale-dm` を含むもの）を1つ開き、その `vi.mock` 構成（`next/server` / `@/lib/api-helpers` / `@/lib/prisma` / `@/lib/audit` / `@/lib/sale-dm-letter/route-guard`）をそのまま踏襲すること。テスト本体は次の3件:

```ts
  it("空白だけの本文は 400(白紙の手紙を作らせない)", async () => {
    const res = await PATCH(makeRequest({ body: "   \n " }), ctx);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("差込の記号が残っている本文は 400", async () => {
    const res = await PATCH(makeRequest({ body: "{{所有者名}} 様" }), ctx);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("ふつうの本文は従来どおり保存され、確定は解除される", async () => {
    const res = await PATCH(makeRequest({ body: "拝啓" }), ctx);
    expect(res.status).toBe(200);
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.body).toBe("拝啓");
    expect(data.status).toBe("draft");
    expect(data.confirmedAt).toBeNull();
  });
```

Run: `npx vitest run src/lib/__tests__/sale-dm-draft-patch-body-validation.test.ts`
Expected: FAIL（1件目・2件目が 200 で通ってしまう＝現状は検証していない）

- [ ] **Step 6: route に検証を通す**

`src/app/api/properties/sale-dm/drafts/[id]/route.ts`:

1. import を追加:

```ts
import {
  letterBodyIssueMessage,
  validateLetterBody,
} from "@/lib/sale-dm-letter/body-validation";
```

2. `if (parsed.body !== undefined) {` のブロック先頭に検証を挿入:

```ts
    if (parsed.body !== undefined) {
      // 本文の検証は貼り付け・一括適用(PR-D2)と同じ関数を通す。1宛先ずつの編集で
      // 迂回できると、白紙やプレースホルダ入りの手紙がそのまま郵送される。
      const issue = validateLetterBody(parsed.body);
      if (issue) throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_BODY");
      data.body = parsed.body;
```

- [ ] **Step 7: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-draft-patch-body-validation.test.ts src/lib/sale-dm-letter`
Expected: PASS（既存の sale-dm lib テストも含めて緑）

- [ ] **Step 8: コミット**

```bash
git add src/lib/sale-dm-letter/body-validation.ts src/lib/sale-dm-letter/__tests__/body-validation.test.ts "src/app/api/properties/sale-dm/drafts/[id]/route.ts" src/lib/__tests__/sale-dm-draft-patch-body-validation.test.ts
git commit -m "feat(sale-dm): 手紙本文の検証を1本にまとめ、下書き編集から通す"
```

---

### Task 3: 型の設定変更のロック順序を「variant → 物件親行 → draft」へ揃える

**Files:**
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts:75-108`
- Test: `src/lib/__tests__/sale-dm-lock-order-guard.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: なし
- Produces: 全 sale-dm 経路で守る順序「Owner → variant → 物件親行 → 子行」

**なぜ変えるのか（実装前に読む）**

現行の型 PATCH は tx の中で **draft 行を先に FOR UPDATE している**（`SELECT id FROM dm_recipient_drafts ... FOR UPDATE`）。PR-D2 で新設する「貼り付け／適用」は **variant 行を先に**ロックする必要がある（凍結判定と確定の直列化）。この2つが混ざると**デッドロック**する。先に既存側を揃えておく。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-lock-order-guard.test.ts` を新規作成:

```ts
/**
 * 売却DM の書き込み tx が守るロック順序（設計 §2.3）:
 *   Owner(代表所有者) → variant → 物件親行 → 子行(draft)
 * ⚠混在するとデッドロックする。SQL の出現順をソースで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function src(p: string) {
  return readFileSync(path.resolve(process.cwd(), p), "utf-8");
}

describe("型の設定変更(variant PATCH)のロック順序", () => {
  const s = src(
    "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
  );

  it("variant 行を FOR UPDATE でロックする", () => {
    expect(s).toMatch(/FROM dm_variants[\s\S]{0,120}FOR UPDATE/);
  });

  it("variant のロックが draft のロックより先に来る", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,120}FOR UPDATE/);
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,120}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(-1);
    expect(v).toBeLessThan(d);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lock-order-guard.test.ts`
Expected: FAIL（`FROM dm_variants ... FOR UPDATE` が無い）

- [ ] **Step 3: variant 行のロックを先に足す**

`variants/[variantId]/route.ts` の tx 内、既存の draft ロック（`await tx.$queryRaw\`SELECT id FROM dm_recipient_drafts ...\``）の**直前**に追加:

```ts
      // ロック順序（設計 §2.3）: variant → 物件親行 → draft。PR-D2 の「貼り付け／適用」は
      // variant を先に取るため、こちらも先に取らないと互いに待ち合ってデッドロックする。
      await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${variantId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lock-order-guard.test.ts`
Expected: PASS（2件）

- [ ] **Step 5: 既存の型 PATCH テストが壊れていないことを確認**

Run: `npx vitest run src/lib/__tests__ --reporter=dot -t "variant"`
Expected: PASS（型 PATCH の既存テストが緑のまま）

- [ ] **Step 6: コミット**

```bash
git add "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts" src/lib/__tests__/sale-dm-lock-order-guard.test.ts
git commit -m "fix(sale-dm): 型の設定変更を variant 行のロックから始める(順序統一)"
```

---

### Task 4: 宛先の確定に variant ロックと担当範囲の再検証を足す

**Files:**
- Modify: `src/app/api/properties/sale-dm/drafts/confirm/route.ts:42-106`
- Test: `src/lib/__tests__/sale-dm-lock-order-guard.test.ts`（Task 3 で作ったファイルに追記）

**Interfaces:**
- Consumes: Task 3 の順序規約
- Produces: 確定 tx が Owner → variant →（field_staff なら）物件親行 → draft の順でロックする

**なぜ必要か（実装前に読む）**

確定は担当範囲の条件を **ロックの外**で評価している（where にリレーション述語を書いているだけ）。リレーション述語はステートメントのスナップショットで評価されるため、**判定〜commit の間に担当が変わる**と、アクセスを失った後の確定が通る（TOCTOU）。また PR-D2 の「貼り付け／適用」は凍結判定のために variant を掴むので、確定側も同じ順で掴まないと直列化されない。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-lock-order-guard.test.ts` の末尾に追記:

```ts
describe("宛先の確定(drafts/confirm)のロック順序", () => {
  const s = src("src/app/api/properties/sale-dm/drafts/confirm/route.ts");

  it("所有者 → variant → 物件親行 の順にロックを取る", () => {
    const o = s.indexOf("lockOwnersForShare");
    const v = s.search(/FROM dm_variants[\s\S]{0,160}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,160}FOR UPDATE/);
    expect(o).toBeGreaterThan(-1);
    expect(v).toBeGreaterThan(o);
    expect(p).toBeGreaterThan(v);
  });

  it("field_staff のときだけ物件親行を取る(admin/office は不要)", () => {
    expect(s).toMatch(/field_staff[\s\S]{0,400}FROM properties[\s\S]{0,160}FOR UPDATE/);
  });

  it("ロック後に担当範囲を再検証する(ロック前の判定だけで確定しない)", () => {
    const p = s.search(/FROM properties[\s\S]{0,160}FOR UPDATE/);
    expect(s.slice(p)).toMatch(/assignedTo|createdBy/);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lock-order-guard.test.ts`
Expected: FAIL（confirm route に variant / properties のロックが無い）

- [ ] **Step 3: 確定 tx にロックと再検証を足す**

`drafts/confirm/route.ts` の tx 内、`await lockOwnersForShare(tx, ownerIds);` の**直後**に追加（`drafts` の select に `variantId: true` と `propertyId: true` を足しておくこと）:

```ts
      // ロック順序（設計 §2.3）: Owner → variant → 物件親行 → 子行。
      // variant を掴むのは、PR-D2 の「貼り付け／適用」（凍結判定）と直列化するため。
      const variantIds = [...new Set(drafts.map((d) => d.variantId))].sort();
      if (variantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${variantIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }

      // field_staff は担当範囲を**ロックを保持したまま**見直す。where のリレーション述語は
      // ステートメントのスナップショットで評価されるため、判定〜commit の間の担当変更を
      // 防げない（アクセスを失った後の確定が通る）。admin/office は判定が常に真なので不要。
      if (session.role === "field_staff") {
        const propertyIds = [...new Set(drafts.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({
            where: {
              id: { in: propertyIds },
              OR: [{ createdBy: session.id }, { assignedTo: session.id }],
            },
            select: { id: true },
          });
          if (visible.length !== propertyIds.length) {
            throw new ApiError(
              409,
              "担当が変わった宛先が含まれています。画面を開き直してから確定してください",
              "SCOPE_CHANGED",
            );
          }
        }
      }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-lock-order-guard.test.ts`
Expected: PASS（5件）

- [ ] **Step 5: 既存の確定テストが壊れていないことを確認**

Run: `npx vitest run src/lib/__tests__ --reporter=dot -t "confirm"`
Expected: PASS（既存の確定テストが緑のまま。`$queryRaw` のモックが無くて落ちる場合は、そのテストのモックに `$queryRaw: vi.fn().mockResolvedValue([])` を足す）

- [ ] **Step 6: コミット**

```bash
git add src/app/api/properties/sale-dm/drafts/confirm/route.ts src/lib/__tests__/sale-dm-lock-order-guard.test.ts
git commit -m "fix(sale-dm): 確定は型と物件をロックしてから担当範囲を見直す"
```

---

### Task 5: 書き込みを行う経路に property:write を統一要求

**Files:**
- Modify: `src/lib/sale-dm-letter/route-guard.ts`（`requireSaleDmWriteAccess` 追加）
- Modify: `campaigns/route.ts` / `campaigns/[id]/variants/route.ts` / `campaigns/[id]/variants/[variantId]/route.ts` / `campaigns/[id]/assign/route.ts` / `drafts/[id]/route.ts` / `drafts/confirm/route.ts`
- Test: `src/lib/__tests__/sale-dm-write-permission-guard.test.ts`（新規・走査型）

**Interfaces:**
- Consumes: 既存の `requireSaleDmAccess`
- Produces: `requireSaleDmWriteAccess(): Promise<{ session; permissions; ownerDisplayConfig }>`

**なぜ必要か（実装前に読む）**

これまで書き込み系の実質的な門は `sale_dm:generate` だった（生成できなければ何も作れない）。外部AI方式では**生成なしで一式が作れる**ので、この門が外れる。閲覧権限だけの利用者が記録の作成・失効・確定までできてしまう前に、書き込み系を `property:write` に揃える。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/sale-dm-write-permission-guard.test.ts` を新規作成:

```ts
/**
 * 売却DM の**書き込み系 route は全部** property:write を要求する（設計 §2.5）。
 *
 * ⚠route 名を手で並べない。sale-dm 配下の route.ts を走査し、POST/PATCH/DELETE を
 * 公開しているものを機械的に対象にするので、**将来 route を足したときの付け忘れも落ちる**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

/** 読み取り専用として書き込み門を要求しない route（理由を必ず書く）。 */
const READ_ONLY_EXCEPTIONS: Record<string, string> = {};

describe("sale-dm: 書き込み系 route は property:write を要求する", () => {
  const files = routeFiles(ROOT);

  it("走査できている（0件なら検査が空振り）", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of routeFiles(ROOT)) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const s = readFileSync(file, "utf-8");
    const writes = /export async function (POST|PATCH|DELETE|PUT)\b/.test(s);
    if (!writes) continue;
    const reason = READ_ONLY_EXCEPTIONS[rel];
    it(`${rel}${reason ? `（除外: ${reason}）` : ""}`, () => {
      if (reason) return;
      const guarded =
        s.includes("requireSaleDmWriteAccess") ||
        /hasPermission\([^)]*"property"[^)]*"write"/.test(s);
      expect(guarded, `${rel} が書き込み門を通っていない`).toBe(true);
    });
  }
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-write-permission-guard.test.ts`
Expected: FAIL（複数の route が門を通っていない）

- [ ] **Step 3: 共通ガードを足す**

`src/lib/sale-dm-letter/route-guard.ts` の末尾に追加:

```ts
// 書き込み系（キャンペーン作成・型の作成/更新/削除・割当・確定・下書き編集）の共通門。
// これまでの実質的な門は sale_dm:generate（生成できなければ何も作れない）だったが、
// 外部AI方式では生成なしで一式が作れるため、閲覧権限だけの利用者が記録の作成・失効・
// 確定までできてしまう。同じ結果を生む全経路に同じ門を置く（設計 §2.5）。
export async function requireSaleDmWriteAccess() {
  const ctx = await requireSaleDmAccess();
  if (!hasPermission(ctx.permissions, "property", "write")) {
    throw new ApiError(403, "物件情報の編集権限がありません", "FORBIDDEN");
  }
  return ctx;
}
```

- [ ] **Step 4: 6つの route を差し替える**

各ファイルで `requireSaleDmAccess` の import と呼び出しを `requireSaleDmWriteAccess` に置き換える（GET と混在するファイルでは、**書き込みハンドラだけ**を置き換える）:

- `campaigns/route.ts`（POST）
- `campaigns/[id]/variants/route.ts`（POST）
- `campaigns/[id]/variants/[variantId]/route.ts`（PATCH・DELETE）
- `campaigns/[id]/assign/route.ts`（POST）
- `drafts/[id]/route.ts`（PATCH）
- `drafts/confirm/route.ts`（POST）

⚠`mark-sent` / `outcome` は既に `property:write` を要求している（DM記録の書き込み3本の慣例）。走査テストが緑なら追加不要。落ちたら同じ置き換えを行う。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/sale-dm-write-permission-guard.test.ts`
Expected: PASS（全 route）

- [ ] **Step 6: 既存の sale-dm route テストを通す**

Run: `npx vitest run src/lib/__tests__ --reporter=dot -t "sale-dm"`
Expected: PASS（403 期待に変わったテストがあれば、モックの権限に `property:write` を足す）

- [ ] **Step 7: コミット**

```bash
git add src/lib/sale-dm-letter/route-guard.ts src/app/api/properties/sale-dm src/lib/__tests__/sale-dm-write-permission-guard.test.ts
git commit -m "feat(sale-dm): 書き込み系の経路に物件の編集権限を統一して要求する"
```

---

### Task 6: 全ゲートと提出

- [ ] **Step 1: 制御文字・バイナリ混入の確認**

Run: `git diff --stat origin/main...HEAD`
Expected: `Bin` の行が無いこと

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー 0

- [ ] **Step 3: lint（差分ファイルのみ）**

Run: `npx eslint $(git diff --name-only origin/main...HEAD | grep -E '\.tsx?$' | tr '\n' ' ')`
Expected: 新規の error 0（既存債務は `git stash` でベースライン比較して切り分ける）

- [ ] **Step 4: フルテスト**

Run: `npx vitest run`
Expected: 全件 PASS

- [ ] **Step 5: 本番ビルド**

Run: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
Expected: 成功。**新しいルートは増えない**

- [ ] **Step 6: 提出前の自己レビュー**

次の観点で差分を読み直す:
1. ロック順序が全経路で Owner → variant → 物件親行 → 子行 になっているか（混在が残っていないか）
2. `property:write` を足したことで、**既存の利用者（管理者2名）が使えなくなる操作が無いか**
3. 本文検証が「塞ぐ方向」だけで、通っていたまともな本文を弾いていないか
4. migration が ADD COLUMN だけで、書き手を作っていないか

- [ ] **Step 7: PR を作成して @codex を起動**

```bash
git push -u origin feat/sale-dm-external-base
gh pr create --title "feat(sale-dm): 外部AI方式の土台(列追加・本文検証・ロック順序・書込権限)" --body "<本文>"
gh pr comment <PR> --body "@codex review"
```

---

## Self-Review（この計画を書いたあとの確認結果）

**1. 仕様カバレッジ（設計書 → タスク）**

| 設計書の項目 | 本 PR | 備考 |
|---|---|---|
| §2.4 列3本の追加（backfill なし） | Task 1 | 書き手は PR-D2 |
| §2.3 本文検証（trim・タグ）を3経路共通ヘルパーに | Task 2 | 本 PR は下書き編集の1経路。残り2経路は PR-D2（同じ関数を使う） |
| §2.3 ロック順序の全経路統一 | Task 3・4 | |
| §2.3 確定 route の variant ロック＋field_staff 親行ロック | Task 4 | |
| §2.5 書き込み系に property:write 統一 | Task 5 | 貼り付け／適用は PR-D2（新設時に同じ門を付ける） |
| §2.1 AI直結の410化 / §2.2 プロンプト / §2.3 貼り付け・適用 / §2.4 凍結印の配線 / §2.5 capability 置換 / §2.6 監査 / 照合スクリプト / UI | **PR-D2** | キャンペーン作成と AI 生成が同じ処理に組み込まれているため、410 化は作成の分離と同時でないと作成が壊れる |

**2. プレースホルダ走査:** Task 2 Step 5 と Task 5 Step 4 は既存ファイルの構成に合わせる指示を含むが、**何を書くか（テスト本体・置き換え対象の一覧）は具体に列挙済み**。それ以外の手順は実コードを載せた。

**3. 型の一貫性:** `LetterBodyIssue` / `validateLetterBody` / `letterBodyIssueMessage` / `LETTER_BODY_MAX_LENGTH`（Task 2 で定義 → Task 2 の route で使用、PR-D2 でも同名）・`requireSaleDmWriteAccess`（Task 5 で定義 → 6 route で使用）を確認した。

**4. 意図的にスコープ外にしたもの**
- **差込タグの語彙と展開**（`{{物件所在}}`/`{{物件種別}}`）は PR-D2。本 PR は `{{` を**すべて弾く**（今の本文にタグは存在しないので退行しない）。PR-D2 で許可タグを足して広げる。
- **凍結印を立てる配線・二重判定・DELETE 409・照合スクリプト**は PR-D2（守る対象である `prompt_text`/`body_template` を書くのが D2 のため）。
