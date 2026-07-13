# 販売図面 F4-1：会社情報の設定画面化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development で本計画をタスク単位に実装する。ステップは `- [ ]` で追跡。

**Goal:** 会社帯の自社情報を管理画面から編集可能にし（7項目・DB1行保存・未設定は `COMPANY_INFO` フォールバック）、図面生成時にサーバが焼き込む。あわせて会社帯から英字社名・保証協会・所属協会を削除する。

**Architecture:** 既存の管理設定画面（`/admin/sale-dm-settings`）と同一骨格・暗号化なし（非秘匿）。singleton テーブル `company_profile`。会社帯座標はデータ非依存ゆえエディタ無改修＝サーバ図面生成（`new/route.ts`）で `loadCompanyProfile()` を各ビルダーへ渡し `buildFooterBand` へ流す。

**Tech Stack:** Next.js(App Router)/TypeScript・Prisma(PostgreSQL)・zod・vitest(node env)。

## Global Constraints（全タスク共通）

- **非秘匿**：暗号化・enc列・enc-key env・`encryptionConfigured`・503分岐・バナーは作らない。プレーン `String?` 列のみ。
- **権限**：APIルートは `hasPermission(perms, "user_management", "write")`（管理者のみ）。失敗は `ApiError(403, "会社情報の編集は管理者のみ可能です", "FORBIDDEN")`。
- **監査**：`writeAuditLog({ userId, action: "company_profile_update", targetTable: "company_profile", detail: { target: "singleton", fields, updatedAt } })`。**値は入れない・項目名のみ**。`targetId` は渡さない（uuid列ゆえ "singleton" 不可）。`ACTION_EXTRA_KEYS` に `company_profile_update` を登録（未登録＝ビューアで `[REDACTED]`）。
- **singleton**：`id String @id @default("singleton")`・migration `id ... DEFAULT 'singleton'`・遅延 `upsert`・読取は行不在許容。
- **フォールバック**：DB値優先、空/空白のみ→`COMPANY_INFO`。`COMPANY_INFO` は3キー削除後に**正確に7項目**として残す。
- **api-client**：`USE_MOCK` 短絡（EMPTY定数）必須。
- **二重レンダラ無改修**：`buildFooterBand` は text/table/shape のみ出力。parity/関連テストは3項目削除・注入に合わせ更新。
- **HTTP本番**：`crypto.randomUUID` 不使用。
- **TDD＋全ゲート**：RED→GREEN。`npx tsc --noEmit`=0 ／ フル `npx vitest run` 緑 ／ `npx eslint <変更>`=0 ／ `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` 緑。
- **worktree**：`property-management-worktrees/sales-sheet-company-settings`（branch `feat/sales-sheet-company-settings`）。`npm ci`＋`prisma generate` 済。

## File Structure

- Create: `prisma/migrations/<ts>_add_company_profile/migration.sql` — 新テーブル。
- Modify: `prisma/schema.prisma` — `CompanyProfile` モデル追加。
- Create: `src/lib/sales-sheet/company-profile-store.ts` — 型・`resolveCompanyProfile`・`loadCompanyProfile`。
- Create: `src/lib/sales-sheet/__tests__/company-profile-store.test.ts`。
- Modify: `src/lib/sales-sheet/company-info.ts` — 3キー削除（7項目化）。
- Modify: `src/lib/sales-sheet/footer-band.ts` — company注入＋3要素削除＋2×2再配置。
- Modify: `src/lib/sales-sheet/build-document.ts` — `SpecSheetParts.company`＋4 Input型に `company?`＋4ビルダー forward。
- Modify: `src/app/api/properties/[id]/sales-sheets/new/route.ts` — `loadCompanyProfile()` を4ビルダーへ配線。
- Create: `src/app/api/admin/company-settings/route.ts` — GET/PUT。
- Create: `src/app/api/admin/company-settings/__tests__/route.test.ts`。
- Modify: `src/lib/api-client.ts` — 型・EMPTY・fetch/update ラッパー。
- Modify: `src/lib/audit-log-detail-safety.ts` — `ACTION_EXTRA_KEYS` 登録。
- Create: `src/app/(dashboard)/admin/company-settings/page.tsx` — 設定フォーム。
- Modify: `src/components/layout/sidebar.tsx` — `adminNavItems` に1件。
- Create: `src/components/layout/__tests__/company-settings-nav-source.test.ts`。
- 更新テスト: `footer-band.test.ts` / `company-info.test.ts` / `spec-sheet-document.test.ts` / `render-html-parity.test.ts` / `build-mansion.test.ts`（他 build-*.test も3項目削除に該当すれば）。

---

## Task 1: Prisma モデル＋migration（`company_profile`）

**Files:**
- Modify: `prisma/schema.prisma`（末尾の設定モデル群の後・`RegistryFetchConfig` の下）
- Create: `prisma/migrations/<ts>_add_company_profile/migration.sql`（`<ts>` は既存 migration フォルダより辞書順で後。`ls prisma/migrations` で最新を確認し `20260713000000` 等）

**Interfaces:**
- Produces: Prisma client `prisma.companyProfile`（fields `id, nameJa, license, tel, fax, email, hp, address, updatedAt, updatedById`）。

- [ ] **Step 1: schema.prisma にモデル追加**

```prisma
// 会社情報（会社帯）の設定保管。管理画面から編集。1行のみ(id="singleton")。全項目 非秘匿・平文。
// 未設定(null/空)は company-info.ts の COMPANY_INFO をフォールバック(resolveCompanyProfile)。
model CompanyProfile {
  id          String   @id @default("singleton")
  nameJa      String?  @map("name_ja")
  license     String?
  tel         String?
  fax         String?
  email       String?
  hp          String?
  address     String?
  updatedAt   DateTime @updatedAt @map("updated_at")
  updatedById String?  @map("updated_by_id") @db.Uuid

  @@map("company_profile")
}
```

- [ ] **Step 2: migration.sql を作成**（手書き・`prisma migrate dev` は使わない＝既存運用に合わせ additive SQL を用意）

```sql
-- CreateTable
CREATE TABLE "company_profile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "name_ja" TEXT,
    "license" TEXT,
    "tel" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "hp" TEXT,
    "address" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);
```

- [ ] **Step 3: prisma generate で型反映**

Run: `npx prisma generate`
Expected: 成功（`prisma.companyProfile` が型に出る）。

- [ ] **Step 4: ローカルDBに適用（任意・環境がある場合）**

Run: `npx prisma migrate deploy`（or ローカル未接続ならスキップ＝型生成のみで後続タスクは進む。**本番適用は別承認**）
Expected: `company_profile` 追加。

- [ ] **Step 5: commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(sales-sheet): company_profile テーブル追加(F4-1)"
```

---

## Task 2: `company-profile-store.ts`（解決ロジック）

**Files:**
- Create: `src/lib/sales-sheet/company-profile-store.ts`
- Test: `src/lib/sales-sheet/__tests__/company-profile-store.test.ts`

**Interfaces:**
- Consumes: `COMPANY_INFO`（`company-info.ts`・この時点では10キーだが読むのは7キーのみ）、`prisma`（`@/lib/prisma` or 既存の prisma import パスに合わせる）。
- Produces: `type CompanyProfile = { nameJa: string; license: string; tel: string; fax: string; email: string; hp: string; address: string }`（全 string 必須＝解決後）／`resolveCompanyProfile(row): CompanyProfile`（純関数）／`loadCompanyProfile(): Promise<CompanyProfile>`。

- [ ] **Step 1: 失敗テストを書く**

```ts
// src/lib/sales-sheet/__tests__/company-profile-store.test.ts
import { describe, it, expect } from "vitest";
import { resolveCompanyProfile, type CompanyProfile } from "../company-profile-store";
import { COMPANY_INFO } from "../company-info";

describe("resolveCompanyProfile", () => {
  it("row=null は全項目 COMPANY_INFO 既定へフォールバック", () => {
    const r = resolveCompanyProfile(null);
    expect(r.nameJa).toBe(COMPANY_INFO.nameJa);
    expect(r.tel).toBe(COMPANY_INFO.tel);
    expect(r.address).toBe(COMPANY_INFO.address);
  });
  it("DB値があれば優先", () => {
    const r = resolveCompanyProfile({ nameJa: "株式会社テスト", tel: "01-2345-6789" });
    expect(r.nameJa).toBe("株式会社テスト");
    expect(r.tel).toBe("01-2345-6789");
    expect(r.license).toBe(COMPANY_INFO.license); // 未指定はフォールバック
  });
  it("空文字/空白のみはフォールバック（保存クリアと同義）", () => {
    const r = resolveCompanyProfile({ nameJa: "", tel: "   " });
    expect(r.nameJa).toBe(COMPANY_INFO.nameJa);
    expect(r.tel).toBe(COMPANY_INFO.tel);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/company-profile-store.test.ts`
Expected: FAIL（モジュール未作成）。

- [ ] **Step 3: 実装**

```ts
// src/lib/sales-sheet/company-profile-store.ts
import { prisma } from "@/lib/prisma"; // ※既存 import パスに合わせる（sale-dm config-store を参照）
import { COMPANY_INFO } from "./company-info";

export type CompanyProfile = {
  nameJa: string;
  license: string;
  tel: string;
  fax: string;
  email: string;
  hp: string;
  address: string;
};

/** 解決後の会社情報の既定値（3キー削除後の COMPANY_INFO と同一）。 */
const DEFAULT: CompanyProfile = {
  nameJa: COMPANY_INFO.nameJa,
  license: COMPANY_INFO.license,
  tel: COMPANY_INFO.tel,
  fax: COMPANY_INFO.fax,
  email: COMPANY_INFO.email,
  hp: COMPANY_INFO.hp,
  address: COMPANY_INFO.address,
};

type Row = Partial<Record<keyof CompanyProfile, string | null | undefined>>;

function pick(v: string | null | undefined, fallback: string): string {
  const t = (v ?? "").trim();
  return t !== "" ? t : fallback;
}

/** DB行(or null)→解決済み会社情報。空/空白は既定へフォールバック（純関数）。 */
export function resolveCompanyProfile(row: Row | null): CompanyProfile {
  if (!row) return { ...DEFAULT };
  return {
    nameJa: pick(row.nameJa, DEFAULT.nameJa),
    license: pick(row.license, DEFAULT.license),
    tel: pick(row.tel, DEFAULT.tel),
    fax: pick(row.fax, DEFAULT.fax),
    email: pick(row.email, DEFAULT.email),
    hp: pick(row.hp, DEFAULT.hp),
    address: pick(row.address, DEFAULT.address),
  };
}

/** DBから会社情報を読み解決する。DBエラー時は既定へフォールバック（図面生成を止めない）。 */
export async function loadCompanyProfile(): Promise<CompanyProfile> {
  try {
    const row = await prisma.companyProfile.findUnique({ where: { id: "singleton" } });
    return resolveCompanyProfile(row);
  } catch {
    return { ...DEFAULT };
  }
}
```

- [ ] **Step 4: 成功確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/company-profile-store.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add src/lib/sales-sheet/company-profile-store.ts src/lib/sales-sheet/__tests__/company-profile-store.test.ts
git commit -m "feat(sales-sheet): 会社情報の解決ロジック(DB→既定フォールバック)"
```

---

## Task 3: `footer-band.ts`（company注入＋3要素削除＋2×2再配置）＋ `company-info.ts` 7項目化

**Files:**
- Modify: `src/lib/sales-sheet/footer-band.ts`
- Modify: `src/lib/sales-sheet/company-info.ts`（`nameEn`/`guaranteeAssoc`/`memberAssoc` を削除）
- Test: `src/lib/sales-sheet/__tests__/footer-band.test.ts`（更新）・`company-info.test.ts`（更新）

**Interfaces:**
- Consumes: `CompanyProfile`（Task 2）。
- Produces: `buildFooterBand(footer, data, company?: CompanyProfile): SalesSheetElement[]`（`company` 既定＝`COMPANY_INFO`）。出力から `footer-name-en`/`footer-guarantee`/`footer-member` が消える。

- [ ] **Step 1: テスト更新（RED）**

`footer-band.test.ts` に以下を追加/更新：
```ts
it("company を渡すとその会社名/連絡先が入る", () => {
  const els = buildFooterBand(FOOTER, { transactionType: "仲介" }, {
    nameJa: "株式会社テスト", license: "免許X", tel: "01-1", fax: "02-2",
    email: "a@b.jp", hp: "https://x.jp/", address: "000-0000 テスト町1",
  });
  const nameJa = els.find((e) => e.id === "footer-name-ja");
  expect(nameJa && "content" in nameJa && nameJa.content).toBe("株式会社テスト");
});
it("英字社名・保証協会・所属協会の要素は出力されない", () => {
  const els = buildFooterBand(FOOTER, {});
  expect(els.find((e) => e.id === "footer-name-en")).toBeUndefined();
  expect(els.find((e) => e.id === "footer-guarantee")).toBeUndefined();
  expect(els.find((e) => e.id === "footer-member")).toBeUndefined();
});
it("company 未指定でも既定(COMPANY_INFO)で会社名が入る（後方互換）", () => {
  const els = buildFooterBand(FOOTER, {});
  const nameJa = els.find((e) => e.id === "footer-name-ja");
  expect(nameJa && "content" in nameJa && nameJa.content).toBeTruthy();
});
```
`company-info.test.ts`：`nameEn`/`guaranteeAssoc`/`memberAssoc` を参照する assert を削除。残り7キー存在の確認へ更新。

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-band.test.ts src/lib/sales-sheet/__tests__/company-info.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`company-info.ts`：`nameEn`・`guaranteeAssoc`・`memberAssoc` の3行を削除（残り7キー）。
```ts
export const COMPANY_INFO = {
  nameJa: "株式会社リガーレジャパン",
  license: "宅建免許 東京都知事免許(1)第108344号",
  tel: "03-6823-2760",
  fax: "03-6823-2761",
  email: "info@ligarejapan.com",
  hp: "https://ligarejapan.com/",
  address: "154-0011 東京都世田谷区上馬4-36-15",
} as const;
```

`footer-band.ts`：
1. import 追加：`import type { CompanyProfile } from "./company-profile-store";`
2. シグネチャ：`export function buildFooterBand(footer: Rect, data: FooterBandData, company: CompanyProfile = COMPANY_INFO): SalesSheetElement[]`
3. `footer-name-en` の push を削除。名前行は `footer-name-ja`＋TEL/FAX のみ。`NAME_EN_OFFSET_MM`/`NAME_EN_W_MM` 定数を削除。
4. text の値を `company.*` 参照へ：`company.nameJa` / `TEL ${company.tel}` / `FAX ${company.fax}` / `Email ${company.email}` / `H　P ${company.hp}` / `所在地 ${company.address}` / `company.license`。
5. 情報グリッドを **2×2** へ：左列＝`["footer-license", company.license]`, `["footer-address", `所在地 ${company.address}`]`。右列＝`["footer-email", `Email ${company.email}`]`, `["footer-hp", `H　P ${company.hp}`]`。行数は2（`gridRowH = (companyContentBottom - gridY0) / 2`）。`gridLeft`/`gridRight` を2要素配列に変更し、既存の `forEach((_,i)=> y0 + i*gridRowH)` を流用。
   - ※視覚は後段（Task 8）でプレビュー確認・微調整。**幾何 assert はエンジン出力oracle方式ゆえ緑維持**（`spec-sheet-document.test.ts` は再計算比較）。

- [ ] **Step 4: 成功確認 → 影響テスト**

Run: `npx vitest run src/lib/sales-sheet/__tests__/footer-band.test.ts src/lib/sales-sheet/__tests__/company-info.test.ts src/lib/sales-sheet/__tests__/spec-sheet-document.test.ts src/lib/sales-sheet/__tests__/render-html-parity.test.ts`
Expected: PASS（parity の会社帯 assert は英字社名でなく会社名JPで確認するよう更新）。

- [ ] **Step 5: commit**

```bash
git add src/lib/sales-sheet/footer-band.ts src/lib/sales-sheet/company-info.ts src/lib/sales-sheet/__tests__/
git commit -m "feat(sales-sheet): 会社帯に会社情報を注入+英字社名/保証協会/所属協会を削除(2x2)"
```

---

## Task 4: `build-document.ts` 配線＋`new/route.ts` で会社情報読込

**Files:**
- Modify: `src/lib/sales-sheet/build-document.ts`
- Modify: `src/app/api/properties/[id]/sales-sheets/new/route.ts`
- Test: `src/lib/sales-sheet/__tests__/build-mansion.test.ts`（更新）

**Interfaces:**
- Consumes: `buildFooterBand(...,company)`（Task 3）、`loadCompanyProfile()`（Task 2）。
- Produces: `SpecSheetParts.company?: CompanyProfile`／各 `Sale*Input.company?: CompanyProfile`／各ビルダーが footer へ company を forward。

- [ ] **Step 1: テスト（RED）**

`build-mansion.test.ts` に：
```ts
it("input.company が会社帯へ流れる", () => {
  const doc = buildSaleMansionDocument({
    property: { address: "x" }, building: { name: "テスト棟" },
    company: { nameJa: "株式会社ABC", license: "L", tel: "T", fax: "F", email: "e@x.jp", hp: "https://x.jp/", address: "A" },
    overrides: {},
  });
  const nameJa = doc.elements.find((e) => e.id === "footer-name-ja");
  expect(nameJa && "content" in nameJa && nameJa.content).toBe("株式会社ABC");
});
```

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/build-mansion.test.ts`
Expected: FAIL（`company` 未サポート）。

- [ ] **Step 3: 実装**

`build-document.ts`：
1. `import type { CompanyProfile } from "./company-profile-store";`
2. `SpecSheetParts` に `company?: CompanyProfile;` を追加。
3. `buildSpecSheetDocument` の footer 展開を `...buildFooterBand(L.footer, parts.footer ?? {}, parts.company)` に変更。
4. `SaleMansionInput`/`SaleLandInput`/`SaleHouseInput`/`SaleBuildingInput` の各 interface に `company?: CompanyProfile;` を追加。
5. `buildSaleMansionDocument`/`buildSaleLandDocument`/`buildSaleHouseDocument`/`buildSaleBuildingDocument` の `buildSpecSheetDocument({...})` 呼び出しに `company: input.company,` を追加。

`new/route.ts`：
1. import に `loadCompanyProfile` 追加（`@/lib/sales-sheet/company-profile-store`）。
2. ビルダー分岐の直前で `const company = await loadCompanyProfile();`
3. 4つの `buildSale*Document({...})` 各呼び出しに `company,` を追加（`photos`/`overrides` と並べて）。

- [ ] **Step 4: 成功確認**

Run: `npx vitest run src/lib/sales-sheet/__tests__/build-mansion.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add src/lib/sales-sheet/build-document.ts "src/app/api/properties/[id]/sales-sheets/new/route.ts" src/lib/sales-sheet/__tests__/build-mansion.test.ts
git commit -m "feat(sales-sheet): 図面生成時に会社情報(DB)を会社帯へ配線"
```

---

## Task 5: 保存API `admin/company-settings/route.ts`（GET/PUT）＋監査allowlist

**Files:**
- Create: `src/app/api/admin/company-settings/route.ts`
- Test: `src/app/api/admin/company-settings/__tests__/route.test.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`（`ACTION_EXTRA_KEYS`）

**先に読むべき precedent**（構造・helper import・`parseJsonBody`/`ApiError`/`handleApiError`/`requireSaleDmAdmin` の正確な形）：`src/app/api/admin/sale-dm-settings/route.ts`。本タスクはこれを写経し、フィールドを会社7項目・暗号化なしに置換する。

**Interfaces:**
- Consumes: `getApiSession`/`getUserPermissions`/`ApiError`/`handleApiError`/`parseJsonBody`（`@/lib/api-helpers`）、`hasPermission`（`@/lib/permissions`）、`prisma`、`writeAuditLog`（`@/lib/audit`）、`loadCompanyProfile`（Task 2）。
- Produces: `GET`→`{ data: { nameJa, license, tel, fax, email, hp, address, updatedAt } }`（`Cache-Control: no-store`）／`PUT`（部分更新・空文字→null・upsert・監査）。

- [ ] **Step 1: route テスト（RED）**（sale-dm route.test を参照。mock prisma/session）

最低限：未認証→403／非管理者→403／管理者PUT で空文字が null 化され upsert される／監査 detail に**値が含まれない**（`fields` 配列と `target` のみ）。

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/app/api/admin/company-settings/__tests__/route.test.ts`
Expected: FAIL（route 未作成）。

- [ ] **Step 3: 実装**（sale-dm route を写経・暗号化系を除去）

```ts
// src/app/api/admin/company-settings/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

const CONFIG_ID = "singleton";
const FIELDS = ["nameJa", "license", "tel", "fax", "email", "hp", "address"] as const;

async function requireAdmin() {
  const session = await getApiSession();
  if (!session) throw new ApiError(401, "認証が必要です", "UNAUTHORIZED");
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "会社情報の編集は管理者のみ可能です", "FORBIDDEN");
  }
  return session;
}

// 空文字→null（クリア）。undefined は「変更しない」。
const optStr = z.string().trim().optional();
const putSchema = z.object({
  nameJa: optStr, license: optStr, tel: optStr, fax: optStr, email: optStr, hp: optStr, address: optStr,
});

export async function GET() {
  try {
    await requireAdmin();
    const p = await loadCompanyProfile();
    const row = await prisma.companyProfile.findUnique({ where: { id: CONFIG_ID } });
    return NextResponse.json(
      { data: { ...p, updatedAt: row?.updatedAt ?? null } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireAdmin();
    const body = await parseJsonBody(request);
    const parsed = putSchema.parse(body);

    const data: Partial<Record<(typeof FIELDS)[number], string | null>> = {};
    const changed: string[] = [];
    for (const f of FIELDS) {
      const v = parsed[f];
      if (v === undefined) continue;
      data[f] = v === "" ? null : v;
      changed.push(f);
    }

    const saved = await prisma.companyProfile.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data, updatedById: session.id },
      update: { ...data, updatedById: session.id },
    });

    await writeAuditLog({
      userId: session.id,
      action: "company_profile_update",
      targetTable: "company_profile",
      detail: { target: CONFIG_ID, fields: changed, updatedAt: saved.updatedAt },
    });

    const p = await loadCompanyProfile();
    return NextResponse.json(
      { data: { ...p, updatedAt: saved.updatedAt } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return handleApiError(e);
  }
}
```
※`getApiSession`/`ApiError`/`parseJsonBody`/`handleApiError` の**正確なシグネチャは precedent に合わせて調整**（例：session の null 表現・`ApiError` 引数順）。

`audit-log-detail-safety.ts`：`ACTION_EXTRA_KEYS` に追加（既存様式に合わせる）：
```ts
company_profile_update: new Set(["target", "updatedAt"]),
```
（`fields` は `ALWAYS_SAFE_KEYS` ゆえ生存。値は入らないので追加の許可不要。）

- [ ] **Step 4: 成功確認**

Run: `npx vitest run src/app/api/admin/company-settings/__tests__/route.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add "src/app/api/admin/company-settings/" src/lib/audit-log-detail-safety.ts
git commit -m "feat(sales-sheet): 会社情報 設定API(GET/PUT・管理者のみ・監査)"
```

---

## Task 6: api-client ラッパー

**Files:**
- Modify: `src/lib/api-client.ts`

**先に読むべき precedent**：同ファイル内 `SaleDmSettings`/`EMPTY_SALE_DM_SETTINGS`/`fetchSaleDmSettings`/`updateSaleDmSettings`。

**Interfaces:**
- Produces: `type CompanyProfileSettings`／`EMPTY_COMPANY_PROFILE_SETTINGS`／`fetchCompanySettings()`／`updateCompanySettings(body)`。

- [ ] **Step 1: 実装**（sale-dm 版を写経・エンドポイント `"/api/admin/company-settings"`）

```ts
export type CompanyProfileSettings = {
  nameJa: string; license: string; tel: string; fax: string;
  email: string; hp: string; address: string; updatedAt: string | null;
};
export const EMPTY_COMPANY_PROFILE_SETTINGS: CompanyProfileSettings = {
  nameJa: "", license: "", tel: "", fax: "", email: "", hp: "", address: "", updatedAt: null,
};
export async function fetchCompanySettings(): Promise<{ data: CompanyProfileSettings }> {
  if (USE_MOCK) return { data: EMPTY_COMPANY_PROFILE_SETTINGS };
  return apiGet("/api/admin/company-settings"); // ※既存 apiGet/apiPut ヘルパ名に合わせる
}
export async function updateCompanySettings(
  body: Partial<Omit<CompanyProfileSettings, "updatedAt">>,
): Promise<{ data: CompanyProfileSettings }> {
  if (USE_MOCK) return { data: EMPTY_COMPANY_PROFILE_SETTINGS };
  return apiPut("/api/admin/company-settings", body);
}
```
※`USE_MOCK`・`apiGet`/`apiPut`（or `fetchJson` 等）の**実ヘルパ名は既存ラッパーに合わせる**。

- [ ] **Step 2: ゲート**

Run: `npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: commit**

```bash
git add src/lib/api-client.ts
git commit -m "feat(sales-sheet): 会社情報設定の api-client ラッパー"
```

---

## Task 7: 設定画面 page.tsx＋メニュー追加

**Files:**
- Create: `src/app/(dashboard)/admin/company-settings/page.tsx`
- Modify: `src/components/layout/sidebar.tsx`
- Test: `src/components/layout/__tests__/company-settings-nav-source.test.ts`

**先に読むべき precedent**：`src/app/(dashboard)/admin/sale-dm-settings/page.tsx`（`"use client"`・`Field` ヘルパ・load/save）／`sidebar.tsx` の `adminNavItems`／`__tests__/sale-dm-settings-nav-source.test.ts`。

**Interfaces:**
- Consumes: `fetchCompanySettings`/`updateCompanySettings`/`CompanyProfileSettings`（Task 6）。

- [ ] **Step 1: nav-source テスト（RED）**（sale-dm nav-source を写経）

```ts
// company-settings-nav-source.test.ts
import { readFileSync } from "node:fs";
it("管理メニューに会社情報リンクがある", () => {
  const src = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  expect(src).toContain("/admin/company-settings");
  expect(src).toContain("会社情報");
});
```

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/components/layout/__tests__/company-settings-nav-source.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`sidebar.tsx`：`adminNavItems` に `{ label: "会社情報", href: "/admin/company-settings", icon: <Building2 className="h-4 w-4" /> }` を追加（`lucide-react` から `Building2` を import・既存 import 行に足す）。

`page.tsx`（sale-dm page を写経・秘匿ヘルパ不使用・7項目の `Field`）：
```tsx
"use client";
import { useEffect, useState } from "react";
import { fetchCompanySettings, updateCompanySettings, EMPTY_COMPANY_PROFILE_SETTINGS, type CompanyProfileSettings } from "@/lib/api-client";

export default function CompanySettingsPage() {
  const [s, setS] = useState<CompanyProfileSettings>(EMPTY_COMPANY_PROFILE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchCompanySettings().then((r) => setS(r.data)).catch(() => setMsg("読み込みに失敗しました")).finally(() => setLoading(false));
  }, []);

  const set = (k: keyof CompanyProfileSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS((prev) => ({ ...prev, [k]: e.target.value }));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const { updatedAt, ...body } = s;
      const r = await updateCompanySettings(body);
      setS(r.data); setMsg("保存しました");
    } catch { setMsg("保存に失敗しました（管理者のみ編集できます）"); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="p-6">読み込み中…</div>;
  return (
    <div className="mx-auto max-w-2xl p-6 space-y-4">
      <h1 className="text-xl font-bold">会社情報</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">販売図面 下部の会社帯に表示される情報です。空欄は初期値が使われます。</p>
      <Field label="会社名" value={s.nameJa} onChange={set("nameJa")} hint="長すぎると図面上で切れる場合があります" />
      <Field label="宅建免許番号" value={s.license} onChange={set("license")} />
      <Field label="電話番号" value={s.tel} onChange={set("tel")} />
      <Field label="FAX番号" value={s.fax} onChange={set("fax")} />
      <Field label="メールアドレス" value={s.email} onChange={set("email")} />
      <Field label="ホームページURL" value={s.hp} onChange={set("hp")} />
      <Field label="所在地" value={s.address} onChange={set("address")} hint="郵便番号＋住所" />
      <button onClick={save} disabled={saving} className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50">
        {saving ? "保存中…" : "保存"}
      </button>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}

function Field({ label, value, onChange, hint }: { label: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; hint?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input value={value} onChange={onChange} className="mt-1 w-full rounded border px-3 py-2 dark:bg-gray-800" />
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </label>
  );
}
```
※クラス名・`Field` 様式・ダーク対応は sale-dm page に合わせて整える。

- [ ] **Step 4: 成功確認＋全ゲート**

Run: `npx vitest run` / `npx tsc --noEmit` / `npx eslint <変更ファイル>` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build`
Expected: 全緑・build のルート一覧に `/admin/company-settings` が出る。

- [ ] **Step 5: commit**

```bash
git add "src/app/(dashboard)/admin/company-settings/" src/components/layout/
git commit -m "feat(sales-sheet): 会社情報 設定画面+管理メニュー追加"
```

---

## Task 8: 視覚プレビュー（会社帯）→ 御社確認

**Files:** なし（確認タスク）。

- [ ] mansion doc（会社帯付き）を `render-html.ts` でHTML化し、2×2会社帯（英字社名・協会行なし）の見た目をユーザーへ送付（機能B同様）。ズレがあれば footer-band の定数を微調整（Task 3へ戻る）。

---

## 実装後（全タスク完了時）

- 提出前レビュー（`feature-dev:code-reviewer`・ホットスポット＝認可/監査値漏れ/二重レンダラparity/後方互換）→ push → PR → `@codex review`。
- マージはユーザー。マージ後、**本番反映（migration `company_profile` 適用＋build）は別承認**（vps-deploy）。
