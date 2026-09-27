# 売却DM「DMの種類」台帳 PR-S1(台帳+物件の欄)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「DMの種類」台帳(手紙の文面+LP)を管理者が登録・編集でき、物件に「DMの種類」欄を持たせる(発送の作り方はまだ変えない)。

**Architecture:** 表 `dm_scenarios`/`dm_scenario_media` と参照列4本を1本の additive migration で足す。台帳の API は既存の LP型の API(指示文→貼り戻し→写真と図→プレビュー)と同じ純関数を使い、保存先だけ台帳にする。写真の「使用中」判定は1つの関数に集約して4か所から呼ぶ。物件の欄は既存の `PATCH /api/properties/[id]` に足し、トランザクション内で台帳の行を `FOR SHARE` して有効性を確かめる。

**Tech Stack:** Next.js App Router(route handlers)・Prisma(PostgreSQL)・zod・vitest・React(client components)

**Spec:** `docs/superpowers/specs/2026-09-27-sale-dm-scenarios-design.md`(§3.1・§3.2・§3.3.1・§3.6・§4・§6・§6.1 が本 PR の範囲。§3.3/§3.3.0/§3.4 の発送側は PR-S2)

## Global Constraints

- migration は ADD のみ(既存の行・列を書き換えない)。最初の2件(相続 `auto_key=inheritance`・空き家 `auto_key=vacant`)は migration で入れる。
- 台帳を指す4列(`properties.dm_scenario_id`・`dm_campaigns.default_scenario_id`・`dm_variants.scenario_id`・`dm_lp_variants.scenario_id`)はすべて `ON DELETE RESTRICT`。
- `dm_variants`・`dm_lp_variants` に `(campaign_id, scenario_id) WHERE scenario_id IS NOT NULL` の部分一意索引。台帳の `name` は `WHERE deleted_at IS NULL` の部分一意索引。部分一意索引は Prisma schema で表せないので **SQL だけで管理**(既存例 `20260526000000_add_field_survey`)し、違反(P2002)は 409 にする。
- 台帳の削除は**論理削除**(`deleted_at`+`active=false`)。参照があれば 409。`auto_key` のある行は削除不可(409)。
- 台帳を書き換える経路はすべて先に `SELECT id FROM dm_scenarios WHERE id=$1 FOR UPDATE`。台帳を読むだけの経路(物件の欄の保存)は `FOR SHARE`。全体のロック順=発送→手紙の型→LPの型→所有者→物件→宛先→**台帳**→写真。
- 台帳の中身の読み書きは**管理者だけ**(`hasPermission(perms, "user_management", "write")`)。種類の選択肢(id・name・sort_order・auto_key だけ)は、物件を編集できる人または売却DMを使える人。
- 操作の記録(AuditLog)は操作名・台帳の id・変わった項目名・件数・結果だけ。文面・指示文の中身は入れない。
- 写真の「使用中」= `dm_lp_variant_media` か、**削除されていない台帳の** `dm_scenario_media` から参照されている。
- 画面の文言は平易な日本語。管理者にだけ設定画面へのリンクを出す(実績144の決まり)。
- 生成コードの NUL/制御文字チェック(`git diff --stat` に `Bin` が出ないこと)。heredoc でコードを書かない(Write/Edit を使う)。
- 各 Task の最後にフルテスト `npx vitest run` を回す(対象テストだけで緑と言わない)。

## Review Focus

1. 画面を開いたまま管理者が種類を「使わない」/削除した後に、物件の欄を保存する → 409「選んだDMの種類は使えなくなりました」で、物件に無効な種類が入らない(Task 8)。
2. 台帳だけが使う写真を写真ライブラリから消そうとする → 断られる。台帳のプレビューで写真が出る(Task 3)。
3. 同じ名前の種類を2つ作る/削除済みと同じ名前で作り直す → 前者は 409、後者は作れる(Task 4)。
4. 手紙の設定(語調など)を変えた後に、古い指示文で作った文面を貼り戻す → 指紋不一致で断られる(Task 5)。
5. 現場担当(field_staff)が担当外の物件に種類を保存しようとする/保存の直前に担当が付け替えられる → 403(Task 8)。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `prisma/migrations/20260927100000_add_dm_scenarios/migration.sql` | 新設(表2・列4・索引・FK・最初の2件) |
| `prisma/schema.prisma` | `DmScenario`・`DmScenarioMedia` と参照列・逆参照 |
| `src/lib/sale-dm-letter/asset-references.ts` | 写真の「使用中」判定の一本化 |
| `src/lib/sale-dm-letter/scenario-resolve.ts` | 種類の決め方(純関数・§3.2) |
| `src/lib/sale-dm-letter/scenario-guard.ts` | 台帳の権限(管理者/選択肢)とロック・有効性の小関数 |
| `src/lib/sale-dm-letter/lp-media-rows.ts` | 写真と図の行⇄計画の変換(media route から移設・共用) |
| `src/lib/validators-sale-dm.ts` | 台帳用 zod スキーマ追加 |
| `src/app/api/properties/sale-dm/scenarios/route.ts` | GET 一覧(管理者)・POST 追加 |
| `src/app/api/properties/sale-dm/scenarios/options/route.ts` | GET 選択肢(管理者以外も) |
| `src/app/api/properties/sale-dm/scenarios/[id]/route.ts` | GET・PATCH・DELETE(論理削除) |
| `src/app/api/properties/sale-dm/scenarios/[id]/{prompt,template,lp-prompt,lp-template,media,preview,image-prompt}/route.ts` | 手紙/LPの指示文・貼り戻し・写真と図・プレビュー・画像の指示文 |
| `src/lib/api-client.ts` | 台帳のクライアント関数と型 |
| `src/components/sale-dm/lp-media-panel.tsx`・`lp-preview-panel.tsx` | 呼び先を外から渡せる形へ |
| `src/components/sale-dm/scenario-text-editor.tsx` | 台帳の手紙/LP文面の編集部品 |
| `src/app/(dashboard)/admin/dm-scenarios/page.tsx`・`[id]/page.tsx` | 台帳の一覧・編集画面 |
| `src/components/layout/sidebar-model.tsx` | サイドバー「DMの種類」 |
| `src/app/api/properties/[id]/route.ts`・`src/lib/validators.ts` | 物件の欄の保存 |
| `src/app/(dashboard)/properties/[id]/page.tsx` | 物件詳細の「DMの種類」欄 |
| `src/lib/audit-log-detail-safety.ts` | 新しい操作名の許可キー |

---

### Task 1: migration と schema

**Files:**
- Create: `prisma/migrations/20260927100000_add_dm_scenarios/migration.sql`
- Modify: `prisma/schema.prisma`(`DmLpAsset`・`DmLpVariantMedia` の近く/`Property` 349行付近/`DmCampaign`/`DmVariant`/`DmLpVariant`)
- Test: `src/lib/__tests__/sale-dm-scenarios-migration-scan.test.ts`

**Interfaces:**
- Produces: Prisma models `DmScenario`(`prisma.dmScenario`)・`DmScenarioMedia`(`prisma.dmScenarioMedia`)、列 `Property.dmScenarioId`・`DmCampaign.defaultScenarioId`・`DmVariant.scenarioId`・`DmLpVariant.scenarioId`、`DmLpAsset.scenarioMedia` 逆参照。

- [ ] **Step 1: 失敗するテストを書く**(migration の中身を走査して、約束を固定する)

```ts
// src/lib/__tests__/sale-dm-scenarios-migration-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260927100000_add_dm_scenarios/migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("DMの種類 migration(設計 §3.1)", () => {
  it("台帳を指す4列はすべて ON DELETE RESTRICT", () => {
    for (const [table, col] of [
      ["properties", "dm_scenario_id"],
      ["dm_campaigns", "default_scenario_id"],
      ["dm_variants", "scenario_id"],
      ["dm_lp_variants", "scenario_id"],
    ]) {
      const re = new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${col}_fkey" FOREIGN KEY \\("${col}"\\) REFERENCES "dm_scenarios"\\("id"\\) ON DELETE RESTRICT`);
      expect(sql, `${table}.${col}`).toMatch(re);
    }
  });
  it("写しの一意(発送×種類)と名前の一意は部分一意索引", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_variants_campaign_scenario_uniq"\s+ON "dm_variants"\("campaign_id", "scenario_id"\)\s+WHERE "scenario_id" IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_lp_variants_campaign_scenario_uniq"\s+ON "dm_lp_variants"\("campaign_id", "scenario_id"\)\s+WHERE "scenario_id" IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_scenarios_name_live_uniq"\s+ON "dm_scenarios"\("name"\)\s+WHERE "deleted_at" IS NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_scenarios_auto_key_key" ON "dm_scenarios"\("auto_key"\);/);
  });
  it("最初の2件(相続/空き家)を auto_key 付きで入れる", () => {
    expect(sql).toMatch(/INSERT INTO "dm_scenarios"[\s\S]*'相続'[\s\S]*'inheritance'/);
    expect(sql).toMatch(/INSERT INTO "dm_scenarios"[\s\S]*'空き家'[\s\S]*'vacant'/);
  });
  it("写真と図の行は台帳を親に CASCADE・写真へは RESTRICT", () => {
    expect(sql).toMatch(/"dm_scenario_media_scenario_id_fkey" FOREIGN KEY \("scenario_id"\) REFERENCES "dm_scenarios"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"dm_scenario_media_asset_id_fkey" FOREIGN KEY \("asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT/);
  });
  it("既存の行を書き換えない(UPDATE/DELETE/DROP を含まない)", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
  });
});
```

- [ ] **Step 2: 失敗を確認** — Run: `npx vitest run src/lib/__tests__/sale-dm-scenarios-migration-scan.test.ts` / Expected: FAIL(ENOENT)

- [ ] **Step 3: migration を書く**(Write ツールで。`gen_random_uuid()` は既存 migration でも使用済み)

```sql
-- 売却DM「DMの種類」台帳(設計 2026-09-27)。additive のみ。最初の2件(相続・空き家)を入れる。
-- ⚠部分一意索引は Prisma schema で表せないため、この SQL でのみ管理する。

-- CreateTable
CREATE TABLE "dm_scenarios" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "auto_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "design_template" TEXT,
    "tone" TEXT,
    "length" TEXT,
    "appeal" TEXT,
    "strength" TEXT,
    "extra_instruction" TEXT,
    "letter_prompt_text" TEXT,
    "letter_body_template" TEXT,
    "lp_tone" TEXT,
    "lp_length" TEXT,
    "lp_appeal" TEXT,
    "lp_strength" TEXT,
    "lp_prompt_text" TEXT,
    "lp_raw_template" TEXT,
    "lp_headline" TEXT,
    "lp_lead" TEXT,
    "lp_body_text" TEXT,
    "lp_faq_json" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dm_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_scenario_media" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "heading" TEXT,
    "asset_id" UUID,
    "figure_kind" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dm_scenario_media_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "properties" ADD COLUMN "dm_scenario_id" UUID;
ALTER TABLE "dm_campaigns" ADD COLUMN "default_scenario_id" UUID;
ALTER TABLE "dm_variants" ADD COLUMN "scenario_id" UUID;
ALTER TABLE "dm_lp_variants" ADD COLUMN "scenario_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "dm_scenarios_auto_key_key" ON "dm_scenarios"("auto_key");
CREATE UNIQUE INDEX "dm_scenarios_name_live_uniq"
    ON "dm_scenarios"("name")
    WHERE "deleted_at" IS NULL;
CREATE INDEX "dm_scenario_media_scenario_id_idx" ON "dm_scenario_media"("scenario_id");
CREATE INDEX "dm_scenario_media_asset_id_idx" ON "dm_scenario_media"("asset_id");
CREATE INDEX "properties_dm_scenario_id_idx" ON "properties"("dm_scenario_id");
CREATE UNIQUE INDEX "dm_variants_campaign_scenario_uniq"
    ON "dm_variants"("campaign_id", "scenario_id")
    WHERE "scenario_id" IS NOT NULL;
CREATE UNIQUE INDEX "dm_lp_variants_campaign_scenario_uniq"
    ON "dm_lp_variants"("campaign_id", "scenario_id")
    WHERE "scenario_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "dm_scenario_media" ADD CONSTRAINT "dm_scenario_media_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_scenario_media" ADD CONSTRAINT "dm_scenario_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_dm_scenario_id_fkey" FOREIGN KEY ("dm_scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_campaigns" ADD CONSTRAINT "dm_campaigns_default_scenario_id_fkey" FOREIGN KEY ("default_scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_variants" ADD CONSTRAINT "dm_variants_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variants" ADD CONSTRAINT "dm_lp_variants_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 最初の2件(自動の振り分け先)
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
VALUES (gen_random_uuid(), '相続', 'inheritance', 10, 'inheritance', 'inheritance', CURRENT_TIMESTAMP);
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
VALUES (gen_random_uuid(), '空き家', 'vacant', 20, 'vacant', 'vacant', CURRENT_TIMESTAMP);
```

- [ ] **Step 4: schema.prisma を合わせる**(`DmLpVariantMedia` の後ろに追加し、参照列と逆参照を足す)

```prisma
/// 売却DM「DMの種類」台帳(設計 2026-09-27)。手紙の文面+LPを種類ごとに1組持ち、発送作成時に写し取られる。
/// 削除は論理削除(deletedAt)。⚠name の一意は「削除されていない行の中で」=部分一意索引は migration SQL のみで管理。
model DmScenario {
  id                 String    @id @default(uuid()) @db.Uuid
  name               String
  autoKey            String?   @unique @map("auto_key")
  sortOrder          Int       @default(0) @map("sort_order")
  active             Boolean   @default(true)
  designTemplate     String?   @map("design_template")
  tone               String?
  length             String?
  appeal             String?
  strength           String?
  extraInstruction   String?   @map("extra_instruction")
  letterPromptText   String?   @map("letter_prompt_text")
  letterBodyTemplate String?   @map("letter_body_template")
  lpTone             String?   @map("lp_tone")
  lpLength           String?   @map("lp_length")
  lpAppeal           String?   @map("lp_appeal")
  lpStrength         String?   @map("lp_strength")
  lpPromptText       String?   @map("lp_prompt_text")
  lpRawTemplate      String?   @map("lp_raw_template")
  lpHeadline         String?   @map("lp_headline")
  lpLead             String?   @map("lp_lead")
  lpBodyText         String?   @map("lp_body_text")
  lpFaqJson          Json?     @map("lp_faq_json")
  deletedAt          DateTime? @map("deleted_at")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  media      DmScenarioMedia[]
  properties Property[]
  campaigns  DmCampaign[]
  variants   DmVariant[]
  lpVariants DmLpVariant[]

  @@map("dm_scenarios")
}

/// 台帳の写真と図(DmLpVariantMedia と同じ形)。
model DmScenarioMedia {
  id         String   @id @default(uuid()) @db.Uuid
  scenarioId String   @map("scenario_id") @db.Uuid
  slot       String
  heading    String?
  assetId    String?  @map("asset_id") @db.Uuid
  figureKind String?  @map("figure_kind")
  sortOrder  Int      @default(0) @map("sort_order")
  createdAt  DateTime @default(now()) @map("created_at")

  scenario DmScenario @relation(fields: [scenarioId], references: [id], onDelete: Cascade)
  asset    DmLpAsset? @relation(fields: [assetId], references: [id], onDelete: Restrict)

  @@index([scenarioId])
  @@index([assetId])
  @@map("dm_scenario_media")
}
```

追加する列(各モデルの該当位置へ):

```prisma
// Property(introductionRoute の次の行)
  dmScenarioId             String?           @map("dm_scenario_id") @db.Uuid
// Property の関係欄
  dmScenario DmScenario? @relation(fields: [dmScenarioId], references: [id], onDelete: Restrict)
// Property の索引欄
  @@index([dmScenarioId])

// DmCampaign
  defaultScenarioId String?     @map("default_scenario_id") @db.Uuid
  defaultScenario   DmScenario? @relation(fields: [defaultScenarioId], references: [id], onDelete: Restrict)

// DmVariant / DmLpVariant(どちらも)
  scenarioId String?     @map("scenario_id") @db.Uuid
  scenario   DmScenario? @relation(fields: [scenarioId], references: [id], onDelete: Restrict)

// DmLpAsset の関係欄
  scenarioMedia DmScenarioMedia[]
```

- [ ] **Step 5: 検証** — Run: `npx prisma validate && npx prisma generate && npx vitest run src/lib/__tests__/sale-dm-scenarios-migration-scan.test.ts` / Expected: valid・PASS。続けて手元の開発DBに適用: `npx prisma migrate deploy`([[local-dev-env-setup]] の DB)→ `psql` で `SELECT name, auto_key FROM dm_scenarios ORDER BY sort_order;` が2行。⚠`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma` で出る差分が**部分一意索引の3本だけ**であること(それ以外の差分が出たら schema と SQL のずれ=直す)。

- [ ] **Step 6: フルテスト+コミット** — `npx vitest run` 緑 → `git add prisma/ src/lib/__tests__/sale-dm-scenarios-migration-scan.test.ts && git commit -m "feat(sale-dm-scenarios): DMの種類の台帳と参照列の migration"`

---

### Task 2: 種類の決め方(純関数)

**Files:**
- Create: `src/lib/sale-dm-letter/scenario-resolve.ts`
- Test: `src/lib/__tests__/sale-dm-scenario-resolve.test.ts`

**Interfaces:**
- Produces:
```ts
export type ScenarioRow = { id: string; name: string; autoKey: string | null; active: boolean; deletedAt: Date | null };
export type ResolveInput = { propertyScenarioId: string | null; introductionRoute: string | null; defaultScenarioId: string | null; scenarios: ScenarioRow[] };
export type ResolveResult =
  | { ok: true; scenarioId: string; via: "property" | "auto" | "default" }
  | { ok: false; reason: "no_default" | "property_scenario_missing" };
export function resolveScenario(input: ResolveInput): ResolveResult;
export const AUTO_KEY_BY_ROUTE: Readonly<Record<string, string>>; // reception_csv→inheritance / field_survey→vacant
export function isUsableScenario(s: ScenarioRow | undefined): boolean; // active && !deletedAt
```
- PR-S2(作成・種類を変える)と物件詳細の表示(Task 9)がこれを使う。

- [ ] **Step 1: 失敗するテスト(総当たり)**

```ts
import { describe, it, expect } from "vitest";
import { resolveScenario, AUTO_KEY_BY_ROUTE } from "@/lib/sale-dm-letter/scenario-resolve";
import { INTRODUCTION_ROUTE_VALUES } from "@/lib/property-types";

const S = (id: string, autoKey: string | null, active = true, deleted = false) =>
  ({ id, name: id, autoKey, active, deletedAt: deleted ? new Date() : null });

describe("resolveScenario(設計 §3.2)", () => {
  const inh = S("inh", "inheritance"), vac = S("vac", "vacant"), area = S("area", null);

  it("物件の欄が有効ならそれが最優先", () => {
    expect(resolveScenario({ propertyScenarioId: "area", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [inh, vac, area] }))
      .toEqual({ ok: true, scenarioId: "area", via: "property" });
  });
  it("導入ルート8種すべて: 受付帳取込=相続・現地調査=空き家・他は既定", () => {
    for (const route of [...INTRODUCTION_ROUTE_VALUES, null]) {
      const r = resolveScenario({ propertyScenarioId: null, introductionRoute: route, defaultScenarioId: "area", scenarios: [inh, vac, area] });
      const expected = route === "reception_csv" ? { ok: true, scenarioId: "inh", via: "auto" }
        : route === "field_survey" ? { ok: true, scenarioId: "vac", via: "auto" }
        : { ok: true, scenarioId: "area", via: "default" };
      expect(r, String(route)).toEqual(expected);
    }
  });
  it("「使わない」「削除済み」はどの段でも返さない", () => {
    for (const bad of [S("inh", "inheritance", false), S("inh", "inheritance", true, true)]) {
      const r = resolveScenario({ propertyScenarioId: "inh", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [bad, vac] });
      expect(r).toEqual({ ok: true, scenarioId: "vac", via: "default" });
    }
  });
  it("物件の欄が指す id が一覧に無い=黙って落とさず止める", () => {
    expect(resolveScenario({ propertyScenarioId: "ghost", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "property_scenario_missing" });
  });
  it("既定が無い/無効で他の段でも決まらない=no_default", () => {
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", defaultScenarioId: null, scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "no_default" });
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", defaultScenarioId: "x", scenarios: [inh, vac, S("x", null, false)] }))
      .toEqual({ ok: false, reason: "no_default" });
  });
  it("自動の対応表は2つだけ", () => {
    expect(AUTO_KEY_BY_ROUTE).toEqual({ reception_csv: "inheritance", field_survey: "vacant" });
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/sale-dm-scenario-resolve.test.ts` → FAIL(module not found)

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/scenario-resolve.ts
/**
 * 宛先の「DMの種類」を決める純関数(設計 2026-09-27 §3.2)。DB を読まない。
 * 順: 物件の欄 → 導入ルート(自動) → 発送の既定。どの段でも「使わない」「削除済み」は返さない。
 * 物件の欄が指す id が一覧に無いときは、自動・既定に落とさず止める(黙って別の種類にしない)。
 * ⚠呼び出し側は、台帳の行と物件の行をロックした後に読んだ値を渡すこと(§3.3 の 2・3)。
 */
export type ScenarioRow = { id: string; name: string; autoKey: string | null; active: boolean; deletedAt: Date | null };
export type ResolveInput = { propertyScenarioId: string | null; introductionRoute: string | null; defaultScenarioId: string | null; scenarios: ScenarioRow[] };
export type ResolveResult =
  | { ok: true; scenarioId: string; via: "property" | "auto" | "default" }
  | { ok: false; reason: "no_default" | "property_scenario_missing" };

export const AUTO_KEY_BY_ROUTE: Readonly<Record<string, string>> = Object.freeze({
  reception_csv: "inheritance",
  field_survey: "vacant",
});

export function isUsableScenario(s: ScenarioRow | undefined): boolean {
  return !!s && s.active && s.deletedAt === null;
}

export function resolveScenario(input: ResolveInput): ResolveResult {
  const byId = new Map(input.scenarios.map((s) => [s.id, s]));
  if (input.propertyScenarioId) {
    const own = byId.get(input.propertyScenarioId);
    if (!own) return { ok: false, reason: "property_scenario_missing" };
    if (isUsableScenario(own)) return { ok: true, scenarioId: own.id, via: "property" };
  }
  const autoKey = input.introductionRoute ? AUTO_KEY_BY_ROUTE[input.introductionRoute] : undefined;
  if (autoKey) {
    const auto = input.scenarios.find((s) => s.autoKey === autoKey);
    if (isUsableScenario(auto)) return { ok: true, scenarioId: auto!.id, via: "auto" };
  }
  if (input.defaultScenarioId) {
    const def = byId.get(input.defaultScenarioId);
    if (isUsableScenario(def)) return { ok: true, scenarioId: def!.id, via: "default" };
  }
  return { ok: false, reason: "no_default" };
}
```

- [ ] **Step 4: PASS 確認** → **Step 5:** フルテスト+ `git commit -m "feat(sale-dm-scenarios): 種類の決め方の純関数"`

---

### Task 3: 写真の「使用中」判定を1か所に(4か所の置き換え)

**Files:**
- Create: `src/lib/sale-dm-letter/asset-references.ts`
- Modify: `src/app/api/properties/sale-dm/lp-assets/route.ts:51-55`・`src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts:30-33`・`src/app/lp-assets/[publicId]/route.ts:24-26`・`src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts:16,50-53`・`src/app/(dashboard)/admin/lp-assets/page.tsx:56`
- Test: `src/lib/__tests__/sale-dm-asset-references.test.ts`(純関数+走査)、既存 `sale-dm-lp-assets-route.test.ts` に台帳ケース追加

**Interfaces:**
- Produces:
```ts
export const ASSET_REFERENCE_COUNT_SELECT: { _count: { select: { media: true; scenarioMedia: { where: { scenario: { deletedAt: null } } } } } };
export function isAssetReferenced(row: { _count: { media: number; scenarioMedia: number } }): boolean;
export async function countAssetReferences(tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia">, assetId: string): Promise<number>;
```

- [ ] **Step 1: 失敗するテスト**

```ts
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAssetReferenced, countAssetReferences, ASSET_REFERENCE_COUNT_SELECT } from "@/lib/sale-dm-letter/asset-references";

describe("写真の使用中判定(設計 §3.1)", () => {
  it("LP型か台帳のどちらかで使われていれば使用中", () => {
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 0 } })).toBe(false);
    expect(isAssetReferenced({ _count: { media: 1, scenarioMedia: 0 } })).toBe(true);
    expect(isAssetReferenced({ _count: { media: 0, scenarioMedia: 2 } })).toBe(true);
  });
  it("削除済みの台帳の割り付けは数えない(select の where)", () => {
    expect(ASSET_REFERENCE_COUNT_SELECT._count.select.scenarioMedia).toEqual({ where: { scenario: { deletedAt: null } } });
  });
  it("countAssetReferences は両方を足す", async () => {
    const tx = { dmLpVariantMedia: { count: vi.fn(async () => 1) }, dmScenarioMedia: { count: vi.fn(async () => 2) } };
    await expect(countAssetReferences(tx as never, "a1")).resolves.toBe(3);
    expect(tx.dmScenarioMedia.count).toHaveBeenCalledWith({ where: { assetId: "a1", scenario: { deletedAt: null } } });
  });
  it("走査: _count.media / dmLpVariantMedia.count を直接使うのは判定関数のファイルだけ", () => {
    const files = [
      "src/app/api/properties/sale-dm/lp-assets/route.ts",
      "src/app/api/properties/sale-dm/lp-assets/[assetId]/route.ts",
      "src/app/lp-assets/[publicId]/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts",
      "src/app/api/properties/sale-dm/scenarios/[id]/media/route.ts",
    ];
    for (const f of files) {
      let src: string;
      try { src = readFileSync(join(process.cwd(), f), "utf8"); } catch { continue; } // 台帳の media は Task 7 で作られる
      expect(src, f).not.toMatch(/_count\.media\b|_count:\s*\{\s*select:\s*\{\s*media:\s*true\s*\}\s*\}|dmLpVariantMedia\.count\(/);
    }
  });
});
```

(走査の対象は、Task 7 で台帳の media route ができた後も必ず含まれるよう、Task 7 の最後の Step で `continue` の try を外す。)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**

```ts
// src/lib/sale-dm-letter/asset-references.ts
/**
 * 写真(dm_lp_assets)が「使用中」か=LP型の枠(dm_lp_variant_media)か、削除されていない台帳の枠
 * (dm_scenario_media)から参照されているか(設計 2026-09-27 §3.1)。
 * ⚠写真の削除は論理削除なので FK の RESTRICT では守れない。数える場所は必ずこのファイルを通す
 *   (削除・公開口・一覧・LPの写真画面の4か所。走査テストで固定)。
 */
import type { PrismaClient } from "@prisma/client";

export const ASSET_REFERENCE_COUNT_SELECT = {
  _count: { select: { media: true, scenarioMedia: { where: { scenario: { deletedAt: null } } } } },
} as const;

export function isAssetReferenced(row: { _count: { media: number; scenarioMedia: number } }): boolean {
  return row._count.media > 0 || row._count.scenarioMedia > 0;
}

export async function countAssetReferences(
  tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia">,
  assetId: string,
): Promise<number> {
  const [a, b] = await Promise.all([
    tx.dmLpVariantMedia.count({ where: { assetId } }),
    tx.dmScenarioMedia.count({ where: { assetId, scenario: { deletedAt: null } } }),
  ]);
  return a + b;
}
```

置き換え(4か所):
- `lp-assets/route.ts` GET: `select: { ...SELECT, ...ASSET_REFERENCE_COUNT_SELECT }` / `toPublicAsset(r, isAssetReferenced(r))`
- `lp-assets/[assetId]/route.ts` DELETE: `const referenced = await countAssetReferences(tx, assetId);` と、文言 `"この写真はLPまたはDMの種類で使われています。先にそこから外してください"`
- `lp-assets/[publicId]/route.ts`: `select: { storageKey: true, mime: true, deletedAt: true, ...ASSET_REFERENCE_COUNT_SELECT }` / `if (!asset || asset.deletedAt || !isAssetReferenced(asset)) return NOT_FOUND();`
- `lp-variants/[lpId]/media/route.ts`: `ASSET_SELECT = { ...既存の列, ...ASSET_REFERENCE_COUNT_SELECT }` / `listAssets()` を `rows.map(({ _count, ...a }) => ({ ...a, referenced: isAssetReferenced({ _count }) }))`
- `admin/lp-assets/page.tsx:56` の `title` を `"LPまたはDMの種類で使われています"` に。

- [ ] **Step 4: 既存テストに台帳ケース**(`sale-dm-lp-assets-route.test.ts` の prisma モックに `dmScenarioMedia: { count: vi.fn(async () => 0) }` を足し、DELETE で `dmScenarioMedia.count` が 1 を返すとき 409 `REFERENCED`、GET で `_count.scenarioMedia=1` の行が `referenced:true` になるテストを追加。公開口の route テスト(`lp-assets/[publicId]`)があれば同様に `scenarioMedia=1` で 200)。

- [ ] **Step 5: フルテスト+コミット** `git commit -m "feat(sale-dm-scenarios): 写真の使用中判定を1か所に(台帳の割り付けも数える)"`

---

### Task 4: 台帳の権限・スキーマ・一覧/追加/選択肢/個別(GET・PATCH・DELETE)

**Files:**
- Create: `src/lib/sale-dm-letter/scenario-guard.ts`・`src/app/api/properties/sale-dm/scenarios/route.ts`・`.../scenarios/options/route.ts`・`.../scenarios/[id]/route.ts`
- Modify: `src/lib/validators-sale-dm.ts`・`src/lib/audit-log-detail-safety.ts`・`src/lib/__tests__/sale-dm-write-permission-guard.test.ts`(例外登録)
- Test: `src/lib/__tests__/sale-dm-scenarios-route.test.ts`

**Interfaces:**
- Produces:
```ts
// scenario-guard.ts
export async function requireScenarioAdmin(): Promise<{ session: { id: string; role: string } }>; // 403 FORBIDDEN
export async function requireScenarioOptionsAccess(): Promise<{ session: { id: string; role: string } }>; // property:write または checkSaleDmAccessFor ok
export async function lockScenarioForUpdate(tx: Prisma.TransactionClient, id: string): Promise<void>; // FOR UPDATE・無ければ/削除済みなら 404 SCENARIO_NOT_FOUND
export async function lockScenarioForShare(tx: Prisma.TransactionClient, id: string): Promise<{ id: string; active: boolean; deletedAt: Date | null } | null>;
export const SCENARIO_OPTION_SELECT: { id: true; name: true; sortOrder: true; autoKey: true };
// validators-sale-dm.ts
export const saleDmScenarioCreateSchema: z.ZodObject<{ name: z.ZodString }>;          // trim・1〜40字
export const saleDmScenarioPatchSchema;  // name?, sortOrder?, active?, designTemplate?, tone?, length?, appeal?, strength?, extraInstruction?, lpTone?, lpLength?, lpAppeal?, lpStrength?(各 enum は adjust-model の OPTIONS の value)
```
- 監査 action 名: `sale_dm_scenario_create` / `sale_dm_scenario_update` / `sale_dm_scenario_delete`。

- [ ] **Step 1: 失敗するテスト**(既存 `sale-dm-lp-media-route.test.ts` の冒頭のモック一式をそのまま写し、prisma モックに `dmScenario: { findMany, findFirst, findUnique, create, update, count }`・`property: { count }`・`dmCampaign: { count }`・`dmVariant: { count }`・`dmLpVariant: { count }` を足す)。テストケース:

```ts
describe("台帳 API(設計 §3.6・§4)", () => {
  it("一覧(中身あり)は管理者だけ: 管理者以外は 403", async () => { /* getUserPermissions に user_management:write が無い → GET /scenarios が 403 FORBIDDEN */ });
  it("選択肢は office_staff(property:write)でも取れ、中身の列を返さない", async () => {
    // getUserPermissions: property write のみ → GET /scenarios/options 200
    // prisma.dmScenario.findMany が { where: { active: true, deletedAt: null }, select: { id, name, sortOrder, autoKey }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } で呼ばれること
    // 応答の各要素のキー集合が ["autoKey","id","name","sortOrder"] と完全一致
  });
  it("選択肢: property:write も売却DMの権限も無い → 403", async () => {});
  it("追加: 同じ名前(削除されていない行)=P2002 → 409 NAME_TAKEN", async () => {
    // prisma.dmScenario.create が { code: "P2002" } を投げる → 409 NAME_TAKEN
  });
  it("PATCH: 先に FOR UPDATE、手紙の設定を変えたら手紙の指示文・原文を消す/LPの設定を変えたらLPの原文・切り分け・写真と図を消す", async () => {
    // $queryRaw の1回目が `FOR UPDATE` を含む
    // tone を変える → update の data に letterPromptText:null, letterBodyTemplate:null
    // lpTone を変える → data に lpPromptText:null, lpRawTemplate:null, lpHeadline:null, lpLead:null, lpBodyText:null, lpFaqJson: Prisma.DbNull と dmScenarioMedia.deleteMany({ where: { scenarioId } })
    // name だけ変える → 文面は消さない
  });
  it("DELETE: 参照があれば 409 SCENARIO_IN_USE・auto_key の行は 409 SCENARIO_RESERVED・どちらでも無ければ論理削除", async () => {
    // property.count / dmCampaign.count / dmVariant.count / dmLpVariant.count のいずれか>0 → 409
    // autoKey:"inheritance" → 409 SCENARIO_RESERVED
    // 参照0・autoKey null → dmScenario.update({ data: { deletedAt: expect.any(Date), active: false } })、delete は呼ばない
  });
  it("削除済みの行への GET/PATCH は 404", async () => {});
  it("監査の detail に文面の中身を入れない(changedFields は列名の配列だけ)", async () => {
    // writeAuditLog が { action: "sale_dm_scenario_update", targetTable: "dm_scenarios", targetId: id, detail: { changedFields: ["tone"] } } で呼ばれる
  });
});
```

(各 `it` の中身は、既存の route テストと同じく `new Request(url, { method, body: JSON.stringify(...) })` を作って handler を直接呼び、`res.status` と `(await res.json()).error.code` を見る形で書く。)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: scenario-guard.ts**

```ts
// src/lib/sale-dm-letter/scenario-guard.ts
import type { Prisma } from "@prisma/client";
import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";

/** 台帳の中身の読み書き=管理者だけ(設計 §3.6)。 */
export async function requireScenarioAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "DMの種類の編集は管理者のみ行えます", "FORBIDDEN");
  }
  return { session };
}

/** 種類の選択肢=物件を編集できる人(物件の欄)か売却DMを使える人(発送の既定)。中身は返さない。 */
export async function requireScenarioOptionsAccess() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (hasPermission(perms, "property", "write")) return { session };
  const dm = await checkSaleDmAccessFor(session.id);
  if (dm.ok) return { session };
  throw new ApiError(403, "権限がありません", "FORBIDDEN");
}

export const SCENARIO_OPTION_SELECT = { id: true, name: true, sortOrder: true, autoKey: true } as const;

/** 台帳を書き換える経路は必ず最初にこれ(§3.3.1)。削除済みは 404。 */
export async function lockScenarioForUpdate(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; deleted_at: Date | null }>>`
    SELECT id, deleted_at FROM dm_scenarios WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0 || rows[0].deleted_at) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
}

/** 台帳を読むだけの経路(物件の欄の保存など)。書く側の FOR UPDATE とだけ直列になる。 */
export async function lockScenarioForShare(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; active: boolean; deleted_at: Date | null }>>`
    SELECT id, active, deleted_at FROM dm_scenarios WHERE id = ${id}::uuid FOR SHARE`;
  return rows[0] ? { id: rows[0].id, active: rows[0].active, deletedAt: rows[0].deleted_at } : null;
}
```

- [ ] **Step 4: スキーマ**(`validators-sale-dm.ts` の末尾)

```ts
import { DESIGN_OPTIONS, TONE_OPTIONS, LENGTH_OPTIONS, APPEAL_OPTIONS, STRENGTH_OPTIONS } from "@/lib/sale-dm-letter/adjust-model";
const vals = <T extends readonly { value: string }[]>(o: T) => o.map((x) => x.value) as [T[number]["value"], ...T[number]["value"][]];

export const saleDmScenarioCreateSchema = z.object({ name: z.string().trim().min(1).max(40) });
export const saleDmScenarioPatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
  designTemplate: z.enum(vals(DESIGN_OPTIONS)).optional(),
  tone: z.enum(vals(TONE_OPTIONS)).optional(),
  length: z.enum(vals(LENGTH_OPTIONS)).optional(),
  appeal: z.enum(vals(APPEAL_OPTIONS)).optional(),
  strength: z.enum(vals(STRENGTH_OPTIONS)).optional(),
  extraInstruction: z.string().trim().max(500).nullable().optional(),
  lpTone: z.enum(vals(TONE_OPTIONS)).optional(),
  lpLength: z.enum(vals(LENGTH_OPTIONS)).optional(),
  lpAppeal: z.enum(vals(APPEAL_OPTIONS)).optional(),
  lpStrength: z.enum(vals(STRENGTH_OPTIONS)).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "更新する項目がありません" });
```

(⚠`adjust-model.ts` は `import type { SaleDmDraft } from "@/lib/api-client"` だけなので server から import してよい=型のみ。もし循環や client 限定の import があれば OPTIONS を `src/lib/sale-dm-letter/options.ts` に移して両方から import する。)

`extraInstruction` の上限は既存の `DmVariant` の作成スキーマと同じ値に合わせる(`grep -n extraInstruction src/lib/validators-sale-dm.ts` で確認し、違えばそちらに揃える)。

- [ ] **Step 5: route 実装**

`scenarios/route.ts`:
```ts
export async function GET() {
  try {
    await requireScenarioAdmin();
    const rows = await prisma.dmScenario.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, autoKey: true, sortOrder: true, active: true, letterBodyTemplate: true, lpBodyText: true, updatedAt: true },
    });
    // 一覧では文面そのものは返さず「登録済みか」だけ
    return NextResponse.json({ scenarios: rows.map(({ letterBodyTemplate, lpBodyText, ...r }) => ({ ...r, hasLetter: !!letterBodyTemplate, hasLp: !!lpBodyText })) });
  } catch (e) { return handleApiError(e); }
}

export async function POST(request: Request) {
  try {
    const { session } = await requireScenarioAdmin();
    const parsed = saleDmScenarioCreateSchema.parse(await parseJsonBody(request));
    const max = await prisma.dmScenario.aggregate({ _max: { sortOrder: true }, where: { deletedAt: null } });
    let row;
    try {
      row = await prisma.dmScenario.create({ data: { name: parsed.name, sortOrder: (max._max.sortOrder ?? 0) + 10 }, select: { id: true } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ApiError(409, "同じ名前のDMの種類があります", "NAME_TAKEN");
      throw e;
    }
    await writeAuditLog({ userId: session.id, action: "sale_dm_scenario_create", targetTable: "dm_scenarios", targetId: row.id, detail: { result: "created" } });
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (e) { return handleApiError(e); }
}
```

`scenarios/options/route.ts`:
```ts
export async function GET() {
  try {
    await requireScenarioOptionsAccess();
    const scenarios = await prisma.dmScenario.findMany({
      where: { active: true, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: SCENARIO_OPTION_SELECT,
    });
    return NextResponse.json({ scenarios });
  } catch (e) { return handleApiError(e); }
}
```

`scenarios/[id]/route.ts`:
```ts
type Ctx = { params: Promise<{ id: string }> };
const LETTER_KEYS = ["designTemplate", "tone", "length", "appeal", "strength", "extraInstruction"] as const;
const LP_KEYS = ["lpTone", "lpLength", "lpAppeal", "lpStrength"] as const;

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const row = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    return NextResponse.json({ scenario: row });
  } catch (e) { return handleApiError(e); }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const parsed = saleDmScenarioPatchSchema.parse(await parseJsonBody(request));
    const changedFields = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const cur = await tx.dmScenario.findUniqueOrThrow({ where: { id } });
      const changed = (Object.keys(parsed) as (keyof typeof parsed)[]).filter((k) => (cur as Record<string, unknown>)[k] !== parsed[k]);
      if (changed.length === 0) return [];
      const data: Prisma.DmScenarioUpdateInput = { ...parsed };
      if (changed.some((k) => (LETTER_KEYS as readonly string[]).includes(k))) {
        Object.assign(data, { letterPromptText: null, letterBodyTemplate: null });
      }
      if (changed.some((k) => (LP_KEYS as readonly string[]).includes(k))) {
        Object.assign(data, { lpPromptText: null, lpRawTemplate: null, lpHeadline: null, lpLead: null, lpBodyText: null, lpFaqJson: Prisma.DbNull });
        await tx.dmScenarioMedia.deleteMany({ where: { scenarioId: id } });
      }
      try {
        await tx.dmScenario.update({ where: { id }, data });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new ApiError(409, "同じ名前のDMの種類があります", "NAME_TAKEN");
        throw e;
      }
      return changed;
    });
    if (changedFields.length > 0) {
      await writeAuditLog({ userId: session.id, action: "sale_dm_scenario_update", targetTable: "dm_scenarios", targetId: id, detail: { changedFields } });
    }
    return NextResponse.json({ changedFields });
  } catch (e) { return handleApiError(e); }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const cur = await tx.dmScenario.findUniqueOrThrow({ where: { id }, select: { autoKey: true } });
      if (cur.autoKey) throw new ApiError(409, "相続・空き家は消せません。止めるときは「使わない」にしてください", "SCENARIO_RESERVED");
      const [p, c, v, l] = await Promise.all([
        tx.property.count({ where: { dmScenarioId: id } }),
        tx.dmCampaign.count({ where: { defaultScenarioId: id } }),
        tx.dmVariant.count({ where: { scenarioId: id } }),
        tx.dmLpVariant.count({ where: { scenarioId: id } }),
      ]);
      if (p + c + v + l > 0) throw new ApiError(409, "このDMの種類は物件や発送で使われています。「使わない」にしてください", "SCENARIO_IN_USE");
      // 論理削除(設計 §3.1): 物理 DELETE は RESTRICT の参照検査が物件行を読み、物件の保存と逆向きに待ち合う
      await tx.dmScenario.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    });
    await writeAuditLog({ userId: session.id, action: "sale_dm_scenario_delete", targetTable: "dm_scenarios", targetId: id, detail: { result: "deleted" } });
    return NextResponse.json({ ok: true });
  } catch (e) { return handleApiError(e); }
}
```

(import: `NextResponse` from `next/server`、`prisma` from `@/lib/prisma`、`Prisma` from `@prisma/client`、`handleApiError`/`ApiError`/`parseJsonBody` from `@/lib/api-helpers`、`writeAuditLog` from `@/lib/audit`。)

- [ ] **Step 6: 監査の許可キー**(`audit-log-detail-safety.ts` の `ACTION_EXTRA_KEYS` の sale_dm 群の後ろ)

```ts
sale_dm_scenario_create: new Set(["result"]),
sale_dm_scenario_update: new Set(["changedFields"]),
sale_dm_scenario_delete: new Set(["result"]),
```
既存の `audit-log-detail-safety.test.ts` の sale_dm ケース(648行付近)にならい、`sanitizeAuditDetail("sale_dm_scenario_update", { changedFields: ["tone"], letterBodyTemplate: "本文" })` が `{ changedFields: ["tone"], letterBodyTemplate: "[REDACTED]" }` になるテストを足す(配列値の扱いが違う場合は既存の配列キーの書き方に合わせる)。

- [ ] **Step 7: 書き込みの権限走査の例外登録** — `sale-dm-write-permission-guard.test.ts` の `WRITE_GATE_EXCEPTIONS` に、`scenarios/route.ts`・`scenarios/[id]/route.ts`(と Task 5〜7 で足す書き込み route)を `{ reason: "DMの種類の台帳=管理者のみ(user_management:write)", mustContain: "requireScenarioAdmin()" }` で登録する。

- [ ] **Step 8: PASS 確認 → フルテスト → コミット** `git commit -m "feat(sale-dm-scenarios): 台帳の一覧・追加・選択肢・変更・論理削除 API"`

---

### Task 5: 台帳の手紙(指示文・貼り戻し)

**Files:**
- Create: `src/app/api/properties/sale-dm/scenarios/[id]/prompt/route.ts`・`.../[id]/template/route.ts`
- Test: `src/lib/__tests__/sale-dm-scenario-letter-route.test.ts`

**Interfaces:**
- Consumes: `buildExternalPrompt(options: {tone,length,appeal,strength}): string`・`promptDigest(prompt)`・`bodyTemplateDigest(t)`(`external-prompt.ts`)・`validateLetterBody(body, {allowTags:true})`・`letterBodyIssueMessage`(`body-validation.ts`)・`lockScenarioForUpdate`・`requireScenarioAdmin`
- Produces: GET `{ prompt, digest, bodyDigest, body: letterBodyTemplate }`・PUT body `{ body, promptDigest, baseBodyDigest }` → `{ changed: boolean, bodyDigest }`。監査 `sale_dm_scenario_letter_template`(detail `{ length }`)。

- [ ] **Step 1: 失敗するテスト**(ケース)
  - 手紙の設定(tone/length/appeal/strength)のどれかが未設定 → GET 400 `SCENARIO_SETTINGS_INCOMPLETE`(「先に書き方の設定を選んでください」)
  - GET は `buildExternalPrompt` の結果と `promptDigest`・`bodyTemplateDigest(null)` を返す
  - PUT: 同じ本文 → `{ changed:false }` で update を呼ばない
  - PUT: `promptDigest` が現在の設定の指示文と違う → 409 `PROMPT_STALE`(Review Focus 4)
  - PUT: `baseBodyDigest` が今の原文と違う → 409 `BODY_STALE`
  - PUT: `validateLetterBody` が `"unknown_tag"` → 400 `INVALID_LETTER_BODY`
  - PUT: 正常 → `lockScenarioForUpdate` の後に `update({ data: { letterBodyTemplate: body, letterPromptText: prompt } })`、監査 detail は `{ length: body.length }` だけ

  (既存の `sale-dm-template-route.test.ts` が同じ流れを検査しているので、エラーコード名はそちらと揃える=そのファイルの `PROMPT_STALE` 等の実際のコード名を `grep -n "code" src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route.ts` で確認し、**同じ名前**を使う。)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装**(既存 `variants/[variantId]/template/route.ts` の流れを台帳に写す。凍結・担当範囲・宛先の本文クリアは台帳に無いので入れない)

```ts
// scenarios/[id]/prompt/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const s = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    const opts = letterOptions(s);
    const prompt = buildExternalPrompt(opts);
    return NextResponse.json({ prompt, digest: promptDigest(prompt), bodyDigest: bodyTemplateDigest(s.letterBodyTemplate), body: s.letterBodyTemplate });
  } catch (e) { return handleApiError(e); }
}
```

`letterOptions` と `lpOptions` は `scenario-guard.ts` に追加する:

```ts
export function letterOptions(s: { tone: string | null; length: string | null; appeal: string | null; strength: string | null; designTemplate: string | null }) {
  if (!s.tone || !s.length || !s.appeal || !s.strength || !s.designTemplate) {
    throw new ApiError(400, "先に書き方の設定をすべて選んでください", "SCENARIO_SETTINGS_INCOMPLETE");
  }
  return { tone: s.tone, length: s.length, appeal: s.appeal, strength: s.strength };
}
export function lpOptions(s: { lpTone: string | null; lpLength: string | null; lpAppeal: string | null; lpStrength: string | null }) {
  if (!s.lpTone || !s.lpLength || !s.lpAppeal || !s.lpStrength) {
    throw new ApiError(400, "先にLPの書き方の設定をすべて選んでください", "SCENARIO_SETTINGS_INCOMPLETE");
  }
  return { tone: s.lpTone, length: s.lpLength, appeal: s.lpAppeal, strength: s.lpStrength };
}
```

```ts
// scenarios/[id]/template/route.ts
const putSchema = z.object({ body: z.string(), promptDigest: z.string().length(64), baseBodyDigest: z.string().length(64) });

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const parsed = putSchema.parse(await parseJsonBody(request));
    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id } });
      if (s.letterBodyTemplate === parsed.body) return { changed: false as const };
      const prompt = buildExternalPrompt(letterOptions(s));
      if (promptDigest(prompt) !== parsed.promptDigest) throw new ApiError(409, "書き方の設定が変わりました。指示文をコピーし直してください", "PROMPT_STALE");
      if (bodyTemplateDigest(s.letterBodyTemplate) !== parsed.baseBodyDigest) throw new ApiError(409, "ほかの人が先に文面を保存しました。開き直してください", "BODY_STALE");
      const issue = validateLetterBody(parsed.body, { allowTags: true });
      if (issue) throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_LETTER_BODY");
      await tx.dmScenario.update({ where: { id }, data: { letterBodyTemplate: parsed.body, letterPromptText: prompt } });
      return { changed: true as const };
    });
    if (result.changed) {
      await writeAuditLog({ userId: session.id, action: "sale_dm_scenario_letter_template", targetTable: "dm_scenarios", targetId: id, detail: { length: parsed.body.length } });
    }
    return NextResponse.json({ ...result, bodyDigest: bodyTemplateDigest(parsed.body) }); // 変更なし=保存済みと同じ本文なので同じ指紋
  } catch (e) { return handleApiError(e); }
}
```

(エラーコード名は Step 1 の注記どおり既存 route に合わせて置き換える。)

- [ ] **Step 4:** `ACTION_EXTRA_KEYS` に `sale_dm_scenario_letter_template: new Set(["length"])`・書き込み権限走査の例外に template route を追加。
- [ ] **Step 5: PASS → フルテスト → コミット** `feat(sale-dm-scenarios): 台帳の手紙の指示文と貼り戻し`

---

### Task 6: 台帳のLP(指示文・貼り戻し)

**Files:**
- Create: `src/app/api/properties/sale-dm/scenarios/[id]/lp-prompt/route.ts`・`.../[id]/lp-template/route.ts`・`src/lib/sale-dm-letter/lp-media-rows.ts`
- Modify: `src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route.ts`(`rowsToPlan`/`planToRows` を lib へ移し、route からは再 export)
- Test: `src/lib/__tests__/sale-dm-scenario-lp-route.test.ts`

**Interfaces:**
- Consumes: `buildLpExternalPrompt`・`promptDigest`・`bodyTemplateDigest`・`splitLpTemplate(raw): {ok:true;parts}|{ok:false;issue}`・`lpSplitIssueMessage`・`lpBodyHeadings(body): string[]`・`reconcileSectionMedia(_old, newHeadings, sections)`・`saleDmLpTemplatePutSchema`
- Produces: `lp-media-rows.ts` に `rowsToPlan(rows)`・`planToRows(plan)`(既存 media route からそのまま移設・型は `{ slot; heading; assetId; figureKind; sortOrder }` の配列 ⇄ `MediaPlan`)。PUT 応答 `{ changed, bodyDigest }`。監査 `sale_dm_scenario_lp_template`(detail `{ length, sectionCount }`)。

- [ ] **Step 1: 失敗するテスト**(ケース)
  - LP の設定が未完成 → GET 400 `SCENARIO_SETTINGS_INCOMPLETE`
  - PUT: 切り分けに失敗 → 400 `INVALID_LP_TEMPLATE`(メッセージは `lpSplitIssueMessage`)
  - PUT: 正常 → `lpRawTemplate`・`lpHeadline`・`lpLead`・`lpBodyText`・`lpFaqJson`・`lpPromptText` を保存し、**小見出しが変わった分の section 行だけ消え、残る見出しの割り付けは残る**(`reconcileSectionMedia` の結果で `dmScenarioMedia` の section 行を置き換え、hero は触らない)
  - `rowsToPlan`/`planToRows` の往復が恒等(移設の回帰)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 移設** — `lp-variants/[lpId]/media/route.ts` にある `rowsToPlan`・`planToRows` の本体を `src/lib/sale-dm-letter/lp-media-rows.ts` へ**そのまま**移し、route 側は `export { rowsToPlan, planToRows } from "@/lib/sale-dm-letter/lp-media-rows";` とする(既存テストが route から import していても壊れない)。

- [ ] **Step 4: 実装**(既存 `lp-variants/[lpId]/template/route.ts` の流れを台帳に写す。`lp-prompt` は Task 5 の prompt route と同形で `buildLpExternalPrompt(lpOptions(s))`・`bodyTemplateDigest(s.lpRawTemplate)`・`body: s.lpRawTemplate` を返す)

```ts
// scenarios/[id]/lp-template/route.ts(要点)
const result = await prisma.$transaction(async (tx) => {
  await lockScenarioForUpdate(tx, id);
  const s = await tx.dmScenario.findUniqueOrThrow({ where: { id } });
  if (s.lpRawTemplate === parsed.body) return { changed: false as const, sectionCount: 0 };
  const prompt = buildLpExternalPrompt(lpOptions(s));
  if (promptDigest(prompt) !== parsed.promptDigest) throw new ApiError(409, "LPの書き方の設定が変わりました。指示文をコピーし直してください", "PROMPT_STALE");
  if (bodyTemplateDigest(s.lpRawTemplate) !== parsed.baseBodyDigest) throw new ApiError(409, "ほかの人が先にLPを保存しました。開き直してください", "BODY_STALE");
  const split = splitLpTemplate(parsed.body);
  if (!split.ok) throw new ApiError(400, lpSplitIssueMessage(split.issue), "INVALID_LP_TEMPLATE");
  const oldRows = await tx.dmScenarioMedia.findMany({ where: { scenarioId: id }, orderBy: { sortOrder: "asc" } });
  const oldPlan = rowsToPlan(oldRows);
  const newHeadings = [...new Set(lpBodyHeadings(split.parts.bodyText))];
  const sections = reconcileSectionMedia([...new Set(lpBodyHeadings(s.lpBodyText ?? ""))], newHeadings, oldPlan.sections);
  await tx.dmScenarioMedia.deleteMany({ where: { scenarioId: id, slot: "section" } });
  const sectionRows = planToRows({ hero: null, sections }).filter((r) => r.slot === "section");
  if (sectionRows.length > 0) await tx.dmScenarioMedia.createMany({ data: sectionRows.map((r) => ({ ...r, scenarioId: id })) });
  await tx.dmScenario.update({ where: { id }, data: {
    lpRawTemplate: parsed.body, lpPromptText: prompt,
    lpHeadline: split.parts.headline, lpLead: split.parts.lead, lpBodyText: split.parts.bodyText, lpFaqJson: split.parts.faq,
  } });
  return { changed: true as const, sectionCount: newHeadings.length };
});
```

(⚠`split.parts` のプロパティ名は `lp-template.ts` の `LpTemplateParts` の実名に合わせる=既存 LP template route が `dmLpVariant.update` に渡している形をそのまま写す。)

- [ ] **Step 5:** 監査キー `sale_dm_scenario_lp_template: new Set(["length", "sectionCount"])`・書き込み権限走査の例外に lp-template を追加。
- [ ] **Step 6: PASS → フルテスト → コミット** `feat(sale-dm-scenarios): 台帳のLPの指示文と貼り戻し`

---

### Task 7: 台帳の写真と図・プレビュー・画像の指示文

**Files:**
- Create: `src/app/api/properties/sale-dm/scenarios/[id]/media/route.ts`・`.../[id]/preview/route.ts`・`.../[id]/image-prompt/route.ts`
- Modify: `src/lib/__tests__/sale-dm-asset-references.test.ts`(走査の `try/continue` を外す)
- Test: `src/lib/__tests__/sale-dm-scenario-media-route.test.ts`

**Interfaces:**
- Consumes: `saleDmLpMediaPutSchema`・`validateMediaPlan(plan, headings)`・`mediaPlanIssueMessage`・`referencedAssetIds(plan)`・`lpBodyHeadings`・`rowsToPlan`/`planToRows`・`ASSET_REFERENCE_COUNT_SELECT`/`isAssetReferenced`・`buildLpRenderInput(rows: LpSourceRows, opts)`・`renderLpPage`・`LP_PAGE_HEADERS`・`loadSaleDmPublicPageConfig`・`buildImagePrompt({slot, appeal, propertyKind, style})`・`saleDmLpImagePromptQuerySchema`
- Produces: GET media `{ plan, headings, assets: Array<asset & { referenced: boolean }> }`(発送版 media GET と同じ形)・PUT media(発送版と同じ body)・GET preview `?device=sp|pc` → HTML・GET image-prompt `?slot&heading&style` → `{ prompt }`。監査 `sale_dm_scenario_media_update`(`assetCount`・`figureCount`)。

- [ ] **Step 1: 失敗するテスト**(ケース)
  - media PUT: ロック順は `dm_scenarios FOR UPDATE` → `dm_lp_assets FOR UPDATE`(`$queryRaw` の呼び出し順を検査)
  - media PUT: 本文に無い小見出しの割り付け → 400 `INVALID_MEDIA_PLAN`
  - media PUT: 削除済みの写真 → 409(発送版と同じコード名)
  - media GET の `assets[].referenced` は `isAssetReferenced` 経由(台帳だけが使う写真で true)
  - preview: LP の文面が無い → 404 `LP_NOT_READY`、ある → 200 `text/html`・`LP_PAGE_HEADERS` 付き・`buildLpRenderInput` に `property: { address: null, propertyType: null }`・`mode: "preview"`(既存 preview route の mode 名に合わせる)が渡る
  - image-prompt: `buildImagePrompt` に `propertyKind: null`・`appeal: lpAppeal`(未設定なら 400 `SCENARIO_SETTINGS_INCOMPLETE`)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: 実装** — 3本とも既存の発送版(`lp-variants/[lpId]/{media,preview,image-prompt}/route.ts`)を開き、**親の取り方だけ**を差し替えて写す:
  - 認可: `requireSaleDmAccess`+`assertSaleDmCampaignOwned` → `requireScenarioAdmin()`
  - 親行: `dmLpVariant.findFirst({ where: { id: lpId, campaignId: id } })` → `dmScenario.findFirst({ where: { id, deletedAt: null } })`
  - ロック: `SELECT id FROM dm_lp_variants ... FOR UPDATE` → `lockScenarioForUpdate(tx, id)`
  - 凍結・宛先・担当範囲の検査 → **削除**(台帳には無い)
  - 枠の表: `dmLpVariantMedia`(`lpVariantId`) → `dmScenarioMedia`(`scenarioId`)
  - 本文: `v.bodyText` → `s.lpBodyText`、`v.headline/lead/faqJson` → `s.lpHeadline/lpLead/lpFaqJson`、`v.appeal` → `s.lpAppeal`
  - preview の `LpSourceRows`: `{ variant: { headline: s.lpHeadline!, lead: s.lpLead, bodyText: s.lpBodyText!, faqJson: s.lpFaqJson }, media: (dmScenarioMedia を asset 込みで select), property: { address: null, propertyType: null }, company: (既存 preview と同じく loadSaleDmPublicPageConfig から) }`
  - image-prompt の `propertyKind`: 宛先が無いので `null` 固定(`buildImagePrompt` は null 受け付け済み)
  - listAssets: `select: { ...列, ...ASSET_REFERENCE_COUNT_SELECT }` → `referenced: isAssetReferenced({ _count })`

- [ ] **Step 4:** `sale-dm-asset-references.test.ts` の走査から `try { ... } catch { continue; }` を外し、5ファイルとも必ず読む形にする。監査キー `sale_dm_scenario_media_update: new Set(["assetCount", "figureCount"])`・書き込み権限走査の例外に media route を追加。
- [ ] **Step 5: PASS → フルテスト → コミット** `feat(sale-dm-scenarios): 台帳の写真と図・プレビュー・画像の指示文`

---

### Task 8: 物件の「DMの種類」欄(保存)

**Files:**
- Modify: `src/lib/validators.ts:218-285`(`updatePropertySchema`)・`src/app/api/properties/[id]/route.ts:318-412`・`src/lib/edit-lock/__tests__/version-increment-scan.test.ts`(`route.ts:399` の行番号)・`docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md`(行番号)
- Test: `src/lib/__tests__/property-dm-scenario-patch.test.ts`

**Interfaces:**
- Consumes: `lockScenarioForShare(tx, id)`・`canAccessPropertyRecord(session, {createdBy, assignedTo})`(`@/lib/property-access`)
- Produces: `PATCH /api/properties/[id]` が `dmScenarioId: uuid | null` を受ける。無効な種類 → 409 `SCENARIO_UNAVAILABLE`。

- [ ] **Step 1: 失敗するテスト**(既存の物件 PATCH のテストがあればそのモックを流用。`grep -ln "properties/\[id\]/route" src/lib/__tests__` で探す。ケース:)
  - `dmScenarioId` が有効 → 200、`updateMany` の data に `dmScenarioId` と `version: { increment: 1 }`、ChangeLog に `fieldName: "dmScenarioId"` の行
  - `lockScenarioForShare` が `null`(存在しない)/`active:false`/`deletedAt` あり → 409 `SCENARIO_UNAVAILABLE`・`updateMany` を呼ばない(Review Focus 1)
  - `$queryRaw` の順が `properties ... FOR UPDATE`(lockPropertyRow)→ `dm_scenarios ... FOR SHARE`
  - `dmScenarioId: null`(自動に戻す)→ 台帳のロックを取らずに保存
  - field_staff: トランザクション内で読み直した `createdBy/assignedTo` が本人でない → 403(ロック前は担当・ロック後に付け替え済みのケース=Review Focus 5)
  - `dmScenarioId` を含まない既存の保存は、台帳の問い合わせを1回も呼ばない(既存挙動不変)

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: スキーマ** — `updatePropertySchema` の `introductionRoute` の次に `dmScenarioId: z.string().uuid().optional().nullable(),`(`createPropertySchema` には足さない=作成時は自動)。

- [ ] **Step 4: route** — `prisma.$transaction` の `lockPropertyRow(tx, id)` と `assertNotEditLockedByOther(...)` の**後**、`updateMany` の**前**に挿入:

```ts
      // DMの種類(設計 2026-09-27 §3.4・§3.6): 物件→台帳の順でロックし、ロック後に有効性を確かめる。
      if (updateFields.dmScenarioId) {
        const sc = await lockScenarioForShare(tx, updateFields.dmScenarioId);
        if (!sc || !sc.active || sc.deletedAt) {
          throw new ApiError(409, "選んだDMの種類は使えなくなりました。選び直してください", "SCENARIO_UNAVAILABLE");
        }
      }
      // 担当範囲はロック後に読み直して再確認(ロック前の確認の後に担当が付け替えられた場合に書かない)
      if (isPropertyScopedRole(session.role)) {
        const fresh = await tx.property.findUnique({ where: { id }, select: { createdBy: true, assignedTo: true } });
        if (!fresh || !canAccessPropertyRecord(session, fresh)) {
          throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
        }
      }
```

(⚠トランザクションの中で投げた `ApiError` が route の外側の `handleApiError` に届くことを確認=既存の `assertNotEditLockedByOther` が同じ経路で 423 を返しているのでそれに倣う。`persistedFields` の組み立てで `dmScenarioId` が落ちないこと=`persistedFields` が許可リストなら `dmScenarioId` を足す。)

- [ ] **Step 5: 版番号の走査を直す** — 挿入で `updateMany` の行番号が動くので、`npx vitest run src/lib/edit-lock/__tests__/version-increment-scan.test.ts` の失敗メッセージに出る新しい行番号で `VERSIONED` の `"src/app/api/properties/[id]/route.ts:399"` を置き換え、`2026-09-18-edit-lock-version-inventory.md` の該当行も同じ番号に直す。

- [ ] **Step 6: PASS → フルテスト → コミット** `feat(sale-dm-scenarios): 物件の「DMの種類」欄の保存(台帳の有効性と担当範囲をロック後に確認)`

---

### Task 9: 画面(物件の欄・台帳の管理画面・サイドバー・共用部品の呼び先注入)

**Files:**
- Modify: `src/lib/api-client.ts`・`src/components/sale-dm/lp-media-panel.tsx`・`src/components/sale-dm/lp-preview-panel.tsx`・呼び出し元(`grep -rn "LpMediaPanel\|LpPreviewPanel" src/components src/app`)・`src/components/layout/sidebar-model.tsx:126`・`src/app/(dashboard)/properties/[id]/page.tsx`(`IntroductionRouteField` の隣=1128行付近)
- Create: `src/components/sale-dm/scenario-text-editor.tsx`・`src/app/(dashboard)/admin/dm-scenarios/page.tsx`・`src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx`・`src/components/properties/dm-scenario-field.tsx`
- Test: `src/lib/__tests__/sale-dm-scenario-ui-scan.test.ts`

**Interfaces:**
- Produces(api-client):
```ts
export type SaleDmScenarioOption = { id: string; name: string; sortOrder: number; autoKey: string | null };
export type SaleDmScenarioSummary = SaleDmScenarioOption & { active: boolean; hasLetter: boolean; hasLp: boolean; updatedAt: string };
export type SaleDmScenario = { id: string; name: string; autoKey: string | null; sortOrder: number; active: boolean; designTemplate: string | null; tone: string | null; length: string | null; appeal: string | null; strength: string | null; extraInstruction: string | null; letterBodyTemplate: string | null; lpTone: string | null; lpLength: string | null; lpAppeal: string | null; lpStrength: string | null; lpRawTemplate: string | null; lpHeadline: string | null; lpBodyText: string | null };
export async function fetchSaleDmScenarioOptions(): Promise<SaleDmScenarioOption[]>;
export async function fetchSaleDmScenarios(): Promise<SaleDmScenarioSummary[]>;
export async function createSaleDmScenario(name: string): Promise<{ id: string }>;
export async function fetchSaleDmScenario(id: string): Promise<SaleDmScenario>;
export async function updateSaleDmScenario(id: string, patch: Partial<SaleDmScenario>): Promise<{ changedFields: string[] }>;
export async function deleteSaleDmScenario(id: string): Promise<void>;
export async function fetchSaleDmScenarioPrompt(id: string, kind: "letter" | "lp"): Promise<{ prompt: string; digest: string; bodyDigest: string; body: string | null }>;
export async function saveSaleDmScenarioTemplate(id: string, kind: "letter" | "lp", input: { body: string; promptDigest: string; baseBodyDigest: string }): Promise<{ changed: boolean; bodyDigest: string }>;
// 共用部品の呼び先
export type LpMediaApi = {
  load: () => Promise<SaleDmLpMediaResponse>;          // 既存 fetchSaleDmLpMedia の戻り型
  save: (plan: SaleDmLpMediaPut) => Promise<unknown>;
  imagePrompt: (q: { slot: "hero" | "section"; heading?: string; style: "photo" | "illustration" | "flat" }) => Promise<{ prompt: string }>;
  previewUrl: (device: "sp" | "pc") => string;
};
export function campaignLpMediaApi(campaignId: string, lpId: string): LpMediaApi;
export function scenarioLpMediaApi(scenarioId: string): LpMediaApi;
```
- `LpMediaPanel` の props: `{ api: LpMediaApi; label: string; onClose: () => void }`、`LpPreviewPanel` の props: `{ previewUrl: (device) => string; label: string; onClose: () => void }`。

- [ ] **Step 1: 失敗する走査テスト**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("DMの種類の画面(設計 §3.6)", () => {
  it("共用部品は発送用の呼び先を直接書かない(呼び先は api で受け取る)", () => {
    for (const f of ["src/components/sale-dm/lp-media-panel.tsx", "src/components/sale-dm/lp-preview-panel.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/fetchSaleDmLpMedia|saveSaleDmLpMedia|fetchSaleDmLpImagePrompt|LP_PREVIEW_URL|campaignId/);
    }
  });
  it("サイドバーに「DMの種類」(管理者のみ)", () => {
    expect(read("src/components/layout/sidebar-model.tsx")).toMatch(/label:\s*"DMの種類",\s*href:\s*"\/admin\/dm-scenarios"[^}]*minRole:\s*"admin"/);
  });
  it("物件の欄は選択肢の口だけを使う(中身の口を叩かない)", () => {
    const src = read("src/components/properties/dm-scenario-field.tsx");
    expect(src).toMatch(/fetchSaleDmScenarioOptions/);
    expect(src).not.toMatch(/fetchSaleDmScenarios\b|fetchSaleDmScenario\(/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

- [ ] **Step 3: api-client** — 上の Interfaces の関数を、既存の `fetchSaleDmLpMedia` 等と同じ書き方(`fetch` → `if (!res.ok) throw await toApiError(res)` 等、同ファイルの既存ヘルパー)で足す。`campaignLpMediaApi` は既存の `fetchSaleDmLpMedia(campaignId, lpId)`・`saveSaleDmLpMedia`・`fetchSaleDmLpImagePrompt`・`LP_PREVIEW_URL(campaignId, lpId, device)` を束ねるだけ。`scenarioLpMediaApi` は `/api/properties/sale-dm/scenarios/${id}/media`・`/image-prompt`・`/preview?device=` を叩く。モック分岐(`api-client.ts` に mock モードの分岐がある場合)は既存の LP 関数と同じ形で足す。

- [ ] **Step 4: 共用部品の注入** — `LpMediaPanel` の `campaignId/lpId` props を `api: LpMediaApi` に置き換え、中の `fetchSaleDmLpMedia(campaignId, lpId)` → `api.load()`、`saveSaleDmLpMedia(...)` → `api.save(plan)`、`fetchSaleDmLpImagePrompt(...)` → `api.imagePrompt(q)`。`LpPreviewPanel` は `previewUrl` を受ける。呼び出し元(発送の画面)は `api={campaignLpMediaApi(campaign.id, lp.id)}`・`previewUrl={(d) => LP_PREVIEW_URL(campaign.id, lp.id, d)}` を渡す(見た目・挙動は変えない)。

- [ ] **Step 5: 台帳の編集部品** `scenario-text-editor.tsx` — 1つの部品で手紙とLPを扱う(`kind: "letter" | "lp"`)。構成は既存 `variant-manager.tsx` の「指示文をコピー → 貼り付け欄 → 保存」部分と同じ見た目:
  - 書き方の設定の select(手紙=デザイン・語調・長さ・訴求・強さ+追加の指示/LP=語調・長さ・訴求・強さ)。変更は `updateSaleDmScenario` で即保存し、保存後に「設定を変えたので、文面を作り直してください」と出す(PATCH が文面を消すため)。
  - 「指示文をコピー」: `fetchSaleDmScenarioPrompt(id, kind)` → クリップボード。`digest`・`bodyDigest` を state に持つ。
  - 貼り付け欄+「保存」: `saveSaleDmScenarioTemplate(id, kind, { body, promptDigest: digest, baseBodyDigest: bodyDigest })`。409 `PROMPT_STALE` は「設定が変わりました。指示文をコピーし直してください」を表示。
  - 登録済みなら現在の文面を読み取り専用で表示。

- [ ] **Step 6: 管理画面**
  - `/admin/dm-scenarios`: 一覧(名前・並び・「手紙 登録済み/未登録」「LP 登録済み/未登録」・使う/使わない の切り替え・削除)と「種類を追加」。削除の 409 はメッセージをそのまま出す。相続・空き家の行には削除ボタンを出さない(`autoKey` あり)。
  - `/admin/dm-scenarios/[id]`: 名前の変更、`ScenarioTextEditor kind="letter"`、`ScenarioTextEditor kind="lp"`、LP が登録済みなら「写真と図」(`<LpMediaPanel api={scenarioLpMediaApi(id)} …/>`)と「プレビュー」(`<LpPreviewPanel previewUrl={(d) => \`/api/properties/sale-dm/scenarios/${id}/preview?device=${d}\`} …/>`)。
  - どちらも `"use client"`。既存 `/admin/lp-assets/page.tsx` と同じ枠(見出し・`src/components/ui/` の部品)を使う。
  - サイドバー: `sidebar-model.tsx:126` の「LPの写真」の次に `{ label: "DMの種類", href: "/admin/dm-scenarios", icon: ic(Tags), minRole: "admin" },`(`Tags` は lucide-react から import)。

- [ ] **Step 7: 物件の欄** `src/components/properties/dm-scenario-field.tsx` — `IntroductionRouteField`(page.tsx 2420行)と同じ形:
  - props `{ property: { id; version; dmScenarioId: string | null; introductionRoute: string | null }; onRefresh; canWrite; editLockHeld }`
  - 選択肢は `fetchSaleDmScenarioOptions()`。先頭に「自動」(value="")。
  - 表示ラベル: 物件に値があればその名前。空欄なら `resolveScenario({ propertyScenarioId: null, introductionRoute, defaultScenarioId: null, scenarios })` で `via:"auto"` なら「自動: 相続」、決まらなければ「自動(発送のときに選ぶ既定の種類)」。`scenarios` は選択肢(有効なものだけ)を `ScenarioRow` に変換(`active: true, deletedAt: null`)。物件の値が選択肢に無い(使わない/削除)ときは「(使えなくなった種類)自動に戻してください」と出す。
  - 保存: `runNoLockPropertyPatch(property.id, property.version, { dmScenarioId: value || null }, …)`(page.tsx から export 済み)。409 `SCENARIO_UNAVAILABLE` はメッセージを表示して選択肢を読み直す。
  - page.tsx の `IntroductionRouteField` の直後に `<DmScenarioField …/>` を置く。物件の GET が `dmScenarioId` を返すことを確認(`findUnique` が全列なら追加不要。select 指定なら足す)。

- [ ] **Step 8: 実機確認(Playwright か手動・[[local-dev-env-setup]])**
  1. 管理者で `/admin/dm-scenarios` → 相続・空き家の2行が出る・削除ボタンが無い。
  2. 相続を開き、手紙の設定を選ぶ → 指示文をコピー → 適当な文面を貼って保存 → 一覧で「手紙 登録済み」。
  3. LP も同様 → 写真を1枚割り付け → プレビューに出る → `/admin/lp-assets` でその写真の削除ボタンが押せない。
  4. 事務員(office_staff)で物件詳細 → 「DMの種類」に「自動: 相続」(受付帳取込の物件)→「空き家」を選んで保存 → 履歴タブに変更が出る。
  5. 管理者が空き家を「使わない」にした後、4 の画面を開いたまま別の種類を保存 → 「選んだDMの種類は使えなくなりました」。
  6. 発送の画面の既存の「写真と図」「プレビュー」が今までどおり動く(呼び先注入の回帰)。

- [ ] **Step 9: フルテスト+ `npm run build` + `npm run lint` → コミット** `feat(sale-dm-scenarios): 台帳の管理画面・物件の「DMの種類」欄・共用部品の呼び先注入`

---

### Task 10: 仕上げ(全体確認)

- [ ] `npx vitest run`(フル)・`npm run build`・`npm run lint` がすべて緑。
- [ ] `git diff --stat origin/main` に `Bin` が無い(制御文字の混入なし)。
- [ ] 設計書 §3.1・§3.2・§3.3.1・§3.6・§4・§6.1 の各項目に対応する Task があることを、設計書を開いて1行ずつ確認(PR-S2 の範囲=§3.3/§3.3.0/§3.4 の発送側は含まないことも確認)。
- [ ] PR 本文に「発送の作り方はまだ変わらない(PR-S2)」「migration あり(反映は表→コードの順)」「実機確認の手順(Task 9 Step 8)」を書く。
