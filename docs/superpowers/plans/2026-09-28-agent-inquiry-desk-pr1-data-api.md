# 業者からの反響の受付 PR1(データ+API)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 業者の名簿・反響・内見の予定・広告の可否の4表と、それを読み書きする API を作る(画面は PR2/PR3)。

**Architecture:** Prisma に4表+enum を ADD のみの migration で足し、権限 `agent_inquiry:read/write` を3テンプレートへ付与する。判定・整形・許可リストは `src/lib/agent-inquiry/` の純関数に集め、route は薄く保つ。同時更新は `version` 列の `updateMany` で 409 `VERSION_CONFLICT`。

**Tech Stack:** Next.js 16 route handlers / Prisma(PostgreSQL)/ zod / vitest(node 環境・prisma と api-helpers を mock)/ libphonenumber-js(既存 `formatPhoneJp`)。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md`

## Global Constraints

- migration は **ADD のみ**(既存の行・列を UPDATE/DELETE/DROP しない)。ファイル名 `prisma/migrations/20260928100000_add_agent_inquiries/migration.sql`。
- 用件は `viewing | ad_permission | material_request` の3つ。入口 `phone | email | fax`(既定 phone)。状態 `open | in_progress | done`(既定 open)。
- 内見の種別 `guided`(案内)`| preview`(下見)。日時の無い内見(日程調整中)を許す。
- 広告の媒体は `own_site | athome | suumo | homes | other_portal | flyer`、値は `ok | ng | ask`。未設定=行なし。
- 業者の必須は **商号と代表電話**。電話・携帯・FAX は `formatPhoneJp(x).value` で保存(桁不正でも保存は止めない)。
- 反響の担当の既定=登録者。物件は必須。反響・業者は**削除 API を作らない**(業者は `isArchived`)。
- 権限: 反響・業者の読み=`agent_inquiry:read`、書き=`agent_inquiry:write`。3テンプレートすべてに付与。
- 受付の窓の物件検索・反響一覧・詳細・今日明日の内見・業者詳細で返す物件は **id・表示名・部屋番号・町名まで・種別・広告の可否** だけ(許可リスト `toDeskProperty`)。物件検索の条件は物件名・棟名・部屋番号・所在地のみ。
- 物件画面の反響欄 API と広告の可否の変更は **既存の物件権限**(`property:read` / `property:write`+現地スタッフは作成者/担当のみ)に従う。
- 監査 detail は **id・変えた項目名・状態/用件の値だけ**。問い合わせ者の名前・携帯・メール・メモ・内見の結果の中身を書かない。
- 409 のコードは既存と同じ `VERSION_CONFLICT`、文言「他のユーザーが先に更新しています。画面を再読み込みしてください。」
- 権限の一覧は `src/app/(dashboard)/admin/templates/[id]/page.tsx` と `src/app/(dashboard)/admin/users/[id]/permissions/page.tsx` の `RESOURCES` を**必ず同内容**で更新(片方だけだと付与できず 403 になる実例あり)。
- テストの文字列走査は CRLF を LF に正規化してから比べる。
- route テストの mock 雛形は `src/lib/__tests__/sale-dm-scenarios-route.test.ts` の先頭(next/server・api-helpers・audit・prisma の vi.mock)と同じ形を使う。
- commit 末尾:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015eJAMGUbK65d3qvTbeSJBb
  ```

## Review Focus

1. **現地スタッフが担当外の物件の中身を受け取れてしまう**: 受付の窓の物件検索・反響一覧・詳細・今日明日の内見・業者詳細で、所有者・価格・地番・メモが1つでも返れば漏えい → Task 5/7 で「物件のキー集合が許可リストと完全一致」を assert。
2. **所有者名などで物件検索が当たる=返さない情報を推測できる**: `where` に owner / lotNumber / note が入らないことを Task 7 で assert。
3. **携帯で業者を引くときの打ちかけ・全角・ハイフン**: `０９０－１２３４－５` が数字照合に回り、6桁以下は文字検索に回ることを Task 2 で総当たり。
4. **古い画面からの保存が黙って上書き**: 業者・反響の PATCH で `updateMany` count 0 → 409(存在しなければ 404)を Task 4/5 で assert。
5. **監査ログに携帯・メール・メモ・結果の中身が混ざる**: 各 route で `writeAuditLog` の呼び出しを JSON 化し、入力値を含まないことを Task 4/5/6 で assert。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `prisma/schema.prisma`(変更) | 4モデル+6 enum+Property/User の逆リレーション |
| `prisma/migrations/20260928100000_add_agent_inquiries/migration.sql`(新) | 表・索引・FK・権限付与 |
| `prisma/seed.ts`(変更) | 3テンプレートへ `agent_inquiry` read/write |
| `src/lib/api-helpers.ts`(変更) | mock 権限に `agent_inquiry` read/write |
| 権限画面2つ(変更) | RESOURCES に「反響の受付」 |
| `src/lib/agent-inquiry/constants.ts` | enum 値の配列・ラベル |
| `src/lib/agent-inquiry/validators.ts` | zod スキーマと正規化 |
| `src/lib/agent-inquiry/agent-query.ts` | 業者検索語の振り分け |
| `src/lib/agent-inquiry/desk-property.ts` | 町名までの切り落とし+物件の許可リスト整形 |
| `src/lib/agent-inquiry/inquiry-view.ts` | 反響の select と画面用の形 |
| `src/lib/agent-inquiry/timeline.ts` | 物件の時系列と件数 |
| `src/lib/agent-inquiry/audit-detail.ts` | 監査 detail(許可リスト) |
| `src/lib/agent-inquiry/jst-range.ts` | 今日・明日(JST)の範囲 |
| `src/lib/agent-inquiry/guard.ts` | `requireAgentInquiry` |
| `src/lib/agent-inquiry/agent-search.ts` | 業者検索の DB 照会 |
| `src/lib/agent-inquiry/property-access.ts` | 物件画面と同じ閲覧/編集規則 |
| `src/app/api/agents/route.ts`・`[id]/route.ts` | 業者 |
| `src/app/api/agent-inquiries/route.ts`・`[id]/route.ts`・`counts/route.ts`・`upcoming/route.ts` | 反響 |
| `src/app/api/agent-inquiries/[id]/viewings/route.ts`・`[id]/viewings/[vid]/route.ts` | 内見 |
| `src/app/api/agent-inquiries/property-search/route.ts` | 受付の窓の物件検索 |
| `src/app/api/properties/[id]/agent-inquiries/route.ts`・`[id]/ad-permissions/route.ts` | 物件側 |
| `src/lib/__tests__/agent-inquiry-*.test.ts` | テスト |

---

### Task 0: worktree の準備

- [ ] **Step 1: 依存と生成物を入れ、基準の緑を確認**

```bash
cd C:/Users/issin/Desktop/Claude/property-management-worktrees/agent-inquiry-desk
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npx prisma generate
npx vitest run src/lib/__tests__ 2>&1 | tail -5
```
Expected: 失敗 0(赤があれば既存問題として止めて報告)。

---

### Task 1: スキーマ・migration・権限付与

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/seed.ts`, `src/lib/api-helpers.ts`, `src/app/(dashboard)/admin/templates/[id]/page.tsx`, `src/app/(dashboard)/admin/users/[id]/permissions/page.tsx`
- Create: `prisma/migrations/20260928100000_add_agent_inquiries/migration.sql`
- Test: `src/lib/__tests__/agent-inquiry-migration-scan.test.ts`

**Interfaces:**
- Produces: Prisma モデル `Agent` / `AgentInquiry` / `AgentViewing` / `PropertyAdPermission`、enum `AgentInquiryKind` / `AgentInquiryChannel` / `AgentInquiryStatus` / `ViewingType` / `AdMedium` / `AdPermissionValue`。権限 `agent_inquiry:read` / `agent_inquiry:write`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/__tests__/agent-inquiry-migration-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20260928100000_add_agent_inquiries/migration.sql");

describe("反響の受付 migration(設計 §1/§4)", () => {
  it("4表を作る", () => {
    for (const t of ["agents", "agent_inquiries", "agent_viewings", "property_ad_permissions"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });
  it("反響→物件・業者は RESTRICT、内見→反響は CASCADE、広告の可否→物件は CASCADE", () => {
    expect(sql).toMatch(/"agent_inquiries_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_inquiries_agent_id_fkey" FOREIGN KEY \("agent_id"\) REFERENCES "agents"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_viewings_inquiry_id_fkey" FOREIGN KEY \("inquiry_id"\) REFERENCES "agent_inquiries"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"property_ad_permissions_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE CASCADE/);
  });
  it("広告の可否は物件×媒体で一意", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "property_ad_permissions_property_id_medium_key" ON "property_ad_permissions"\("property_id", "medium"\);/);
  });
  it("3テンプレートに agent_inquiry read/write を付与(重複しない)", () => {
    for (const a of ["read", "write"]) {
      expect(sql).toMatch(new RegExp(`'agent_inquiry', '${a}', true[\\s\\S]*?IN \\('管理者用', '事務担当用', '現地担当用'\\)[\\s\\S]*?ON CONFLICT \\("template_id", "resource", "action"\\) DO NOTHING`));
    }
  });
  it("既存の行を書き換えない", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
  });
});

describe("権限の一覧は2画面で同じ(片方だけだと付与できない)", () => {
  it("templates と users の RESOURCES に agent_inquiry read/write", () => {
    for (const p of [
      "src/app/(dashboard)/admin/templates/[id]/page.tsx",
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/\{ key: "agent_inquiry", label: "反響の受付", actions: \["read", "write"\] \}/);
    }
  });
  it("seed で3テンプレートに付与", () => {
    const seed = read("prisma/seed.ts");
    for (const t of ["fieldStaffTemplate", "officeStaffTemplate", "adminTemplate"]) {
      for (const a of ["read", "write"]) {
        expect(seed).toContain(`{ templateId: ${t}.id, resource: "agent_inquiry", action: "${a}", granted: true }`);
      }
    }
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/__tests__/agent-inquiry-migration-scan.test.ts`
Expected: FAIL(ENOENT migration.sql)

- [ ] **Step 3: schema.prisma に追記**(enum は既存 enum 群の最後、model は `model DmInquiry` の後ろ)

```prisma
enum AgentInquiryKind {
  viewing
  ad_permission
  material_request
}

enum AgentInquiryChannel {
  phone
  email
  fax
}

enum AgentInquiryStatus {
  open
  in_progress
  done
}

enum ViewingType {
  guided
  preview
}

enum AdMedium {
  own_site
  athome
  suumo
  homes
  other_portal
  flyer
}

enum AdPermissionValue {
  ok
  ng
  ask
}

/// 業者の名簿(設計 2026-09-28 §1)。会社の情報だけ。担当者個人は反響の側に持つ。
model Agent {
  id          String   @id @default(uuid()) @db.Uuid
  companyName String   @map("company_name")
  companyKana String?  @map("company_kana")
  branchName  String?  @map("branch_name")
  licenseNo   String?  @map("license_no")
  phone       String
  fax         String?
  email       String?
  address     String?
  note        String?
  isArchived  Boolean  @default(false) @map("is_archived")
  version     Int      @default(1)
  createdById String   @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  createdBy User           @relation("AgentCreatedBy", fields: [createdById], references: [id])
  inquiries AgentInquiry[]

  @@index([companyName])
  @@map("agents")
}

/// 業者からの反響(設計 §1)。所有者本人からの「査定の申込」(DmInquiry)とは別物。
model AgentInquiry {
  id            String              @id @default(uuid()) @db.Uuid
  propertyId    String              @map("property_id") @db.Uuid
  agentId       String              @map("agent_id") @db.Uuid
  contactName   String?             @map("contact_name")
  contactMobile String?             @map("contact_mobile")
  contactEmail  String?             @map("contact_email")
  kind          AgentInquiryKind
  channel       AgentInquiryChannel @default(phone)
  receivedAt    DateTime            @default(now()) @map("received_at")
  status        AgentInquiryStatus  @default(open)
  assigneeId    String?             @map("assignee_id") @db.Uuid
  note          String?
  version       Int                 @default(1)
  createdById   String              @map("created_by_id") @db.Uuid
  createdAt     DateTime            @default(now()) @map("created_at")
  updatedAt     DateTime            @updatedAt @map("updated_at")

  property  Property       @relation(fields: [propertyId], references: [id], onDelete: Restrict)
  agent     Agent          @relation(fields: [agentId], references: [id], onDelete: Restrict)
  assignee  User?          @relation("AgentInquiryAssignee", fields: [assigneeId], references: [id])
  createdBy User           @relation("AgentInquiryCreatedBy", fields: [createdById], references: [id])
  viewings  AgentViewing[]

  @@index([status, receivedAt])
  @@index([propertyId, receivedAt])
  @@index([agentId, receivedAt])
  @@map("agent_inquiries")
}

/// 内見の予定(1反響に複数)。scheduledAt が空=日程調整中。
model AgentViewing {
  id          String      @id @default(uuid()) @db.Uuid
  inquiryId   String      @map("inquiry_id") @db.Uuid
  scheduledAt DateTime?   @map("scheduled_at")
  viewingType ViewingType @map("viewing_type")
  attendantId String?     @map("attendant_id") @db.Uuid
  resultNote  String?     @map("result_note")
  canceledAt  DateTime?   @map("canceled_at")
  createdAt   DateTime    @default(now()) @map("created_at")
  updatedAt   DateTime    @updatedAt @map("updated_at")

  inquiry   AgentInquiry @relation(fields: [inquiryId], references: [id], onDelete: Cascade)
  attendant User?        @relation("AgentViewingAttendant", fields: [attendantId], references: [id])

  @@index([scheduledAt])
  @@index([inquiryId])
  @@map("agent_viewings")
}

/// 広告の可否(物件×媒体で1行・未設定=行なし)。区分は部屋=Property 行ごと。
model PropertyAdPermission {
  id          String            @id @default(uuid()) @db.Uuid
  propertyId  String            @map("property_id") @db.Uuid
  medium      AdMedium
  value       AdPermissionValue
  updatedById String            @map("updated_by_id") @db.Uuid
  updatedAt   DateTime          @updatedAt @map("updated_at")

  property  Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  updatedBy User     @relation("PropertyAdPermissionUpdatedBy", fields: [updatedById], references: [id])

  @@unique([propertyId, medium])
  @@map("property_ad_permissions")
}
```

`model Property` の Relations に:
```prisma
  agentInquiries   AgentInquiry[]
  adPermissions    PropertyAdPermission[]
```
`model User` の Relations に:
```prisma
  agentsCreated            Agent[]                @relation("AgentCreatedBy")
  agentInquiriesAssigned   AgentInquiry[]         @relation("AgentInquiryAssignee")
  agentInquiriesCreated    AgentInquiry[]         @relation("AgentInquiryCreatedBy")
  agentViewingsAttended    AgentViewing[]         @relation("AgentViewingAttendant")
  adPermissionsUpdated     PropertyAdPermission[] @relation("PropertyAdPermissionUpdatedBy")
```

- [ ] **Step 4: migration SQL を生成して権限付与を足す**

```bash
git show origin/main:prisma/schema.prisma > /tmp/schema-main.prisma
npx prisma migrate diff --from-schema-datamodel /tmp/schema-main.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/agent.sql
mkdir -p prisma/migrations/20260928100000_add_agent_inquiries
```
出力を `prisma/migrations/20260928100000_add_agent_inquiries/migration.sql` に置き、**CREATE TYPE / CREATE TABLE / CREATE INDEX / ADD CONSTRAINT だけ**であることを目視(既存表への ALTER COLUMN・DROP が混ざっていたら、それは既知の「migration と schema の DEFAULT ずれ」由来なので**その行は削る**)。先頭に説明コメント、末尾に:

```sql
-- 反響の受付の権限(設計 §4)。全員が使う=3テンプレートすべてに付与。DDL は無い(resource/action は素の文字列)。
-- fresh DB ではテンプレート未作成のため 0 行になり、seed が同じ行を作る。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'agent_inquiry', 'read', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'agent_inquiry', 'write', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
```

- [ ] **Step 5: seed・mock・権限画面**

`prisma/seed.ts` の `templateEntries` 末尾(`registry_pdf` download の3行の後)に:
```ts
    // 反響の受付(設計 2026-09-28 §4)。全員が使う=3テンプレートすべてに付与。
    { templateId: fieldStaffTemplate.id, resource: "agent_inquiry", action: "read", granted: true },
    { templateId: officeStaffTemplate.id, resource: "agent_inquiry", action: "read", granted: true },
    { templateId: adminTemplate.id, resource: "agent_inquiry", action: "read", granted: true },
    { templateId: fieldStaffTemplate.id, resource: "agent_inquiry", action: "write", granted: true },
    { templateId: officeStaffTemplate.id, resource: "agent_inquiry", action: "write", granted: true },
    { templateId: adminTemplate.id, resource: "agent_inquiry", action: "write", granted: true },
```
`src/lib/api-helpers.ts` の mock 権限配列(`registry_pdf` download の後)に:
```ts
      // 反響の受付(agent_inquiry)。mock は admin 相当のため付与。
      { resource: "agent_inquiry", action: "read", granted: true },
      { resource: "agent_inquiry", action: "write", granted: true },
```
両権限画面の `RESOURCES` の `audit_log` 行の直後に(2ファイル同文):
```ts
  // 反響の受付(業者からの内見・広告の許可・資料請求)。全員に既定付与。
  // ⚠ もう一方の権限画面の RESOURCES と必ず同内容にすること。
  { key: "agent_inquiry", label: "反響の受付", actions: ["read", "write"] },
```

- [ ] **Step 6: 生成とテスト**

Run: `npx prisma generate && npx vitest run src/lib/__tests__/agent-inquiry-migration-scan.test.ts && npx tsc --noEmit`
Expected: PASS / tsc 0

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/api-helpers.ts "src/app/(dashboard)/admin" src/lib/__tests__/agent-inquiry-migration-scan.test.ts
git commit -m "feat(agent-inquiry): 反響の受付の4表・migration・権限 agent_inquiry を追加"
```

---

### Task 2: 定数・入力検証・業者検索語の振り分け(純関数)

**Files:**
- Create: `src/lib/agent-inquiry/constants.ts`, `src/lib/agent-inquiry/validators.ts`, `src/lib/agent-inquiry/agent-query.ts`
- Test: `src/lib/__tests__/agent-inquiry-validators.test.ts`, `src/lib/__tests__/agent-inquiry-agent-query.test.ts`

**Interfaces:**
- Produces:
  - `INQUIRY_KINDS`, `INQUIRY_CHANNELS`, `INQUIRY_STATUSES`, `VIEWING_TYPES`, `AD_MEDIA`, `AD_VALUES`(readonly tuple)、型 `InquiryKind` `AdMediumKey` `AdValueKey`、`INQUIRY_KIND_LABELS` `AD_MEDIUM_LABELS`
  - `classifyAgentQuery(q: string): { type: "digits"; digits: string } | { type: "text"; text: string } | { type: "none" }`
  - zod: `agentCreateSchema`, `agentUpdateSchema`(`version` 必須・`isArchived` 可)、`inquiryCreateSchema`(`viewing` 任意・用件=内見のときだけ)、`inquiryUpdateSchema`(`version` 必須)、`viewingCreateSchema`, `viewingUpdateSchema`, `adPermissionsPutSchema`
  - `normalizeAgentInput(a)`・`normalizeInquiryContact(c)`(電話類は `formatPhoneJp(x).value`、空文字→null、undefined はキーごと出さない)

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-inquiry-agent-query.test.ts
import { describe, it, expect } from "vitest";
import { classifyAgentQuery } from "@/lib/agent-inquiry/agent-query";

describe("業者検索語の振り分け(設計 §2.2-1)", () => {
  it.each([
    ["0312345", { type: "digits", digits: "0312345" }],
    ["03-1234-5", { type: "digits", digits: "03123455" }],
    ["０９０－１２３４－５", { type: "digits", digits: "090123455" }],
    ["090 1234 5678", { type: "digits", digits: "09012345678" }],
  ])("数字7桁以上 → 数字照合 %s", (q, want) => {
    expect(classifyAgentQuery(q)).toEqual(want);
  });
  it.each([
    ["031234", { type: "text", text: "031234" }],
    ["○○不動産", { type: "text", text: "○○不動産" }],
    ["  新宿  ", { type: "text", text: "新宿" }],
    ["不動産03", { type: "text", text: "不動産03" }],
  ])("それ以外 → 文字検索 %s", (q, want) => {
    expect(classifyAgentQuery(q)).toEqual(want);
  });
  it.each(["", " ", "あ"])("1文字以下は検索しない %j", (q) => {
    expect(classifyAgentQuery(q)).toEqual({ type: "none" });
  });
});
```

```ts
// src/lib/__tests__/agent-inquiry-validators.test.ts
import { describe, it, expect } from "vitest";
import {
  agentCreateSchema, inquiryCreateSchema, inquiryUpdateSchema, adPermissionsPutSchema,
  normalizeAgentInput, normalizeInquiryContact,
} from "@/lib/agent-inquiry/validators";

const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";

describe("業者の入力", () => {
  it("商号と代表電話は必須", () => {
    expect(agentCreateSchema.safeParse({ companyName: "", phone: "0312345678" }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ companyName: "○○不動産", phone: "" }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ companyName: "○○不動産", phone: "0312345678" }).success).toBe(true);
  });
  it("電話はハイフン入りへ・桁不正はそのまま・空の任意欄は null", () => {
    const a = normalizeAgentInput(agentCreateSchema.parse({ companyName: " ○○不動産 ", phone: "0312345678", fax: "", email: "" }));
    expect(a).toMatchObject({ companyName: "○○不動産", phone: "03-1234-5678", fax: null, email: null });
    expect(normalizeAgentInput(agentCreateSchema.parse({ companyName: "x", phone: "0312" })).phone).toBe("0312");
  });
  it("メール形式が不正なら弾く", () => {
    expect(agentCreateSchema.safeParse({ companyName: "x", phone: "0312345678", email: "abc" }).success).toBe(false);
  });
});

describe("反響の入力", () => {
  const base = { propertyId: PID, agentId: AID, kind: "viewing" };
  it("物件と業者と用件は必須・入口の既定は電話", () => {
    expect(inquiryCreateSchema.safeParse({ agentId: AID, kind: "viewing" }).success).toBe(false);
    expect(inquiryCreateSchema.parse(base).channel).toBe("phone");
  });
  it("用件は3つだけ(空室確認は無い)", () => {
    expect(inquiryCreateSchema.safeParse({ ...base, kind: "vacancy" }).success).toBe(false);
    for (const k of ["viewing", "ad_permission", "material_request"]) {
      expect(inquiryCreateSchema.safeParse({ ...base, kind: k }).success).toBe(true);
    }
  });
  it("内見の予定は用件=内見のときだけ受け付ける", () => {
    const v = { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z" };
    expect(inquiryCreateSchema.safeParse({ ...base, viewing: v }).success).toBe(true);
    expect(inquiryCreateSchema.safeParse({ ...base, kind: "ad_permission", viewing: v }).success).toBe(false);
  });
  it("日時の無い内見(日程調整中)も可", () => {
    expect(inquiryCreateSchema.safeParse({ ...base, viewing: { viewingType: "preview" } }).success).toBe(true);
  });
  it("携帯は整形・メールの空は null", () => {
    expect(normalizeInquiryContact({ contactName: " 田中 ", contactMobile: "09012345678", contactEmail: "" }))
      .toEqual({ contactName: "田中", contactMobile: "090-1234-5678", contactEmail: null });
  });
  it("触らない項目はキーごと出さない", () => {
    expect(normalizeInquiryContact({})).toEqual({});
  });
  it("変更は version 必須", () => {
    expect(inquiryUpdateSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(inquiryUpdateSchema.safeParse({ status: "done", version: 1 }).success).toBe(true);
  });
});

describe("広告の可否", () => {
  it("6媒体×ok/ng/ask/null(null=未設定に戻す)", () => {
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: null }] }).success).toBe(true);
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "twitter", value: "ok" }] }).success).toBe(false);
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "maybe" }] }).success).toBe(false);
  });
  it("同じ媒体を2回送れない", () => {
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "ok" }, { medium: "athome", value: "ng" }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/agent-inquiry-validators.test.ts src/lib/__tests__/agent-inquiry-agent-query.test.ts` → FAIL(module not found)

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/constants.ts
/** 反響の受付の値の一覧(設計 2026-09-28 §1)。Prisma enum と同じ並び。 */
export const INQUIRY_KINDS = ["viewing", "ad_permission", "material_request"] as const;
export const INQUIRY_CHANNELS = ["phone", "email", "fax"] as const;
export const INQUIRY_STATUSES = ["open", "in_progress", "done"] as const;
export const VIEWING_TYPES = ["guided", "preview"] as const;
export const AD_MEDIA = ["own_site", "athome", "suumo", "homes", "other_portal", "flyer"] as const;
export const AD_VALUES = ["ok", "ng", "ask"] as const;

export type InquiryKind = (typeof INQUIRY_KINDS)[number];
export type AdMediumKey = (typeof AD_MEDIA)[number];
export type AdValueKey = (typeof AD_VALUES)[number];

export const INQUIRY_KIND_LABELS: Record<InquiryKind, string> = {
  viewing: "内見", ad_permission: "広告の許可", material_request: "資料請求",
};
export const AD_MEDIUM_LABELS: Record<AdMediumKey, string> = {
  own_site: "自社HP", athome: "at home", suumo: "SUUMO", homes: "HOME'S", other_portal: "その他のポータル", flyer: "チラシ",
};
```

```ts
// src/lib/agent-inquiry/agent-query.ts
import { phoneSearchDigits } from "@/lib/phone-format-jp";

export type AgentQuery = { type: "digits"; digits: string } | { type: "text"; text: string } | { type: "none" };

/**
 * 業者検索の1つの欄に打たれた語を振り分ける(設計 §2.2-1)。
 * 数字と区切りだけで7桁以上 → 代表電話・過去の問い合わせ者の携帯を数字だけで照合。
 * それ以外 → 商号・ふりがな・支店の部分一致。2文字未満は検索しない。
 */
export function classifyAgentQuery(q: string): AgentQuery {
  const digits = phoneSearchDigits(q);
  if (digits) return { type: "digits", digits };
  const text = q.normalize("NFKC").trim();
  if ([...text].length < 2) return { type: "none" };
  return { type: "text", text };
}
```

```ts
// src/lib/agent-inquiry/validators.ts
import { z } from "zod";
import { formatPhoneJp } from "@/lib/phone-format-jp";
import { AD_MEDIA, AD_VALUES, INQUIRY_CHANNELS, INQUIRY_KINDS, INQUIRY_STATUSES, VIEWING_TYPES } from "./constants";

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
const optEmail = z.union([z.literal(""), z.string().trim().email().max(254)]).optional().nullable();

export const agentCreateSchema = z.object({
  companyName: z.string().trim().min(1, "商号を入れてください").max(100),
  companyKana: optText(100),
  branchName: optText(100),
  licenseNo: optText(60),
  phone: z.string().trim().min(1, "代表電話を入れてください").max(30),
  fax: optText(30),
  email: optEmail,
  address: optText(200),
  note: optText(2000),
});
export const agentUpdateSchema = agentCreateSchema.partial().extend({
  isArchived: z.boolean().optional(),
  version: z.number().int().positive(),
});

export const viewingCreateSchema = z.object({
  scheduledAt: z.string().datetime().optional().nullable(),
  viewingType: z.enum(VIEWING_TYPES),
  attendantId: uuid.optional().nullable(),
});
export const viewingUpdateSchema = z.object({
  scheduledAt: z.string().datetime().optional().nullable(),
  viewingType: z.enum(VIEWING_TYPES).optional(),
  attendantId: uuid.optional().nullable(),
  resultNote: optText(2000),
  canceled: z.boolean().optional(),
});

const contactFields = {
  contactName: optText(60),
  contactMobile: optText(30),
  contactEmail: optEmail,
};

export const inquiryCreateSchema = z
  .object({
    propertyId: uuid,
    agentId: uuid,
    ...contactFields,
    kind: z.enum(INQUIRY_KINDS),
    channel: z.enum(INQUIRY_CHANNELS).default("phone"),
    note: optText(10000),
    viewing: viewingCreateSchema.optional(),
  })
  .refine((v) => !v.viewing || v.kind === "viewing", { message: "内見の予定は用件が内見のときだけ入れられます", path: ["viewing"] });

export const inquiryUpdateSchema = z.object({
  ...contactFields,
  status: z.enum(INQUIRY_STATUSES).optional(),
  assigneeId: uuid.optional().nullable(),
  note: optText(10000),
  version: z.number().int().positive(),
});

export const adPermissionsPutSchema = z
  .object({ items: z.array(z.object({ medium: z.enum(AD_MEDIA), value: z.enum(AD_VALUES).nullable() })).min(1).max(AD_MEDIA.length) })
  .refine((v) => new Set(v.items.map((i) => i.medium)).size === v.items.length, { message: "同じ媒体が2回あります", path: ["items"] });

const blankToNull = (s: string | null | undefined): string | null | undefined => {
  if (s === undefined) return undefined;
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const phoneOrNull = (s: string | null | undefined) => {
  const v = blankToNull(s);
  return v == null ? v : formatPhoneJp(v).value;
};
/** undefined のキーは出さない(PATCH で触っていない列を null にしない)。 */
function pick<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function normalizeAgentInput(a: Partial<z.infer<typeof agentCreateSchema>> & { isArchived?: boolean }) {
  return pick({
    companyName: a.companyName?.trim(),
    companyKana: blankToNull(a.companyKana),
    branchName: blankToNull(a.branchName),
    licenseNo: blankToNull(a.licenseNo),
    phone: a.phone === undefined ? undefined : formatPhoneJp(a.phone).value,
    fax: phoneOrNull(a.fax),
    email: blankToNull(a.email),
    address: blankToNull(a.address),
    note: blankToNull(a.note),
    isArchived: a.isArchived,
  });
}

export function normalizeInquiryContact(c: { contactName?: string | null; contactMobile?: string | null; contactEmail?: string | null }) {
  return pick({
    contactName: blankToNull(c.contactName),
    contactMobile: phoneOrNull(c.contactMobile),
    contactEmail: blankToNull(c.contactEmail),
  });
}
```

- [ ] **Step 4: 通過を確認** — 同じコマンドで PASS
- [ ] **Step 5: Commit** — `git add src/lib/agent-inquiry src/lib/__tests__/agent-inquiry-validators.test.ts src/lib/__tests__/agent-inquiry-agent-query.test.ts && git commit -m "feat(agent-inquiry): 入力検証と業者検索語の振り分け"`

---

### Task 3: 物件の許可リスト整形・時系列・監査 detail・JST 範囲(純関数)

**Files:**
- Create: `src/lib/agent-inquiry/desk-property.ts`, `src/lib/agent-inquiry/inquiry-view.ts`, `src/lib/agent-inquiry/timeline.ts`, `src/lib/agent-inquiry/audit-detail.ts`, `src/lib/agent-inquiry/jst-range.ts`
- Test: `src/lib/__tests__/agent-inquiry-desk-property.test.ts`, `src/lib/__tests__/agent-inquiry-timeline.test.ts`, `src/lib/__tests__/agent-inquiry-audit-detail.test.ts`, `src/lib/__tests__/agent-inquiry-jst-range.test.ts`

**Interfaces:**
- Produces:
  - `townOnly(address: string): string`
  - `DESK_PROPERTY_SELECT`、`DeskProperty = { id: string; name: string; roomNo: string | null; town: string; propertyType: string; adPermissions: Partial<Record<AdMediumKey, AdValueKey>> }`、`DESK_PROPERTY_KEYS`、`toDeskProperty(row): DeskProperty`
  - `INQUIRY_LIST_SELECT`、`toInquiryView(row)`(`property` を必ず `toDeskProperty` に通す)
  - `buildPropertyTimeline(inquiries: TimelineInquiry[]): TimelineEntry[]`、`countInquiries(inquiries): { total; guided; preview; materialRequest; adPermission }`
  - `inquiryAuditDetail(changed: string[], extra?: { status?: string; kind?: string }): Record<string, unknown>`
  - `todayTomorrowJst(now: Date): { from: Date; to: Date }`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-inquiry-desk-property.test.ts
import { describe, it, expect } from "vitest";
import { townOnly, toDeskProperty, DESK_PROPERTY_KEYS, DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";
import { toInquiryView } from "@/lib/agent-inquiry/inquiry-view";

describe("町名までに切り落とす(設計 §4)", () => {
  it.each([
    ["東京都中野区中野2丁目3-4", "東京都中野区中野2丁目"],
    ["東京都中野区中野二丁目3番4号", "東京都中野区中野二丁目"],
    ["東京都中野区本町３－１－２", "東京都中野区本町"],
    ["東京都青梅市今寺123番地", "東京都青梅市今寺"],
    ["東京都青梅市今寺", "東京都青梅市今寺"],
    ["", ""],
  ])("%s → %s", (a, want) => expect(townOnly(a)).toBe(want));
});

describe("受付の窓に返す物件は許可リストだけ", () => {
  const row = {
    id: "p1", propertyType: "apartment_unit", buildingName: null, roomNo: "305",
    address: "東京都中野区中野2丁目3-4",
    building: { name: "サンライズ中野" },
    adPermissions: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: "ng" }],
  };
  it("棟名を物件名に・町名まで・広告の可否を媒体→値に", () => {
    expect(toDeskProperty(row)).toEqual({
      id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目",
      propertyType: "apartment_unit", adPermissions: { athome: "ok", flyer: "ng" },
    });
  });
  it("物件名も棟名も無い(戸建・土地)は町名を名前にする", () => {
    expect(toDeskProperty({ ...row, building: null, roomNo: null }).name).toBe("東京都中野区中野2丁目");
  });
  it("余計な列が混ざっても返さない(キー集合が完全一致)", () => {
    const out = toDeskProperty({ ...row, salePrice: 1, lotNumber: "1-2", note: "x", owners: [{ name: "所有者" }] } as never);
    expect(Object.keys(out).sort()).toEqual([...DESK_PROPERTY_KEYS].sort());
  });
  it("DB から読む列も許可リストに必要なものだけ", () => {
    expect(Object.keys(DESK_PROPERTY_SELECT).sort()).toEqual(["address", "adPermissions", "building", "buildingName", "id", "propertyType", "roomNo"].sort());
  });
  it("反響の形でも物件は許可リストだけ", () => {
    const v = toInquiryView({ id: "i", property: { ...row, salePrice: 9, createdBy: "u" } } as never);
    expect(Object.keys(v.property).sort()).toEqual([...DESK_PROPERTY_KEYS].sort());
  });
});
```

```ts
// src/lib/__tests__/agent-inquiry-timeline.test.ts
import { describe, it, expect } from "vitest";
import { buildPropertyTimeline, countInquiries } from "@/lib/agent-inquiry/timeline";

const d = (s: string) => new Date(s);
const inq = (over: Record<string, unknown>) => ({
  id: "i", kind: "viewing", receivedAt: d("2026-09-20T00:00:00Z"), status: "open",
  agent: { companyName: "○○不動産" }, contactName: "田中", viewings: [], ...over,
}) as never;

describe("物件の時系列(新しい順)", () => {
  it("内見は予定日時で1行ずつ・それ以外は受けた日時・取り消しは印付き・日程未定は受けた日時", () => {
    const t = buildPropertyTimeline([
      inq({ id: "a", kind: "ad_permission", receivedAt: d("2026-09-20T00:40:00Z") }),
      inq({ id: "v", receivedAt: d("2026-09-21T00:00:00Z"), viewings: [
        { id: "v1", scheduledAt: d("2026-10-02T05:00:00Z"), viewingType: "guided", canceledAt: null, attendant: { name: "佐藤" }, resultNote: null },
        { id: "v2", scheduledAt: d("2026-09-25T06:30:00Z"), viewingType: "preview", canceledAt: d("2026-09-24T00:00:00Z"), attendant: null, resultNote: null },
        { id: "v3", scheduledAt: null, viewingType: "guided", canceledAt: null, attendant: null, resultNote: null },
      ] }),
    ]);
    expect(t.map((e) => [e.key, e.at.toISOString(), e.canceled])).toEqual([
      ["viewing:v1", "2026-10-02T05:00:00.000Z", false],
      ["viewing:v2", "2026-09-25T06:30:00.000Z", true],
      ["viewing:v3", "2026-09-21T00:00:00.000Z", false],
      ["inquiry:a", "2026-09-20T00:40:00.000Z", false],
    ]);
    expect(t[2].unscheduled).toBe(true);
    expect(t[0].attendantName).toBe("佐藤");
  });
  it("内見の予定が無い内見の反響は反響として1行", () => {
    expect(buildPropertyTimeline([inq({ id: "x" })]).map((e) => e.key)).toEqual(["inquiry:x"]);
  });
});

describe("件数", () => {
  it("案内/下見は取り消しを数えない", () => {
    const c = countInquiries([
      inq({ viewings: [
        { id: "1", scheduledAt: null, viewingType: "guided", canceledAt: null },
        { id: "2", scheduledAt: null, viewingType: "preview", canceledAt: null },
        { id: "3", scheduledAt: null, viewingType: "guided", canceledAt: d("2026-09-01T00:00:00Z") },
      ] }),
      inq({ kind: "material_request" }),
      inq({ kind: "ad_permission" }),
    ]);
    expect(c).toEqual({ total: 3, guided: 1, preview: 1, materialRequest: 1, adPermission: 1 });
  });
});
```

```ts
// src/lib/__tests__/agent-inquiry-audit-detail.test.ts
import { describe, it, expect } from "vitest";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";

describe("監査 detail は項目名と状態の値だけ(設計 §4)", () => {
  it("許可された項目名だけ残す・値は入れない", () => {
    expect(inquiryAuditDetail(["status", "contactMobile", "note", "evil<script>"], { status: "done" }))
      .toEqual({ changed: ["contactMobile", "note", "status"], status: "done" });
  });
  it("状態・用件の値も列挙値以外は落とす", () => {
    expect(inquiryAuditDetail([], { status: "090-1234-5678", kind: "viewing" })).toEqual({ changed: [], kind: "viewing" });
  });
});
```

```ts
// src/lib/__tests__/agent-inquiry-jst-range.test.ts
import { describe, it, expect } from "vitest";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";

describe("今日・明日(JST)", () => {
  it.each([
    ["2026-09-30T14:59:59Z", "2026-09-29T15:00:00.000Z", "2026-10-01T15:00:00.000Z"],
    ["2026-09-30T15:00:00Z", "2026-09-30T15:00:00.000Z", "2026-10-02T15:00:00.000Z"],
  ])("%s", (now, from, to) => {
    const r = todayTomorrowJst(new Date(now));
    expect([r.from.toISOString(), r.to.toISOString()]).toEqual([from, to]);
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/agent-inquiry-desk-property.test.ts src/lib/__tests__/agent-inquiry-timeline.test.ts src/lib/__tests__/agent-inquiry-audit-detail.test.ts src/lib/__tests__/agent-inquiry-jst-range.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/desk-property.ts
import { AD_MEDIA, type AdMediumKey, type AdValueKey } from "./constants";

/**
 * 所在地を町名(丁目)までにする(設計 §4=受付の窓では番地以降を見せない)。
 * 「丁目」があればそこまで。無ければ最初の数字か「〇番」の手前まで。
 */
export function townOnly(address: string): string {
  const a = address.normalize("NFKC").trim();
  const chome = a.match(/^(.*?丁目)/);
  if (chome) return chome[1];
  const cut = a.search(/[0-9]|[一二三四五六七八九十百]+番/);
  return (cut === -1 ? a : a.slice(0, cut)).trim();
}

/** DB から読む列=許可リストに必要なものだけ。 */
export const DESK_PROPERTY_SELECT = {
  id: true,
  propertyType: true,
  buildingName: true,
  roomNo: true,
  address: true,
  building: { select: { name: true } },
  adPermissions: { select: { medium: true, value: true } },
} as const;

export interface DeskProperty {
  id: string;
  name: string;
  roomNo: string | null;
  town: string;
  propertyType: string;
  adPermissions: Partial<Record<AdMediumKey, AdValueKey>>;
}
export const DESK_PROPERTY_KEYS = ["id", "name", "roomNo", "town", "propertyType", "adPermissions"] as const;

export interface DeskPropertyRow {
  id: string;
  propertyType: string;
  buildingName: string | null;
  roomNo: string | null;
  address: string;
  building: { name: string } | null;
  adPermissions: { medium: string; value: string }[];
}

/** 受付の窓に返す形(許可リストで組み立てる=行に何が混ざっていても外へ出さない)。 */
export function toDeskProperty(row: DeskPropertyRow): DeskProperty {
  const town = townOnly(row.address ?? "");
  const ads: Partial<Record<AdMediumKey, AdValueKey>> = {};
  for (const p of row.adPermissions ?? []) {
    if ((AD_MEDIA as readonly string[]).includes(p.medium)) ads[p.medium as AdMediumKey] = p.value as AdValueKey;
  }
  return {
    id: row.id,
    name: row.building?.name || row.buildingName || town,
    roomNo: row.roomNo ?? null,
    town,
    propertyType: row.propertyType,
    adPermissions: ads,
  };
}
```

```ts
// src/lib/agent-inquiry/inquiry-view.ts
import { DESK_PROPERTY_SELECT, toDeskProperty, type DeskPropertyRow } from "./desk-property";

/** 一覧・詳細で読む列。物件は許可リスト用の列だけ。 */
export const INQUIRY_LIST_SELECT = {
  id: true, kind: true, status: true, channel: true, receivedAt: true, version: true,
  contactName: true, contactMobile: true, contactEmail: true, note: true,
  assignee: { select: { id: true, name: true } },
  agent: { select: { id: true, companyName: true, branchName: true, phone: true } },
  viewings: {
    orderBy: { scheduledAt: "asc" as const },
    select: {
      id: true, scheduledAt: true, viewingType: true, canceledAt: true, resultNote: true,
      attendant: { select: { id: true, name: true } },
    },
  },
  property: { select: DESK_PROPERTY_SELECT },
} as const;

/** 反響を画面に返す形。物件は必ず許可リスト(toDeskProperty)を通す。 */
export function toInquiryView<T extends { property: DeskPropertyRow }>(row: T) {
  const { property, ...rest } = row;
  return { ...rest, property: toDeskProperty(property) };
}
```

```ts
// src/lib/agent-inquiry/timeline.ts
export interface TimelineViewing {
  id: string;
  scheduledAt: Date | null;
  viewingType: "guided" | "preview";
  canceledAt: Date | null;
  attendant?: { name: string } | null;
  resultNote?: string | null;
}
export interface TimelineInquiry {
  id: string;
  kind: "viewing" | "ad_permission" | "material_request";
  receivedAt: Date;
  status: string;
  agent: { companyName: string };
  contactName: string | null;
  viewings: TimelineViewing[];
}
export interface TimelineEntry {
  key: string;
  at: Date;
  inquiryId: string;
  kind: TimelineInquiry["kind"];
  viewingType: TimelineViewing["viewingType"] | null;
  agentName: string;
  contactName: string | null;
  attendantName: string | null;
  resultNote: string | null;
  canceled: boolean;
  unscheduled: boolean;
}

/** 物件の時系列(設計 §2.3)。内見は予定1件=1行・予定日時で。その他と予定の無い内見の反響は受けた日時で。新しい順。 */
export function buildPropertyTimeline(inquiries: TimelineInquiry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const q of inquiries) {
    const base = { inquiryId: q.id, kind: q.kind, agentName: q.agent.companyName, contactName: q.contactName };
    if (q.kind === "viewing" && q.viewings.length > 0) {
      for (const v of q.viewings) {
        out.push({
          ...base,
          key: `viewing:${v.id}`,
          at: v.scheduledAt ?? q.receivedAt,
          viewingType: v.viewingType,
          attendantName: v.attendant?.name ?? null,
          resultNote: v.resultNote ?? null,
          canceled: v.canceledAt != null,
          unscheduled: v.scheduledAt == null,
        });
      }
    } else {
      out.push({ ...base, key: `inquiry:${q.id}`, at: q.receivedAt, viewingType: null, attendantName: null, resultNote: null, canceled: false, unscheduled: false });
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key));
}

/** 件数(案内/下見は取り消しを除く)。 */
export function countInquiries(inquiries: Pick<TimelineInquiry, "kind" | "viewings">[]) {
  let guided = 0, preview = 0, materialRequest = 0, adPermission = 0;
  for (const q of inquiries) {
    if (q.kind === "material_request") materialRequest++;
    if (q.kind === "ad_permission") adPermission++;
    for (const v of q.viewings) {
      if (v.canceledAt) continue;
      if (v.viewingType === "guided") guided++; else preview++;
    }
  }
  return { total: inquiries.length, guided, preview, materialRequest, adPermission };
}
```

```ts
// src/lib/agent-inquiry/audit-detail.ts
import { INQUIRY_KINDS, INQUIRY_STATUSES } from "./constants";

/** 監査に書いてよい項目名(値は書かない)。設計 §4・許可リスト方式。 */
const FIELD_NAMES = new Set([
  "propertyId", "agentId", "contactName", "contactMobile", "contactEmail", "kind", "channel", "status", "assigneeId", "note",
  "companyName", "companyKana", "branchName", "licenseNo", "phone", "fax", "email", "address", "isArchived",
  "scheduledAt", "viewingType", "attendantId", "resultNote", "canceled", "adPermissions",
]);

export function inquiryAuditDetail(changed: string[], extra: { status?: string; kind?: string } = {}) {
  const out: Record<string, unknown> = { changed: changed.filter((f) => FIELD_NAMES.has(f)).sort() };
  if (extra.status && (INQUIRY_STATUSES as readonly string[]).includes(extra.status)) out.status = extra.status;
  if (extra.kind && (INQUIRY_KINDS as readonly string[]).includes(extra.kind)) out.kind = extra.kind;
  return out;
}
```

```ts
// src/lib/agent-inquiry/jst-range.ts
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** JST の「今日 0:00」〜「明後日 0:00」(=今日と明日)を UTC の Date で返す。 */
export function todayTomorrowJst(now: Date) {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const startJstAsUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  const from = new Date(startJstAsUtc - JST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 2 * 24 * 60 * 60 * 1000) };
}
```

- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 物件の許可リスト整形・時系列・監査 detail・JST 範囲"`

---

### Task 4: 権限ガード・業者 API

**Files:**
- Create: `src/lib/agent-inquiry/guard.ts`, `src/lib/agent-inquiry/agent-search.ts`, `src/app/api/agents/route.ts`, `src/app/api/agents/[id]/route.ts`
- Test: `src/lib/__tests__/agent-inquiry-agents-route.test.ts`

**Interfaces:**
- Consumes: Task 2 `agentCreateSchema` `agentUpdateSchema` `normalizeAgentInput` `classifyAgentQuery`、Task 3 `inquiryAuditDetail` `DESK_PROPERTY_SELECT` `toDeskProperty`
- Produces:
  - `requireAgentInquiry(action: "read" | "write"): Promise<{ session: ApiSession; perms: PermissionEntry[] }>`、`VERSION_CONFLICT_MESSAGE`
  - `searchAgents(q: string): Promise<AgentHit[]>` — `AgentHit = { id; companyName; branchName: string | null; phone; lastContact: { name; mobile; email } | null; matchedBy: "phone" | "mobile" | "text" }`(上限20・しまった業者は除外)
  - `GET /api/agents?q=` → `{ agents: AgentHit[] }` / `POST /api/agents` → 201 `{ id }` / `GET /api/agents/[id]` → `{ agent, inquiries }` / `PATCH /api/agents/[id]` → `{ version }`

- [ ] **Step 1: 失敗するテスト**

```ts
// src/lib/__tests__/agent-inquiry-agents-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => JSON.parse(await r.text())),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError
      ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
      : (e as { name?: string })?.name === "ZodError" ? Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 })
      : Response.json({ error: { code: "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: 500 })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agent: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "a-new" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    agentInquiry: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as SEARCH, POST } from "../../app/api/agents/route";
import { PATCH } from "../../app/api/agents/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { agent: { findMany: Fn; findUnique: Fn; create: Fn; updateMany: Fn }; $queryRaw: Fn };
const AID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: AID }) };
const grant = (...actions: string[]) =>
  (getUserPermissions as Fn).mockResolvedValue(actions.map((a) => ({ resource: "agent_inquiry", action: a, granted: true })));
const json = (method: string, body: unknown) =>
  new Request("http://x/api/agents", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
  grant("read", "write");
});

describe("業者 API", () => {
  it("権限が無ければ 403", async () => {
    grant();
    expect((await SEARCH(new Request("http://x/api/agents?q=" + encodeURIComponent("不動産")))).status).toBe(403);
    grant("read");
    expect((await POST(json("POST", { companyName: "x", phone: "0312345678" }))).status).toBe(403);
  });
  it("現地スタッフも登録できる・電話はハイフン入りで保存・登録者を記録", async () => {
    const res = await POST(json("POST", { companyName: " △△住宅 ", phone: "0398765432" }));
    expect(res.status).toBe(201);
    expect(pm.agent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyName: "△△住宅", phone: "03-9876-5432", createdById: "u1" }),
    }));
  });
  it("監査に電話・メール・メモの値を書かない", async () => {
    await POST(json("POST", { companyName: "x", phone: "0398765432", email: "a@b.jp", note: "秘密のメモ" }));
    const s = JSON.stringify((writeAuditLog as Fn).mock.calls);
    expect(s).not.toMatch(/03-9876-5432|0398765432|a@b\.jp|秘密のメモ/);
    expect(s).toContain("agent_create");
  });
  it("7桁以上の数字は数字照合(代表電話+反響の携帯)に回す", async () => {
    await SEARCH(new Request("http://x/api/agents?q=090-1234-5"));
    expect(pm.$queryRaw).toHaveBeenCalledTimes(1);
    expect(pm.agent.findMany).not.toHaveBeenCalled();
  });
  it("文字は商号・ふりがな・支店の部分一致・しまった業者を除く・20件まで", async () => {
    await SEARCH(new Request("http://x/api/agents?q=" + encodeURIComponent("不動産")));
    expect(pm.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isArchived: false, OR: [
        { companyName: { contains: "不動産", mode: "insensitive" } },
        { companyKana: { contains: "不動産", mode: "insensitive" } },
        { branchName: { contains: "不動産", mode: "insensitive" } },
      ] },
      take: 20,
    }));
  });
  it("同じ業者が代表電話と携帯の両方で当たったら携帯側(問い合わせ者つき)を残す", async () => {
    pm.$queryRaw.mockResolvedValueOnce([
      { id: AID, company_name: "○○", branch_name: null, phone: "03-1", c_name: null, c_mobile: null, c_email: null, matched_by: "phone" },
      { id: AID, company_name: "○○", branch_name: null, phone: "03-1", c_name: "田中", c_mobile: "090-1234-5678", c_email: "t@x.jp", matched_by: "mobile" },
    ]);
    const body = await (await SEARCH(new Request("http://x/api/agents?q=09012345678"))).json();
    expect(body.agents).toEqual([{ id: AID, companyName: "○○", branchName: null, phone: "03-1", matchedBy: "mobile",
      lastContact: { name: "田中", mobile: "090-1234-5678", email: "t@x.jp" } }]);
  });
  it("古い版からの変更は 409 VERSION_CONFLICT", async () => {
    pm.agent.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID });
    const res = await PATCH(json("PATCH", { companyName: "y", version: 2 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
  });
  it("存在しない業者の変更は 404", async () => {
    pm.agent.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agent.findUnique.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { companyName: "y", version: 1 }), ctx)).status).toBe(404);
  });
  it("触っていない列は更新しない(PATCH で null にしない)", async () => {
    await PATCH(json("PATCH", { isArchived: true, version: 1 }), ctx);
    expect(pm.agent.updateMany).toHaveBeenCalledWith({ where: { id: AID, version: 1 }, data: { isArchived: true, version: { increment: 1 } } });
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run src/lib/__tests__/agent-inquiry-agents-route.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/guard.ts
import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/** 反響の受付の権限(設計 §4)。全員に既定付与・個別に外せる。 */
export async function requireAgentInquiry(action: "read" | "write") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "agent_inquiry", action)) {
    throw new ApiError(403, "反響の受付の権限がありません", "FORBIDDEN");
  }
  return { session, perms };
}

export const VERSION_CONFLICT_MESSAGE = "他のユーザーが先に更新しています。画面を再読み込みしてください。";
```

```ts
// src/lib/agent-inquiry/agent-search.ts
import prisma from "@/lib/prisma";
import { classifyAgentQuery } from "./agent-query";

const LIMIT = 20;
export interface AgentHit {
  id: string;
  companyName: string;
  branchName: string | null;
  phone: string;
  lastContact: { name: string | null; mobile: string | null; email: string | null } | null;
  matchedBy: "phone" | "mobile" | "text";
}

type Row = {
  id: string; company_name: string; branch_name: string | null; phone: string;
  c_name: string | null; c_mobile: string | null; c_email: string | null; matched_by: "phone" | "mobile";
};

/**
 * 業者検索(設計 §2.2-1)。数字=代表電話と過去の反響の携帯を数字だけで照合(regexp_replace は
 * index が効かない=7桁以上のときだけ・件数上限の前にしまった業者を外す)。携帯で当たったら
 * その業者の最新の反響の問い合わせ者を返す(フォームを埋めるため)。文字=商号・ふりがな・支店。
 */
export async function searchAgents(q: string): Promise<AgentHit[]> {
  const cq = classifyAgentQuery(q);
  if (cq.type === "none") return [];
  if (cq.type === "text") {
    const rows = await prisma.agent.findMany({
      where: { isArchived: false, OR: [
        { companyName: { contains: cq.text, mode: "insensitive" } },
        { companyKana: { contains: cq.text, mode: "insensitive" } },
        { branchName: { contains: cq.text, mode: "insensitive" } },
      ] },
      select: { id: true, companyName: true, branchName: true, phone: true },
      orderBy: { companyName: "asc" },
      take: LIMIT,
    });
    return rows.map((r) => ({ ...r, lastContact: null, matchedBy: "text" as const }));
  }
  const like = `%${cq.digits}%`;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT * FROM (
      SELECT a.id, a.company_name, a.branch_name, a.phone,
             NULL::text AS c_name, NULL::text AS c_mobile, NULL::text AS c_email, 'phone' AS matched_by
      FROM "agents" a
      WHERE a.is_archived = false
        AND regexp_replace(a.phone, '[^0-9]', '', 'g') LIKE ${like}
      LIMIT ${LIMIT}
    ) p
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (a.id) a.id, a.company_name, a.branch_name, a.phone,
             i.contact_name AS c_name, i.contact_mobile AS c_mobile, i.contact_email AS c_email, 'mobile' AS matched_by
      FROM "agent_inquiries" i JOIN "agents" a ON a.id = i.agent_id
      WHERE a.is_archived = false
        AND regexp_replace(coalesce(i.contact_mobile, ''), '[^0-9]', '', 'g') LIKE ${like}
      ORDER BY a.id, i.received_at DESC
      LIMIT ${LIMIT}
    ) m
  `;
  const byId = new Map<string, AgentHit>();
  for (const r of rows) {
    const hit: AgentHit = {
      id: r.id, companyName: r.company_name, branchName: r.branch_name, phone: r.phone,
      lastContact: r.matched_by === "mobile" ? { name: r.c_name, mobile: r.c_mobile, email: r.c_email } : null,
      matchedBy: r.matched_by,
    };
    const prev = byId.get(r.id);
    if (!prev || (prev.matchedBy === "phone" && hit.matchedBy === "mobile")) byId.set(r.id, hit);
  }
  return [...byId.values()].slice(0, LIMIT);
}
```

```ts
// src/app/api/agents/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { searchAgents } from "@/lib/agent-inquiry/agent-search";
import { agentCreateSchema, normalizeAgentInput } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";

const NO_STORE = { "Cache-Control": "no-store" };

/** 業者の検索(設計 §3)。 */
export async function GET(request: Request) {
  try {
    await requireAgentInquiry("read");
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ agents: await searchAgents(q) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 業者の新規登録(反響を登録する人がその場で・設計 方針7)。 */
export async function POST(request: Request) {
  try {
    const { session } = await requireAgentInquiry("write");
    const input = normalizeAgentInput(agentCreateSchema.parse(await parseJsonBody(request)));
    const row = await prisma.agent.create({
      data: { ...input, companyName: input.companyName!, phone: input.phone!, createdById: session.id },
      select: { id: true },
    });
    await writeAuditLog({ userId: session.id, action: "agent_create", targetTable: "agents", targetId: row.id, detail: inquiryAuditDetail(Object.keys(input)) });
    return NextResponse.json({ id: row.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/agents/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry, VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { agentUpdateSchema, normalizeAgentInput } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

/** 業者の詳細+その業者からの反響(新しい順・物件は許可リストの形)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireAgentInquiry("read");
    const id = await idOf(ctx);
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new ApiError(404, "業者が見つかりません", "NOT_FOUND");
    const inquiries = await prisma.agentInquiry.findMany({
      where: { agentId: id },
      orderBy: { receivedAt: "desc" },
      take: 200,
      select: { id: true, kind: true, status: true, receivedAt: true, contactName: true, property: { select: DESK_PROPERTY_SELECT } },
    });
    return NextResponse.json(
      { agent, inquiries: inquiries.map(({ property, ...q }) => ({ ...q, property: toDeskProperty(property) })) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 業者の編集・しまう(version で 409)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const { version, ...rest } = agentUpdateSchema.parse(await parseJsonBody(request));
    const data = normalizeAgentInput(rest);
    const res = await prisma.agent.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) {
      const cur = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
      if (!cur) throw new ApiError(404, "業者が見つかりません", "NOT_FOUND");
      throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    await writeAuditLog({
      userId: session.id,
      action: rest.isArchived === true ? "agent_archive" : "agent_update",
      targetTable: "agents", targetId: id, detail: inquiryAuditDetail(Object.keys(data)),
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 通過を確認** → PASS。`npx tsc --noEmit` = 0
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 業者の名簿 API(検索・登録・編集・しまう)"`

---

### Task 5: 反響 API(登録・一覧・詳細・変更・件数・今日明日の内見)

**Files:**
- Create: `src/app/api/agent-inquiries/route.ts`, `src/app/api/agent-inquiries/[id]/route.ts`, `src/app/api/agent-inquiries/counts/route.ts`, `src/app/api/agent-inquiries/upcoming/route.ts`, `src/lib/agent-inquiry/user-check.ts`
- Test: `src/lib/__tests__/agent-inquiry-inquiries-route.test.ts`

**Interfaces:**
- Consumes: Task 2 `inquiryCreateSchema` `inquiryUpdateSchema` `normalizeInquiryContact`、Task 3 `INQUIRY_LIST_SELECT` `toInquiryView` `DESK_PROPERTY_SELECT` `toDeskProperty` `inquiryAuditDetail` `todayTomorrowJst`、Task 4 `requireAgentInquiry` `VERSION_CONFLICT_MESSAGE`
- Produces:
  - `assertActiveUser(userId: string | null | undefined, code: string): Promise<void>`(null/undefined は何もしない・無効/不在は 422)
  - `POST /api/agent-inquiries` → 201 `{ id }` / `GET /api/agent-inquiries?status=&assignee=<uuid|me>&cursor=` → `{ items, nextCursor }` / `GET /api/agent-inquiries/[id]` → `{ inquiry, canOpenProperty }` / `PATCH /api/agent-inquiries/[id]` → `{ version }` / `GET /api/agent-inquiries/counts` → `{ open, upcomingViewings }` / `GET /api/agent-inquiries/upcoming` → `{ viewings }`

- [ ] **Step 1: 失敗するテスト**(Task 4 と同じ mock 雛形。prisma mock は下の形)

```ts
// src/lib/__tests__/agent-inquiry-inquiries-route.test.ts (先頭の vi.mock 3つは Task 4 と同一)
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: { create: vi.fn(), findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })), count: vi.fn(async () => 0) },
    agentViewing: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    agent: { findUnique: vi.fn(async () => null) },
    property: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as LIST, POST } from "../../app/api/agent-inquiries/route";
import { GET as GET_ONE, PATCH } from "../../app/api/agent-inquiries/[id]/route";
import { GET as COUNTS } from "../../app/api/agent-inquiries/counts/route";
import { GET as UPCOMING } from "../../app/api/agent-inquiries/upcoming/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { create: Fn; findMany: Fn; findUnique: Fn; updateMany: Fn; count: Fn };
  agentViewing: { count: Fn; findMany: Fn }; agent: { findUnique: Fn }; property: { findUnique: Fn }; user: { findUnique: Fn };
};
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";
const IID = "44444444-4444-4444-8444-444444444444";
const UID = "66666666-6666-4666-8666-666666666666";
const ctx = { params: Promise.resolve({ id: IID }) };
const json = (method: string, body: unknown) =>
  new Request("http://x/api/agent-inquiries", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const deskRow = { id: PID, propertyType: "land", buildingName: null, roomNo: null, address: "東京都中野区中野2丁目3", building: null, adPermissions: [] };
const DESK_KEYS = ["adPermissions", "id", "name", "propertyType", "roomNo", "town"];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue([
    { resource: "agent_inquiry", action: "read", granted: true }, { resource: "agent_inquiry", action: "write", granted: true }]);
  pm.property.findUnique.mockResolvedValue({ id: PID });
  pm.agent.findUnique.mockResolvedValue({ id: AID, isArchived: false });
  pm.agentInquiry.create.mockResolvedValue({ id: IID });
});

describe("反響 API", () => {
  it("現地スタッフが担当外の物件にも登録できる・担当=登録者・状態=未対応・内見も同時に", async () => {
    const res = await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing", contactMobile: "09012345678",
      viewing: { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z" } }));
    expect(res.status).toBe(201);
    expect(pm.property.findUnique).toHaveBeenCalledWith({ where: { id: PID }, select: { id: true } });
    expect(pm.agentInquiry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      propertyId: PID, agentId: AID, assigneeId: "u-field", createdById: "u-field", status: "open", contactMobile: "090-1234-5678",
      viewings: { create: [expect.objectContaining({ viewingType: "guided", scheduledAt: new Date("2026-10-02T05:00:00.000Z") })] },
    }) }));
  });
  it("存在しない物件は 404・しまった業者は 409", async () => {
    pm.property.findUnique.mockResolvedValueOnce(null);
    expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing" }))).status).toBe(404);
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, isArchived: true });
    expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing" }))).status).toBe(409);
  });
  it("立ち会いに無効な利用者は 422", async () => {
    pm.user.findUnique.mockResolvedValueOnce({ isActive: false });
    const res = await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing", viewing: { viewingType: "guided", attendantId: UID } }));
    expect(res.status).toBe(422);
  });
  it("監査に携帯・メール・メモの値を書かない", async () => {
    await POST(json("POST", { propertyId: PID, agentId: AID, kind: "material_request", contactMobile: "09012345678", contactEmail: "t@x.jp", note: "本文ABC" }));
    const s = JSON.stringify((writeAuditLog as Fn).mock.calls);
    expect(s).not.toMatch(/090-?1234-?5678|t@x\.jp|本文ABC/);
    expect(s).toContain("agent_inquiry_create");
  });
  it("一覧の物件は許可リストのキーだけ", async () => {
    pm.agentInquiry.findMany.mockResolvedValue([{ id: IID, kind: "viewing", status: "open", viewings: [], property: { ...deskRow, salePrice: 1, lotNumber: "9" } }]);
    const body = await (await LIST(new Request("http://x/api/agent-inquiries?status=open"))).json();
    expect(Object.keys(body.items[0].property).sort()).toEqual(DESK_KEYS);
    expect(JSON.stringify(body)).not.toMatch(/lotNumber|salePrice/);
    expect(pm.agentInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "open" }, take: 51 }));
  });
  it("assignee=me は自分の id で絞る", async () => {
    await LIST(new Request("http://x/api/agent-inquiries?assignee=me"));
    expect(pm.agentInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assigneeId: "u-field" } }));
  });
  it("詳細の canOpenProperty は物件の閲覧権限と現地スタッフの担当範囲で決まる・担当範囲の列は返さない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([
      { resource: "agent_inquiry", action: "read", granted: true }, { resource: "property", action: "read", granted: true }]);
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, viewings: [], property: { ...deskRow, createdBy: "other", assignedTo: "other" } });
    let body = await (await GET_ONE(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(false);
    expect(Object.keys(body.inquiry.property).sort()).toEqual(DESK_KEYS);
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, viewings: [], property: { ...deskRow, createdBy: "u-field", assignedTo: null } });
    body = await (await GET_ONE(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(true);
  });
  it("変更: 古い版は 409・監査は項目名と状態の値だけ", async () => {
    pm.agentInquiry.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agentInquiry.findUnique.mockResolvedValueOnce({ id: IID });
    expect((await PATCH(json("PATCH", { status: "done", version: 1 }), ctx)).status).toBe(409);
    await PATCH(json("PATCH", { status: "done", note: "メモXYZ", version: 2 }), ctx);
    const last = (writeAuditLog as Fn).mock.calls.at(-1)![0];
    expect(last.detail).toEqual({ changed: ["note", "status"], status: "done" });
  });
  it("担当者の振り替えは有効な利用者だけ", async () => {
    pm.user.findUnique.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { assigneeId: UID, version: 1 }), ctx)).status).toBe(422);
  });
  it("件数: 未対応と今日明日の内見(取り消し除く)", async () => {
    pm.agentInquiry.count.mockResolvedValue(3);
    pm.agentViewing.count.mockResolvedValue(2);
    expect(await (await COUNTS()).json()).toEqual({ open: 3, upcomingViewings: 2 });
    expect(pm.agentViewing.count).toHaveBeenCalledWith({ where: expect.objectContaining({ canceledAt: null }) });
  });
  it("今日明日の内見の物件は許可リストだけ", async () => {
    pm.agentViewing.findMany.mockResolvedValue([{ id: "v", scheduledAt: new Date(), viewingType: "guided", attendant: null,
      inquiry: { id: IID, contactName: "田中", agent: { companyName: "○○" }, property: { ...deskRow, salePrice: 1 } } }]);
    const body = await (await UPCOMING()).json();
    expect(Object.keys(body.viewings[0].inquiry.property).sort()).toEqual(DESK_KEYS);
  });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL

- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/user-check.ts
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";

/** 担当者・立ち会いに選べるのは有効な利用者だけ(存在しない id で FK 違反の 500 にしない)。 */
export async function assertActiveUser(userId: string | null | undefined, code: string) {
  if (!userId) return;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!u?.isActive) throw new ApiError(422, "担当者を選び直してください", code);
}
```

```ts
// src/app/api/agent-inquiries/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { inquiryCreateSchema, normalizeInquiryContact } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { INQUIRY_STATUSES } from "@/lib/agent-inquiry/constants";
import { INQUIRY_LIST_SELECT, toInquiryView } from "@/lib/agent-inquiry/inquiry-view";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

const NO_STORE = { "Cache-Control": "no-store" };
const PAGE = 50;

/** 一覧(状態・担当で絞る・新しい順・カーソル式)。 */
export async function GET(request: Request) {
  try {
    const { session } = await requireAgentInquiry("read");
    const sp = new URL(request.url).searchParams;
    const status = z.enum(INQUIRY_STATUSES).optional().parse(sp.get("status") ?? undefined);
    const assigneeRaw = sp.get("assignee");
    const assigneeId = assigneeRaw === "me" ? session.id : assigneeRaw ? z.string().uuid().parse(assigneeRaw) : undefined;
    const cursorRaw = sp.get("cursor");
    const cursor = cursorRaw ? z.string().uuid().parse(cursorRaw) : undefined;
    const rows = await prisma.agentInquiry.findMany({
      where: { ...(status ? { status } : {}), ...(assigneeId ? { assigneeId } : {}) },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: INQUIRY_LIST_SELECT,
    });
    const items = rows.slice(0, PAGE).map(toInquiryView);
    return NextResponse.json({ items, nextCursor: rows.length > PAGE ? items[items.length - 1].id : null }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 登録(設計 §2.2)。物件の閲覧権限は問わない(方針10)。内見の予定を同時に作れる。 */
export async function POST(request: Request) {
  try {
    const { session } = await requireAgentInquiry("write");
    const input = inquiryCreateSchema.parse(await parseJsonBody(request));
    const [property, agent] = await Promise.all([
      prisma.property.findUnique({ where: { id: input.propertyId }, select: { id: true } }),
      prisma.agent.findUnique({ where: { id: input.agentId }, select: { id: true, isArchived: true } }),
    ]);
    if (!property) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
    if (!agent) throw new ApiError(404, "業者が見つかりません", "AGENT_NOT_FOUND");
    if (agent.isArchived) throw new ApiError(409, "この業者はしまわれています。名簿で戻してから選んでください", "AGENT_ARCHIVED");
    await assertActiveUser(input.viewing?.attendantId, "INVALID_ATTENDANT");
    const contact = normalizeInquiryContact(input);
    const row = await prisma.agentInquiry.create({
      data: {
        propertyId: input.propertyId,
        agentId: input.agentId,
        ...contact,
        kind: input.kind,
        channel: input.channel,
        note: input.note?.trim() || null,
        status: "open",
        assigneeId: session.id,
        createdById: session.id,
        ...(input.viewing ? { viewings: { create: [{
          viewingType: input.viewing.viewingType,
          scheduledAt: input.viewing.scheduledAt ? new Date(input.viewing.scheduledAt) : null,
          attendantId: input.viewing.attendantId ?? null,
        }] } } : {}),
      },
      select: { id: true },
    });
    const filled = Object.entries(contact).filter(([, v]) => v != null).map(([k]) => k);
    await writeAuditLog({
      userId: session.id, action: "agent_inquiry_create", targetTable: "agent_inquiries", targetId: row.id,
      detail: inquiryAuditDetail(input.note?.trim() ? [...filled, "note"] : filled, { kind: input.kind, status: "open" }),
    });
    return NextResponse.json({ id: row.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/agent-inquiries/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry, VERSION_CONFLICT_MESSAGE } from "@/lib/agent-inquiry/guard";
import { inquiryUpdateSchema, normalizeInquiryContact } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { INQUIRY_LIST_SELECT, toInquiryView } from "@/lib/agent-inquiry/inquiry-view";
import { DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = await idOf(ctx);
    const row = await prisma.agentInquiry.findUnique({
      where: { id },
      select: { ...INQUIRY_LIST_SELECT, property: { select: { ...DESK_PROPERTY_SELECT, createdBy: true, assignedTo: true } } },
    });
    if (!row) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
    const { createdBy, assignedTo } = row.property;
    // 「メイン画面で物件を開く」を出してよいか=既存の物件画面の閲覧規則(field_staff は作成者/担当のみ)。
    const canOpenProperty = hasPermission(perms, "property", "read") &&
      (session.role !== "field_staff" || createdBy === session.id || assignedTo === session.id);
    // toInquiryView が toDeskProperty を通すので createdBy/assignedTo は外へ出ない。
    return NextResponse.json({ inquiry: toInquiryView(row), canOpenProperty }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const { version, status, assigneeId, note, ...contactIn } = inquiryUpdateSchema.parse(await parseJsonBody(request));
    await assertActiveUser(assigneeId, "INVALID_ASSIGNEE");
    const data = {
      ...normalizeInquiryContact(contactIn),
      ...(status !== undefined ? { status } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(note !== undefined ? { note: note?.trim() || null } : {}),
    };
    const res = await prisma.agentInquiry.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) {
      const cur = await prisma.agentInquiry.findUnique({ where: { id }, select: { id: true } });
      if (!cur) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
      throw new ApiError(409, VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    }
    await writeAuditLog({ userId: session.id, action: "agent_inquiry_update", targetTable: "agent_inquiries", targetId: id, detail: inquiryAuditDetail(Object.keys(data), { status }) });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/agent-inquiries/counts/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";

/** ホーム用の件数(設計 §2.3)。 */
export async function GET() {
  try {
    await requireAgentInquiry("read");
    const { from, to } = todayTomorrowJst(new Date());
    const [open, upcomingViewings] = await Promise.all([
      prisma.agentInquiry.count({ where: { status: "open" } }),
      prisma.agentViewing.count({ where: { canceledAt: null, scheduledAt: { gte: from, lt: to } } }),
    ]);
    return NextResponse.json({ open, upcomingViewings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/agent-inquiries/upcoming/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

/** 今日・明日の内見(取り消し以外・時刻順)。 */
export async function GET() {
  try {
    await requireAgentInquiry("read");
    const { from, to } = todayTomorrowJst(new Date());
    const rows = await prisma.agentViewing.findMany({
      where: { canceledAt: null, scheduledAt: { gte: from, lt: to } },
      orderBy: { scheduledAt: "asc" },
      take: 100,
      select: {
        id: true, scheduledAt: true, viewingType: true,
        attendant: { select: { id: true, name: true } },
        inquiry: { select: { id: true, contactName: true, agent: { select: { companyName: true } }, property: { select: DESK_PROPERTY_SELECT } } },
      },
    });
    const viewings = rows.map(({ inquiry: { property, ...inq }, ...v }) => ({ ...v, inquiry: { ...inq, property: toDeskProperty(property) } }));
    return NextResponse.json({ viewings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 通過を確認** — `npx vitest run src/lib/__tests__/agent-inquiry-` → PASS、tsc 0
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 反響 API(登録・一覧・詳細・変更・件数・今日明日の内見)"`

---

### Task 6: 内見の予定 API

**Files:**
- Create: `src/app/api/agent-inquiries/[id]/viewings/route.ts`, `src/app/api/agent-inquiries/[id]/viewings/[vid]/route.ts`
- Test: `src/lib/__tests__/agent-inquiry-viewings-route.test.ts`

**Interfaces:**
- Consumes: `viewingCreateSchema` `viewingUpdateSchema` `requireAgentInquiry` `inquiryAuditDetail` `assertActiveUser`
- Produces: `POST /api/agent-inquiries/[id]/viewings` → 201 `{ id }`(用件が内見でなければ 409 `NOT_VIEWING`)/ `PATCH /api/agent-inquiries/[id]/viewings/[vid]` → `{ ok: true }`(`canceled: true` で `canceledAt=now`、`false` で null。`vid` がその反響の内見でなければ 404)

- [ ] **Step 1: 失敗するテスト**(先頭の vi.mock 3つは Task 4 と同一。prisma mock は `agentInquiry: { findUnique }`, `agentViewing: { create, findFirst, update }`, `user: { findUnique: vi.fn(async () => ({ isActive: true })) }`)

```ts
import { POST as ADD } from "../../app/api/agent-inquiries/[id]/viewings/route";
import { PATCH as EDIT } from "../../app/api/agent-inquiries/[id]/viewings/[vid]/route";
const IID = "44444444-4444-4444-8444-444444444444";
const VID = "55555555-5555-4555-8555-555555555555";
const addCtx = { params: Promise.resolve({ id: IID }) };
const editCtx = { params: Promise.resolve({ id: IID, vid: VID }) };

it("用件が内見でない反響には追加できない(409 NOT_VIEWING)", async () => {
  pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, kind: "ad_permission" });
  const res = await ADD(json("POST", { viewingType: "guided" }), addCtx);
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("NOT_VIEWING");
});
it("追加: 日時なし(日程調整中)も可", async () => {
  pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, kind: "viewing" });
  pm.agentViewing.create.mockResolvedValue({ id: VID });
  expect((await ADD(json("POST", { viewingType: "preview" }), addCtx)).status).toBe(201);
  expect(pm.agentViewing.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inquiryId: IID, scheduledAt: null }) }));
});
it("別の反響の内見 id は 404", async () => {
  pm.agentViewing.findFirst.mockResolvedValue(null);
  const res = await EDIT(json("PATCH", { canceled: true }), editCtx);
  expect(res.status).toBe(404);
  expect(pm.agentViewing.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: VID, inquiryId: IID } }));
});
it("取り消しと結果・監査に結果の文面を書かない", async () => {
  pm.agentViewing.findFirst.mockResolvedValue({ id: VID });
  await EDIT(json("PATCH", { canceled: true, resultNote: "駅距離で見送り" }), editCtx);
  expect(pm.agentViewing.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ canceledAt: expect.any(Date), resultNote: "駅距離で見送り" }) }));
  expect(JSON.stringify((writeAuditLog as Fn).mock.calls)).not.toContain("駅距離");
});
it("取り消しを戻す", async () => {
  pm.agentViewing.findFirst.mockResolvedValue({ id: VID });
  await EDIT(json("PATCH", { canceled: false }), editCtx);
  expect(pm.agentViewing.update).toHaveBeenCalledWith({ where: { id: VID }, data: { canceledAt: null } });
});
```

- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**

```ts
// src/app/api/agent-inquiries/[id]/viewings/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { viewingCreateSchema } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string }> };

/** 内見の予定を足す(日程変更・2回目の案内・設計 方針5)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const input = viewingCreateSchema.parse(await parseJsonBody(request));
    const inq = await prisma.agentInquiry.findUnique({ where: { id }, select: { id: true, kind: true } });
    if (!inq) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
    if (inq.kind !== "viewing") throw new ApiError(409, "内見の反響ではありません", "NOT_VIEWING");
    await assertActiveUser(input.attendantId, "INVALID_ATTENDANT");
    const row = await prisma.agentViewing.create({
      data: {
        inquiryId: id,
        viewingType: input.viewingType,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        attendantId: input.attendantId ?? null,
      },
      select: { id: true },
    });
    await writeAuditLog({ userId: session.id, action: "agent_viewing_create", targetTable: "agent_viewings", targetId: row.id, detail: inquiryAuditDetail(Object.keys(input)) });
    return NextResponse.json({ id: row.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/agent-inquiries/[id]/viewings/[vid]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { viewingUpdateSchema } from "@/lib/agent-inquiry/validators";
import { inquiryAuditDetail } from "@/lib/agent-inquiry/audit-detail";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";

type Ctx = { params: Promise<{ id: string; vid: string }> };

/** 内見の変更・取り消し・結果の記入。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireAgentInquiry("write");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const vid = z.string().uuid().parse(p.vid);
    const input = viewingUpdateSchema.parse(await parseJsonBody(request));
    const cur = await prisma.agentViewing.findFirst({ where: { id: vid, inquiryId: id }, select: { id: true } });
    if (!cur) throw new ApiError(404, "内見の予定が見つかりません", "NOT_FOUND");
    await assertActiveUser(input.attendantId, "INVALID_ATTENDANT");
    const data = {
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null } : {}),
      ...(input.viewingType !== undefined ? { viewingType: input.viewingType } : {}),
      ...(input.attendantId !== undefined ? { attendantId: input.attendantId } : {}),
      ...(input.resultNote !== undefined ? { resultNote: input.resultNote?.trim() || null } : {}),
      ...(input.canceled !== undefined ? { canceledAt: input.canceled ? new Date() : null } : {}),
    };
    await prisma.agentViewing.update({ where: { id: vid }, data });
    await writeAuditLog({ userId: session.id, action: "agent_viewing_update", targetTable: "agent_viewings", targetId: vid, detail: inquiryAuditDetail(Object.keys(input)) });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 内見の予定 API(追加・変更・取り消し・結果)"`

---

### Task 7: 受付の窓の物件検索 API

**Files:**
- Create: `src/app/api/agent-inquiries/property-search/route.ts`
- Test: `src/lib/__tests__/agent-inquiry-property-search-route.test.ts`

**Interfaces:**
- Consumes: `requireAgentInquiry("read")`、`DESK_PROPERTY_SELECT` `toDeskProperty`
- Produces: `GET /api/agent-inquiries/property-search?q=` → `{ properties: DeskProperty[] }`(2文字未満は空・上限20・空白区切りは語ごとに AND)

- [ ] **Step 0: Property の削除/しまう列の確認** — `grep -n "deletedAt\|isArchived\|archivedAt" prisma/schema.prisma` で `model Property` の範囲を確認。該当列があれば、下の `where` に `{ deletedAt: null }` 等を AND で足し、テスト「消した物件は出ない」を1件加える。無ければそのまま。

- [ ] **Step 1: 失敗するテスト**(先頭の vi.mock 3つは Task 4 と同一。prisma mock は `property: { findMany: vi.fn(async () => []) }`)

```ts
import { GET as SEARCH } from "../../app/api/agent-inquiries/property-search/route";
import { DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";
const url = (q: string) => new Request("http://x/api/agent-inquiries/property-search?q=" + encodeURIComponent(q));

it("現地スタッフでも担当外を含む全物件が対象(作成者/担当の条件を付けない)", async () => {
  (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
  await SEARCH(url("サンライズ"));
  expect(JSON.stringify(pm.property.findMany.mock.calls[0][0].where)).not.toMatch(/createdBy|assignedTo/);
});
it("検索条件は物件名・棟名・部屋番号・所在地だけ(所有者・地番・メモで当たらない)", async () => {
  await SEARCH(url("中野"));
  const arg = pm.property.findMany.mock.calls[0][0];
  expect(arg.where.OR).toEqual([
    { buildingName: { contains: "中野", mode: "insensitive" } },
    { building: { name: { contains: "中野", mode: "insensitive" } } },
    { roomNo: { contains: "中野" } },
    { address: { contains: "中野", mode: "insensitive" } },
  ]);
  expect(JSON.stringify(arg.where)).not.toMatch(/owner|lotNumber|note/i);
  expect(arg.select).toEqual(DESK_PROPERTY_SELECT);
  expect(arg.take).toBe(20);
});
it("空白区切りは語ごとに AND", async () => {
  await SEARCH(url("サンライズ 305"));
  expect(pm.property.findMany.mock.calls[0][0].where.AND).toHaveLength(2);
});
it("返すのは許可リストのキーだけ", async () => {
  pm.property.findMany.mockResolvedValue([{ id: "p", propertyType: "land", buildingName: null, roomNo: null, address: "東京都中野区中野2丁目3", building: null, adPermissions: [], salePrice: 9 }]);
  const body = await (await SEARCH(url("ab"))).json();
  expect(Object.keys(body.properties[0]).sort()).toEqual(["adPermissions", "id", "name", "propertyType", "roomNo", "town"]);
});
it("権限が無ければ 403・1文字は検索しない", async () => {
  (getUserPermissions as Fn).mockResolvedValue([]);
  expect((await SEARCH(url("ab"))).status).toBe(403);
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "agent_inquiry", action: "read", granted: true }]);
  expect((await (await SEARCH(url("a"))).json()).properties).toEqual([]);
  expect(pm.property.findMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**

```ts
// src/app/api/agent-inquiries/property-search/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

const LIMIT = 20;
const termWhere = (t: string) => ({
  OR: [
    { buildingName: { contains: t, mode: "insensitive" as const } },
    { building: { name: { contains: t, mode: "insensitive" as const } } },
    { roomNo: { contains: t } },
    { address: { contains: t, mode: "insensitive" as const } },
  ],
});

/**
 * 受付の窓の物件検索(設計 §4・方針10)。反響の受付の権限があれば全物件が対象(現地スタッフの
 * 作成者/担当の制限を掛けない)。その代わり返す項目は許可リスト(toDeskProperty)だけ、検索条件も
 * 物件名・棟名・部屋番号・所在地だけ=所有者・地番・メモでは当たらない(返さない情報を推測させない)。
 */
export async function GET(request: Request) {
  try {
    await requireAgentInquiry("read");
    const q = (new URL(request.url).searchParams.get("q") ?? "").normalize("NFKC").trim();
    if ([...q].length < 2) return NextResponse.json({ properties: [] }, { headers: { "Cache-Control": "no-store" } });
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 4);
    const where = terms.length === 1 ? termWhere(terms[0]) : { AND: terms.map(termWhere) };
    const rows = await prisma.property.findMany({ where, select: DESK_PROPERTY_SELECT, orderBy: { updatedAt: "desc" }, take: LIMIT });
    return NextResponse.json({ properties: rows.map(toDeskProperty) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 受付の窓の物件検索(許可リストで全物件)"`

---

### Task 8: 物件側 API(反響欄・広告の可否)

**Files:**
- Create: `src/lib/agent-inquiry/property-access.ts`, `src/app/api/properties/[id]/agent-inquiries/route.ts`, `src/app/api/properties/[id]/ad-permissions/route.ts`
- Test: `src/lib/__tests__/agent-inquiry-property-routes.test.ts`

**Interfaces:**
- Consumes: `buildPropertyTimeline` `countInquiries` `adPermissionsPutSchema`
- Produces:
  - `assertPropertyReadable(propertyId, session, perms)` / `assertPropertyWritable(propertyId, session, perms)`
  - `GET /api/properties/[id]/agent-inquiries` → `{ counts, timeline, adPermissions }`
  - `PUT /api/properties/[id]/ad-permissions` body `{ items: { medium, value: ok|ng|ask|null }[] }` → `{ adPermissions }`

- [ ] **Step 0: 既存規則と突き合わせ** — `sed -n 105,130p "src/app/api/properties/[id]/route.ts"` と `sed -n 315,335p` で field_staff の判定を読み、下の `assertProperty` と同じ条件か確認(違えば既存に合わせる)。

- [ ] **Step 1: 失敗するテスト**(先頭の vi.mock 3つは Task 4 と同一。prisma mock は `property: { findUnique }`, `agentInquiry: { findMany: vi.fn(async () => []) }`, `propertyAdPermission: { findMany: vi.fn(async () => []), upsert: vi.fn(), deleteMany: vi.fn() }`, `$transaction: vi.fn(async (fn) => fn(db))`)

```ts
import { GET as TIMELINE } from "../../app/api/properties/[id]/agent-inquiries/route";
import { PUT } from "../../app/api/properties/[id]/ad-permissions/route";
const PID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: PID }) };
const perms = (...p: [string, string][]) => (getUserPermissions as Fn).mockResolvedValue(p.map(([resource, action]) => ({ resource, action, granted: true })));

it("現地スタッフの担当外は 403", async () => {
  (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
  perms(["property", "read"]);
  pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: "y" });
  expect((await TIMELINE(new Request("http://x"), ctx)).status).toBe(403);
});
it("時系列・件数・広告の可否を返す", async () => {
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  perms(["property", "read"]);
  pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: null });
  pm.propertyAdPermission.findMany.mockResolvedValue([{ medium: "athome", value: "ok" }]);
  const body = await (await TIMELINE(new Request("http://x"), ctx)).json();
  expect(body).toEqual({ counts: { total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 }, timeline: [], adPermissions: { athome: "ok" } });
});
it("広告の可否の変更は物件の編集権限・null は行を消す・1トランザクション", async () => {
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  perms(["property", "read"], ["property", "write"]);
  pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: null });
  const res = await PUT(json("PUT", { items: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: null }] }), ctx);
  expect(res.status).toBe(200);
  expect(pm.$transaction).toHaveBeenCalled();
  expect(pm.propertyAdPermission.upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { propertyId_medium: { propertyId: PID, medium: "athome" } },
    create: { propertyId: PID, medium: "athome", value: "ok", updatedById: "u1" },
    update: { value: "ok", updatedById: "u1" },
  }));
  expect(pm.propertyAdPermission.deleteMany).toHaveBeenCalledWith({ where: { propertyId: PID, medium: "flyer" } });
});
it("反響の受付の権限だけでは広告の可否を変えられない(403)", async () => {
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  perms(["property", "read"], ["agent_inquiry", "write"]);
  pm.property.findUnique.mockResolvedValue({ id: PID, createdBy: "x", assignedTo: null });
  expect((await PUT(json("PUT", { items: [{ medium: "athome", value: "ok" }] }), ctx)).status).toBe(403);
});
```

- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**

```ts
// src/lib/agent-inquiry/property-access.ts
import prisma from "@/lib/prisma";
import { ApiError, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/** 既存の物件画面と同じ規則(field_staff は作成者/担当の物件だけ)。 */
async function assertProperty(propertyId: string, session: ApiSession, perms: PermissionEntry[], action: "read" | "write") {
  if (!hasPermission(perms, "property", action)) throw new ApiError(403, "権限がありません", "FORBIDDEN");
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, createdBy: true, assignedTo: true } });
  if (!p) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (session.role === "field_staff" && p.createdBy !== session.id && p.assignedTo !== session.id) {
    throw new ApiError(403, "この物件を見る権限がありません", "FORBIDDEN");
  }
}
export const assertPropertyReadable = (id: string, s: ApiSession, p: PermissionEntry[]) => assertProperty(id, s, p, "read");
export const assertPropertyWritable = (id: string, s: ApiSession, p: PermissionEntry[]) => assertProperty(id, s, p, "write");
```

```ts
// src/app/api/properties/[id]/agent-inquiries/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { buildPropertyTimeline, countInquiries } from "@/lib/agent-inquiry/timeline";

type Ctx = { params: Promise<{ id: string }> };

/** 物件画面の「反響」欄(設計 §2.3)。物件の閲覧規則に従う。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyReadable(id, session, perms);
    const [inquiries, ads] = await Promise.all([
      prisma.agentInquiry.findMany({
        where: { propertyId: id },
        orderBy: { receivedAt: "desc" },
        take: 500,
        select: {
          id: true, kind: true, receivedAt: true, status: true, contactName: true,
          agent: { select: { companyName: true } },
          viewings: { select: { id: true, scheduledAt: true, viewingType: true, canceledAt: true, resultNote: true, attendant: { select: { name: true } } } },
        },
      }),
      prisma.propertyAdPermission.findMany({ where: { propertyId: id }, select: { medium: true, value: true } }),
    ]);
    return NextResponse.json(
      {
        counts: countInquiries(inquiries),
        timeline: buildPropertyTimeline(inquiries),
        adPermissions: Object.fromEntries(ads.map((a) => [a.medium, a.value])),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// src/app/api/properties/[id]/ad-permissions/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertPropertyWritable } from "@/lib/agent-inquiry/property-access";
import { adPermissionsPutSchema } from "@/lib/agent-inquiry/validators";

type Ctx = { params: Promise<{ id: string }> };

/** 広告の可否の変更(物件の編集権限・設計 §2.3)。null=未設定に戻す。 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyWritable(id, session, perms);
    const { items } = adPermissionsPutSchema.parse(await parseJsonBody(request));
    await prisma.$transaction(async (tx) => {
      for (const it of items) {
        if (it.value === null) {
          await tx.propertyAdPermission.deleteMany({ where: { propertyId: id, medium: it.medium } });
        } else {
          await tx.propertyAdPermission.upsert({
            where: { propertyId_medium: { propertyId: id, medium: it.medium } },
            create: { propertyId: id, medium: it.medium, value: it.value, updatedById: session.id },
            update: { value: it.value, updatedById: session.id },
          });
        }
      }
    });
    const ads = await prisma.propertyAdPermission.findMany({ where: { propertyId: id }, select: { medium: true, value: true } });
    const adPermissions = Object.fromEntries(ads.map((a) => [a.medium, a.value]));
    // 監査の values は媒体→ok/ng/ask の列挙値だけ(個人情報を含まない)。
    await writeAuditLog({
      userId: session.id, action: "property_ad_permissions_update", targetTable: "properties", targetId: id,
      detail: { changed: ["adPermissions"], media: items.map((i) => i.medium).sort(), values: adPermissions },
    });
    return NextResponse.json({ adPermissions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-inquiry): 物件側 API(反響欄・広告の可否)"`

---

### Task 9: 全ゲート・実地確認・提出前レビュー・PR

- [ ] **Step 1: 全ゲート**(実行証跡を残す)

```bash
npx tsc --noEmit
npx vitest run
npx eslint src/lib/agent-inquiry src/app/api/agents src/app/api/agent-inquiries "src/app/api/properties/[id]/agent-inquiries" "src/app/api/properties/[id]/ad-permissions" prisma/seed.ts src/lib/api-helpers.ts "src/app/(dashboard)/admin/templates/[id]/page.tsx" "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx" src/lib/__tests__/agent-inquiry-*.test.ts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build
git diff --stat origin/main
```
Expected: tsc 0 / vitest 失敗 0 / eslint 0 / build 成功(route 一覧に `/api/agents` `/api/agent-inquiries/*` `/api/properties/[id]/agent-inquiries` `/api/properties/[id]/ad-permissions`)/ diff に `Bin` が無い。

- [ ] **Step 2: ローカル DB で migration と SQL を実地確認**(`local-dev-env-setup` メモの手順で dev 起動)

```bash
npx prisma migrate deploy
npm run dev
```
ログイン後、ブラウザの devtools かスクリプトで: `POST /api/agents`(代表電話 0312345678)→ `POST /api/agent-inquiries`(携帯 09012345678・用件 内見・viewing つき)→ `GET /api/agents?q=0901234`(携帯で当たり lastContact が埋まる)→ `GET /api/agents?q=0312345`(代表電話で当たる)→ `GET /api/agent-inquiries/property-search?q=<実在の物件名>` → `PUT /api/properties/<id>/ad-permissions` → `GET /api/properties/<id>/agent-inquiries` → `GET /api/agent-inquiries/counts`。**数字照合 SQL の構文・型エラーはここでしか出ない**。現地スタッフの利用者でも物件検索と登録ができ、`GET /api/properties/<担当外>/agent-inquiries` は 403 になることを確認。

- [ ] **Step 3: 提出前レビュー** — `feature-dev:code-reviewer`(sonnet)に staged diff を渡す。ホットスポット: 受付の窓の物件検索・一覧・詳細・今日明日・業者詳細の**許可リスト**(現地スタッフへの漏えい)/検索条件からの推測/監査 detail の許可リスト/version の 409/数字照合 SQL の LIMIT と archived 除外/権限2画面の RESOURCES の一致/migration が ADD のみ/PATCH で触っていない列を null にしない。P1/P2 を潰す。

- [ ] **Step 4: push・PR・@codex**

```bash
git push -u origin feat/agent-inquiry-desk
gh pr create --title "feat(agent-inquiry): 業者からの反響の受付 PR1(データ+API)" --body-file <本文ファイル>
gh pr comment <PR> --body "@codex review"
```
PR 本文: 平易な日本語で「何ができるようになるか(まだ画面は無い)/migration あり(ADD のみ・権限付与の INSERT あり)/テスト/安全(許可リスト・監査)」+末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)` とセッション URL。到着監視は codex-triage スキルの 3 系統 Monitor。push ごとに CI の結論も確認。

- [ ] **Step 5: メモリ更新** — `next-epic-agent-inquiry-management.md` に PR 番号・状態を追記。
