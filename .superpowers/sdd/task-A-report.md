# Task A Report: SalesSheetDesign モデル＋migration＋検証サービス

## What Was Implemented

### Files Changed

1. **`prisma/schema.prisma`** (modified)
   - Added `salesSheetDesigns SalesSheetDesign[]` back-relation to `Property` model
   - Appended `SalesSheetDesign` model with cuid `id`, UUID `propertyId` FK (CASCADE delete), `Json document`, `templateId?`, `thumbnailUrl?`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt` (`@updatedAt`), index on `propertyId`, mapped to `sales_sheet_designs`

2. **`prisma/migrations/20260628000000_add_sales_sheet_design/migration.sql`** (new)
   - Hand-written idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD CONSTRAINT`)
   - **Key correction vs. brief**: `propertyId` typed `UUID NOT NULL` (not `TEXT`) to match `properties.id` which is `@db.Uuid`; the FK references `"properties"("id")` with `ON DELETE CASCADE ON UPDATE CASCADE`

3. **`src/lib/sales-sheet/design-service.ts`** (new)
   - Exports: `createDesign`, `getDesign`, `listDesigns`, `updateDesign`, `deleteDesign`, `SaveDesignInput`
   - `PrismaLike = typeof prismaDefault` for the injected db parameter
   - `parseSalesSheetDocument` called at every write boundary (create, update with patch.document)
   - Optimistic lock in `updateDesign`: compares `current.updatedAt.getTime()` with `patch.expectedUpdatedAt.getTime()`, returns `{ ok: false, reason: "conflict" }` on mismatch
   - `getDesign` enforces `propertyId` scope: returns `null` if design exists but belongs to a different property

4. **`src/lib/sales-sheet/__tests__/design-service.test.ts`** (new)
   - 16 tests, no `vi.mock("@/lib/prisma")` — uses direct `db` injection via fake object cast to `PrismaClient`
   - Follows co-located `__tests__/` convention, env=node

## TDD Evidence

### RED (before design-service.ts existed)

Command:
```
npx vitest run src/lib/sales-sheet/__tests__/design-service.test.ts
```

Output (truncated):
```
FAIL  src/lib/sales-sheet/__tests__/design-service.test.ts
Error: Cannot find module '../design-service' imported from ...design-service.test.ts

Test Files  1 failed (1)
    Tests  no tests
  Duration  341ms
```

### GREEN (after implementing design-service.ts)

Command:
```
npx vitest run src/lib/sales-sheet/__tests__/design-service.test.ts
```

Output:
```
Test Files  1 passed (1)
    Tests  16 passed (16)
  Duration  348ms (transform 87ms, setup 0ms, import 203ms, tests 9ms, environment 0ms)
```

## Full Suite Results

### `npm test` (vitest run)
```
Test Files  331 passed | 1 skipped (332)
    Tests  7124 passed | 2 skipped (7126)
  Duration  18.04s
```
Pristine — no failures, no new warnings from my files.

### `npx tsc --noEmit`
No output — clean.

### `npm run lint` (my files only)
```
npx eslint src/lib/sales-sheet/design-service.ts src/lib/sales-sheet/__tests__/design-service.test.ts
```
No output — zero issues. Pre-existing warnings/errors in other files are unchanged.

## Self-Review Findings

1. **propertyId type correction**: The brief's SQL used `TEXT NOT NULL` for `propertyId`, but `properties.id` is `@db.Uuid` in the Prisma schema. All existing FK columns to `properties.id` in other migrations use `UUID`. I used `UUID NOT NULL` and added `@db.Uuid` to the schema field — required for a valid PostgreSQL FK.

2. **Test scope**: 16 tests covering all 5 functions — happy paths plus: invalid document throw (create/update), cross-property null scope (getDesign/updateDesign/deleteDesign), optimistic-lock conflict, not_found returns, default title fallback.

3. **No new npm dependencies added.**

4. **Migration is file-only**: `prisma migrate dev/deploy` was not run. `npx prisma generate` only.

## Fix: schema conventions

Applied in response to code-review feedback to align `SalesSheetDesign` with project-wide conventions.

### What changed

**`prisma/schema.prisma`**
- `SalesSheetDesign` model: added `@map("property_id")` on `propertyId`; `@map("template_id")` on `templateId`; `@map("thumbnail_url")` on `thumbnailUrl`; `@map("created_at")` on `createdAt`; `@map("updated_at")` on `updatedAt`.
- `createdBy` and `updatedBy` promoted from plain `String` to `String @map("created_by") @db.Uuid` / `String @map("updated_by") @db.Uuid` (UUID FKs to `users`).
- Added relation fields to `SalesSheetDesign`: `creator User @relation("SalesSheetDesignCreatedBy", ...)` and `updater User @relation("SalesSheetDesignUpdatedBy", ...)` — no explicit `onDelete`, matching the existing `Building.creator` pattern (defaults to `RESTRICT`).
- Added back-relations to `User` model (after `fieldSurveyPinPhotos`): `salesSheetDesignsCreated SalesSheetDesign[] @relation("SalesSheetDesignCreatedBy")` and `salesSheetDesignsUpdated SalesSheetDesign[] @relation("SalesSheetDesignUpdatedBy")`.

**`prisma/migrations/20260628000000_add_sales_sheet_design/migration.sql`**
- All column names rewritten to snake_case: `property_id`, `template_id`, `thumbnail_url`, `created_by`, `updated_by`, `created_at`, `updated_at`.
- Index renamed from `sales_sheet_designs_propertyId_idx` → `sales_sheet_designs_property_id_idx`.
- `property_id` FK renamed to `sales_sheet_designs_property_id_fkey`.
- Added two user FKs verified against init migration (`properties_created_by_fkey` uses `ON DELETE RESTRICT ON UPDATE CASCADE`):

```sql
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

(`users` is the correct table name — `@@map("users")` confirmed in schema; `users.id` is `@db.Uuid`.)

### design-service.ts — no changes needed

`createDesign` passes `createdBy: input.userId` and `updatedBy: input.userId` as scalar strings in the `data` object. With Prisma, providing the scalar FK is valid input even when a named relation field exists — Prisma distinguishes scalar writes from relation writes. `npx tsc --noEmit` confirmed zero type errors.

### Test results

```
# npm test (vitest run — full suite)
Test Files  331 passed | 1 skipped (332)
    Tests  7124 passed | 2 skipped (7126)
  Duration  18.21s

# npx tsc --noEmit
(no output — clean)

# npm run lint
1622 problems (843 errors, 779 warnings)
```
Lint count identical before and after (verified via `git stash` + lint baseline): 1622 problems pre-existed on `505a44a`. Zero new issues introduced.

## Concerns

- The `ALTER TABLE ... ADD CONSTRAINT` line is not wrapped in an `IF NOT EXISTS` guard (PostgreSQL does not support this syntax for constraints). On a fresh DB this is fine. If the migration is somehow applied twice, it will fail with a "constraint already exists" error. This is standard Prisma migration behavior (migrations are tracked in `_prisma_migrations` and applied only once), so this is acceptable and matches all other migrations in the project.
- The `document` column is `JSONB` in PostgreSQL (via Prisma's `Json` type) but is typed as `Json` in Prisma. Reads return `Prisma.JsonValue`. The service passes raw reads to callers — if callers need a typed `SalesSheetDocument`, they should call `parseSalesSheetDocument` on the result. This is noted for Task B (API layer).
