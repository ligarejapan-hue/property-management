# マンション名簿で物件登録を自動補完する Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セルフインから集めた一都三県のマンション一覧を裏の名簿(`mansion_catalog`)に入れ、区分マンションの登録・棟の検索で使えるようにする。

**Architecture:** 名簿は独立した表。文字→数字は純関数(`src/lib/mansion-catalog/parse.ts`)。名簿から棟にする処理は1か所(`adopt.ts`)に集め、物件保存の自動つなぎ込み(`applyBuildingLink` の create)と棟一覧のボタンの両方がそれを使う/同じ考え方で埋める。読み込みは合言葉つきの口(国交省の業者一覧の `crawl-run` と同じ作り)。

**Tech Stack:** Next.js App Router・Prisma(PostgreSQL 16)・vitest(env=node・UI は `renderToStaticMarkup`)。

**Spec:** `docs/superpowers/specs/2026-10-18-mansion-catalog-design.md`

## Global Constraints

- migration は**足すだけ**(新しい表1つ+`buildings.catalog_id` の nullable 列+一意索引)。既存の行を書き換えない。
- 社内の棟の値は**空いている欄だけ**埋める。名簿の取り直しで棟を上書きしない。
- 候補(`/api/buildings/suggest`)で返す住所は**町丁目まで**(番地をURL・応答・ログに載せない)。
- 名簿を読む=`property:read`/名簿から棟にする=`property:write`/読み込み=合言葉 `MANSION_CATALOG_LOAD_SECRET`(未設定=503・不一致=403)。
- ログ・監査には件数・id だけ(住所・建物名を書かない)。
- ロックの鍵は `buildingLinkLockKey(areaKey, nameKey)`(`src/lib/building-link/resolve.ts:75`)を共用する。
- ユーザー向けの文言は平易な日本語。
- 各タスクの最後に `npx tsc --noEmit` と対象テスト。最後のタスクでフルスイート `npx vitest run`・`npx eslint <変更ファイル>`・`npm run build`。

## Review Focus

1. **名簿に同じ名前・同じ丁目の建物が2件ある**(同じマンションの別番号・取得時の重複) → 自動では埋めない(違う建物の値を入れない)。Task 4・5 にテストあり。
2. **名簿の建物がもう棟になっているのに、別の物件の保存が同じ鍵で create に来た**(棟の名前を手で変えた後など) → `catalog_id` の一意制約で保存ごと失敗しない。Task 5 にテストあり。
3. **読み込みファイルに壊れた行・名前や住所の無い行・同じ番号の行** → 飛ばして数える/1件にまとめる。止まらない。Task 3 にテストあり。
4. **全角数字・「不明」・想定外の形**(`地上１４階建`・`総戸数不明`・`不明`) → null にして他の欄は入れる。Task 2 にテストあり。
5. **物件の保存と「マンション棟に登録」ボタンが同時**→ 同じ建物の棟が2つできない。Task 4 に順番の総当たりテストあり。

---

### Task 1: 表を足す(migration+schema)

**Files:**
- Modify: `prisma/schema.prisma`(`model Building` :280-314 に1列+関係、末尾近くに `model MansionCatalog`)
- Create: `prisma/migrations/20261018090000_mansion_catalog/migration.sql`

**Interfaces:**
- Produces: Prisma `mansionCatalog` モデル(列は下の通り)・`Building.catalogId: string | null`・`Building.catalog`・`MansionCatalog.building`

- [ ] **Step 1: schema に足す**

`model Building` の `areaKey` の下に:

```prisma
  // 名簿(mansion_catalog)のどの建物から作った/埋めたか。同じ名簿の建物から棟を2つ作らない鍵(設計 2026-10-18)。
  catalogId           String?   @unique @map("catalog_id") @db.Uuid
```

関係の並び(`photos BuildingPhoto[]` の下)に:

```prisma
  catalog    MansionCatalog? @relation(fields: [catalogId], references: [id], onDelete: SetNull)
```

新しいモデル(`model Building` の直後):

```prisma
/// マンション名簿(セルフイン 全国マンションデータベースの一都三県・2026-10-17 収集・運営会社の許可済み)。
/// 画面の「マンション棟」一覧には並べない。物件登録の補完と、棟の検索の2段目にだけ使う(設計 2026-10-18)。
model MansionCatalog {
  id                String    @id @default(uuid()) @db.Uuid
  source            String
  sourceId          String    @map("source_id")
  name              String
  address           String
  prefCode          String    @map("pref_code")
  stations          String[]
  builtYear         Int?      @map("built_year")
  builtMonth        Int?      @map("built_month")
  totalFloors       Int?      @map("total_floors")
  basementFloors    Int?      @map("basement_floors")
  totalUnits        Int?      @map("total_units")
  structureType     String?   @map("structure_type")
  developer         String?
  managementCompany String?   @map("management_company")
  raw               Json      @db.JsonB
  nameKey           String?   @map("name_key")
  areaKey           String?   @map("area_key")
  fetchedAt         DateTime  @map("fetched_at")
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")

  building Building?

  @@unique([source, sourceId])
  @@index([areaKey, nameKey])
  @@index([nameKey])
  @@index([name])
  @@map("mansion_catalog")
}
```

- [ ] **Step 2: migration を作る**

Run: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script --shadow-database-url "$SHADOW_DATABASE_URL"`
(シャドウDBが無い手元では、下の SQL をそのまま書く)

`prisma/migrations/20261018090000_mansion_catalog/migration.sql`:

```sql
-- マンション名簿(セルフイン 一都三県)と、棟がどの名簿の建物から来たかの列(2026-10-18 発注者承認)。足すだけ。
CREATE TABLE "mansion_catalog" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "pref_code" TEXT NOT NULL,
    "stations" TEXT[],
    "built_year" INTEGER,
    "built_month" INTEGER,
    "total_floors" INTEGER,
    "basement_floors" INTEGER,
    "total_units" INTEGER,
    "structure_type" TEXT,
    "developer" TEXT,
    "management_company" TEXT,
    "raw" JSONB NOT NULL,
    "name_key" TEXT,
    "area_key" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mansion_catalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mansion_catalog_source_source_id_key" ON "mansion_catalog"("source", "source_id");
CREATE INDEX "mansion_catalog_area_key_name_key_idx" ON "mansion_catalog"("area_key", "name_key");
CREATE INDEX "mansion_catalog_name_key_idx" ON "mansion_catalog"("name_key");
CREATE INDEX "mansion_catalog_name_idx" ON "mansion_catalog"("name");

ALTER TABLE "buildings" ADD COLUMN "catalog_id" UUID;
CREATE UNIQUE INDEX "buildings_catalog_id_key" ON "buildings"("catalog_id");
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "mansion_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

⚠diff を使った場合は、出た SQL が上と同じ中身(足すだけ)かを見比べる。違う列の変更が混ざったら、それは schema と migration の既存のずれ(MEMORY の「DEFAULTずれ7表」)なので**入れない**。

- [ ] **Step 3: 型を作り直して確かめる**

Run: `npx prisma generate && npx prisma validate && npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261018090000_mansion_catalog
git commit -m "feat(db): マンション名簿の表と棟の catalog_id を足す(足すだけ)"
```

---

### Task 2: 取った1行を名簿の行にする(純関数)

**Files:**
- Create: `src/lib/mansion-catalog/parse.ts`
- Test: `src/lib/mansion-catalog/__tests__/parse.test.ts`

**Interfaces:**
- Consumes: `buildingNameKey`, `areaKey`(`src/lib/building-identity.ts`)
- Produces:
  - `export const CATALOG_SOURCE = "selfin"`
  - `export interface CatalogRow { source: string; sourceId: string; name: string; address: string; prefCode: string; stations: string[]; builtYear: number | null; builtMonth: number | null; totalFloors: number | null; basementFloors: number | null; totalUnits: number | null; structureType: string | null; developer: string | null; managementCompany: string | null; raw: Record<string, unknown>; nameKey: string | null; areaKey: string | null; fetchedAt: Date }`
  - `export function parseCompleted(s: string | null): { year: number; month: number | null } | null`
  - `export function parseFloors(s: string | null): { above: number | null; below: number | null }`
  - `export function parseUnits(s: string | null): number | null`
  - `export function cleanText(s: unknown): string | null`
  - `export function toCatalogRow(line: string): CatalogRow | null`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from "vitest";
import { parseCompleted, parseFloors, parseUnits, cleanText, toCatalogRow } from "@/lib/mansion-catalog/parse";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

// 実データ(2026-10-17 東京 26,640件)で見た形をそのまま使う。
const LINE = JSON.stringify({
  pref: "13", page: 1, fetchedAt: "2026-10-17T02:28:52.096Z", id: "2093122", name: "プラウド青砥",
  address: "東京都葛飾区青戸4丁目2番14号", stations: ["お花茶屋駅より 徒歩10分", "青砥駅より 徒歩13分"],
  completed: "2026年9月", structure: "RC（鉄筋コンクリート）", floors: "地上14階建", units: "155戸",
  developer: "野村不動産", manager: "野村不動産パートナーズ",
});

describe("文字を数字に", () => {
  it("竣工年月", () => {
    expect(parseCompleted("2026年9月")).toEqual({ year: 2026, month: 9 });
    expect(parseCompleted("１９７８年５月")).toEqual({ year: 1978, month: 5 });
    expect(parseCompleted("1978年")).toEqual({ year: 1978, month: null });
    expect(parseCompleted("不明")).toBeNull();
    expect(parseCompleted("2026年13月")).toEqual({ year: 2026, month: null });
    expect(parseCompleted(null)).toBeNull();
  });
  it("階建(地上・地下)", () => {
    expect(parseFloors("地上14階建")).toEqual({ above: 14, below: null });
    expect(parseFloors("地上10階建 地下1階")).toEqual({ above: 10, below: 1 });
    expect(parseFloors("地上１０階建　地下２階")).toEqual({ above: 10, below: 2 });
    expect(parseFloors("不明")).toEqual({ above: null, below: null });
    expect(parseFloors(null)).toEqual({ above: null, below: null });
  });
  it("総戸数", () => {
    expect(parseUnits("155戸")).toBe(155);
    expect(parseUnits("１，２００戸")).toBe(1200);
    expect(parseUnits("総戸数不明")).toBeNull();
    expect(parseUnits("0戸")).toBeNull();
  });
  it("不明・空は null", () => {
    expect(cleanText("不明")).toBeNull();
    expect(cleanText("  ")).toBeNull();
    expect(cleanText(3)).toBeNull();
    expect(cleanText(" 野村不動産 ")).toBe("野村不動産");
  });
});

describe("toCatalogRow", () => {
  it("1行を名簿の行にする(比べる形も入れる・取ったままも raw に残す)", () => {
    const r = toCatalogRow(LINE)!;
    expect(r).toMatchObject({
      source: "selfin", sourceId: "2093122", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号",
      prefCode: "13", builtYear: 2026, builtMonth: 9, totalFloors: 14, basementFloors: null, totalUnits: 155,
      structureType: "RC（鉄筋コンクリート）", developer: "野村不動産", managementCompany: "野村不動産パートナーズ",
      nameKey: buildingNameKey("プラウド青砥"), areaKey: areaKey("東京都葛飾区青戸4丁目2番14号"),
    });
    expect(r.stations).toEqual(["お花茶屋駅より 徒歩10分", "青砥駅より 徒歩13分"]);
    expect(r.fetchedAt.toISOString()).toBe("2026-10-17T02:28:52.096Z");
    expect(r.raw).toMatchObject({ floors: "地上14階建", units: "155戸" });
  });
  it("★壊れた行・番号/名前/住所の無い行は null(読み込みで飛ばして数える)", () => {
    expect(toCatalogRow("{")).toBeNull();
    expect(toCatalogRow("")).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), name: "" }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), address: null }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), id: "abc" }))).toBeNull();
    expect(toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), pref: "99" }))).toBeNull();
  });
  it("★構造「不明」・取った時刻が読めないときも、他の欄は入れる", () => {
    const r = toCatalogRow(JSON.stringify({ ...JSON.parse(LINE), structure: "不明", fetchedAt: "x", stations: "x" }))!;
    expect(r.structureType).toBeNull();
    expect(r.stations).toEqual([]);
    expect(Number.isNaN(r.fetchedAt.getTime())).toBe(false);
    expect(r.totalUnits).toBe(155);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/mansion-catalog/__tests__/parse.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
/**
 * セルフインの一覧から取った1行(collect.cjs の JSONL)を、名簿の行にする。DB を触らない純関数(設計 2026-10-18 §4)。
 * ⚠数字に直せない値は null(他の欄は入れる)。取った文字は raw にそのまま残す。
 */
import { areaKey, buildingNameKey } from "@/lib/building-identity";

export const CATALOG_SOURCE = "selfin";
/** 一都三県(東京・神奈川・埼玉・千葉)。 */
const PREF_CODES = new Set(["13", "14", "11", "12"]);

export interface CatalogRow {
  source: string;
  sourceId: string;
  name: string;
  address: string;
  prefCode: string;
  stations: string[];
  builtYear: number | null;
  builtMonth: number | null;
  totalFloors: number | null;
  basementFloors: number | null;
  totalUnits: number | null;
  structureType: string | null;
  developer: string | null;
  managementCompany: string | null;
  raw: Record<string, unknown>;
  nameKey: string | null;
  areaKey: string | null;
  fetchedAt: Date;
}

const nfkc = (s: string) => s.normalize("NFKC");

export function cleanText(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t === "" || t === "不明" ? null : t;
}

export function parseCompleted(s: string | null): { year: number; month: number | null } | null {
  if (!s) return null;
  const m = nfkc(s).match(/(\d{4})年(?:\s*(\d{1,2})月)?/);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : null;
  return { year: Number(m[1]), month: month !== null && month >= 1 && month <= 12 ? month : null };
}

export function parseFloors(s: string | null): { above: number | null; below: number | null } {
  if (!s) return { above: null, below: null };
  const t = nfkc(s);
  const above = t.match(/地上\s*(\d+)\s*階/);
  const below = t.match(/地下\s*(\d+)\s*階/);
  const n = (m: RegExpMatchArray | null) => (m && Number(m[1]) > 0 ? Number(m[1]) : null);
  return { above: n(above), below: n(below) };
}

export function parseUnits(s: string | null): number | null {
  if (!s) return null;
  const m = nfkc(s).replace(/,/g, "").match(/(\d+)\s*戸/);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

export function toCatalogRow(line: string): CatalogRow | null {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const sourceId = typeof o.id === "string" && /^\d+$/.test(o.id) ? o.id : null;
  const name = cleanText(o.name);
  const address = cleanText(o.address);
  const prefCode = typeof o.pref === "string" && PREF_CODES.has(o.pref) ? o.pref : null;
  if (!sourceId || !name || !address || !prefCode) return null;
  const completed = parseCompleted(cleanText(o.completed));
  const floors = parseFloors(cleanText(o.floors));
  const fetched = typeof o.fetchedAt === "string" ? new Date(o.fetchedAt) : new Date(NaN);
  return {
    source: CATALOG_SOURCE,
    sourceId,
    name,
    address,
    prefCode,
    stations: Array.isArray(o.stations) ? o.stations.map(cleanText).filter((x): x is string => x !== null) : [],
    builtYear: completed?.year ?? null,
    builtMonth: completed?.month ?? null,
    totalFloors: floors.above,
    basementFloors: floors.below,
    totalUnits: parseUnits(cleanText(o.units)),
    structureType: cleanText(o.structure),
    developer: cleanText(o.developer),
    managementCompany: cleanText(o.manager),
    raw: o,
    nameKey: buildingNameKey(name),
    areaKey: areaKey(address),
    // 読めない時刻は「今」にしない(呼び出し側の時計に任せず、固定の値にする=テストが時計に依存しない)。
    fetchedAt: Number.isNaN(fetched.getTime()) ? new Date(0) : fetched,
  };
}
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run src/lib/mansion-catalog/__tests__/parse.test.ts && npx tsc --noEmit`
Expected: PASS・エラー0

- [ ] **Step 5: Commit**

```bash
git add src/lib/mansion-catalog
git commit -m "feat(mansion-catalog): 取った1行を名簿の行にする(竣工・階建・戸数を数字に)"
```

---

### Task 3: 名簿に読み込む(読み込みの関数+合言葉の口)

**Files:**
- Create: `src/lib/mansion-catalog/load.ts`
- Create: `src/lib/mansion-catalog/store.ts`
- Create: `src/app/api/mansion-catalog/load-run/route.ts`
- Modify: `src/proxy.ts:24-35`(`PUBLIC_EXACT_PATHS` に1行)
- Modify: `deploy/env/app.env.example`(`AGENT_REGISTRY_DAYTIME_DAYS` の行の下に2行)
- Test: `src/lib/mansion-catalog/__tests__/load.test.ts`, `src/app/api/mansion-catalog/load-run/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `toCatalogRow`, `CatalogRow`(Task 2)
- Produces:
  - `export const LOAD_BATCH = 500`
  - `export interface CatalogStore { upsertMany(rows: CatalogRow[]): Promise<{ inserted: number; updated: number }> }`
  - `export interface LoadResult { inserted: number; updated: number; skipped: number; duplicates: number }`
  - `export async function loadCatalogLines(lines: AsyncIterable<string> | Iterable<string>, store: CatalogStore): Promise<LoadResult>`
  - `export function createPrismaCatalogStore(): CatalogStore`(store.ts)
  - route `POST /api/mansion-catalog/load-run`(header `x-mansion-catalog-secret`)。応答 `{ files: number, ...LoadResult, linked: number }`(`linked` は Task 6 で足す。ここでは 0 固定)

- [ ] **Step 1: 失敗するテストを書く(load)**

```ts
import { describe, it, expect } from "vitest";
import { loadCatalogLines, LOAD_BATCH, type CatalogStore } from "@/lib/mansion-catalog/load";
import type { CatalogRow } from "@/lib/mansion-catalog/parse";

const line = (id: string, name = `棟${id}`) =>
  JSON.stringify({ pref: "13", page: 1, fetchedAt: "2026-10-17T00:00:00Z", id, name, address: "東京都葛飾区青戸4丁目2番14号", stations: [], completed: "2000年1月", structure: "RC", floors: "地上5階建", units: "20戸", developer: null, manager: null });

function fakeStore() {
  const rows = new Map<string, CatalogRow>();
  const batches: number[] = [];
  const store: CatalogStore = {
    async upsertMany(batch) {
      batches.push(batch.length);
      let inserted = 0;
      for (const r of batch) {
        if (!rows.has(r.sourceId)) inserted++;
        rows.set(r.sourceId, r);
      }
      return { inserted, updated: batch.length - inserted };
    },
  };
  return { store, rows, batches };
}

describe("loadCatalogLines", () => {
  it("500件ずつ入れ、入れた/更新した数を返す", async () => {
    const f = fakeStore();
    const lines = Array.from({ length: LOAD_BATCH + 3 }, (_, i) => line(String(i + 1)));
    const r = await loadCatalogLines(lines, f.store);
    expect(r).toEqual({ inserted: LOAD_BATCH + 3, updated: 0, skipped: 0, duplicates: 0 });
    expect(f.batches).toEqual([LOAD_BATCH, 3]);
  });
  it("★壊れた行は飛ばして数え、同じ番号は後の行で1件にまとめる", async () => {
    const f = fakeStore();
    const r = await loadCatalogLines(["{", "", line("1", "古い名前"), line("2"), line("1", "新しい名前")], f.store);
    expect(r).toEqual({ inserted: 2, updated: 0, skipped: 2, duplicates: 1 });
    expect(f.rows.get("1")?.name).toBe("新しい名前");
  });
  it("2回目は更新として数える", async () => {
    const f = fakeStore();
    await loadCatalogLines([line("1")], f.store);
    expect(await loadCatalogLines([line("1")], f.store)).toEqual({ inserted: 0, updated: 1, skipped: 0, duplicates: 0 });
  });
});
```

⚠「同じ番号は1件にまとめる」はファイル全体で見る(並びの同点で別ページに出るため)。まとめるため、全行を一度 Map に貯めてから 500 件ずつ送る(8万8千件・1件1KB 程度=100MB 未満なので一度に持ってよい)。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/mansion-catalog/__tests__/load.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: load.ts を書く**

```ts
/**
 * 名簿の読み込み(設計 2026-10-18 §4)。DB は CatalogStore 越しにだけ触る(テストで差し替える)。
 * ⚠同じ建物番号は**ファイル全体で**1件にまとめる(後の行が勝つ)。並びの同点で同じ建物が2ページに出るため。
 */
import { toCatalogRow, type CatalogRow } from "./parse";

export const LOAD_BATCH = 500;

export interface CatalogStore {
  upsertMany(rows: CatalogRow[]): Promise<{ inserted: number; updated: number }>;
}
export interface LoadResult { inserted: number; updated: number; skipped: number; duplicates: number }

export async function loadCatalogLines(
  lines: AsyncIterable<string> | Iterable<string>,
  store: CatalogStore,
): Promise<LoadResult> {
  const byId = new Map<string, CatalogRow>();
  let skipped = 0;
  let duplicates = 0;
  for await (const raw of lines) {
    const row = toCatalogRow(raw.trim());
    if (!row) {
      skipped++;
      continue;
    }
    const key = `${row.source}:${row.sourceId}`;
    if (byId.has(key)) {
      duplicates++;
      byId.delete(key); // 後の行を最後に並べ直す(Map の順)
    }
    byId.set(key, row);
  }
  const rows = [...byId.values()];
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += LOAD_BATCH) {
    const r = await store.upsertMany(rows.slice(i, i + LOAD_BATCH));
    inserted += r.inserted;
    updated += r.updated;
  }
  return { inserted, updated, skipped, duplicates };
}
```

- [ ] **Step 4: store.ts を書く(Prisma)**

```ts
/** 名簿の読み込みの DB 側。1回 500 件を1つのトランザクションで入れる/更新する。 */
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { CatalogStore } from "./load";
import type { CatalogRow } from "./parse";

const data = (r: CatalogRow) => ({
  name: r.name,
  address: r.address,
  prefCode: r.prefCode,
  stations: r.stations,
  builtYear: r.builtYear,
  builtMonth: r.builtMonth,
  totalFloors: r.totalFloors,
  basementFloors: r.basementFloors,
  totalUnits: r.totalUnits,
  structureType: r.structureType,
  developer: r.developer,
  managementCompany: r.managementCompany,
  raw: r.raw as Prisma.InputJsonValue,
  nameKey: r.nameKey,
  areaKey: r.areaKey,
  fetchedAt: r.fetchedAt,
});

export function createPrismaCatalogStore(): CatalogStore {
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return { inserted: 0, updated: 0 };
      return prisma.$transaction(async (tx) => {
        const existing = await tx.mansionCatalog.findMany({
          where: { OR: rows.map((r) => ({ source: r.source, sourceId: r.sourceId })) },
          select: { source: true, sourceId: true },
        });
        const have = new Set(existing.map((e) => `${e.source}:${e.sourceId}`));
        for (const r of rows) {
          await tx.mansionCatalog.upsert({
            where: { source_sourceId: { source: r.source, sourceId: r.sourceId } },
            create: { source: r.source, sourceId: r.sourceId, ...data(r) },
            update: data(r),
          });
        }
        const updated = rows.filter((r) => have.has(`${r.source}:${r.sourceId}`)).length;
        return { inserted: rows.length - updated, updated };
      }, { timeout: 60_000 });
    },
  };
}
```

- [ ] **Step 5: 失敗するテストを書く(route)**

`src/app/api/mansion-catalog/load-run/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const upsertMany = vi.fn(async (rows: unknown[]) => ({ inserted: rows.length, updated: 0 }));
vi.mock("@/lib/mansion-catalog/store", () => ({ createPrismaCatalogStore: () => ({ upsertMany }) }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error {
    constructor(public status: number, message: string, public code = "ERROR") { super(message); }
  }
  return {
    ApiError: MockApiError,
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status ?? 500 });
    },
  };
});
import { POST } from "../route";

const LINE = JSON.stringify({ pref: "13", page: 1, fetchedAt: "2026-10-17T00:00:00Z", id: "1", name: "棟", address: "東京都葛飾区青戸4丁目2番14号", stations: [], completed: null, structure: null, floors: null, units: null, developer: null, manager: null });
const req = (secret?: string) =>
  new Request("http://localhost/api/mansion-catalog/load-run", { method: "POST", headers: secret ? { "x-mansion-catalog-secret": secret } : {} });

let dir: string;
const saved = { s: process.env.MANSION_CATALOG_LOAD_SECRET, d: process.env.MANSION_CATALOG_DIR };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-"));
  upsertMany.mockClear();
  delete process.env.MANSION_CATALOG_LOAD_SECRET;
  delete process.env.MANSION_CATALOG_DIR;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.s === undefined) delete process.env.MANSION_CATALOG_LOAD_SECRET; else process.env.MANSION_CATALOG_LOAD_SECRET = saved.s;
  if (saved.d === undefined) delete process.env.MANSION_CATALOG_DIR; else process.env.MANSION_CATALOG_DIR = saved.d;
});

describe("POST /api/mansion-catalog/load-run", () => {
  it("合言葉が未設定なら 503(休眠)", async () => {
    expect((await POST(req("x"))).status).toBe(503);
  });
  it("合言葉が違えば 403・何も読まない", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    process.env.MANSION_CATALOG_DIR = dir;
    expect((await POST(req("nope"))).status).toBe(403);
    expect(upsertMany).not.toHaveBeenCalled();
  });
  it("フォルダが未設定なら 503", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    expect((await POST(req("s3cret"))).status).toBe(503);
  });
  it("決まった名前のファイルだけ読み、件数だけ返す", async () => {
    process.env.MANSION_CATALOG_LOAD_SECRET = "s3cret";
    process.env.MANSION_CATALOG_DIR = dir;
    writeFileSync(join(dir, "buildings-13.jsonl"), LINE + "\n{\n");
    writeFileSync(join(dir, "other.jsonl"), LINE + "\n");
    const res = await POST(req("s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ files: 1, inserted: 1, updated: 0, skipped: 1, duplicates: 0 });
  });
  it("proxy の公開リストに載っている(無いと 307 でログインへ飛ばされる)", () => {
    const src = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(src).toContain('"/api/mansion-catalog/load-run"');
  });
});
```

- [ ] **Step 6: route を書く**

```ts
import { timingSafeEqual } from "crypto";
import { createReadStream, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { loadCatalogLines } from "@/lib/mansion-catalog/load";
import { createPrismaCatalogStore } from "@/lib/mansion-catalog/store";

/**
 * POST /api/mansion-catalog/load-run — 集めたマンション一覧(JSONL)を名簿に読み込む(設計 2026-10-18 §4)。
 * 作りは国交省の業者一覧の crawl-run と同じ:
 * - `MANSION_CATALOG_LOAD_SECRET` 未設定なら 503(休眠)・header `x-mansion-catalog-secret` 不一致は 403
 * - 読むのは `MANSION_CATALOG_DIR` の `buildings-<2桁>.jsonl` だけ(未設定なら 503)
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスが必要
 * - 返す・ログに出すのは件数だけ(建物名・住所を出さない)
 */
let running = false;
const FILE_RE = /^buildings-\d{2}\.jsonl$/;

async function* readLines(dir: string, files: string[]) {
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(dir, f), { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim() !== "") yield line;
  }
}

export async function POST(request: Request) {
  try {
    const secret = process.env.MANSION_CATALOG_LOAD_SECRET;
    if (!secret) throw new ApiError(503, "マンション名簿の読み込みは未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-mansion-catalog-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const dir = process.env.MANSION_CATALOG_DIR;
    if (!dir) throw new ApiError(503, "マンション名簿のフォルダが未設定です", "NOT_CONFIGURED");
    if (running) throw new ApiError(409, "前の読み込みがまだ動いています", "ALREADY_RUNNING");
    running = true;
    try {
      const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
      const result = await loadCatalogLines(readLines(dir, files), createPrismaCatalogStore());
      const linked = 0; // Task 6 で今ある棟をつなぐ
      console.log(
        `[mansion-catalog] files=${files.length} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} duplicates=${result.duplicates} linked=${linked}`,
      );
      return apiResponse({ files: files.length, ...result, linked });
    } finally {
      running = false;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
```

`src/proxy.ts` の `"/api/agent-registry/crawl-run",` の下に:

```ts
  // マンション名簿の読み込み(手で1回叩く・合言葉で守る・未設定なら 503)。
  "/api/mansion-catalog/load-run",
```

`deploy/env/app.env.example` の `AGENT_REGISTRY_DAYTIME_DAYS` の行の下に:

```
# マンション名簿(セルフイン)の読み込み口。未設定なら休眠(503)。
# MANSION_CATALOG_LOAD_SECRET="<openssl rand -base64 32 で生成>"
# MANSION_CATALOG_DIR="/var/lib/property-management/mansion-catalog"
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run src/lib/mansion-catalog src/app/api/mansion-catalog src/__tests__ 2>&1 | tail -5; npx tsc --noEmit`
(`src/__tests__` 等にある proxy の走査テストも通ること。proxy のテストの場所は `grep -rln "isPublicPath" src --include=*.test.ts` で探して一緒に流す)
Expected: PASS・エラー0

- [ ] **Step 8: Commit**

```bash
git add src/lib/mansion-catalog src/app/api/mansion-catalog src/proxy.ts deploy/env/app.env.example
git commit -m "feat(mansion-catalog): 集めた一覧を名簿に読み込む口(合言葉・件数だけ返す)"
```

---

### Task 4: 名簿から棟にする(adopt)

**Files:**
- Create: `src/lib/mansion-catalog/adopt.ts`
- Test: `src/lib/mansion-catalog/__tests__/adopt.test.ts`

**Interfaces:**
- Consumes: `buildingLinkLockKey`(`src/lib/building-link/resolve.ts`)
- Produces:
  - `export interface CatalogEntry { id: string; name: string; address: string; builtYear: number | null; builtMonth: number | null; totalFloors: number | null; basementFloors: number | null; totalUnits: number | null; structureType: string | null; managementCompany: string | null; nameKey: string | null; areaKey: string | null }`
  - `export const CATALOG_FILL_FIELDS = ["builtYear","builtMonth","totalFloors","basementFloors","totalUnits","structureType","managementCompany"] as const`
  - `export type CatalogFill = Partial<Record<(typeof CATALOG_FILL_FIELDS)[number], number | string>>`
  - `export function catalogFillValues(c: CatalogEntry): CatalogFill`(null の欄は含めない)
  - `export function fillEmptyFromCatalog(existing: Record<string, unknown>, c: CatalogEntry): CatalogFill`(existing の欄が null/undefined のものだけ)
  - `export const CATALOG_ENTRY_SELECT`(Prisma の select・上の CatalogEntry の列)
  - `export type AdoptTx`(下のコード)
  - `export type AdoptResult = { kind: "existing" | "linked" | "created"; building: { id: string; name: string } } | { kind: "ambiguous" } | { kind: "not_found" } | { kind: "none" }`
  - `export async function adoptCatalogBuilding(tx: AdoptTx, catalogId: string, userId: string | null, opts?: { create?: boolean }): Promise<AdoptResult>`
    - `none` = `create: false`(または userId が null)で、つなぐ棟が無かった(作らない)。Task 6 の後処理が使う。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect, vi } from "vitest";
import { adoptCatalogBuilding, fillEmptyFromCatalog, catalogFillValues, type AdoptTx, type CatalogEntry } from "@/lib/mansion-catalog/adopt";
import { buildingLinkLockKey } from "@/lib/building-link/resolve";

const C: CatalogEntry = {
  id: "c1", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9,
  totalFloors: 14, basementFloors: null, totalUnits: 155, structureType: "RC（鉄筋コンクリート）",
  managementCompany: "野村不動産パートナーズ", nameKey: "プラウド青砥", areaKey: "東京都葛飾区青戸4丁目",
};
type B = { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; catalogId: string | null; createdBy: string } & Record<string, unknown>;

function fakeTx(buildings: B[], catalog: CatalogEntry[] = [C], lock?: (k: string) => Promise<void>) {
  let seq = 0;
  const audits: unknown[] = [];
  const tx = {
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => { if (lock) await lock(String(v[0])); return 0; }),
    mansionCatalog: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => catalog.find((c) => c.id === where.id) ?? null) },
    building: {
      findFirst: vi.fn(async ({ where }: { where: { catalogId: string } }) => buildings.find((b) => b.catalogId === where.catalogId) ?? null),
      findMany: vi.fn(async ({ where }: { where: { areaKey: string; nameKey: string } }) =>
        buildings.filter((b) => b.areaKey === where.areaKey && b.nameKey === where.nameKey)),
      create: vi.fn(async ({ data }: { data: Omit<B, "id"> }) => {
        if (data.catalogId && buildings.some((b) => b.catalogId === data.catalogId)) throw new Error("unique catalog_id");
        const b = { id: `new-${++seq}`, ...data } as B;
        buildings.push(b);
        return { id: b.id, name: b.name };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<B> }) => {
        const b = buildings.find((x) => x.id === where.id)!;
        Object.assign(b, data);
        return { id: b.id, name: b.name };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: unknown }) => { audits.push(data); return { id: "a" }; }) },
  };
  return { tx: tx as unknown as AdoptTx, audits, buildings };
}

describe("fillEmptyFromCatalog", () => {
  it("空いている欄だけ。手で入れた値は変えない", () => {
    expect(fillEmptyFromCatalog({ builtYear: 1990, totalFloors: null, totalUnits: undefined }, C)).toEqual({
      builtMonth: 9, totalFloors: 14, totalUnits: 155, structureType: "RC（鉄筋コンクリート）", managementCompany: "野村不動産パートナーズ",
    });
    expect(catalogFillValues(C)).not.toHaveProperty("basementFloors");
  });
});

describe("adoptCatalogBuilding", () => {
  it("名簿の建物が無ければ not_found", async () => {
    const f = fakeTx([], []);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toEqual({ kind: "not_found" });
  });
  it("同じ鍵の棟が無ければ、名簿の値を入れて作る(catalog_id 付き・監査は id だけ)", async () => {
    const f = fakeTx([]);
    const r = await adoptCatalogBuilding(f.tx, "c1", "u1");
    expect(r).toMatchObject({ kind: "created" });
    expect(f.buildings[0]).toMatchObject({ name: "プラウド青砥", address: C.address, catalogId: "c1", totalFloors: 14, totalUnits: 155, nameKey: C.nameKey, areaKey: C.areaKey, createdBy: "u1" });
    expect(f.audits).toEqual([{ userId: "u1", action: "building.catalog_adopt", targetTable: "buildings", targetId: f.buildings[0].id, detail: { catalogId: "c1", kind: "created" } }]);
  });
  it("ロックの鍵は物件の保存と同じ", async () => {
    const f = fakeTx([]);
    await adoptCatalogBuilding(f.tx, "c1", "u1");
    expect((f.tx.$executeRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toBe(buildingLinkLockKey(C.areaKey, C.nameKey!));
  });
  it("もう棟になっていれば、その棟を返す(何も変えない)", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: "z", areaKey: "z", catalogId: "c1", createdBy: "u0" }]);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toEqual({ kind: "existing", building: { id: "b1", name: "プラウド青砥" } });
    expect(f.audits).toEqual([]);
  });
  it("同じ鍵の自社の棟が1つなら、つないで空いている欄だけ埋める", async () => {
    const f = fakeTx([{ id: "b1", name: "プラウド青砥", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0", builtYear: 2025, totalFloors: null }]);
    expect(await adoptCatalogBuilding(f.tx, "c1", "u1")).toMatchObject({ kind: "linked", building: { id: "b1" } });
    expect(f.buildings[0]).toMatchObject({ catalogId: "c1", builtYear: 2025, totalFloors: 14 });
  });
  it("★同じ鍵の棟が2つ・または別の名簿の建物につながった棟なら ambiguous(どれにも付けない・作らない)", async () => {
    const two = fakeTx([
      { id: "b1", name: "a", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0" },
      { id: "b2", name: "b", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: null, createdBy: "u0" },
    ]);
    expect(await adoptCatalogBuilding(two.tx, "c1", "u1")).toEqual({ kind: "ambiguous" });
    const other = fakeTx([{ id: "b1", name: "a", address: "x", nameKey: C.nameKey, areaKey: C.areaKey, catalogId: "c9", createdBy: "u0" }]);
    expect(await adoptCatalogBuilding(other.tx, "c1", "u1")).toEqual({ kind: "ambiguous" });
    expect(two.buildings).toHaveLength(2);
  });
  it("create:false のときは作らず none", async () => {
    const f = fakeTx([]);
    expect(await adoptCatalogBuilding(f.tx, "c1", null, { create: false })).toEqual({ kind: "none" });
    expect(f.buildings).toHaveLength(0);
  });
  it("★同時に2回呼ばれても棟は1つ(ロックはトランザクションの終わりまで続く=順番に並べて写す)", async () => {
    const buildings: B[] = [];
    const a = fakeTx(buildings);
    const run = serialLock();
    const rs = await Promise.all([run(() => adoptCatalogBuilding(a.tx, "c1", "u1")), run(() => adoptCatalogBuilding(a.tx, "c1", "u2"))]);
    expect(buildings).toHaveLength(1);
    expect(rs.map((r) => r.kind)).toEqual(["created", "existing"]);
  });
});

/** 本物のアドバイザリロックは tx の終わりまで続く。後から来た呼び出しは、前の呼び出しが終わるまで待つ。 */
function serialLock() {
  let tail = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
```

⚠物件の保存(applyBuildingLink)と adopt が同時に来た場合は、同じ鍵のロックを取るので同じく順番に並ぶ。片方が棟を作れば、もう片方はロックのあとの読み直しでその棟を見つける(Task 5 の `catalogForNewBuilding` は「もう棟になっている」を見て入れない/adopt は同じ鍵の棟1つにつなぐ)。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/mansion-catalog/__tests__/adopt.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
/**
 * 名簿の建物を「マンション棟」にする(設計 2026-10-18 §5)。どの入口もここを通す。
 * ⚠必ず呼ぶ側のトランザクションの tx を渡す。ロックの鍵は物件の保存(applyBuildingLink)と同じ
 *   buildingLinkLockKey=同時に来た保存と取り込みが同じ建物の棟を2つ作らない。
 * ⚠社内の棟は**空いている欄だけ**埋める。名前・住所・手で入れた値は変えない。
 */
import type { Prisma } from "@/generated/prisma";
import { buildingLinkLockKey } from "@/lib/building-link/resolve";

export interface CatalogEntry {
  id: string; name: string; address: string;
  builtYear: number | null; builtMonth: number | null;
  totalFloors: number | null; basementFloors: number | null; totalUnits: number | null;
  structureType: string | null; managementCompany: string | null;
  nameKey: string | null; areaKey: string | null;
}
export const CATALOG_ENTRY_SELECT = {
  id: true, name: true, address: true, builtYear: true, builtMonth: true, totalFloors: true,
  basementFloors: true, totalUnits: true, structureType: true, managementCompany: true, nameKey: true, areaKey: true,
} as const;
export const CATALOG_FILL_FIELDS = [
  "builtYear", "builtMonth", "totalFloors", "basementFloors", "totalUnits", "structureType", "managementCompany",
] as const;
export type CatalogFill = Partial<Record<(typeof CATALOG_FILL_FIELDS)[number], number | string>>;

export function catalogFillValues(c: CatalogEntry): CatalogFill {
  const out: CatalogFill = {};
  for (const f of CATALOG_FILL_FIELDS) if (c[f] !== null) out[f] = c[f] as number | string;
  return out;
}
export function fillEmptyFromCatalog(existing: Record<string, unknown>, c: CatalogEntry): CatalogFill {
  const values = catalogFillValues(c);
  const out: CatalogFill = {};
  for (const f of CATALOG_FILL_FIELDS) {
    if (values[f] !== undefined && (existing[f] === null || existing[f] === undefined)) out[f] = values[f];
  }
  return out;
}

export type AdoptTx = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  mansionCatalog: Pick<Prisma.TransactionClient["mansionCatalog"], "findUnique">;
  building: Pick<Prisma.TransactionClient["building"], "findFirst" | "findMany" | "create" | "update">;
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "create">;
};
export type AdoptResult =
  | { kind: "existing" | "linked" | "created"; building: { id: string; name: string } }
  | { kind: "ambiguous" }
  | { kind: "not_found" }
  | { kind: "none" };

const BUILDING_FILL_SELECT = {
  id: true, name: true, catalogId: true,
  builtYear: true, builtMonth: true, totalFloors: true, basementFloors: true, totalUnits: true, structureType: true, managementCompany: true,
} as const;

export async function adoptCatalogBuilding(
  tx: AdoptTx,
  catalogId: string,
  userId: string | null,
  opts: { create?: boolean } = {},
): Promise<AdoptResult> {
  const c = await tx.mansionCatalog.findUnique({ where: { id: catalogId }, select: CATALOG_ENTRY_SELECT });
  if (!c) return { kind: "not_found" };
  // ⚠$executeRaw + ::bigint(apply.ts と同じ書き方)。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildingLinkLockKey(c.areaKey, c.nameKey ?? "")})::bigint)`;
  // ロックのあとに読み直す。
  const already = await tx.building.findFirst({ where: { catalogId: c.id }, select: { id: true, name: true } });
  if (already) return { kind: "existing", building: { id: already.id, name: already.name } };
  const sameKey = c.areaKey !== null && c.nameKey !== null
    ? await tx.building.findMany({ where: { areaKey: c.areaKey, nameKey: c.nameKey }, select: BUILDING_FILL_SELECT, take: 3 })
    : [];
  const audit = (buildingId: string, kind: "linked" | "created") =>
    tx.auditLog.create({
      data: { userId, action: "building.catalog_adopt", targetTable: "buildings", targetId: buildingId, detail: { catalogId: c.id, kind } },
    });
  if (sameKey.length === 1 && sameKey[0].catalogId === null) {
    const b = await tx.building.update({
      where: { id: sameKey[0].id },
      data: { catalogId: c.id, ...fillEmptyFromCatalog(sameKey[0], c) },
      select: { id: true, name: true },
    });
    await audit(b.id, "linked");
    return { kind: "linked", building: b };
  }
  if (sameKey.length > 0) return { kind: "ambiguous" };
  if (opts.create === false || userId === null) return { kind: "none" };
  const b = await tx.building.create({
    data: {
      name: c.name, address: c.address, nameKey: c.nameKey, areaKey: c.areaKey, catalogId: c.id, createdBy: userId,
      ...catalogFillValues(c),
    },
    select: { id: true, name: true },
  });
  await audit(b.id, "created");
  return { kind: "created", building: b };
}
```

⚠テストの監査の期待値は `{ userId, action, targetTable, targetId, detail }`。実装もその形(上の通り)。

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run src/lib/mansion-catalog/__tests__/adopt.test.ts && npx tsc --noEmit`
Expected: PASS・エラー0

- [ ] **Step 5: Commit**

```bash
git add src/lib/mansion-catalog
git commit -m "feat(mansion-catalog): 名簿の建物を棟にする処理を1か所に(空欄だけ埋める・同時でも1棟)"
```

---

### Task 5: 物件の保存で、新しい棟に名簿の値を入れる

**Files:**
- Modify: `src/lib/building-link/apply.ts`(`BuildingLinkTx` :26-30・`if (d.kind === "create")` :154-165)
- Modify: `src/lib/building-link/__tests__/fake-building-tx.ts`(`mansionCatalog.findMany`・`building.findFirst` を足す・`FakeDb.catalog?`・`FakeBuilding.catalogId?`)
- Test: `src/lib/building-link/__tests__/apply-catalog.test.ts`

**Interfaces:**
- Consumes: `CATALOG_ENTRY_SELECT`, `catalogFillValues`, `CatalogEntry`(Task 4)
- Produces: `BuildingLinkTx` に `mansionCatalog: Pick<…, "findMany">` と `building.findFirst` が加わる。全呼び出し元は本物の tx を渡しているので型は通る(`grep -rn "applyBuildingLink(" src --include=*.ts` で確かめる)。

- [ ] **Step 1: fake を広げる**

`fake-building-tx.ts`:
- `FakeBuilding` に `catalogId?: string | null` と `[k: string]: unknown` を足す。
- `FakeDb` に `catalog?: CatalogEntry[]` を足す(`import type { CatalogEntry } from "@/lib/mansion-catalog/adopt"`)。
- `building` に:

```ts
      findFirst: vi.fn(async ({ where }: { where: { catalogId: string } }) => {
        const b = db.buildings.find((x) => x.catalogId === where.catalogId);
        return b ? view(b) : null;
      }),
```

- `create` の中で、`data.catalogId` が既にある棟と同じなら `throw new Error("unique catalog_id")`(本物の一意制約を写す)。
- 返す口に:

```ts
    mansionCatalog: {
      findMany: vi.fn(async ({ where, take }: { where: { areaKey: string; nameKey: string }; take?: number }) =>
        (db.catalog ?? []).filter((c) => c.areaKey === where.areaKey && c.nameKey === where.nameKey).slice(0, take ?? Infinity)),
    },
```

- [ ] **Step 2: 失敗するテストを書く**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
import { applyBuildingLink } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import type { CatalogEntry } from "@/lib/mansion-catalog/adopt";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

const ADDR = "東京都葛飾区青戸４丁目２－１４－８０２";
const NAME = "プラウド青砥";
const entry = (id: string): CatalogEntry => ({
  id, name: NAME, address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9, totalFloors: 14,
  basementFloors: null, totalUnits: 155, structureType: "RC", managementCompany: "野村不動産パートナーズ",
  nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
});
let db: FakeDb;
beforeEach(() => {
  db = { buildings: [], properties: [{ id: "p1", buildingId: null, buildingName: NAME }], executed: [], catalog: [entry("c1")] };
});
const input = { propertyId: "p1", propertyType: "apartment_unit", buildingName: NAME, address: ADDR, buildingNumber: null, choice: AUTO_CHOICE, currentBuildingId: null, userId: "u1" };

describe("applyBuildingLink × 名簿", () => {
  it("新しい棟を作るとき、名簿に同じ鍵が1件なら値を入れて catalog_id を付ける(名前・住所は物件のまま)", async () => {
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("created");
    expect(db.buildings[0]).toMatchObject({ name: NAME, catalogId: "c1", builtYear: 2026, builtMonth: 9, totalFloors: 14, totalUnits: 155, managementCompany: "野村不動産パートナーズ" });
    expect(db.buildings[0]).not.toHaveProperty("basementFloors");
  });
  it("★名簿に同じ鍵が2件なら値を入れない(違う建物の値を入れない)", async () => {
    db.catalog = [entry("c1"), entry("c2")];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0].catalogId ?? null).toBeNull();
    expect(db.buildings[0]).not.toHaveProperty("totalFloors");
  });
  it("名簿に無ければ今まで通り", async () => {
    db.catalog = [];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0].catalogId ?? null).toBeNull();
  });
  it("★その名簿の建物がもう別の棟になっていたら(名前を変えた棟など)値を入れず、保存は失敗しない", async () => {
    db.buildings.push({ id: "b9", name: "名前を変えた棟", address: "x", nameKey: "別", areaKey: "別", createdAt: new Date(), createdBy: "u0", catalogId: "c1" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("created");
    expect(db.buildings.find((b) => b.id !== "b9")?.catalogId ?? null).toBeNull();
  });
  it("既存の棟につなぐときは名簿を見ない", async () => {
    db.buildings.push({ id: "b1", name: NAME, address: "x", nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR), createdAt: new Date(), createdBy: "u0" });
    const tx = createFakeBuildingTx(db);
    await applyBuildingLink(tx, input);
    expect(tx.mansionCatalog.findMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run src/lib/building-link/__tests__/apply-catalog.test.ts`
Expected: FAIL(catalogId が入らない)

- [ ] **Step 4: apply.ts を直す**

import に `import { CATALOG_ENTRY_SELECT, catalogFillValues } from "@/lib/mansion-catalog/adopt";`

`BuildingLinkTx`:

```ts
export type BuildingLinkTx = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  building: Pick<Prisma.TransactionClient["building"], "findUnique" | "findFirst" | "findMany" | "create">;
  property: Pick<Prisma.TransactionClient["property"], "update">;
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "create">;
  mansionCatalog: Pick<Prisma.TransactionClient["mansionCatalog"], "findMany">;
};
```

`loadCandidates` の下に:

```ts
/**
 * 新しい棟に入れる名簿の建物(設計 2026-10-18 §6.1)。同じ町丁目・同じ比べる形が**ちょうど1件**で、
 * まだどの棟にもなっていないときだけ。⚠アドバイザリロックの中で呼ぶ(同じ鍵=adopt と同じロック)。
 * ⚠もう棟になっている(棟の名前を手で変えた後など)ときは入れない=catalog_id の一意制約で保存ごと落とさない。
 */
async function catalogForNewBuilding(tx: BuildingLinkTx, area: string | null, nameKey: string) {
  if (area === null) return null;
  const rows = await tx.mansionCatalog.findMany({ where: { areaKey: area, nameKey }, select: CATALOG_ENTRY_SELECT, take: 2 });
  if (rows.length !== 1) return null;
  const used = await tx.building.findFirst({ where: { catalogId: rows[0].id }, select: { id: true } });
  return used ? null : rows[0];
}
```

`if (d.kind === "create") {` の `tx.building.create` を:

```ts
    const fromCatalog = await catalogForNewBuilding(tx, area, nameKey);
    building = await tx.building.create({
      data: {
        name: input.buildingName as string,
        address: buildingAddressFromUnit(input.address, input.buildingNumber),
        nameKey,
        areaKey: area,
        createdBy: input.userId,
        ...(fromCatalog ? { catalogId: fromCatalog.id, ...catalogFillValues(fromCatalog) } : {}),
      },
      select: { id: true, name: true },
    });
```

⚠`choice.kind === "new"`(人が「新しい棟」を選んだ)のときはロックを取っていない(apply.ts :136-142 の else 側だけでロック)。名簿を見るのは create 全部なので、`new` のときも同じロックを取ってから見る:`if (d.kind === "create")` の先頭で、`input.choice.kind === "new"` なら
`await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(${buildingLinkLockKey(area, nameKey)})::bigint)\`` を呼ぶ。

- [ ] **Step 5: 既存のテストも含めて通るのを確かめる**

Run: `npx vitest run src/lib/building-link && npx tsc --noEmit`
Expected: PASS・エラー0(既存の apply.test・apply-concurrency.test も通る。`new` でロックを1本足したので、`db.executed` の本数を数えているテストがあれば期待値を直す=増えたのは意図どおり)

- [ ] **Step 6: Commit**

```bash
git add src/lib/building-link
git commit -m "feat(building-link): 新しい棟を作るとき名簿に1件だけ一致すれば竣工・階数・戸数などを入れる"
```

---

### Task 6: 「マンション棟に登録」の口と、今ある棟をつなぐ後処理

**Files:**
- Create: `src/app/api/mansion-catalog/[id]/adopt/route.ts`
- Create: `src/lib/mansion-catalog/link-existing.ts`
- Modify: `src/app/api/mansion-catalog/load-run/route.ts`(`const linked = 0;` を置き換え)
- Test: `src/app/api/mansion-catalog/[id]/adopt/__tests__/route.test.ts`, `src/lib/mansion-catalog/__tests__/link-existing.test.ts`

**Interfaces:**
- Consumes: `adoptCatalogBuilding`, `AdoptTx`(Task 4)
- Produces:
  - `POST /api/mansion-catalog/:id/adopt` → 200 `{ buildingId: string, kind: "existing" | "linked" | "created" }`/404 `NOT_FOUND`/409 `CATALOG_AMBIGUOUS`/403
  - `export async function linkExistingBuildings(deps: { listUnlinked(): Promise<{ id: string; nameKey: string | null; areaKey: string | null }[]>; findCatalogIds(areaKey: string, nameKey: string): Promise<string[]>; adopt(catalogId: string): Promise<AdoptResult> }): Promise<number>`(つないだ数)
  - `export function createPrismaLinkDeps(): Parameters<typeof linkExistingBuildings>[0]`

- [ ] **Step 1: 失敗するテストを書く(link-existing)**

```ts
import { describe, it, expect, vi } from "vitest";
import { linkExistingBuildings } from "@/lib/mansion-catalog/link-existing";

describe("linkExistingBuildings", () => {
  it("名簿に1件だけ一致する棟だけ adopt(create:false)し、つないだ数を返す", async () => {
    const adopt = vi.fn(async (id: string) => (id === "c1" ? { kind: "linked" as const, building: { id: "b1", name: "a" } } : { kind: "ambiguous" as const }));
    const n = await linkExistingBuildings({
      listUnlinked: async () => [
        { id: "b1", nameKey: "a", areaKey: "x" },
        { id: "b2", nameKey: "b", areaKey: "x" },
        { id: "b3", nameKey: null, areaKey: "x" },
      ],
      findCatalogIds: async (_area, nameKey) => (nameKey === "a" ? ["c1"] : ["c2", "c3"]),
      adopt,
    });
    expect(n).toBe(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith("c1");
  });
});
```

- [ ] **Step 2: link-existing.ts を書く**

```ts
/**
 * 今ある棟のうち名簿とつながっていないものを、名簿に**ちょうど1件**一致すればつなぐ(設計 §6.4)。
 * 作らない(adopt の create:false)。空いている欄だけ埋まる。
 */
import prisma from "@/lib/prisma";
import { adoptCatalogBuilding, type AdoptResult, type AdoptTx } from "./adopt";

export async function linkExistingBuildings(deps: {
  listUnlinked(): Promise<{ id: string; nameKey: string | null; areaKey: string | null }[]>;
  findCatalogIds(areaKey: string, nameKey: string): Promise<string[]>;
  adopt(catalogId: string): Promise<AdoptResult>;
}): Promise<number> {
  let linked = 0;
  for (const b of await deps.listUnlinked()) {
    if (b.nameKey === null || b.areaKey === null) continue;
    const ids = await deps.findCatalogIds(b.areaKey, b.nameKey);
    if (ids.length !== 1) continue;
    const r = await deps.adopt(ids[0]);
    if (r.kind === "linked") linked++;
  }
  return linked;
}

export function createPrismaLinkDeps(): Parameters<typeof linkExistingBuildings>[0] {
  return {
    listUnlinked: () => prisma.building.findMany({ where: { catalogId: null }, select: { id: true, nameKey: true, areaKey: true } }),
    findCatalogIds: async (areaKey, nameKey) =>
      (await prisma.mansionCatalog.findMany({ where: { areaKey, nameKey }, select: { id: true }, take: 2 })).map((r) => r.id),
    adopt: (catalogId) => prisma.$transaction((tx) => adoptCatalogBuilding(tx as unknown as AdoptTx, catalogId, null, { create: false })),
  };
}
```

load-run の `const linked = 0; // Task 6 で今ある棟をつなぐ` を:

```ts
      const linked = await linkExistingBuildings(createPrismaLinkDeps());
```

(import `import { createPrismaLinkDeps, linkExistingBuildings } from "@/lib/mansion-catalog/link-existing";`。load-run のテストには `vi.mock("@/lib/mansion-catalog/link-existing", () => ({ linkExistingBuildings: async () => 0, createPrismaLinkDeps: () => ({}) }))` を足し、`toMatchObject` に `linked: 0` を足す)

- [ ] **Step 3: 失敗するテストを書く(adopt の口)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const adoptCatalogBuilding = vi.fn();
const getApiSession = vi.fn(async () => ({ id: "u1", role: "admin" }));
const getUserPermissions = vi.fn(async () => [{ resource: "property", action: "write" }]);
vi.mock("@/lib/mansion-catalog/adopt", () => ({ adoptCatalogBuilding: (...a: unknown[]) => adoptCatalogBuilding(...a) }));
vi.mock("@/lib/prisma", () => ({ default: { $transaction: (fn: (tx: unknown) => unknown) => fn({}) } }));
vi.mock("@/lib/permissions", () => ({
  hasPermission: (perms: { resource: string; action: string }[], r: string, a: string) => perms.some((p) => p.resource === r && p.action === a),
}));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error { constructor(public status: number, message: string, public code = "ERROR") { super(message); } }
  return {
    ApiError: MockApiError,
    getApiSession: () => getApiSession(),
    getUserPermissions: () => getUserPermissions(),
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: err.status ?? 500 });
    },
  };
});
import { POST } from "../route";

const call = () => POST(new Request("http://localhost/api/mansion-catalog/c1/adopt", { method: "POST" }) as never, { params: Promise.resolve({ id: "c1" }) });
beforeEach(() => adoptCatalogBuilding.mockReset());

describe("POST /api/mansion-catalog/:id/adopt", () => {
  it("棟の id を返す", async () => {
    adoptCatalogBuilding.mockResolvedValue({ kind: "created", building: { id: "b1", name: "a" } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buildingId: "b1", kind: "created" });
    expect(adoptCatalogBuilding).toHaveBeenCalledWith({}, "c1", "u1");
  });
  it("書き込めない人は 403(DB を触らない)", async () => {
    getUserPermissions.mockResolvedValueOnce([{ resource: "property", action: "read" }]);
    expect((await call()).status).toBe(403);
    expect(adoptCatalogBuilding).not.toHaveBeenCalled();
  });
  it("無ければ 404・同じ名前の棟が複数なら 409", async () => {
    adoptCatalogBuilding.mockResolvedValueOnce({ kind: "not_found" });
    expect((await call()).status).toBe(404);
    adoptCatalogBuilding.mockResolvedValueOnce({ kind: "ambiguous" });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CATALOG_AMBIGUOUS");
  });
});
```

⚠このリポの route の第2引数の形(`{ params: Promise<{ id: string }> }`)は `src/app/api/buildings/[id]/route.ts` の書き方に合わせる(実装前に開いて確かめ、違えばテストの `call` も合わせる)。

- [ ] **Step 4: adopt の口を書く**

```ts
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { adoptCatalogBuilding, type AdoptTx } from "@/lib/mansion-catalog/adopt";

/** POST /api/mansion-catalog/:id/adopt — 名簿の建物をマンション棟にする(設計 2026-10-18 §6.3)。 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) throw new ApiError(403, "権限がありません", "FORBIDDEN");
    const { id } = await params;
    const r = await prisma.$transaction((tx) => adoptCatalogBuilding(tx as unknown as AdoptTx, id, session.id));
    if (r.kind === "not_found" || r.kind === "none") throw new ApiError(404, "名簿の建物が見つかりません", "NOT_FOUND");
    if (r.kind === "ambiguous") {
      throw new ApiError(409, "同じ名前の棟が複数あります。マンション棟の一覧から選んでください", "CATALOG_AMBIGUOUS");
    }
    return apiResponse({ buildingId: r.building.id, kind: r.kind });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run src/lib/mansion-catalog src/app/api/mansion-catalog && npx tsc --noEmit`
Expected: PASS・エラー0

- [ ] **Step 6: Commit**

```bash
git add src/lib/mansion-catalog src/app/api/mansion-catalog
git commit -m "feat(mansion-catalog): マンション棟に登録の口と、今ある棟を名簿につなぐ後処理"
```

---

### Task 7: 物件名の候補に名簿の建物を出す

**Files:**
- Modify: `src/lib/building-link/suggest.ts`(型と並べ方を足す)
- Modify: `src/app/api/buildings/suggest/route.ts`(名簿を読んで `catalog` を返す)
- Modify: `src/lib/building-link/combobox-model.ts`(`SuggestResult.catalog`・`pickAtIndex`)
- Modify: `src/components/buildings/building-name-combobox.tsx`(一覧に名簿の段)
- Test: `src/lib/building-link/__tests__/suggest.test.ts`(追記)・`combobox-model.test.ts`(追記)・`src/components/buildings/__tests__/building-suggestion-list-catalog.test.tsx`(新規)

**Interfaces:**
- Produces:
  - `export interface CatalogSuggestion { catalogId: string; name: string; area: string; builtYear: number | null; totalFloors: number | null; totalUnits: number | null; sameName: boolean; sameArea: boolean }`
  - `export const CATALOG_SUGGEST_LIMIT = 5`
  - `export function rankCatalogSuggestions(rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; builtYear: number | null; totalFloors: number | null; totalUnits: number | null }[], target: { nameKey: string; areaKey: string | null }): CatalogSuggestion[]`
  - suggest の応答: `{ data, complete, catalog: CatalogSuggestion[] }`(`catalog` が無い応答は `[]` 扱い)
  - `pickAtIndex(index, suggestions, allowNew, catalog = [])`: 並びは「棟の候補 → 名簿の候補 → 新しい棟」。名簿の行を選ぶと `{ catalog: CatalogSuggestion }` を返す。
  - `catalogSuggestionLine(s: CatalogSuggestion): string` 例「葛飾区青戸4丁目・2026年竣工・14階建・155戸」(無い値は省く)

- [ ] **Step 1: 失敗するテストを書く(並べ方・行の文字・pickAtIndex)**

`suggest.test.ts` に追記:

```ts
import { rankCatalogSuggestions, CATALOG_SUGGEST_LIMIT } from "@/lib/building-link/suggest";

describe("rankCatalogSuggestions", () => {
  const row = (id: string, nameKey: string, areaKey: string) => ({ id, name: id, address: `${areaKey}1番`, nameKey, areaKey, builtYear: 2000, totalFloors: 5, totalUnits: 20 });
  it("同じ名前+同じ丁目 → 同じ名前 → 部分一致。最大5件・住所は町丁目まで", () => {
    const rows = [row("p", "プラウド青砥二", "東京都葛飾区青戸4丁目"), row("o", "プラウド青砥", "東京都葛飾区青戸5丁目"), row("s", "プラウド青砥", "東京都葛飾区青戸4丁目"),
      ...Array.from({ length: 6 }, (_, i) => row(`x${i}`, `プラウド青砥${i}`, "東京都葛飾区青戸1丁目"))];
    const r = rankCatalogSuggestions(rows, { nameKey: "プラウド青砥", areaKey: "東京都葛飾区青戸4丁目" });
    expect(r.map((s) => s.catalogId).slice(0, 2)).toEqual(["s", "o"]);
    expect(r).toHaveLength(CATALOG_SUGGEST_LIMIT);
    expect(r[0]).toMatchObject({ area: "東京都葛飾区青戸4丁目", sameName: true, sameArea: true });
    expect(JSON.stringify(r)).not.toContain("1番");
  });
});
```

`combobox-model.test.ts` に追記:

```ts
import { pickAtIndex, catalogSuggestionLine } from "@/lib/building-link/combobox-model";
const cat = { catalogId: "c1", name: "プラウド青砥", area: "東京都葛飾区青戸4丁目", builtYear: 2026, totalFloors: 14, totalUnits: 155, sameName: true, sameArea: true };
describe("名簿の候補", () => {
  it("並びは 棟 → 名簿 → 新しい棟", () => {
    const b = [{ id: "b1", name: "a", area: "", unitCount: 1, sameName: false, sameArea: false }];
    expect(pickAtIndex(0, b, true, [cat])).toBe(b[0]);
    expect(pickAtIndex(1, b, true, [cat])).toEqual({ catalog: cat });
    expect(pickAtIndex(2, b, true, [cat])).toBe("new");
    expect(pickAtIndex(2, b, false, [cat])).toBeNull();
    expect(pickAtIndex(1, b, true)).toBe("new");
  });
  it("行の文字(無い値は省く)", () => {
    expect(catalogSuggestionLine(cat)).toBe("東京都葛飾区青戸4丁目・2026年竣工・14階建・155戸");
    expect(catalogSuggestionLine({ ...cat, builtYear: null, totalUnits: null })).toBe("東京都葛飾区青戸4丁目・14階建");
  });
});
```

`src/components/buildings/__tests__/building-suggestion-list-catalog.test.tsx`(新規):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildingSuggestionList } from "@/components/buildings/building-name-combobox";

const cat = { catalogId: "c1", name: "プラウド青砥", area: "東京都葛飾区青戸4丁目", builtYear: 2026, totalFloors: 14, totalUnits: 155, sameName: true, sameArea: false };
describe("候補の一覧の名簿の段", () => {
  it("見出し・行の中身・丁目の札を出し、新しい棟は一番下", () => {
    const html = renderToStaticMarkup(
      <BuildingSuggestionList suggestions={[]} catalog={[cat]} activeIndex={-1} onPick={() => {}} listId="x" />,
    );
    expect(html).toContain("名簿にあるマンション");
    expect(html).toContain("2026年竣工・14階建・155戸");
    expect(html).toContain("丁目が違います");
    expect(html.indexOf("プラウド青砥")).toBeLessThan(html.indexOf("新しい棟として登録する"));
    expect(html).toContain('id="x-opt-0"');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/lib/building-link src/components/buildings`
Expected: FAIL(関数・props が無い)

- [ ] **Step 3: suggest.ts に足す**

```ts
/** 名簿(mansion_catalog)の候補(設計 2026-10-18 §6.2)。⚠住所は町丁目まで。 */
export interface CatalogSuggestion {
  catalogId: string; name: string; area: string;
  builtYear: number | null; totalFloors: number | null; totalUnits: number | null;
  sameName: boolean; sameArea: boolean;
}
export const CATALOG_SUGGEST_LIMIT = 5;

export function rankCatalogSuggestions(
  rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; builtYear: number | null; totalFloors: number | null; totalUnits: number | null }[],
  target: { nameKey: string; areaKey: string | null },
): CatalogSuggestion[] {
  const scored = rows.map((c) => {
    const nk = c.nameKey ?? buildingNameKey(c.name);
    const ak = c.areaKey ?? areaKey(c.address);
    const sameName = nk === target.nameKey;
    const sameArea = target.areaKey !== null && ak === target.areaKey;
    return { c, ak, sameName, sameArea, rank: sameName && sameArea ? 0 : sameName ? 1 : 2 };
  });
  scored.sort((x, y) => x.rank - y.rank || (y.c.totalUnits ?? 0) - (x.c.totalUnits ?? 0) || x.c.id.localeCompare(y.c.id));
  return scored.slice(0, CATALOG_SUGGEST_LIMIT).map(({ c, ak, sameName, sameArea }) => ({
    catalogId: c.id, name: c.name, area: ak ?? "", builtYear: c.builtYear, totalFloors: c.totalFloors, totalUnits: c.totalUnits, sameName, sameArea,
  }));
}
```

- [ ] **Step 4: suggest の route で名簿を読む**

`Promise.all` に4つ目を足す前に、`const catalogSelect = { id: true, name: true, address: true, nameKey: true, areaKey: true, builtYear: true, totalFloors: true, totalUnits: true } as const;` と:

```ts
    // 名簿の建物(設計 2026-10-18 §6.2)。もう棟になったものは出さない(棟の候補に出ている)。
    const catalogQuery = prisma.mansionCatalog.findMany({
      where: {
        building: { is: null },
        OR: [{ nameKey }, { nameKey: { contains: nameKey } }, { name: { contains: name, mode: "insensitive" } }],
      },
      select: catalogSelect,
      take: FETCH_LIMIT,
      orderBy: { id: "asc" },
    });
```

`Promise.all([... , catalogQuery])` で受け、返すときに `catalog: rankCatalogSuggestions(catalogRows, target)` を足す(今の `apiResponse({ data: …, complete: … })` に1項目足す)。⚠名簿は読むだけ・同じ名前の棟の「新しい棟」判断(`complete`)には混ぜない。

- [ ] **Step 5: combobox-model.ts を直す**

```ts
import type { CatalogSuggestion } from "./suggest";
```

`SuggestResult` に `catalog?: CatalogSuggestion[];` を足す。`pickAtIndex` を:

```ts
export function pickAtIndex(
  index: number,
  suggestions: BuildingSuggestion[],
  allowNew: boolean = true,
  catalog: CatalogSuggestion[] = [],
): BuildingSuggestion | { catalog: CatalogSuggestion } | "new" | null {
  const total = suggestions.length + catalog.length;
  if (!Number.isInteger(index) || index < 0 || index > total) return null;
  if (index < suggestions.length) return suggestions[index];
  if (index < total) return { catalog: catalog[index - suggestions.length] };
  return allowNew ? "new" : null;
}

/** 名簿の候補の2行目(町丁目・竣工年・階数・戸数。無い値は省く)。 */
export function catalogSuggestionLine(s: CatalogSuggestion): string {
  return [
    s.area || "住所不明",
    s.builtYear !== null ? `${s.builtYear}年竣工` : null,
    s.totalFloors !== null ? `${s.totalFloors}階建` : null,
    s.totalUnits !== null ? `${s.totalUnits}戸` : null,
  ].filter(Boolean).join("・");
}
```

- [ ] **Step 6: 一覧の部品を直す**

`BuildingSuggestionList` の props に `catalog?: CatalogSuggestion[]` を足し(既定 `[]`)、`onPick` の型を `(s: BuildingSuggestion | { catalog: CatalogSuggestion } | "new") => void` にする。棟の候補の `map` の後、「新しい棟」の行の前に:

```tsx
      {catalog.length > 0 && (
        <li role="presentation" className="border-t border-gray-100 px-3 pt-2 text-[11px] font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400">
          名簿にあるマンション
        </li>
      )}
      {catalog.map((c, j) => {
        const i = suggestions.length + j;
        return (
          <li
            key={`catalog-${c.catalogId}`}
            id={`${listId}-opt-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => { e.preventDefault(); onPick({ catalog: c }); }}
            className={`flex min-h-[44px] cursor-pointer flex-col justify-center px-3 py-1.5 text-sm ${
              i === activeIndex ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            <span className="flex flex-wrap items-center gap-1 text-gray-900 dark:text-gray-100">
              {c.name}
              {c.sameName && !c.sameArea && (
                <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">丁目が違います</span>
              )}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">{catalogSuggestionLine(c)}</span>
          </li>
        );
      })}
```

「新しい棟」の行の `id`・`aria-selected` の番号を `suggestions.length + catalog.length` にする。

`BuildingNameCombobox` 本体:
- `const catalog = state === "ready" || state === "partial" ? result?.catalog ?? [] : [];`
- fetch の応答で `catalog: Array.isArray(body.catalog) ? (body.catalog as CatalogSuggestion[]) : []` を `setResult` に入れる(`body` の型に `catalog?: unknown` を足す)。
- `pick` に分岐を足す:

```ts
    } else if ("catalog" in s) {
      // 名簿の建物は建物名を入れるだけ(選び方は自動のまま)。保存したときに名簿の値の入った棟ができる(設計 §6.2)。
      setSelected(null);
      onChange(s.catalog.name);
      if (choice.kind !== "auto") onChoiceChange({ kind: "auto" });
    } else {
```

- `optionCount = suggestions.length + catalog.length + (allowNew ? 1 : 0)`・Enter の `pickAtIndex(activeIndex, suggestions, allowNew, catalog)`・`<BuildingSuggestionList … catalog={catalog} />`。

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run src/lib/building-link src/components/buildings src/app/api/buildings && npx tsc --noEmit`
Expected: PASS・エラー0(suggest の route に既存テストがあれば、prisma の mock に `mansionCatalog.findMany` を足して `[]` を返す)

- [ ] **Step 8: Commit**

```bash
git add src/lib/building-link src/app/api/buildings/suggest src/components/buildings
git commit -m "feat(buildings): 物件名の候補に名簿のマンションを出す(選ぶと名前が入り保存で棟になる)"
```

---

### Task 8: 「マンション棟」の検索窓に名簿の段

**Files:**
- Modify: `src/app/api/buildings/route.ts:33-68`(GET)
- Modify: `src/lib/api-client.ts:3248-3255`(`fetchBuildings` の戻り値)・`adoptCatalogBuilding` を足す
- Create: `src/components/buildings/catalog-search-results.tsx`
- Modify: `src/app/(dashboard)/buildings/page.tsx`
- Test: `src/app/api/buildings/__tests__/route-catalog.test.ts`, `src/components/buildings/__tests__/catalog-search-results.test.tsx`

**Interfaces:**
- Produces:
  - GET `/api/buildings?keyword=` の応答に `catalog: CatalogSearchItem[]`(2文字未満は `[]`)
  - `export interface CatalogSearchItem { id: string; name: string; address: string; builtYear: number | null; builtMonth: number | null; totalFloors: number | null; totalUnits: number | null; managementCompany: string | null }`(`src/components/buildings/catalog-search-results.tsx` で export)
  - `export const CATALOG_SEARCH_LIMIT = 20`(route)
  - api-client: `fetchBuildings(keyword?) → { data: unknown[]; catalog?: CatalogSearchItem[] }`・`adoptCatalogBuildingApi(id: string) → { buildingId: string; kind: string }`
  - 部品 `CatalogSearchResults({ items, adoptingId, error, onAdopt })`

- [ ] **Step 1: 失敗するテストを書く**

route(`src/app/api/buildings/__tests__/route-catalog.test.ts`):

```ts
import { describe, it, expect, vi } from "vitest";
const findManyBuildings = vi.fn(async () => []);
const findManyCatalog = vi.fn(async () => [{ id: "c1", name: "プラウド青砥" }]);
vi.mock("@/lib/prisma", () => ({ default: { building: { findMany: (...a: unknown[]) => findManyBuildings(...a) }, mansionCatalog: { findMany: (...a: unknown[]) => findManyCatalog(...a) } } }));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/api-helpers", async () => {
  class MockApiError extends Error { constructor(public status: number, message: string, public code = "ERROR") { super(message); } }
  return {
    ApiError: MockApiError,
    getApiSession: async () => ({ id: "u1", role: "admin" }),
    getUserPermissions: async () => [],
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => new Response(String(e), { status: 500 }),
  };
});
import { GET } from "../route";
const req = (q: string) => ({ nextUrl: new URL(`http://localhost/api/buildings${q}`) }) as never;

describe("GET /api/buildings の名簿の段", () => {
  it("2文字以上で探したときだけ、棟になっていない名簿を20件まで返す", async () => {
    const body = await (await GET(req("?keyword=プラウド"))).json();
    expect(body.catalog).toEqual([{ id: "c1", name: "プラウド青砥" }]);
    const args = findManyCatalog.mock.calls[0][0] as { where: { building: unknown }; take: number };
    expect(args.where.building).toEqual({ is: null });
    expect(args.take).toBe(20);
  });
  it("何も入れないときは名簿を引かない", async () => {
    findManyCatalog.mockClear();
    const body = await (await GET(req(""))).json();
    expect(body.catalog).toEqual([]);
    expect(findManyCatalog).not.toHaveBeenCalled();
  });
});
```

⚠`src/app/api/buildings/route.ts` の import(`zod` など)が mock なしで読めない場合は、このリポの他の route テスト(`src/app/api/buildings/[id]/...` のテストがあればそれ)の mock をまねる。

部品(`catalog-search-results.test.tsx`):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogSearchResults } from "@/components/buildings/catalog-search-results";

const item = { id: "c1", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9, totalFloors: 14, totalUnits: 155, managementCompany: "野村不動産パートナーズ" };
describe("CatalogSearchResults", () => {
  it("見出し・中身・登録ボタン", () => {
    const html = renderToStaticMarkup(<CatalogSearchResults items={[item]} adoptingId={null} error={null} onAdopt={() => {}} />);
    expect(html).toContain("名簿にあるマンション（1件）");
    expect(html).toContain("2026年9月竣工・14階建・155戸・管理: 野村不動産パートナーズ");
    expect(html).toContain("マンション棟に登録");
  });
  it("0件なら何も出さない・登録中はボタンを止める・失敗の文言", () => {
    expect(renderToStaticMarkup(<CatalogSearchResults items={[]} adoptingId={null} error={null} onAdopt={() => {}} />)).toBe("");
    const html = renderToStaticMarkup(<CatalogSearchResults items={[item]} adoptingId="c1" error="同じ名前の棟が複数あります" onAdopt={() => {}} />);
    expect(html).toContain("disabled");
    expect(html).toContain("登録しています");
    expect(html).toContain("同じ名前の棟が複数あります");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run src/app/api/buildings src/components/buildings`
Expected: FAIL

- [ ] **Step 3: route の GET に足す**

`const buildings = await prisma.building.findMany(...)` の後に:

```ts
    // 名簿にあるマンション(設計 2026-10-18 §6.3)。探したときだけ・棟になったものは出さない。
    const catalog = q.length >= 2
      ? await prisma.mansionCatalog.findMany({
          where: {
            building: { is: null },
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { address: { contains: q, mode: "insensitive" as const } },
            ],
          },
          select: { id: true, name: true, address: true, builtYear: true, builtMonth: true, totalFloors: true, totalUnits: true, managementCompany: true },
          orderBy: [{ name: "asc" }],
          take: CATALOG_SEARCH_LIMIT,
        })
      : [];

    return apiResponse({ data: buildings, catalog });
```

(ファイル上部に `const CATALOG_SEARCH_LIMIT = 20;`)

- [ ] **Step 4: 部品と api-client と画面**

`src/components/buildings/catalog-search-results.tsx`:

```tsx
/** 「マンション棟」の検索の2段目=名簿にあるマンション(設計 2026-10-18 §6.3)。表示専用(SSR テストのため切り出す)。 */
export interface CatalogSearchItem {
  id: string; name: string; address: string;
  builtYear: number | null; builtMonth: number | null; totalFloors: number | null; totalUnits: number | null;
  managementCompany: string | null;
}

export function catalogSearchLine(i: CatalogSearchItem): string {
  return [
    i.builtYear !== null ? `${i.builtYear}年${i.builtMonth !== null ? `${i.builtMonth}月` : ""}竣工` : null,
    i.totalFloors !== null ? `${i.totalFloors}階建` : null,
    i.totalUnits !== null ? `${i.totalUnits}戸` : null,
    i.managementCompany ? `管理: ${i.managementCompany}` : null,
  ].filter(Boolean).join("・");
}

export function CatalogSearchResults({
  items, adoptingId, error, onAdopt,
}: { items: CatalogSearchItem[]; adoptingId: string | null; error: string | null; onAdopt: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">名簿にあるマンション（{items.length}件）</h2>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">まだマンション棟になっていない建物です。登録すると、竣工年月・階数・戸数などが入った棟ができます。</p>
      {error && <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-gray-900 dark:text-gray-100">{i.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{i.address}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{catalogSearchLine(i)}</p>
            </div>
            <button
              type="button"
              onClick={() => onAdopt(i.id)}
              disabled={adoptingId !== null}
              className="rounded-md border border-indigo-300 px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
            >
              {adoptingId === i.id ? "登録しています…" : "マンション棟に登録"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`api-client.ts`:

```ts
export async function fetchBuildings(keyword?: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [], catalog: [] };
  }
  const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : "";
  return apiFetch<{ data: unknown[]; catalog?: CatalogSearchItem[] }>(`/api/buildings${qs}`);
}

/** 名簿の建物をマンション棟にする(設計 2026-10-18 §6.3)。 */
export async function adoptCatalogBuildingApi(id: string) {
  return apiFetch<{ buildingId: string; kind: string }>(`/api/mansion-catalog/${encodeURIComponent(id)}/adopt`, { method: "POST" });
}
```

(`import type { CatalogSearchItem } from "@/components/buildings/catalog-search-results";`。⚠api-client の `apiFetch` の第2引数の形はファイル内の他の POST(`createBuilding`)に合わせる)

`buildings/page.tsx`:
- `const [catalog, setCatalog] = useState<CatalogSearchItem[]>([]);`・`const [adoptingId, setAdoptingId] = useState<string | null>(null);`・`const [adoptError, setAdoptError] = useState<string | null>(null);`・`const router = useRouter();`(`next/navigation`)
- `load` の中: `setCatalog(res.catalog ?? []); setAdoptError(null);`
- 関数:

```ts
  const adopt = async (id: string) => {
    setAdoptingId(id);
    setAdoptError(null);
    try {
      const r = await adoptCatalogBuildingApi(id);
      router.push(`/buildings/${r.buildingId}`);
    } catch (e) {
      setAdoptError(e instanceof Error ? e.message : "登録できませんでした");
      setAdoptingId(null);
    }
  };
```

- 一覧の表示の後(ローディングの三項の外・最後)に `{keyword && <CatalogSearchResults items={catalog} adoptingId={adoptingId} error={adoptError} onAdopt={adopt} />}`
- ⚠「一致するマンション棟が見つかりません」の空の表示は、名簿に当たりがあるときは文言を「自社のマンション棟には見つかりません。下の名簿から登録できます」にする(`catalog.length > 0` で切り替え)。

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run src/app/api/buildings src/components/buildings "src/app/(dashboard)/buildings" && npx tsc --noEmit`
Expected: PASS・エラー0(既存の `dark.test.ts` などの走査テストが新しい部品の dark: 指定を求めたら合わせる)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/buildings src/lib/api-client.ts src/components/buildings "src/app/(dashboard)/buildings"
git commit -m "feat(buildings): 棟の検索窓に名簿のマンションの段と「マンション棟に登録」"
```

---

### Task 9: 使い方ガイド/マニュアル+全ゲート

**Files:**
- Modify: `public/docs/guide.html`・`public/docs/manual.html`(マンション棟の節)。⚠正本は Artifact(ガイド/マニュアル)=マージ後に同じ文を Artifact にも入れる(メモリ system-docs-guide-manual)
- Modify: `docs/deploy.md`(反映手順に「名簿の読み込み」の節)

- [ ] **Step 1: ガイド/マニュアルに書き足す**

マンション棟の節に、平易な日本語で:
- 区分マンションを登録すると、名簿にある建物なら竣工年月・階数・戸数・構造・管理会社が自動で入った棟ができる(同じ名前・同じ町丁目の建物が名簿に1件だけのとき)。
- 物件名の候補に「名簿にあるマンション」が出る。選ぶと建物名が入り、保存すると棟ができる。
- 「マンション棟」の検索窓で探すと、下に名簿の段が出る。「マンション棟に登録」で棟にできる。
- 社内の棟の値は、名簿で上書きしない(空いている欄だけ埋まる)。
- ⚠古い「無い・これから」の記述があれば消す。書く内容は実コードで裏取りする(実装に無い動きを書かない)。

- [ ] **Step 2: deploy.md に読み込み手順**

```markdown
## マンション名簿の読み込み(2026-10-18〜)
1. 合言葉を作って app.env に足す(値は画面に出さない): `MANSION_CATALOG_LOAD_SECRET`・`MANSION_CATALOG_DIR=/var/lib/property-management/mansion-catalog`→ restart(flock 付き)
2. 集めたファイルを写す(root): `install -d -o www-data -m 750 /var/lib/property-management/mansion-catalog && install -o www-data -m 640 /var/lib/selfin-collect/buildings-*.jsonl /var/lib/property-management/mansion-catalog/`
3. 読み込む: `curl -s -X POST -H @- http://127.0.0.1:3000/api/mansion-catalog/load-run <<< "x-mansion-catalog-secret: $SECRET"` → 件数だけ返る
4. 取り直したときは 2〜3 をもう一度(名簿だけ更新・棟は上書きしない)
```

- [ ] **Step 3: 全ゲート**

Run(ひとつずつ・終了コードで区切る):
```bash
npx tsc --noEmit > /tmp/tsc.out 2>&1; echo exit=$?
npx vitest run > /tmp/vitest.out 2>&1; echo exit=$?
npx eslint $(git diff --name-only origin/main -- '*.ts' '*.tsx') > /tmp/eslint.out 2>&1; echo exit=$?
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build > /tmp/build.out 2>&1; echo exit=$?
```
Expected: 4つとも exit=0。build の route 一覧に `/api/mansion-catalog/load-run` と `/api/mansion-catalog/[id]/adopt` が載る。

- [ ] **Step 4: Commit**

```bash
git add docs/deploy.md public/docs
git commit -m "docs: マンション名簿の使い方と読み込み手順"
```
