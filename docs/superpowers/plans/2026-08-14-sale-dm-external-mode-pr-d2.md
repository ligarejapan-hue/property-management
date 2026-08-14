# 売却DM 外部AI方式 本体（PR-D2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 売却DMの文面を、**有料のAPIキーなしで**作れるようにする — システムが型ごとのプロンプトを出す → 発注者が手元のAIで本文を作る → 貼り付けて保存 → その型の全宛先へ差し込んで適用。あわせて AI 直結の生成経路を止める。

**Architecture:** 設計書 `2026-08-08-sale-dm-external-paste-design.md` の残り全部。土台（列3本・本文検証・ロック順序・書込権限）は **PR-D1 で入済み**。本 PR は ①差込タグの語彙と展開 ②PIIを載せないプロンプト組み立て ③表示/貼り付け/適用の3経路 ④型の凍結 ⑤AI直結の停止と作成の分離 ⑥capability 置換 ⑦画面 ⑧照合スクリプト。

**Tech Stack:** Next.js App Router / TypeScript / Prisma(PostgreSQL) / Vitest / zod

## Global Constraints

- 設計の正本 = `docs/superpowers/specs/2026-08-08-sale-dm-external-paste-design.md`。**§の番号を各タスクに明記する**。
- **migration は作らない**。`prompt_text` / `body_template` / `template_frozen_at` は PR-D1 で追加済み（expand）。本 PR で初めて**書き手**が付く。
- **新しい依存パッケージ・新しい env を作らない。新しい permission slug を作らない**（`property:write` は PR-D1 で統一済み）。
- **プロンプトに PII と個別物件の事実を一切載せない**（設計 §2.2）。載せてよいのは 型・トーン・訴求・押しの強さ・差込タグの説明だけ。⚠**差出人名も `extraInstruction` も載せない**。
- ロック順序（PR-D1 で統一済み）: **Owner → variant → 物件親行 → 子行**。新経路も必ずこの順。
- **凍結の判定は二重**（設計 §2.4）: `template_frozen_at` が立っている **OR** 配下に confirmed/sent の draft が存在する。
- **照合スクリプトは migration に入れない**。反映手順は **migrate → restart → 照合 を連続実施**し、その数分間は売却DMを操作しない（設計 §2.4 @codex R21/R37）。
- コミットは日本語 conventional commits。**amend しない**。
- 作業 worktree = `property-management-worktrees/sale-dm-external-mode` / branch `feat/sale-dm-external-mode`。

## ⚠PR-D1 のレビューで4連続で出た失敗の型（着手前に読む）

1. **入口を1つ塞いで、最後の関所を塞いでいない** → 同じ結果を生む経路が複数あるときは、**最後に必ず通る場所**（＝確定）に寄せる。
2. **検査した値と、実際に使う値が別物** → 検査と状態遷移は**同じロックの中で**。読み直してから検査する。
3. **同じ壊れ方をする2つの状態を違う扱いにする**（空白は 409・空は黙って除外）→ 揃える。
4. **模擬DBが where の絞り込みを再現せず、テストが空振り** → 模擬は実DBのように**条件で絞る**。書いたら**実装を一時的に外して落ちることを実測**してから提出。

---

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `src/lib/sale-dm-letter/tags.ts` | 差込タグの語彙・展開・未解決検出の**単一定義元**（`{{物件所在}}` / `{{物件種別}}`）。DBに触れない |
| `src/lib/sale-dm-letter/external-prompt.ts` | 外部AIへ渡すプロンプトの組み立てと digest。**PII と個別物件の事実を構造上受け取らない**（引数に無い） |
| `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/prompt/route.ts` | GET: プロンプト全文 + digest を返す（+ 監査 `sale_dm_prompt_view`） |
| `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts` | PUT: 本文の貼り付け保存（digest 一致・凍結判定・未確定 draft の失効）（+ 監査 `sale_dm_body_paste`） |
| `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/apply/route.ts` | POST: その型の全宛先へ適用（スコープ除外・タグ解決・件数報告）（+ 監査 `sale_dm_template_apply`） |
| `src/lib/sale-dm-letter/freeze.ts` | 凍結の**二重判定**と「凍結印を立てる」共通ヘルパー |
| `scripts/reconcile-sale-dm-template-freeze.ts` | 既存の confirmed/sent 型へ凍結印を入れる冪等スクリプト（restart 後に1回） |
| 各 `__tests__` | 上記の振る舞いテスト |

**変更**

| ファイル | 変更内容 |
|---|---|
| `src/lib/sale-dm-letter/body-validation.ts` | 許可タグを通す（PR-D1 は `{{` 全部を拒否していた）。展開後の残存 `{{` は拒否 |
| `src/app/api/properties/sale-dm/campaigns/route.ts` | AI生成を止め、**本文は空のまま drafts を作る**。`sale_dm:generate` 要求を外す |
| `src/app/api/properties/sale-dm/drafts/[id]/regenerate/route.ts` | 410 で閉じる |
| `src/app/api/properties/sale-dm/drafts/confirm/route.ts` / `campaigns/[id]/assign/route.ts` / `drafts/[id]/route.ts` | 凍結印を立てる（確定を作る/動かす/戻す全経路） |
| `src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts` | PATCH: 凍結中は設定変更不可 + prompt/template も失効 / DELETE: 凍結済みは 409 |
| `src/app/api/me/permissions/route.ts` ほか3ファイル | `saleDmLetter` → `saleDmPrintReady` 置換 |
| `src/lib/audit-log-detail-safety.ts` | 新 action 3種を `ACTION_EXTRA_KEYS` へ + allowlist |
| `src/components/sale-dm/variant-manager.tsx` | プロンプト表示/コピー・貼り付け欄・適用ボタン・`extraInstruction` 非表示 |
| `src/lib/sale-dm-letter/list-ui.ts` | `canCreateSaleDm` から `sale_dm:generate` 要求を外す（設計 §2.5） |

---

### Task 1: 差込タグの語彙と展開

**Files:**
- Create: `src/lib/sale-dm-letter/tags.ts` / `src/lib/sale-dm-letter/__tests__/tags.test.ts`
- Modify: `src/lib/sale-dm-letter/body-validation.ts`

**Interfaces:**
- Produces:
  - `LETTER_TAGS: readonly ["物件所在", "物件種別"]`
  - `coarsePropertyLocation(address: string | null): string | null`（市区町村＋町名まで）
  - `expandLetterTags(text: string, values: { location: string | null; propertyType: string | null }): string`
  - `hasUnresolvedTag(text: string): boolean`
  - `validateLetterBody(body, opts?: { allowTags?: boolean })` の拡張（既定は従来どおり `{{` 拒否）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sale-dm-letter/__tests__/tags.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LETTER_TAGS,
  coarsePropertyLocation,
  expandLetterTags,
  hasUnresolvedTag,
} from "../tags";

describe("LETTER_TAGS", () => {
  it("語彙は物件所在と物件種別の2つだけ(増やすときは設計§2.2の見直しから)", () => {
    expect([...LETTER_TAGS]).toEqual(["物件所在", "物件種別"]);
  });
});

describe("coarsePropertyLocation", () => {
  it("市区町村+町名までに丸める(番地・号は落とす)", () => {
    expect(coarsePropertyLocation("東京都杉並区西荻北3-19-4")).toBe("東京都杉並区西荻北");
    expect(coarsePropertyLocation("神奈川県横浜市南区井土ケ谷中町69-2")).toBe(
      "神奈川県横浜市南区井土ケ谷中町",
    );
  });

  it("丁目は残す(町名の一部として自然に読めるため)", () => {
    expect(coarsePropertyLocation("東京都世田谷区若林2丁目18-3")).toBe(
      "東京都世田谷区若林2丁目",
    );
  });

  it("番地が無い住所はそのまま", () => {
    expect(coarsePropertyLocation("東京都千代田区丸の内")).toBe("東京都千代田区丸の内");
  });

  it("空・null は null(タグを解決できない=適用をスキップする材料)", () => {
    expect(coarsePropertyLocation(null)).toBeNull();
    expect(coarsePropertyLocation("   ")).toBeNull();
  });
});

describe("expandLetterTags", () => {
  it("許可タグを値で置き換える", () => {
    const out = expandLetterTags("{{物件所在}}の{{物件種別}}について", {
      location: "東京都杉並区西荻北",
      propertyType: "土地",
    });
    expect(out).toBe("東京都杉並区西荻北の土地について");
  });

  it("同じタグが複数回あってもすべて置き換える", () => {
    const out = expandLetterTags("{{物件種別}}と{{物件種別}}", {
      location: null,
      propertyType: "戸建",
    });
    expect(out).toBe("戸建と戸建");
  });

  it("値が null のタグは置き換えない(未解決として残す)", () => {
    const out = expandLetterTags("{{物件所在}}", { location: null, propertyType: "土地" });
    expect(out).toBe("{{物件所在}}");
  });

  it("知らないタグは触らない", () => {
    const out = expandLetterTags("{{所有者名}}", { location: "A", propertyType: "土地" });
    expect(out).toBe("{{所有者名}}");
  });
});

describe("hasUnresolvedTag", () => {
  it("展開後に {{ が残っていれば true", () => {
    expect(hasUnresolvedTag("残り{{所有者名}}")).toBe(true);
    expect(hasUnresolvedTag("問題なし")).toBe(false);
  });
});
```

- [ ] **Step 2: RED を確認**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/tags.test.ts`
Expected: FAIL（`Cannot find module '../tags'`）

- [ ] **Step 3: 実装する**

`src/lib/sale-dm-letter/tags.ts`:

```ts
/**
 * 手紙本文の差込タグ（設計 2026-08-08-sale-dm-external-paste-design.md §2.2）。
 *
 * 1つの型（variant）の本文は**複数物件の宛先にまたがる**ため、プロンプトに個別物件の
 * 事実を書かせると別の物件へ送られてしまう。物件ごとに変わる部分はタグで書かせ、
 * **適用時にシステムが物件ごとに差し込む**。
 *
 * ⚠語彙を増やすときは設計 §2.2 の見直しから。ここが**唯一の定義元**で、
 * プロンプトの説明文・貼り付け検証・適用時の展開がすべてこの表を見る。
 */
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export const LETTER_TAGS = ["物件所在", "物件種別"] as const;
export type LetterTag = (typeof LETTER_TAGS)[number];

/**
 * 物件所在を「市区町村＋町名（丁目まで）」に丸める。
 * ⚠番地・号は落とす＝共通本文に**建物が特定できる粒度**を載せない。
 * 丁目は町名の一部として自然に読めるので残す。
 */
export function coarsePropertyLocation(address: string | null): string | null {
  const s = (address ?? "").trim();
  if (s.length === 0) return null;
  // 「丁目」までを許し、その後の番地（数字・ハイフン・番・号）以降を落とす。
  const m = s.match(/^(.*?(?:丁目)?)(?=[0-9０-９][0-9０-９\-－‐―ー番号の]*$)/);
  const head = (m?.[1] ?? s).replace(/[-－‐―ー]+$/, "").trim();
  return head.length > 0 ? head : null;
}

/** 物件種別の表示名（既存の一覧・CSVと同じ出所）。 */
export function propertyTypeLabel(propertyType: string | null): string | null {
  if (!propertyType) return null;
  return PROPERTY_TYPE_LABELS[propertyType] ?? propertyType;
}

/** 許可タグだけを値で置き換える。値が null のタグは**置き換えない**（未解決として残す）。 */
export function expandLetterTags(
  text: string,
  values: { location: string | null; propertyType: string | null },
): string {
  const table: Record<LetterTag, string | null> = {
    物件所在: values.location,
    物件種別: values.propertyType,
  };
  let out = text;
  for (const tag of LETTER_TAGS) {
    const value = table[tag];
    if (value == null) continue;
    out = out.split(`{{${tag}}}`).join(value);
  }
  return out;
}

/** 展開後に差込の記号が残っているか（未知タグ・綴り違い・値が無いタグ）。 */
export function hasUnresolvedTag(text: string): boolean {
  return text.includes("{{");
}
```

- [ ] **Step 4: GREEN を確認**

Run: `npx vitest run src/lib/sale-dm-letter/__tests__/tags.test.ts`
Expected: PASS

- [ ] **Step 5: body-validation に許可タグを通す（テスト先行）**

`src/lib/sale-dm-letter/__tests__/body-validation.test.ts` に追記:

```ts
  it("許可タグは通す(貼り付け保存の検証・PR-D2)", () => {
    expect(
      validateLetterBody("{{物件所在}}の{{物件種別}}について", { allowTags: true }),
    ).toBeNull();
  });

  it("許可タグ以外は allowTags でも弾く", () => {
    expect(validateLetterBody("{{所有者名}}", { allowTags: true })).toBe("unknown_tag");
  });

  it("既定(allowTags なし)は従来どおり全部の {{ を弾く", () => {
    expect(validateLetterBody("{{物件所在}}")).toBe("unknown_tag");
  });
```

RED を確認してから `body-validation.ts` を変更:

```ts
export function validateLetterBody(
  body: string,
  options: { allowTags?: boolean } = {},
): LetterBodyIssue | null {
  if (body.trim().length === 0) return "empty";
  if (body.length > LETTER_BODY_MAX_LENGTH) return "too_long";
  // 許可タグを取り除いてから残りを見る。⚠取り除く対象は tags.ts の語彙だけ
  //（同じ表を2か所に書かない）。取り除いた後に {{ が残る＝未知タグ・綴り違い。
  const rest = options.allowTags
    ? LETTER_TAGS.reduce((s, t) => s.split(`{{${t}}}`).join(""), body)
    : body;
  if (rest.includes("{{")) return "unknown_tag";
  return null;
}
```

⚠`import { LETTER_TAGS } from "./tags";` を追加。既存の呼び出し（下書き編集）は `allowTags` を渡さないので**挙動が変わらない**ことを既存テストで確認する。

- [ ] **Step 6: コミット**

```bash
git add src/lib/sale-dm-letter/tags.ts src/lib/sale-dm-letter/__tests__/tags.test.ts src/lib/sale-dm-letter/body-validation.ts src/lib/sale-dm-letter/__tests__/body-validation.test.ts
git commit -m "feat(sale-dm): 差込タグ(物件所在/物件種別)の語彙と展開を作る"
```

---

### Task 2: 外部AIへ渡すプロンプトの組み立てと digest

**Files:**
- Create: `src/lib/sale-dm-letter/external-prompt.ts` / `__tests__/external-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 の `LETTER_TAGS`、既存 `prompt.ts` の文体方針テーブル
- Produces:
  - `buildExternalPrompt(options: { tone: string; length: string; appeal: string; strength: string }): string`
  - `promptDigest(prompt: string): string`（sha256 hex）

**設計上の肝（実装前に読む）**

`buildExternalPrompt` の**引数に宛先も物件も差出人も `extraInstruction` も無い**。渡せないので載らない、という形で PII 非搬送を構造的に保証する（設計 §2.2 @codex R11/R12）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { buildExternalPrompt, promptDigest } from "../external-prompt";
import { LETTER_TAGS } from "../tags";

const OPTS = { tone: "formal", length: "medium", appeal: "price", strength: "medium" };

describe("buildExternalPrompt", () => {
  const p = buildExternalPrompt(OPTS);

  it("差込タグの使い方を説明に含む", () => {
    for (const tag of LETTER_TAGS) expect(p).toContain(`{{${tag}}}`);
  });

  it("宛名を本文に書かせない指示を含む", () => {
    expect(p).toMatch(/宛名/);
  });

  it("署名・社名・連絡先を本文に書かせない指示を含む(印刷側が付与するため)", () => {
    expect(p).toMatch(/署名|社名|連絡先/);
  });

  it("外部AIへ個人情報を入力しない注意書きを含む", () => {
    expect(p).toMatch(/氏名|住所/);
    expect(p).toMatch(/入力しないで|入力しない/);
  });

  it("選んだ文体の方針が日本語で入る", () => {
    expect(p).toContain("フォーマルで丁寧");
  });

  it("同じ設定なら同じ文字列(digest が安定する)", () => {
    expect(buildExternalPrompt(OPTS)).toBe(p);
  });
});

describe("promptDigest", () => {
  it("同じ文字列は同じ digest・違えば違う", () => {
    expect(promptDigest("a")).toBe(promptDigest("a"));
    expect(promptDigest("a")).not.toBe(promptDigest("b"));
  });

  it("sha256 の16進64桁", () => {
    expect(promptDigest("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2〜4: RED 確認 → 実装 → GREEN 確認**

`external-prompt.ts` は既存 `prompt.ts` の `TONE_JA`/`LENGTH_JA`/`APPEAL_JA`/`STRENGTH_JA` を **export して再利用**する（同じ表を2か所に書かない）。digest は既存 `dm-batch/csv.ts` の `sha256Hex` を再利用する。

- [ ] **Step 5: コミット**

```bash
git commit -m "feat(sale-dm): 外部AIへ渡すプロンプト(PIIを載せない形)を組み立てる"
```

---

### Task 3: プロンプト表示の経路

**Files:**
- Create: `.../variants/[variantId]/prompt/route.ts` + route テスト
- Modify: `src/lib/audit-log-detail-safety.ts`（`ACTION_EXTRA_KEYS` に `sale_dm_prompt_view`）

**契約**: `GET` → `{ prompt: string, digest: string, frozen: boolean }`。
ガード順は既存 variant 系と同じ **`requireSaleDmAccess()`（読み取り）→ `assertSaleDmCampaignOwned()`** → variant ロード。監査 `sale_dm_prompt_view` に `{ campaignId, variantId, viewedAt }`（本文・プロンプトは載せない）。

⚠**表示は読み取り**なので `property:write` は要求しない。

- [ ] Step 1〜6: テスト先行（404/403、digest が `promptDigest(prompt)` と一致、監査が1回、プロンプトに PII が入らない）→ 実装 → GREEN → 監査 allowlist の走査テスト（PR-D1 の `export-audit-filter-keys-visible` と同じ考え方で、**新 action の detail キーが sanitize を通ること**を検査）→ コミット。

---

### Task 4: 本文の貼り付け保存

**Files:**
- Create: `.../variants/[variantId]/template/route.ts` + route テスト
- Create: `src/lib/sale-dm-letter/freeze.ts` + テスト

**契約**: `PUT { body: string, promptDigest: string }` →
1. `requireSaleDmWriteAccess()` → `assertSaleDmCampaignOwned()`
2. tx: **variant 行を FOR UPDATE** → 凍結判定（`template_frozen_at` OR 配下に confirmed/sent）
   - 凍結済みで、**保存しようとする本文が今の `body_template` と同じ**なら許可（設計 §2.3 @codex R15: assign で空になった draft への再適用を詰ませない）。**違えば 409**
3. `promptDigest` が**いまの設定から作り直したプロンプトの digest と一致**しなければ 409（設定が変わっている）
4. `validateLetterBody(body, { allowTags: true })` → 不正なら 400
5. field_staff で**スコープ外の未確定 draft が1件でもあれば 403**（既存 PATCH と同じ規則）
6. `prompt_text` と `body_template` を**同じ tx で**保存 + **未確定 draft の body を全クリア**（差し替えの失効）
7. 監査 `sale_dm_body_paste`

- [ ] Step 1〜8: テスト先行（凍結 409 / 同一テンプレは許可 / digest 不一致 409 / 不正本文 400 / スコープ外 403 / 保存で未確定 draft がクリアされる / 監査）→ 実装 → GREEN → コミット。

---

### Task 5: その型の全宛先へ適用

**Files:**
- Create: `.../variants/[variantId]/apply/route.ts` + route テスト

**契約**: `POST { overwriteExisting?: boolean }` →
1. `requireSaleDmWriteAccess()` → `assertSaleDmCampaignOwned()`
2. tx: **variant → 物件親行（field_staff のみ）→ draft** の順にロック
3. 対象 = その variant の draft で `status != "sent"` かつ `status != "confirmed"`。既定は **`body` が空のものだけ**、`overwriteExisting` のときは draft 状態の全件
4. field_staff は**スコープ外の draft を原子的に除外**し、件数を報告（拒否ではなく除外＝1件の担当変更でキャンペーン全体を止めない）
5. 物件ごとに `expandLetterTags` で差し込み → `hasUnresolvedTag` が残る draft は**スキップして件数報告**
6. 展開後の本文に `validateLetterBody(expanded)`（タグ無しの厳密版）を掛け、不正ならその draft をスキップ
7. 応答 `{ appliedCount, skippedScopeCount, skippedTagCount }` + 監査 `sale_dm_template_apply`

- [ ] Step 1〜8: テスト先行（既定は空のみ / overwrite / confirmed・sent は触らない / タグ未解決はスキップして件数に出る / スコープ外はスキップして件数に出る / 監査の件数）→ 実装 → GREEN → コミット。

---

### Task 6: 型の凍結（印を立てる全経路・二重判定・削除の禁止）

**Files:**
- Modify: `drafts/confirm/route.ts` / `campaigns/[id]/assign/route.ts` / `drafts/[id]/route.ts` / `variants/[variantId]/route.ts`
- Create: 走査型ガード `src/lib/__tests__/sale-dm-freeze-guard.test.ts`

**⚠ここが PR-D1 で4連続して間違えた型に一番近い。** 「確定を作る／動かす／戻す」**全 mutation** が対象（設計 §2.4 @codex R24→R31→R35）:

| 経路 | いつ印を立てるか |
|---|---|
| `drafts/confirm` | 確定する前（variant ロック下・未設定なら初回のみ） |
| `campaigns/[id]/assign` | confirmed/sent の draft を**別の型へ移す前**に、**移動元**の型へ |
| `drafts/[id]` PATCH（型移動） | 同上 |
| `drafts/[id]` PATCH（本文編集で確定解除） | 解除する前に、その draft の型へ |

- [ ] Step 1: **走査型ガード**を先に書く。`confirmed`/`sent` を `updateMany`/`update` している sale-dm 配下の route を機械的に列挙し、**`markVariantFrozen` を呼んでいること**を検査する（route 名を手で並べない。PR-D1 で7本目を検出した形）。
- [ ] Step 2〜: 各経路に `markVariantFrozen(tx, variantIds)` を挿入 → `variants/[variantId]` の PATCH（凍結中は設定変更 409）と DELETE（凍結済みは 409・**二重判定**）→ GREEN → コミット。

---

### Task 7: AI直結の停止・作成の分離・capability 置換

**Files:**
- Modify: `campaigns/route.ts` / `drafts/[id]/regenerate/route.ts` / `me/permissions/route.ts` / `properties/page.tsx` / `screen-protection-provider.tsx` / `list-ui.ts`

1. `regenerate` は**設定の有無に関わらず 410**（コードは残置・復活は無効化を外すだけ、と docs に注記）
2. `campaigns/route.ts` POST: `generateLetters` の呼び出しを外し、**本文は空のまま drafts を作る**。`sale_dm:generate` の要求を外す。⚠**失敗時にクレームを消す既存の作り**（孤児 campaign を残さない）は維持
3. capability: `saleDmLetter` を **`saleDmPrintReady`（追跡URL・LP・差出人あり／AI設定は見ない）** に置換し、使用箇所4ファイルを全部差し替え（**grep で 0 件になるまで**）
4. `canCreateSaleDm` から `sale_dm:generate` の要求を外す（`property:write` は PR-D1 で追加済み）

- [ ] Step 1: **`saleDmLetter` の残存が 0 件**であることを検査する走査テストを先に書く → RED → 置換 → GREEN
- [ ] Step 2: 作成が AI 設定なしで 200 になり、drafts の body が空であることを route テストで固定
- [ ] Step 3: `regenerate` が 410 を返すことを固定 → コミット

---

### Task 8: 画面（プロンプト表示・貼り付け・適用）

**Files:**
- Modify: `src/components/sale-dm/variant-manager.tsx`

- 型ごとに「**プロンプトを表示**」→ 全文表示 + **ワンクリックコピー**
- 「**本文を貼り付け**」欄 → 保存（表示時の digest を一緒に送る）
- 「**この型の全宛先に適用**」→ 結果（適用/スキップ件数）をその場に表示
- 凍結済みの型は貼り付け・差し替えの導線を出さず、理由を1行で説明
- `extraInstruction` の入力欄を**出さない**（外部プロンプトに載らないため。列は残す）
- ⚠**日数や件数のような可変値を文言に焼き込まない**（PR-C の教訓）

- [ ] Step 1: 配線の走査テスト（PR-C の `properties-page-resend-ui` と同じく**ハンドラ本体を切り出して `toContain`**。距離窓は使わない）→ RED → 実装 → GREEN → コミット

---

### Task 9: 凍結印の照合スクリプト（restart 後に1回）

**Files:**
- Create: `scripts/reconcile-sale-dm-template-freeze.ts` + テスト
- Modify: `docs/deploy.md`（「リリース同梱の一回限り作業」に追記）

既存の `confirmed`/`sent` な draft を持つ variant に `template_frozen_at` を入れる**冪等**スクリプト。値 = 配下 draft の `confirmedAt`/`sentAt` の最小値、無ければ実行時刻。既定 dry-run・`--apply` で実書込（既存 `scripts/reconcile-sale-dm-reactions.ts` と同じ作法・**`.ts` を tsx で実行**）。

⚠**反映手順**: `migrate → restart → 照合` を連続実施し、その間は売却DMを操作しない（設計 §2.4 @codex R37）。**本 PR に migration は無い**ので、実際には `restart → 照合` の順で足りる。

- [ ] Step 1〜: dry-run が何も書かないこと・2回流しても結果が変わらないこと（冪等）をテストで固定 → 実装 → コミット

---

### Task 10: 全ゲートと提出

- [ ] バイナリ混入なし（`git diff --stat origin/main...HEAD` に `Bin` が無い）
- [ ] `npx tsc --noEmit` = 0
- [ ] `npx eslint <変更ファイル>` = 新規 error 0（既存債務は stash 比較で切り分け）
- [ ] `npx vitest run`（**フル**）
- [ ] `npm run build`（新 route 3本が出力に載ることを目視）
- [ ] 提出前の自己レビュー: **①入口でなく関所に寄せたか ②検査と遷移が同じロックの中か ③似た状態の扱いが揃っているか ④テストが空振りしていないか（実装を外して落ちるか実測）**
- [ ] PR 作成 → `@codex review` → 監視（codex-triage）

---

## Self-Review

**1. 仕様カバレッジ**: 設計 §2.1（Task 7）／§2.2（Task 1・2・3）／§2.3（Task 4・5、ロック順序は PR-D1 済）／§2.4（Task 6・9）／§2.5（Task 7、書込権限は PR-D1 済）／§2.6（Task 3・4・5 の監査）。**全項目に担当タスクがある**。

**2. 意図的にスコープ外**: 作業画面の「読み取り専用状態」は Task 7 の capability 置換で入口を閉じることで代替し、個別コントロールの無効化は行わない（PR-D1 のレビューで論点として明示済み）。

**3. リスクの高い順**: Task 6（凍結の全経路）＞ Task 5（適用のスコープ・タグ）＞ Task 7（作成の分離）。**Task 6 は走査型ガードを先に書く**こと。

**4. 前 PR の反省の反映**: 各タスクの Step 1 が必ずテストで、Task 6・7・8 は**走査型**（名前を手で並べない）。Task 10 の自己レビューに4つの型を明記した。
