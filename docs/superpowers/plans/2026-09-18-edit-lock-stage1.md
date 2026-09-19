# 編集中の鍵 第1段(台帳・窓口・保存時の確認) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件と所有者に「編集中の鍵」の台帳と窓口を作り、保存の窓口が他人の鍵を断るようにする(画面はまだ鍵を取らないので、利用者から見た挙動は変わらない)。

**Architecture:** 新しい表 `edit_locks`(1資源1行・一意制約)に鍵を置く。取得は「資源の行をロック → `INSERT … ON CONFLICT DO UPDATE … WHERE <期限切れ OR 解除済み OR 同じ保持者>`」の1文で行い、同じ順序で資源をロックする保存・管理者解除と直列化する。期限の判定はDBの `now()` が権威。判定のルールだけは純関数に出し、画面・窓口・テストで同じものを使う。

**Tech Stack:** Next.js 16(App Router) / Prisma 7 + PostgreSQL 16 / vitest(全モック・CIに実DBは無い) / next-auth v5

**Spec:** `docs/superpowers/specs/2026-09-17-edit-lock-design.md`(発注者決定 D1〜D11・@codex R1〜R5 反映済)

## Global Constraints

- ID はすべて UUID(`@db.Uuid`)。`users.id` が UUID のため、文字列型にすると外部キーで migration が失敗する。
- 期限の判定に**端末の時計を使わない**。すべて DB の `now()`。定数は `src/lib/edit-lock/rules.ts` から SQL に渡す。
- 時間の定数: 合図 30 秒 / 合図の猶予 5 分 / 無操作 60 分(自動ログアウトの `IDLE_TIMEOUT_MS` と一致) / 予告 55 分 / 状態の再確認 30 秒。
- ロック順序は既存規約どおり **所有者 → 物件の親行 → 子行**。合図(`heartbeat`)だけは資源の行をロックしない。
- 監査ログの `detail` は **ID と enum だけ**。氏名・住所・画面の合言葉(生値もハッシュも)は入れない。`audit-log-detail-safety.ts` の action 別許可リストに足さないと管理画面で `[REDACTED]` になる。
- **画面の変更はこの計画に含めない**(第2段)。第1段だけを本番に出しても鍵は1本も生まれず、保存は今までどおり通る。
- テストはすべて既存流儀(`vi.mock("@/lib/prisma")` / `vi.mock("@/lib/api-helpers")`)。**CI に実DBは無い**ので、同時取得の最終確認はローカルの開発DBに対する手動スクリプト(Task 8)で行い、結果を PR に貼る。
- コミットは各タスク末尾で1回。`git add` は触ったファイルだけ(`-A` を使わない)。

## File Structure

| ファイル | 役割 |
|---|---|
| `src/lib/edit-lock/rules.ts`(新規) | 定数と純関数(`isLockExpired` / `evaluateLock`)。DB にも画面にも依存しない |
| `src/lib/edit-lock/service.ts`(新規) | 台帳への読み書き(取得・合図・解除・管理者解除・状態・保存時の確認・後始末)。SQL はここだけ |
| `src/lib/edit-lock/permissions.ts`(新規) | 「その資源の鍵を取れるか/状態を見られるか」の判定(物件=担当範囲・所有者=項目の書込権限) |
| `src/lib/edit-lock/screen-token.ts`(新規) | 合言葉ヘッダ `X-Edit-Screen` の読み取りと sha256 |
| `src/app/api/edit-locks/acquire/route.ts` ほか5本(新規) | 窓口 |
| `prisma/schema.prisma`(変更) | `EditLock` モデルと `EditLockResource` enum |
| `prisma/migrations/20260918100000_add_edit_locks/migration.sql`(新規) | 表の追加のみ |
| `src/app/api/properties/[id]/route.ts`(変更) | PATCH をトランザクションで包み、鍵の確認を足す |
| `src/app/api/owners/[id]/route.ts`(変更) | 同上 |
| `src/app/api/owners/[id]/corporate-apply/route.ts`(変更) | 同上 |
| `src/lib/registry-pdf/process.ts`(変更) | 鍵がある間は空欄の補完を見送る。法人番号の補完で `Owner.version` を進める |
| `src/lib/audit-log-detail-safety.ts`(変更) | 新しい4つの action と取込フラグの許可 |
| `src/app/api/import/jobs/[jobId]/rollback/route.ts` ほか3本(変更) | 資源を消すときに鍵も消す |

---

### Task 1: 鍵のルール(純関数と定数)

**Files:**
- Create: `src/lib/edit-lock/rules.ts`
- Test: `src/lib/edit-lock/__tests__/rules.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `EDIT_LOCK_HEARTBEAT_INTERVAL_MS` / `EDIT_LOCK_HEARTBEAT_GRACE_MS` / `EDIT_LOCK_IDLE_LIMIT_MS` / `EDIT_LOCK_IDLE_WARN_MS` / `EDIT_LOCK_STATUS_POLL_MS`、型 `EditLockResourceType` = `"property" | "owner"`、型 `EditLockRow`、型 `EditLockRequester`、型 `EditLockState`、関数 `isLockExpired(lock: EditLockRow, now: Date): boolean`、関数 `expiryCause(lock: EditLockRow, now: Date): "heartbeat" | "idle" | null`(両方超えていたら heartbeat を優先・期限内は null)、関数 `evaluateLock(lock: EditLockRow | null, now: Date, requester: EditLockRequester): EditLockState`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/rules.test.ts
import { describe, it, expect } from "vitest";
import {
  EDIT_LOCK_HEARTBEAT_GRACE_MS,
  EDIT_LOCK_IDLE_LIMIT_MS,
  evaluateLock,
  expiryCause,
  isLockExpired,
  type EditLockRow,
} from "../rules";
import { IDLE_TIMEOUT_MS } from "@/components/auth/idle-session-guard";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (over: Partial<EditLockRow> = {}): EditLockRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  userId: "user-a",
  screenTokenHash: "hash-a",
  acquiredAt: ago(60_000),
  heartbeatAt: ago(10_000),
  activityAt: ago(10_000),
  forceReleasedAt: null,
  ...over,
});
const A = { userId: "user-a", screenTokenHash: "hash-a" };
const A2 = { userId: "user-a", screenTokenHash: "hash-a2" };
const B = { userId: "user-b", screenTokenHash: "hash-b" };

describe("定数", () => {
  it("無操作の上限は自動ログアウトと一致する", () => {
    expect(EDIT_LOCK_IDLE_LIMIT_MS).toBe(IDLE_TIMEOUT_MS);
  });
});

describe("isLockExpired", () => {
  it("合図が猶予内・操作が上限内なら生きている", () => {
    expect(isLockExpired(row(), NOW)).toBe(false);
  });
  it("合図が猶予を1ミリ秒超えたら期限切れ", () => {
    expect(isLockExpired(row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) }), NOW)).toBe(true);
  });
  it("合図はちょうど猶予なら生きている(境界)", () => {
    expect(isLockExpired(row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS) }), NOW)).toBe(false);
  });
  it("操作が上限を超えたら期限切れ", () => {
    expect(isLockExpired(row({ activityAt: ago(EDIT_LOCK_IDLE_LIMIT_MS + 1) }), NOW)).toBe(true);
  });
});

describe("expiryCause: それぞれの上限で判定する", () => {
  it("合図6分・操作50分 は heartbeat(古さの大小で決めない)", () => {
    expect(expiryCause(row({ heartbeatAt: ago(6 * 60_000), activityAt: ago(50 * 60_000) }), NOW)).toBe("heartbeat");
  });
  it("合図1分・操作61分 は idle", () => {
    expect(expiryCause(row({ heartbeatAt: ago(60_000), activityAt: ago(61 * 60_000) }), NOW)).toBe("idle");
  });
  it("両方超えていたら heartbeat を優先", () => {
    expect(expiryCause(row({ heartbeatAt: ago(6 * 60_000), activityAt: ago(61 * 60_000) }), NOW)).toBe("heartbeat");
  });
  it("期限内なら null", () => {
    expect(expiryCause(row(), NOW)).toBeNull();
  });
});

describe("evaluateLock: 総当たり", () => {
  it("鍵が無ければ空き", () => {
    expect(evaluateLock(null, NOW, A)).toEqual({ state: "free" });
  });
  it("同じ利用者・同じ画面なら自分のもの", () => {
    expect(evaluateLock(row(), NOW, A)).toMatchObject({ state: "mine" });
  });
  it("同じ利用者・別の画面は待つ側(D6)", () => {
    expect(evaluateLock(row(), NOW, A2)).toMatchObject({ state: "held_by_self_other_screen" });
  });
  it("別の利用者は他人の鍵", () => {
    expect(evaluateLock(row(), NOW, B)).toMatchObject({ state: "held_by_other", holderUserId: "user-a" });
  });
  it("期限切れは誰から見ても空き", () => {
    const expired = row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) });
    for (const who of [A, A2, B]) {
      expect(evaluateLock(expired, NOW, who)).toEqual({ state: "free" });
    }
  });
  it("管理者に外された鍵は、外された本人には force_released_mine・他人には空き", () => {
    const killed = row({ forceReleasedAt: ago(1_000) });
    expect(evaluateLock(killed, NOW, A)).toMatchObject({ state: "force_released_mine" });
    expect(evaluateLock(killed, NOW, A2)).toEqual({ state: "free" });
    expect(evaluateLock(killed, NOW, B)).toEqual({ state: "free" });
  });
  it("期限切れかつ外された鍵も空き(外された本人以外)", () => {
    const both = row({ forceReleasedAt: ago(1_000), heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) });
    expect(evaluateLock(both, NOW, B)).toEqual({ state: "free" });
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/rules.test.ts`
Expected: FAIL(`Cannot find module '../rules'`)

- [ ] **Step 3: 最小の実装を書く**

```ts
// src/lib/edit-lock/rules.ts
/**
 * 編集中の鍵の判定ルール(純関数)。DB にも画面にも依存させない。
 * SQL 側(service.ts)とこのファイルは同じ定数から条件を組み立てる。
 */
import { IDLE_TIMEOUT_MS } from "@/components/auth/idle-session-guard";

export const EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
export const EDIT_LOCK_HEARTBEAT_GRACE_MS = 5 * 60_000;
/** 無操作の上限。自動ログアウトと同じ(テストで一致を固定)。 */
export const EDIT_LOCK_IDLE_LIMIT_MS = IDLE_TIMEOUT_MS;
export const EDIT_LOCK_IDLE_WARN_MS = 55 * 60_000;
export const EDIT_LOCK_STATUS_POLL_MS = 30_000;

export type EditLockResourceType = "property" | "owner";

export type EditLockRow = {
  id: string;
  userId: string;
  screenTokenHash: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  activityAt: Date;
  forceReleasedAt: Date | null;
};

export type EditLockRequester = { userId: string; screenTokenHash: string };

export type EditLockState =
  | { state: "free" }
  | { state: "mine"; lockId: string; since: Date }
  | { state: "held_by_self_other_screen"; lockId: string; since: Date }
  | { state: "held_by_other"; lockId: string; holderUserId: string; since: Date }
  | { state: "force_released_mine"; lockId: string };

export function isLockExpired(lock: EditLockRow, now: Date): boolean {
  return expiryCause(lock, now) !== null;
}

/**
 * 何が原因で期限切れになったか。監査に残す。
 * ⚠合図と操作は**上限が違う**(5分と60分)ので、古さの大小で決めてはいけない。
 * 両方超えているときは、先に効く合図の側を原因とする。
 */
export function expiryCause(lock: EditLockRow, now: Date): "heartbeat" | "idle" | null {
  const t = now.getTime();
  if (t - lock.heartbeatAt.getTime() > EDIT_LOCK_HEARTBEAT_GRACE_MS) return "heartbeat";
  if (t - lock.activityAt.getTime() > EDIT_LOCK_IDLE_LIMIT_MS) return "idle";
  return null;
}

export function evaluateLock(
  lock: EditLockRow | null,
  now: Date,
  requester: EditLockRequester,
): EditLockState {
  if (!lock) return { state: "free" };
  const sameHolder =
    lock.userId === requester.userId &&
    lock.screenTokenHash === requester.screenTokenHash;
  // 管理者に外された鍵は、外された本人にだけ「外された」と伝える(遅れて届く保存を断るため)。
  // 他の人から見れば空き。
  if (lock.forceReleasedAt) {
    return sameHolder
      ? { state: "force_released_mine", lockId: lock.id }
      : { state: "free" };
  }
  if (isLockExpired(lock, now)) return { state: "free" };
  if (sameHolder) return { state: "mine", lockId: lock.id, since: lock.acquiredAt };
  if (lock.userId === requester.userId) {
    return { state: "held_by_self_other_screen", lockId: lock.id, since: lock.acquiredAt };
  }
  return {
    state: "held_by_other",
    lockId: lock.id,
    holderUserId: lock.userId,
    since: lock.acquiredAt,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/rules.test.ts`
Expected: PASS(13 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/edit-lock/rules.ts src/lib/edit-lock/__tests__/rules.test.ts
git commit -m "feat(edit-lock): 鍵の判定ルールと定数(純関数)"
```

---

### Task 2: 台帳(スキーマと migration)

**Files:**
- Modify: `prisma/schema.prisma`(末尾に追加)
- Create: `prisma/migrations/20260918100000_add_edit_locks/migration.sql`
- Test: `src/lib/edit-lock/__tests__/migration-shape.test.ts`

**Interfaces:**
- Consumes: Task 1 の `EditLockResourceType`
- Produces: Prisma モデル `EditLock`(`prisma.editLock`)・enum `EditLockResource`・表 `edit_locks`

**なぜ走査テストか:** CI に実DBが無いため、migration の中身(UUID型・一意制約・Cascade)を文字列で固定する。実DBでの適用は Task 8 の手動ゲートで確認する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/migration-shape.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260918100000_add_edit_locks/migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("edit_locks の migration", () => {
  it("ID は UUID 型(users.id と同じ)", () => {
    expect(sql).toMatch(/"id" UUID NOT NULL/);
    expect(sql).toMatch(/"resource_id" UUID NOT NULL/);
    expect(sql).toMatch(/"user_id" UUID NOT NULL/);
    expect(sql).toMatch(/"force_released_by" UUID/);
  });
  it("1資源1行の一意制約がある", () => {
    expect(sql).toMatch(/UNIQUE INDEX .*edit_locks.*resource_type.*resource_id/s);
  });
  it("利用者を消したら鍵も消える", () => {
    expect(sql).toMatch(/FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/);
  });
  it("既存の表を変更しない(追加のみ)", () => {
    expect(sql).not.toMatch(/ALTER TABLE "(properties|owners|users)"/);
    expect(sql).not.toMatch(/DROP /);
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/migration-shape.test.ts`
Expected: FAIL(ENOENT: migration.sql が無い)

- [ ] **Step 3: スキーマに追記して migration を作る**

`prisma/schema.prisma` の末尾に追加:

```prisma
enum EditLockResource {
  property
  owner
}

/// 編集中の鍵(1資源1行)。設計 docs/superpowers/specs/2026-09-17-edit-lock-design.md
model EditLock {
  id              String           @id @default(uuid()) @db.Uuid
  resourceType    EditLockResource @map("resource_type")
  resourceId      String           @map("resource_id") @db.Uuid
  userId          String           @map("user_id") @db.Uuid
  screenTokenHash String           @map("screen_token_hash")
  acquiredAt      DateTime         @default(now()) @map("acquired_at")
  heartbeatAt     DateTime         @default(now()) @map("heartbeat_at")
  activityAt      DateTime         @default(now()) @map("activity_at")
  forceReleasedAt DateTime?        @map("force_released_at")
  forceReleasedBy String?          @map("force_released_by") @db.Uuid

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([resourceType, resourceId])
  @@index([userId])
  @@map("edit_locks")
}
```

`User` モデルに1行足す(他の関係と同じ場所):

```prisma
  editLocks EditLock[]
```

migration を生成:

```bash
npx prisma migrate dev --name add_edit_locks --create-only
```

生成されたディレクトリ名が `20260918100000_add_edit_locks` でなければ、**ディレクトリ名をこの名前に変更**する(テストとdocsが参照するため)。生成SQLが上のテストの4条件を満たすことを目視で確認する。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/migration-shape.test.ts && npx prisma validate && npx prisma generate`
Expected: PASS(4 tests)・`The schema at prisma/schema.prisma is valid`・`Generated Prisma Client`

- [ ] **Step 5: コミット**

```bash
git add prisma/schema.prisma prisma/migrations/20260918100000_add_edit_locks/migration.sql src/lib/edit-lock/__tests__/migration-shape.test.ts
git commit -m "feat(edit-lock): 台帳 edit_locks の追加(migration)"
```

---

### Task 3: 台帳への読み書き(service)

**Files:**
- Create: `src/lib/edit-lock/service.ts`
- Test: `src/lib/edit-lock/__tests__/service.test.ts`

**Interfaces:**
- Consumes: Task 1 の定数・型
- Produces:
  - `acquireEditLock(tx, input): Promise<{ state: "mine"; lockId: string; since: Date; previous: EditLockRow | null } | { state: "held"; current: EditLockRow }>`
  - `heartbeatEditLock(db, input): Promise<{ ok: true } | { ok: false; current: EditLockRow | null }>`
  - `releaseEditLock(db, input): Promise<{ deleted: number }>`
  - `forceReleaseEditLock(tx, input): Promise<{ previousUserId: string } | null>`
  - `readEditLocks(db, resources): Promise<EditLockRow[]>`(`resourceType`/`resourceId` 付き)
  - `assertNotEditLockedByOther(tx, input): Promise<void>`(違反時 `ApiError`)
  - `isResourceEditLocked(db, target): Promise<boolean>`(保持者を持たない処理=取込が使う。DBの now() で判定)
  - `deleteEditLocksFor(tx, resources): Promise<number>`
  - 入力はすべて `{ resourceType, resourceId, userId, screenTokenHash }` を基本形とする

**SQL の正しさの担保:** 条件式は文字列としてテストで固定し、**同時取得の実挙動は Task 8 の実DB手動確認**で担保する(CI に DB が無いため)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/service.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return { ApiError: MockApiError };
});

import {
  acquireEditLock,
  assertNotEditLockedByOther,
  forceReleaseEditLock,
  heartbeatEditLock,
  releaseEditLock,
} from "../service";

/** $queryRaw のテンプレートを1本の文字列に戻す(条件式の検査用)。 */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ""), "");
}

function fakeDb(result: unknown[] = []) {
  const queryRaw = vi.fn().mockResolvedValue(result);
  return { queryRaw, db: { $queryRaw: queryRaw } as never };
}

const BASE = {
  resourceType: "property" as const,
  resourceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  screenTokenHash: "hash-a",
};

beforeEach(() => vi.clearAllMocks());

describe("acquireEditLock", () => {
  it("取得できたら世代(lockId)を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    queryRaw
      .mockResolvedValueOnce([]) // 既存の読み取り
      .mockResolvedValueOnce([{ id: "44444444-4444-4444-8444-444444444444", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
    const res = await acquireEditLock(db, BASE);
    expect(res).toMatchObject({ state: "mine", lockId: "44444444-4444-4444-8444-444444444444" });
  });

  it("取得のSQLは 期限切れ・解除済み・同じ保持者 のときだけ上書きし、世代を振り直す", async () => {
    const { db, queryRaw } = fakeDb([]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x", acquired_at: new Date() }]);
    await acquireEditLock(db, BASE);
    const sql = sqlOf(queryRaw.mock.calls[1]);
    expect(sql).toMatch(/ON CONFLICT \("resource_type", "resource_id"\) DO UPDATE/);
    expect(sql).toMatch(/SET[\s\S]*"id" = gen_random_uuid\(\)/);
    expect(sql).toMatch(/"force_released_at" = NULL/);
    expect(sql).toMatch(/WHERE[\s\S]*"edit_locks"\."force_released_at" IS NOT NULL/);
    expect(sql).toMatch(/"edit_locks"\."heartbeat_at" < now\(\) - make_interval/);
    expect(sql).toMatch(/"edit_locks"\."activity_at" < now\(\) - make_interval/);
    expect(sql).toMatch(/"edit_locks"\."user_id" = EXCLUDED\."user_id" AND "edit_locks"\."screen_token_hash" = EXCLUDED\."screen_token_hash"/);
  });

  it("0件なら他人が保持中として現在の行を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    const current = { id: "l1", user_id: "other", screen_token_hash: "h", acquired_at: new Date(), heartbeat_at: new Date(), activity_at: new Date(), force_released_at: null };
    queryRaw.mockResolvedValueOnce([current]).mockResolvedValueOnce([]).mockResolvedValueOnce([current]);
    const res = await acquireEditLock(db, BASE);
    expect(res).toMatchObject({ state: "held" });
  });
});

describe("heartbeatEditLock", () => {
  it("操作があったときだけ activity_at を進める", async () => {
    const { db, queryRaw } = fakeDb([{ id: "l1" }]);
    await heartbeatEditLock(db, { ...BASE, active: true });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/"heartbeat_at" = now\(\)/);
    expect(sql).toMatch(/"activity_at" = CASE WHEN \{true\} THEN now\(\) ELSE "activity_at" END/);
    expect(sql).toMatch(/"force_released_at" IS NULL/);
  });
});

describe("releaseEditLock", () => {
  it("世代と保持者が一致し、墓標でない行だけ消す", async () => {
    const { db, queryRaw } = fakeDb([]);
    await releaseEditLock(db, { ...BASE, lockId: "l1" });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/DELETE FROM "edit_locks"/);
    expect(sql).toMatch(/"id" = \{l1\}/);
    expect(sql).toMatch(/"user_id" = \{33333333-3333-4333-8333-333333333333\}/);
    expect(sql).toMatch(/"screen_token_hash" = \{hash-a\}/);
    expect(sql).toMatch(/"force_released_at" IS NULL/);
  });
});

describe("forceReleaseEditLock", () => {
  it("世代と資源の両方が一致した行にだけ墓標を立てる", async () => {
    const { db, queryRaw } = fakeDb([{ user_id: "victim" }]);
    const res = await forceReleaseEditLock(db, { resourceType: "property", resourceId: BASE.resourceId, lockId: "l1", adminUserId: "admin" });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/UPDATE "edit_locks"/);
    expect(sql).toMatch(/"force_released_at" = now\(\)/);
    expect(sql).toMatch(/"id" = \{l1\}/);
    expect(sql).toMatch(/"resource_type" = /);
    expect(sql).toMatch(/"resource_id" = /);
    expect(res).toEqual({ previousUserId: "victim" });
  });
});

describe("assertNotEditLockedByOther", () => {
  // ⚠この窓口は SQL 側で active / force_released を計算して返す(DBの時計が権威)。
  const holder = (over: Record<string, unknown> = {}) => [{
    user_id: "other", screen_token_hash: "h-other", force_released: false, active: true, ...over,
  }];

  it("他人が持っていれば 423 EDIT_LOCKED", async () => {
    const { db } = fakeDb(holder());
    await expect(assertNotEditLockedByOther(db, BASE)).rejects.toMatchObject({ status: 423, code: "EDIT_LOCKED" });
  });
  it("自分の墓標なら 423 EDIT_LOCK_FORCE_RELEASED", async () => {
    const { db } = fakeDb(holder({ user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash, force_released: true, active: false }));
    await expect(assertNotEditLockedByOther(db, BASE)).rejects.toMatchObject({ status: 423, code: "EDIT_LOCK_FORCE_RELEASED" });
  });
  it("期限の判定はDBの now() で行う(SQL側で active を計算する)", async () => {
    const { db, queryRaw } = fakeDb([]);
    await assertNotEditLockedByOther(db, BASE);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/AS active/);
    expect(sql).toMatch(/now\(\) - make_interval/);
  });
  it("自分の鍵なら通す", async () => {
    const { db } = fakeDb(holder({ user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash }));
    await expect(assertNotEditLockedByOther(db, BASE)).resolves.toBeUndefined();
  });
  it("鍵が無ければ通す(合言葉が無い古い画面も同じ)", async () => {
    const { db } = fakeDb([]);
    await expect(assertNotEditLockedByOther(db, { ...BASE, screenTokenHash: null })).resolves.toBeUndefined();
  });
  it("他人が持っていて合言葉が無ければ、再読み込みの案内を文言に足す", async () => {
    const { db } = fakeDb(holder());
    await expect(assertNotEditLockedByOther(db, { ...BASE, screenTokenHash: null })).rejects.toMatchObject({
      status: 423,
      message: expect.stringContaining("再読み込み"),
    });
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/service.test.ts`
Expected: FAIL(`Cannot find module '../service'`)

- [ ] **Step 3: 実装を書く**

```ts
// src/lib/edit-lock/service.ts
/**
 * 編集中の鍵の台帳(edit_locks)への読み書き。SQL はこのファイルだけに置く。
 *
 * ⚠期限の判定は **DB の now()** が権威。JS の時刻は使わない。
 * ⚠取得・保存の確認・管理者解除は、呼び出し側が**先に資源の行をロック**してから
 *   呼ぶ(ロック順序 = 所有者 → 物件の親行 → 子行)。合図だけはロックしない。
 */
import { ApiError } from "@/lib/api-helpers";
import {
  EDIT_LOCK_HEARTBEAT_GRACE_MS,
  EDIT_LOCK_IDLE_LIMIT_MS,
  evaluateLock,
  type EditLockResourceType,
  type EditLockRow,
} from "./rules";

type Db = {
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

type RawRow = {
  id: string;
  user_id: string;
  screen_token_hash: string;
  acquired_at: Date;
  heartbeat_at: Date;
  activity_at: Date;
  force_released_at: Date | null;
};

const GRACE_SEC = EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000;
const IDLE_SEC = EDIT_LOCK_IDLE_LIMIT_MS / 1000;

function toRow(r: RawRow): EditLockRow {
  return {
    id: r.id,
    userId: r.user_id,
    screenTokenHash: r.screen_token_hash,
    acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at,
    activityAt: r.activity_at,
    forceReleasedAt: r.force_released_at,
  };
}

type Target = { resourceType: EditLockResourceType; resourceId: string };
type Holder = { userId: string; screenTokenHash: string };

async function readOne(db: Db, t: Target): Promise<EditLockRow | null> {
  const rows = await db.$queryRaw<RawRow[]>`
    SELECT "id", "user_id", "screen_token_hash", "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    WHERE "resource_type" = ${t.resourceType}::"EditLockResource" AND "resource_id" = ${t.resourceId}::uuid
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

export async function acquireEditLock(
  db: Db,
  input: Target & Holder,
): Promise<
  | { state: "mine"; lockId: string; since: Date; previous: EditLockRow | null }
  | { state: "held"; current: EditLockRow }
> {
  const previous = await readOne(db, input);
  const got = await db.$queryRaw<{ id: string; acquired_at: Date }[]>`
    INSERT INTO "edit_locks" ("id", "resource_type", "resource_id", "user_id", "screen_token_hash", "acquired_at", "heartbeat_at", "activity_at")
    VALUES (gen_random_uuid(), ${input.resourceType}::"EditLockResource", ${input.resourceId}::uuid, ${input.userId}::uuid, ${input.screenTokenHash}, now(), now(), now())
    ON CONFLICT ("resource_type", "resource_id") DO UPDATE
    SET "id" = gen_random_uuid(),
        "user_id" = EXCLUDED."user_id",
        "screen_token_hash" = EXCLUDED."screen_token_hash",
        "acquired_at" = now(),
        "heartbeat_at" = now(),
        "activity_at" = now(),
        "force_released_at" = NULL,
        "force_released_by" = NULL
    WHERE "edit_locks"."force_released_at" IS NOT NULL
       OR "edit_locks"."heartbeat_at" < now() - make_interval(secs => ${GRACE_SEC})
       OR "edit_locks"."activity_at" < now() - make_interval(secs => ${IDLE_SEC})
       OR ("edit_locks"."user_id" = EXCLUDED."user_id" AND "edit_locks"."screen_token_hash" = EXCLUDED."screen_token_hash")
    RETURNING "id", "acquired_at"
  `;
  if (got[0]) {
    return { state: "mine", lockId: got[0].id, since: got[0].acquired_at, previous };
  }
  const current = (await readOne(db, input)) ?? previous;
  // 取れず、かつ行も消えている = 直前に別の誰かが取って外した。もう一度取りにいかせる。
  if (!current) throw new ApiError(409, "鍵の状態が変わりました。もう一度お試しください", "EDIT_LOCK_CHANGED");
  return { state: "held", current };
}

export async function heartbeatEditLock(
  db: Db,
  input: Target & Holder & { active: boolean },
): Promise<{ ok: true } | { ok: false; current: EditLockRow | null }> {
  const updated = await db.$queryRaw<{ id: string }[]>`
    UPDATE "edit_locks"
    SET "heartbeat_at" = now(),
        "activity_at" = CASE WHEN ${input.active} THEN now() ELSE "activity_at" END
    WHERE "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "screen_token_hash" = ${input.screenTokenHash}
      AND "force_released_at" IS NULL
      AND "heartbeat_at" >= now() - make_interval(secs => ${GRACE_SEC})
      AND "activity_at" >= now() - make_interval(secs => ${IDLE_SEC})
    RETURNING "id"
  `;
  if (updated[0]) return { ok: true };
  return { ok: false, current: await readOne(db, input) };
}

export async function releaseEditLock(
  db: Db,
  input: Target & Holder & { lockId: string },
): Promise<{ deleted: number }> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    DELETE FROM "edit_locks"
    WHERE "id" = ${input.lockId}::uuid
      AND "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "screen_token_hash" = ${input.screenTokenHash}
      AND "force_released_at" IS NULL
    RETURNING "id"
  `;
  return { deleted: rows.length };
}

export async function forceReleaseEditLock(
  db: Db,
  input: Target & { lockId: string; adminUserId: string },
): Promise<{ previousUserId: string } | null> {
  const rows = await db.$queryRaw<{ user_id: string }[]>`
    UPDATE "edit_locks"
    SET "force_released_at" = now(), "force_released_by" = ${input.adminUserId}::uuid
    WHERE "id" = ${input.lockId}::uuid
      AND "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "force_released_at" IS NULL
    RETURNING "user_id"
  `;
  return rows[0] ? { previousUserId: rows[0].user_id } : null;
}

export async function readEditLocks(
  db: Db,
  resources: Target[],
): Promise<(EditLockRow & Target)[]> {
  if (resources.length === 0) return [];
  const types = resources.map((r) => r.resourceType);
  const ids = resources.map((r) => r.resourceId);
  const rows = await db.$queryRaw<(RawRow & { resource_type: EditLockResourceType; resource_id: string })[]>`
    SELECT "id", "resource_type", "resource_id", "user_id", "screen_token_hash", "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    WHERE ("resource_type"::text, "resource_id"::text) IN (
      SELECT * FROM unnest(${types}::text[], ${ids}::text[])
    )
  `;
  return rows.map((r) => ({ ...toRow(r), resourceType: r.resource_type, resourceId: r.resource_id }));
}

/**
 * 保存の窓口で呼ぶ。**資源の行をロックした後・書き込みの前**に。
 * 合言葉が無い(反映前から開いていた古い画面)ときは、断る文言に再読み込みの案内を足す。
 */
export async function assertNotEditLockedByOther(
  db: Db,
  input: Target & { userId: string; screenTokenHash: string | null },
): Promise<void> {
  // ⚠期限の判定は **DB の now()** で行う(@codex R6 P2)。取得・合図が DB 時計を権威に
  //   しているのに、ここだけアプリの時計で判定すると、5分の境目で食い違って
  //   「生きている鍵を期限切れとみなして書き込む」ことが起きる。
  const rows = await db.$queryRaw<{ user_id: string; screen_token_hash: string; force_released: boolean; active: boolean }[]>`
    SELECT "user_id", "screen_token_hash",
           ("force_released_at" IS NOT NULL) AS force_released,
           ("force_released_at" IS NULL
            AND "heartbeat_at" >= now() - make_interval(secs => ${GRACE_SEC})
            AND "activity_at" >= now() - make_interval(secs => ${IDLE_SEC})) AS active
    FROM "edit_locks"
    WHERE "resource_type" = ${input.resourceType}::"EditLockResource" AND "resource_id" = ${input.resourceId}::uuid
  `;
  const row = rows[0];
  if (!row) return;
  const sameHolder =
    row.user_id === input.userId && row.screen_token_hash === (input.screenTokenHash ?? "");
  const state = { state: row.force_released && sameHolder ? "force_released_mine" : !row.active ? "free" : sameHolder ? "mine" : "held" } as const;
  if (state.state === "force_released_mine") {
    throw new ApiError(423, "管理者が編集を終了しました。この内容は保存できません", "EDIT_LOCK_FORCE_RELEASED");
  }
  if (state.state === "held") {
    const suffix = input.screenTokenHash ? "" : "。画面を再読み込みしてください";
    throw new ApiError(423, `他の画面で編集中です${suffix}`, "EDIT_LOCKED");
  }
}

/** 資源を消す/アーカイブするときの後始末。 */
export async function deleteEditLocksFor(db: Db, resources: Target[]): Promise<number> {
  if (resources.length === 0) return 0;
  const types = resources.map((r) => r.resourceType);
  const ids = resources.map((r) => r.resourceId);
  const rows = await db.$queryRaw<{ id: string }[]>`
    DELETE FROM "edit_locks"
    WHERE ("resource_type"::text, "resource_id"::text) IN (
      SELECT * FROM unnest(${types}::text[], ${ids}::text[])
    )
    RETURNING "id"
  `;
  return rows.length;
}
```

⚠`assertNotEditLockedByOther` の文言には**氏名を入れない**(この関数は保持者の氏名を引かない)。氏名つきの文言は第2段の画面が状態の窓口から取って出す。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/service.test.ts`
Expected: PASS(11 tests)

- [ ] **Step 5: コミット**

```bash
git add src/lib/edit-lock/service.ts src/lib/edit-lock/__tests__/service.test.ts
git commit -m "feat(edit-lock): 台帳の読み書き(取得・合図・解除・管理者解除・確認)"
```

---

### Task 4: 合言葉と権限の判定

**Files:**
- Create: `src/lib/edit-lock/screen-token.ts`
- Create: `src/lib/edit-lock/permissions.ts`
- Test: `src/lib/edit-lock/__tests__/screen-token.test.ts`
- Test: `src/lib/edit-lock/__tests__/permissions.test.ts`

**Interfaces:**
- Consumes: `hasPermission` / `hasExplicitWritePerm`(`@/lib/permissions`)・`canAccessPropertyRecord`(`@/lib/property-access`)
- Produces:
  - `readScreenTokenHash(request: Request): string | null`(ヘッダ `X-Edit-Screen` を sha256。無ければ null)
  - `hashScreenToken(token: string): string`
  - `canWriteOwnerAnyField(perms): boolean`
  - `assertCanLockProperty(session, perms, property): void`(不可なら `ApiError(403)`)
  - `assertCanLockOwner(perms): void`(不可なら `ApiError(403)`)

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/edit-lock/__tests__/screen-token.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readScreenTokenHash, hashScreenToken } from "../screen-token";

describe("画面の合言葉", () => {
  it("ヘッダが無ければ null", () => {
    expect(readScreenTokenHash(new Request("http://x/"))).toBeNull();
  });
  it("空白だけのヘッダも null", () => {
    expect(readScreenTokenHash(new Request("http://x/", { headers: { "X-Edit-Screen": "   " } }))).toBeNull();
  });
  it("sha256 にして返す(生値は返さない)", () => {
    const token = "screen-abc";
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashScreenToken(token)).toBe(expected);
    expect(readScreenTokenHash(new Request("http://x/", { headers: { "X-Edit-Screen": token } }))).toBe(expected);
  });
});
```

```ts
// src/lib/edit-lock/__tests__/permissions.test.ts
import { describe, it, expect } from "vitest";
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return { ApiError: MockApiError };
});
import { vi } from "vitest";
import { assertCanLockOwner, assertCanLockProperty, canWriteOwnerAnyField } from "../permissions";

const P = (...entries: [string, string][]) => entries.map(([resource, action]) => ({ resource, action, granted: true }));

describe("所有者の鍵", () => {
  it("owner:write だけでは取れない(項目の書込権限が要る)", () => {
    expect(() => assertCanLockOwner(P(["owner", "write"]))).toThrowError(/権限/);
  });
  it("項目の書込権限が1つでもあれば取れる", () => {
    expect(canWriteOwnerAnyField(P(["owner", "write"], ["owner_name", "full"]))).toBe(true);
    expect(() => assertCanLockOwner(P(["owner", "write"], ["owner_name", "full"]))).not.toThrow();
  });
  it("owner:write が無ければ取れない", () => {
    expect(() => assertCanLockOwner(P(["owner_name", "full"]))).toThrowError(/権限/);
  });
});

describe("物件の鍵", () => {
  const prop = { createdBy: "u1", assignedTo: null };
  it("property:write が無ければ 403", () => {
    expect(() => assertCanLockProperty({ id: "u1", role: "general" }, P(["property", "read"]), prop)).toThrowError(/権限/);
  });
  it("アルバイトは担当外なら 403", () => {
    expect(() => assertCanLockProperty({ id: "u2", role: "field_staff" }, P(["property", "write"]), prop)).toThrowError(/権限/);
  });
  it("アルバイトでも担当なら取れる", () => {
    expect(() => assertCanLockProperty({ id: "u1", role: "field_staff" }, P(["property", "write"]), prop)).not.toThrow();
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/screen-token.test.ts src/lib/edit-lock/__tests__/permissions.test.ts`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: 実装を書く**

```ts
// src/lib/edit-lock/screen-token.ts
import { createHash } from "node:crypto";

/** ブラウザのタブごとの合言葉を送るヘッダ名。 */
export const EDIT_SCREEN_HEADER = "X-Edit-Screen";

export function hashScreenToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** ヘッダから合言葉を読み、**ハッシュだけ**を返す(生値はどこにも残さない)。 */
export function readScreenTokenHash(request: Request): string | null {
  const raw = request.headers.get(EDIT_SCREEN_HEADER);
  if (!raw || raw.trim() === "") return null;
  return hashScreenToken(raw.trim());
}
```

```ts
// src/lib/edit-lock/permissions.ts
import { ApiError } from "@/lib/api-helpers";
import { hasExplicitWritePerm, hasPermission, type PermissionEntry } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

/**
 * 所有者の編集画面で編集できる項目の権限。
 * ⚠`PATCH /api/owners/[id]` の項目ごとの確認・画面の `canEditOwner` と同じ並びにする。
 */
const OWNER_FIELD_RESOURCES = [
  "owner_name",
  "owner_name_kana",
  "owner_phone",
  "owner_zip",
  "owner_address",
  "owner_email",
  "owner_note",
  "owner_corporate_number",
] as const;

export function canWriteOwnerAnyField(perms: PermissionEntry[]): boolean {
  return OWNER_FIELD_RESOURCES.some((r) => hasExplicitWritePerm(perms, r));
}

/**
 * 所有者の鍵を取れるか。⚠項目の書込権限が1つも無い利用者は、画面に編集ボタンが
 * 出ないのに窓口を直接呼べば鍵だけ取って他人を締め出せてしまうため、ここで断る。
 */
export function assertCanLockOwner(perms: PermissionEntry[]): void {
  if (!hasPermission(perms, "owner", "write") || !canWriteOwnerAnyField(perms)) {
    throw new ApiError(403, "この所有者を編集する権限がありません", "FORBIDDEN");
  }
}

export function assertCanLockProperty(
  session: { id: string; role: string },
  perms: PermissionEntry[],
  property: { createdBy: string; assignedTo: string | null },
): void {
  if (!hasPermission(perms, "property", "write") || !canAccessPropertyRecord(session, property)) {
    throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
  }
}
```

⚠`OWNER_FIELD_RESOURCES` の並びは、実装時に `src/app/api/owners/[id]/route.ts` の `fieldWriteChecks` を開いて**実際の resource 名に合わせる**(名前が違えば合わせ、足りなければ足す)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/`
Expected: PASS(全ファイル)

- [ ] **Step 5: コミット**

```bash
git add src/lib/edit-lock/screen-token.ts src/lib/edit-lock/permissions.ts src/lib/edit-lock/__tests__/screen-token.test.ts src/lib/edit-lock/__tests__/permissions.test.ts
git commit -m "feat(edit-lock): 合言葉の読み取りと鍵の権限判定"
```

---

### Task 5: 窓口5本(API)

**Files:**
- Create: `src/app/api/edit-locks/acquire/route.ts`
- Create: `src/app/api/edit-locks/heartbeat/route.ts`
- Create: `src/app/api/edit-locks/release/route.ts`
- Create: `src/app/api/edit-locks/force-release/route.ts`
- Create: `src/app/api/edit-locks/status/route.ts`
- Modify: `src/lib/audit-log-detail-safety.ts`(4つの action の許可)
- Test: `src/app/api/edit-locks/__tests__/routes.test.ts`
- Test: `src/lib/__tests__/audit-log-detail-safety.test.ts`(既存に追記)

**Interfaces:**
- Consumes: Task 3 の service・Task 4 の合言葉/権限
- Produces: 窓口5本。応答の形は設計 4.2〜4.5。監査 action: `edit_lock_acquire` / `edit_lock_takeover_expired` / `edit_lock_release` / `edit_lock_force_release`

**共通の前処理(各 route で同じ):**
1. `getApiSession()` → `getUserPermissions(session.id)`
2. 本文を zod で検証(`resourceType` は `"property" | "owner"`、`resourceId` は uuid)
3. `readScreenTokenHash(request)`(`release` は本文の `screenToken` も可)
4. ⚠**資源の存在・アーカイブ・担当範囲の確認は、トランザクションの中で資源の行をロックした後に行う**(@codex R6 P2)。
   ロックの前に確認すると、その隙間に所有者がアーカイブされた(アーカイブ側は鍵の後始末を済ませている)・担当が外れた、という場合に
   **消えた資源へ孤児の鍵を作る/担当外の物件の鍵を取れる**。読み直しは `tx.property.findUnique` / `tx.owner.findUnique` を使う。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/app/api/edit-locks/__tests__/routes.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data as object, { status })),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    owner: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: vi.fn().mockResolvedValue([]) })),
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({
  acquireEditLock: vi.fn(),
  heartbeatEditLock: vi.fn(),
  releaseEditLock: vi.fn(),
  forceReleaseEditLock: vi.fn(),
  readEditLocks: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { acquireEditLock, forceReleaseEditLock } from "@/lib/edit-lock/service";
import { POST as acquire } from "../acquire/route";
import { POST as forceRelease } from "../force-release/route";

const PROP = "22222222-2222-4222-8222-222222222222";
const UID = "33333333-3333-4333-8333-333333333333";
const pm = prisma as unknown as { property: { findUnique: Mock } };
const WRITE = [
  { resource: "property", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
];
const req = (body: unknown, token: string | null = "screen-1") =>
  new Request("http://localhost/api/edit-locks/acquire", {
    method: "POST",
    headers: token ? { "Content-Type": "application/json", "X-Edit-Screen": token } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role: "general" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(WRITE);
  pm.property.findUnique.mockResolvedValue({ createdBy: UID, assignedTo: null });
});

describe("POST /api/edit-locks/acquire", () => {
  it("取得できたら 200 と世代を返し、監査を書く", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-1", since: new Date("2026-09-18T10:00:00Z"), previous: null,
    });
    const res = await acquire(req({ resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: "mine", lockId: "lock-1" });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "edit_lock_acquire" }));
  });

  it("期限切れの横取りは takeover の監査を書く", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-2", since: new Date(),
      previous: { id: "old", userId: "other", screenTokenHash: "h", acquiredAt: new Date(0), heartbeatAt: new Date(0), activityAt: new Date(0), forceReleasedAt: null },
    });
    await acquire(req({ resourceType: "property", resourceId: PROP }));
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "edit_lock_takeover_expired", detail: expect.objectContaining({ previousUserId: "other" }) }),
    );
  });

  it("他人が持っていたら 423 と保持者の氏名を返す", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "held",
      current: { id: "lock-3", userId: "other", screenTokenHash: "h", acquiredAt: new Date("2026-09-18T05:02:00Z"), heartbeatAt: new Date(), activityAt: new Date(), forceReleasedAt: null },
    });
    (prisma as unknown as { user: { findMany: Mock } }).user.findMany.mockResolvedValue([{ id: "other", name: "山田" }]);
    const res = await acquire(req({ resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(423);
    await expect(res.json()).resolves.toMatchObject({ code: "EDIT_LOCKED", holderName: "山田" });
  });

  it("合言葉のヘッダが無ければ 400", async () => {
    const res = await acquire(req({ resourceType: "property", resourceId: PROP }, null));
    expect(res.status).toBe(400);
  });

  it("担当外のアルバイトは 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other-user", role: "field_staff" });
    const res = await acquire(req({ resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/edit-locks/force-release", () => {
  const fr = (body: unknown, role = "admin") => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role });
    return forceRelease(new Request("http://localhost/api/edit-locks/force-release", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
  };

  it("管理者以外は 403", async () => {
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: "lock-1" }, "general");
    expect(res.status).toBe(403);
  });

  it("世代が合わなければ 409 EDIT_LOCK_CHANGED", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue(null);
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: "stale" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "EDIT_LOCK_CHANGED" });
  });

  it("外せたら監査に前の保持者を残す", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue({ previousUserId: "victim" });
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: "lock-1" });
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "edit_lock_force_release", detail: expect.objectContaining({ previousUserId: "victim" }) }),
    );
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/app/api/edit-locks/__tests__/routes.test.ts`
Expected: FAIL(route が無い)

- [ ] **Step 3: 窓口を実装する**

`src/app/api/edit-locks/acquire/route.ts`:

```ts
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { acquireEditLock } from "@/lib/edit-lock/service";
import { readScreenTokenHash } from "@/lib/edit-lock/screen-token";
import { assertCanLockOwner, assertCanLockProperty } from "@/lib/edit-lock/permissions";
import { isLockExpired } from "@/lib/edit-lock/rules";

const schema = z.object({
  resourceType: z.enum(["property", "owner"]),
  resourceId: z.string().uuid(),
});

export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const { resourceType, resourceId } = schema.parse(await request.json());
    const screenTokenHash = readScreenTokenHash(request);
    if (!screenTokenHash) {
      throw new ApiError(400, "画面の識別子がありません。画面を再読み込みしてください", "EDIT_SCREEN_REQUIRED");
    }

    const result = await prisma.$transaction(async (tx) => {
      // ロック順序: 所有者 → 物件の親行(既存規約)。保存・管理者解除と同じ順序で直列化する。
      // ⚠存在・アーカイブ・担当範囲の確認は**ロックの後**に行う(@codex R6 P2)。
      if (resourceType === "property") {
        await lockPropertyRow(tx, resourceId);
        const property = await tx.property.findUnique({
          where: { id: resourceId },
          select: { createdBy: true, assignedTo: true },
        });
        if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
        assertCanLockProperty(session, perms, property);
      } else {
        await tx.$queryRaw`SELECT id FROM owners WHERE id = ${resourceId}::uuid FOR UPDATE`;
        const owner = await tx.owner.findUnique({
          where: { id: resourceId },
          select: { id: true, isArchived: true },
        });
        if (!owner || owner.isArchived) throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
        assertCanLockOwner(perms);
      }
      return acquireEditLock(tx, { resourceType, resourceId, userId: session.id, screenTokenHash });
    });

    if (result.state === "held") {
      const [holder] = await prisma.user.findMany({
        where: { id: result.current.userId },
        select: { id: true, name: true },
      });
      return apiResponse(
        {
          code: "EDIT_LOCKED",
          state: result.current.userId === session.id ? "held_by_self_other_screen" : "held_by_other",
          holderName: holder?.name ?? "他の利用者",
          since: result.current.acquiredAt,
        },
        423,
      );
    }

    const tookOver = result.previous && isLockExpired(result.previous, new Date());
    await writeAuditLog({
      userId: session.id,
      action: tookOver ? "edit_lock_takeover_expired" : "edit_lock_acquire",
      targetTable: "edit_locks",
      targetId: result.lockId,
      detail: tookOver
        ? {
            resourceType,
            resourceId,
            previousUserId: result.previous!.userId,
            // ⚠**それぞれの上限と比べる**(@codex R7 P2)。古さの大小で決めると、
            //   合図6分・操作50分(=合図の上限5分だけ超過)を idle と誤って記録する。
            expiredBy: expiryCause(result.previous!, new Date()),
          }
        : { resourceType, resourceId },
    });

    return apiResponse({ state: "mine", lockId: result.lockId, since: result.since });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`heartbeat` / `release` / `force-release` / `status` も**上の acquire と同じ骨格**(前処理1〜4 → 必要なら資源の行ロック → service を呼ぶ → 応答)で作る。
⚠この4本はコードを丸写しせず、次の契約だけを決めてある。**実装時は acquire のコードを開いて同じ形に揃える**こと(応答の形・エラーの投げ方・監査の書き方をばらつかせない)。

- `heartbeat`: 本文に `active: z.boolean()`。**資源の行はロックしない**。`heartbeatEditLock` が `ok:false` なら現在の行を `evaluateLock` にかけ、`force_released_mine` → `{ state: "lost", reason: "force_released" }`、空き/期限切れ → `{ state: "lost", reason: "expired" }`、他人 → `{ state: "taken", holderName, since }`。監査は書かない。
- `release`: 本文 `{ resourceType, resourceId, lockId }`。合言葉は**ヘッダが無ければ本文 `screenToken` から**読む(beacon 用)。`Content-Type` が `text/plain` でも `await request.text()` → `JSON.parse` で受ける。常に 200(冪等)。削除できたときだけ監査 `edit_lock_release`。
- `force-release`: `session.role !== "admin"` なら 403。acquire と同じ順序で資源の行をロックしたトランザクション内で `forceReleaseEditLock`。null なら 409 `EDIT_LOCK_CHANGED`。
- `status`: 本文 `{ resources: z.array(...).max(50) }`。閲覧権限(物件=`property:read`+担当範囲、所有者=`owner:read`)のある資源だけ返す。`readEditLocks` → `evaluateLock` → `free` / `mine` / `held_by_self_other_screen` / `held_by_other`(氏名つき)。`lockId` は `session.role === "admin"` のときだけ含める。

`src/lib/audit-log-detail-safety.ts` の `ACTION_EXTRA_KEYS` に追加:

```ts
  // 編集中の鍵(設計 2026-09-17)。detail は UUID と enum のみ。
  // 氏名・画面の合言葉(生値もハッシュも)は載せない。
  edit_lock_acquire: new Set(["resourceType", "resourceId"]),
  edit_lock_takeover_expired: new Set(["resourceType", "resourceId", "previousUserId", "expiredBy"]),
  edit_lock_release: new Set(["resourceType", "resourceId"]),
  edit_lock_force_release: new Set(["resourceType", "resourceId", "previousUserId"]),
```

`src/lib/__tests__/audit-log-detail-safety.test.ts` に追記:

```ts
  it("編集中の鍵の detail は伏せ字にならない(氏名・合言葉は載せない設計)", () => {
    const safe = sanitizeAuditDetail("edit_lock_takeover_expired", {
      resourceType: "property", resourceId: "r1", previousUserId: "u1", expiredBy: "idle",
    });
    expect(safe).toEqual({ resourceType: "property", resourceId: "r1", previousUserId: "u1", expiredBy: "idle" });
  });
  it("鍵の detail に紛れ込んだ氏名は伏せ字のまま", () => {
    const safe = sanitizeAuditDetail("edit_lock_acquire", { resourceType: "property", holderName: "山田" }) as Record<string, unknown>;
    expect(safe.holderName).toBe(REDACTED);
  });
```

⚠`sanitizeAuditDetail` / `REDACTED` の import 名は既存テストの先頭に合わせる。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/app/api/edit-locks src/lib/__tests__/audit-log-detail-safety.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/app/api/edit-locks src/lib/audit-log-detail-safety.ts src/lib/__tests__/audit-log-detail-safety.test.ts
git commit -m "feat(edit-lock): 窓口5本と監査の許可リスト"
```

---

### Task 6: 保存の窓口での確認(3つの窓口)

**Files:**
- Modify: `src/app/api/properties/[id]/route.ts`(PATCH をトランザクションで包む)
- Modify: `src/app/api/owners/[id]/route.ts`(PATCH)
- Modify: `src/app/api/owners/[id]/corporate-apply/route.ts`(POST)
- Test: `src/app/api/properties/[id]/__tests__/edit-lock.test.ts`
- Test: `src/app/api/owners/[id]/__tests__/edit-lock.test.ts`
- Test: `src/lib/edit-lock/__tests__/save-paths-scan.test.ts`

**Interfaces:**
- Consumes: `assertNotEditLockedByOther`(Task 3)・`readScreenTokenHash`(Task 4)
- Produces: 3つの窓口が 423 を返す。走査テストが「これら3つの窓口すべてが `assertNotEditLockedByOther` を呼ぶ」ことを固定する

**変更の要点(物件の PATCH):**
既存は `prisma.property.updateMany({ where: { id, version, … } })` をトランザクション外で実行している。これを次の形にする。

```ts
// 既存の version / registryStatus の条件はそのまま中に残す。
const guardedUpdate = await prisma.$transaction(async (tx) => {
  await lockPropertyRow(tx, id);
  await assertNotEditLockedByOther(tx, {
    resourceType: "property",
    resourceId: id,
    userId: session.id,
    screenTokenHash: readScreenTokenHash(request),
  });
  return tx.property.updateMany({
    where: { id, version, ...(touchesRegistryKey ? { registryStatus: { not: "scheduled" } } : {}) },
    data: { ...persistedFields, version: { increment: 1 } },
  });
});
```

所有者の PATCH と `corporate-apply` も同じ形(`tx.$queryRaw\`SELECT id FROM owners WHERE id = ${id}::uuid FOR UPDATE\`` → `assertNotEditLockedByOther` → 既存の条件つき更新)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/app/api/properties/[id]/__tests__/edit-lock.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
// 既存の route.test.ts と同じモック一式を用意する(api-helpers / prisma / audit / property-record-guard)。
// ここでは鍵に関わる部分だけを検査する。
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { PATCH } from "../route";

const PROP = "22222222-2222-4222-8222-222222222222";
const patch = (body: unknown, token: string | null = "screen-1") =>
  PATCH(
    new Request(`http://localhost/api/properties/${PROP}`, {
      method: "PATCH",
      headers: token ? { "Content-Type": "application/json", "X-Edit-Screen": token } : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROP }) },
  );

describe("PATCH /api/properties/[id] と編集中の鍵", () => {
  // ⚠「呼ばれたこと」だけを見るテストでは、トランザクションの外で呼んでも
  //   書き込みの後に呼んでも通ってしまう(@codex R6 P2)。**順序そのもの**を記録して検査する。
  it("トランザクション開始 → 行ロック → 鍵の確認 → 条件つき更新 の順で呼ばれる", async () => {
    const order: string[] = [];
    (prisma.$transaction as unknown as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      return fn({
        property: { updateMany: vi.fn(async () => { order.push("update"); return { count: 1 }; }) },
        $queryRaw: vi.fn(async () => []),
      });
    });
    (lockPropertyRow as unknown as Mock).mockImplementation(async () => { order.push("lock"); });
    (assertNotEditLockedByOther as unknown as Mock).mockImplementation(async () => { order.push("assert"); });

    await patch({ version: 1, note: "x" });

    expect(order).toEqual(["tx", "lock", "assert", "update"]);
  });

  it("鍵が他人のものなら 423 を返し、版番号の更新は走らない", async () => {
    (assertNotEditLockedByOther as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error("他の画面で編集中です"), { status: 423, code: "EDIT_LOCKED" }),
    );
    const res = await patch({ version: 1, note: "x" });
    expect(res.status).toBe(423);
  });

  it("合言葉のヘッダが無くても呼ばれる(古い画面。鍵が無ければ通る)", async () => {
    await patch({ version: 1, note: "x" }, null);
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ screenTokenHash: null }),
    );
  });
});
```

```ts
// src/lib/edit-lock/__tests__/save-paths-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存の窓口が増えても鍵の確認を忘れないための走査テスト。
 * ⚠新しい窓口を足したらこの一覧にも足す(足さずに通ると鍵が意味を失う)。
 */
const GUARDED = [
  "src/app/api/properties/[id]/route.ts",
  "src/app/api/owners/[id]/route.ts",
  "src/app/api/owners/[id]/corporate-apply/route.ts",
];

describe("保存の窓口の鍵の確認", () => {
  for (const rel of GUARDED) {
    it(`${rel} は assertNotEditLockedByOther を呼ぶ`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/assertNotEditLockedByOther\(/);
      expect(src).toMatch(/readScreenTokenHash\(/);
    });
  }
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/save-paths-scan.test.ts`
Expected: FAIL(3ファイルとも呼んでいない)

- [ ] **Step 3: 3つの窓口を直す**

上の「変更の要点」のとおり、3ファイルを**トランザクション+資源の行ロック+鍵の確認**の形にする。既存の条件(版番号・`registryStatus`・項目ごとの権限)は**中にそのまま残す**。監査ログの位置は変えない。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/app/api/properties src/app/api/owners src/lib/edit-lock`
Expected: PASS(既存のテストも含めて緑)

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/properties/[id]/route.ts" "src/app/api/owners/[id]/route.ts" "src/app/api/owners/[id]/corporate-apply/route.ts" src/app/api/properties/\[id\]/__tests__/edit-lock.test.ts src/app/api/owners/\[id\]/__tests__/edit-lock.test.ts src/lib/edit-lock/__tests__/save-paths-scan.test.ts
git commit -m "feat(edit-lock): 保存の窓口3本で他人の鍵を断る"
```

---

### Task 7: 謄本PDF取込の見送りと版番号(D10)

**Files:**
- Modify: `src/lib/registry-pdf/process.ts`
- Modify: `src/lib/registry-fetch/auto-fetch.ts`(監査の detail に2つのフラグを渡す)
- Modify: `src/app/(dashboard)/import/registry-pdf/page.tsx`(取込結果に見送りの表示)
- Modify: `src/lib/audit-log-detail-safety.ts`(`registry_auto_fetch` の許可)
- Test: `src/lib/registry-pdf/__tests__/edit-lock-skip.test.ts`
- Test: `src/lib/registry-fetch/__tests__/auto-fetch-edit-lock-audit.test.ts`

**Interfaces:**
- Consumes: `readEditLocks`(Task 3)
- Produces: `processRegistryPdf` の戻り値に `propertyFillSkippedByEditLock: boolean` と `ownerCorporateFillSkippedByEditLock: boolean`

**変更の要点:**
1. 物件の空欄補完(`realEstateNumber`/`lotNumber`/`buildingNumber`)の直前で、物件の行をロックしたトランザクション内で**鍵が誰かにあるか**を見る。あれば**その3項目だけ**書かずにフラグを立てる。
   ⚠**`registryStatus` の `unconfirmed` → `obtained` は鍵の間も必ず進める**(@codex R6 P1)。現在の実装はこの状態変更を空欄補完と同じ1回の `updateMany` にまとめているため、まるごと見送ると**PDFが付いているのに未確認のまま残る**。
   - したがって更新を2つに分ける: (a) 取得状況(常に実行・版番号を進める) (b) 3項目の補完(鍵が無いときだけ)。両方あるときは**1回の updateMany にまとめてよい**(鍵が無い場合)。
   - ⚠取得状況は編集ウィンドウでも変えられる項目なので、鍵の間に進めると**鍵を持つ人の保存が既存の409になることがある**。入力は画面に残り、やり直せば通る。**記録が誤ったまま残るより軽い害**として、この1項目だけ D10 の例外とする。
2. 所有者の法人番号の補完(`reflectParsedOwners` の2か所)も同じ。**補完するときは `version: { increment: 1 }` を必ず付ける**(今は付いていない=編集画面の古い内容で黙って消える)。
3. 監査の detail に2つのフラグを載せ、`ACTION_EXTRA_KEYS.registry_auto_fetch` に許可を足す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/lib/registry-pdf/__tests__/edit-lock-skip.test.ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/edit-lock/service", () => ({ readEditLocks: vi.fn() }));
// prisma と既存の依存は、同ディレクトリの既存テストのモックに合わせる。

import { readEditLocks } from "@/lib/edit-lock/service";

describe("取込と編集中の鍵", () => {
  beforeEach(() => vi.clearAllMocks());

  it("鍵が無ければ空欄を埋め、所有者の法人番号では版番号を進める", async () => {
    (readEditLocks as unknown as Mock).mockResolvedValue([]);
    // processRegistryPdf を Mode A で呼び、
    // property.updateMany が呼ばれること、
    // owner.updateMany の data に version: { increment: 1 } が含まれることを検査する。
  });

  it("物件に鍵があれば空欄を埋めず、フラグを立てる", async () => {
    (readEditLocks as unknown as Mock).mockResolvedValue([
      { id: "l1", resourceType: "property", resourceId: "p1", userId: "u", screenTokenHash: "h", acquiredAt: new Date(), heartbeatAt: new Date(), activityAt: new Date(), forceReleasedAt: null },
    ]);
    // property.updateMany が呼ばれないこと、
    // 戻り値の propertyFillSkippedByEditLock が true であることを検査する。
    // ⚠PDFの保存と所有者の紐付けは従来どおり実行されること(呼ばれた回数で確認)。
    // ⚠**取得状況は鍵があっても obtained に進むこと**(updateMany の data に registryStatus が入り、
    //   realEstateNumber/lotNumber/buildingNumber が入らないことを1回の呼び出しで確認)(@codex R6 P1)。
  });

  it("確認と書き込みが同じトランザクションで、行ロックの後に行われる", async () => {
    // $transaction のモックで順序を配列に記録し、
    // ["tx", "lock", "lockCheck", "update"] の順になることを検査する(@codex R7 P1)。
    // ⚠「鍵の状態を先に読んでおいて、後から更新する」実装はこのテストで落ちる。
  });

  it("所有者に鍵があれば法人番号を埋めず、フラグを立てる", async () => {
    (readEditLocks as unknown as Mock).mockResolvedValue([
      { id: "l2", resourceType: "owner", resourceId: "o1", userId: "u", screenTokenHash: "h", acquiredAt: new Date(), heartbeatAt: new Date(), activityAt: new Date(), forceReleasedAt: null },
    ]);
    // owner.updateMany が呼ばれないこと、ownerCorporateFillSkippedByEditLock が true。
  });
});
```

⚠このテストは既存 `src/lib/registry-pdf/__tests__/` のモックの作り方をそのまま流用する(prisma・storage・parser)。**実装前に既存テストを1本読んでから書く**。

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/registry-pdf/__tests__/edit-lock-skip.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装を書く**

- ⚠**確認と書き込みは1つのトランザクションの中で行う**(@codex R7 P1)。トランザクションの外で読むと、
  読んだ後・書く前に編集者が鍵を取れてしまい、**守るはずの3項目を取込が書いてしまう**。
  順序は取得・保存と同じ「物件の行をロック → 鍵の確認 → 条件つき更新」。期限の判定は**DBの now()**(Task 3 の
  `assertNotEditLockedByOther` と同じSQL)を使い、アプリの時計で判定しない。

```ts
// process.ts: 物件の更新をトランザクションに包む
await prisma.$transaction(async (tx) => {
  await lockPropertyRow(tx, propertyId);
  const propertyLocked = await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId });
  // ここで statusUpdates / fieldUpdates を組み立て、同じ tx で updateMany する
});
```

  Task 3 の service に次を足す(SQL は `assertNotEditLockedByOther` と同じ条件・戻り値は真偽値だけ):

```ts
/** その資源に「今生きている鍵」があるか。取込のように保持者を持たない処理が使う。 */
export async function isResourceEditLocked(db: Db, t: Target): Promise<boolean> {
  const rows = await db.$queryRaw<{ active: boolean }[]>`
    SELECT ("force_released_at" IS NULL
            AND "heartbeat_at" >= now() - make_interval(secs => ${GRACE_SEC})
            AND "activity_at" >= now() - make_interval(secs => ${IDLE_SEC})) AS active
    FROM "edit_locks"
    WHERE "resource_type" = ${t.resourceType}::"EditLockResource" AND "resource_id" = ${t.resourceId}::uuid
  `;
  return rows[0]?.active === true;
}
```

  所有者の法人番号の補完も同じ形(所有者の行を `FOR UPDATE` → `isResourceEditLocked` → `updateMany`)。

- **取得状況の更新は `propertyLocked` に関わらず実行**し、3項目の補完だけ `if (!propertyLocked)` で包む。見送ったときは `propertyFillSkippedByEditLock = true`。
  例(既存の `updates` の組み立てを2つに分ける):

```ts
const statusUpdates: Record<string, unknown> = {};
if (existing.registryStatus === "unconfirmed" && parsed.realEstateNumber) {
  statusUpdates.registryStatus = "obtained"; // 鍵があっても進める(R6 P1)
}
const fieldUpdates: Record<string, unknown> = {};
if (!propertyLocked) {
  if (!existing.realEstateNumber && parsed.realEstateNumber) fieldUpdates.realEstateNumber = parsed.realEstateNumber;
  if (!existing.lotNumber && parsed.lotNumber) fieldUpdates.lotNumber = parsed.lotNumber;
  if (!existing.buildingNumber && parsed.buildingNumber) fieldUpdates.buildingNumber = parsed.buildingNumber;
} else if (parsed.realEstateNumber || parsed.lotNumber || parsed.buildingNumber) {
  propertyFillSkippedByEditLock = true;
}
const updates = { ...statusUpdates, ...fieldUpdates };
```
- 法人番号の2か所も同様に、**所有者の行をロックしたトランザクション内で** `isResourceEditLocked` を見てから、
  `updateMany` の `data` に `version: { increment: 1 }` を足す。
- ⚠**人の取込画面の表示も、この Task に含める**(@codex R7 P2。第2段ではない)。
  `src/app/(dashboard)/import/registry-pdf/page.tsx` の `ImportResult` 型に2つのフラグを足し、既存の警告パネルに1行出す:
  - 物件側 = 「編集中のため、地番・家屋番号・不動産番号の補完を見送りました」
  - 所有者側 = 「編集中のため、法人番号の補完を見送りました」
  表示のテスト(フラグが true のときにこの文言が出る/false のときは出ない)も同じ Task で書く。
  **表示を入れないと、取込は成功したのに欄が空のままであることに誰も気づけない。**
- 監査の detail に2つのフラグを足し、`ACTION_EXTRA_KEYS` に:

```ts
  // 謄本の自動取得。鍵のため補完を見送ったことを管理画面で読めるようにする(D10)。
  registry_auto_fetch: new Set([
    "propertyFillSkippedByEditLock",
    "ownerCorporateFillSkippedByEditLock",
  ]),
```

- ⚠**自動取得の監査は `auto-fetch.ts` が detail を自分で組み立てている**(結果をそのまま展開していない)ので、
  `processRegistryPdf` の戻り値にフラグを足すだけでは**監査に出ない**(@codex R7 P2)。
  `src/lib/registry-fetch/auto-fetch.ts` の `action: "registry_auto_fetch"` を書いている箇所で、
  detail に `propertyFillSkippedByEditLock` / `ownerCorporateFillSkippedByEditLock` を渡す。
  テスト `auto-fetch-edit-lock-audit.test.ts` で、見送りが起きた実行の監査 detail に両方の値が入ることを検査する。

⚠`registry_auto_fetch` には既存の detail キー(mode/status など)もある。**実装時に既存の detail を1件読み、必要なキーをこの Set に併せて足す**(足さないと従来どおり `[REDACTED]` のまま)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/registry-pdf src/lib/__tests__/audit-log-detail-safety.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/registry-pdf/process.ts src/lib/registry-pdf/__tests__/edit-lock-skip.test.ts src/lib/audit-log-detail-safety.ts src/lib/__tests__/audit-log-detail-safety.test.ts
git commit -m "fix(registry-pdf): 法人番号の補完で版番号を進め、編集中は補完を見送る"
```

---

### Task 8: 資源を消すときの後始末と、全ゲート

**Files:**
- Modify: `src/app/api/properties/[id]/route.ts`(DELETE)
- Modify: `src/app/api/admin/owners/[id]/correction/archive/route.ts`
- Modify: `src/app/api/admin/owners/correction/merge/route.ts`
- Modify: `src/app/api/import/jobs/[jobId]/rollback/route.ts`
- Test: `src/lib/edit-lock/__tests__/cleanup-paths-scan.test.ts`
- Create: `scripts/edit-lock-concurrency-check.mjs`(手動確認・CIでは走らせない)

**Interfaces:**
- Consumes: `deleteEditLocksFor`(Task 3)
- Produces: 資源を消す4経路すべてが後始末を呼ぶ。手動確認スクリプト

- [ ] **Step 1: 失敗する走査テストを書く**

```ts
// src/lib/edit-lock/__tests__/cleanup-paths-scan.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 資源を消す/アーカイブする経路は、同じトランザクションで鍵も消す。 */
const PATHS = [
  "src/app/api/properties/[id]/route.ts",
  "src/app/api/admin/owners/[id]/correction/archive/route.ts",
  "src/app/api/admin/owners/correction/merge/route.ts",
  "src/app/api/import/jobs/[jobId]/rollback/route.ts",
];

describe("鍵の後始末", () => {
  for (const rel of PATHS) {
    it(`${rel} は deleteEditLocksFor を呼ぶ`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/deleteEditLocksFor\(/);
    });
  }
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/cleanup-paths-scan.test.ts`
Expected: FAIL(4件とも)

- [ ] **Step 3: 4経路に後始末を足し、手動確認スクリプトを作る**

各経路の削除・アーカイブと**同じトランザクション内**で:

```ts
await deleteEditLocksFor(tx, [{ resourceType: "property", resourceId: id }]);
```

(統合は消える側の所有者、取り消しは削除対象の物件すべてを配列で渡す)

`scripts/edit-lock-concurrency-check.mjs`(開発DBに対して1回だけ手で走らせる):

```js
// 同時取得が1本しか通らないことを実DBで確かめる。
// 使い方: npx dotenv -e .env -- node scripts/edit-lock-concurrency-check.mjs <propertyId>
import { PrismaClient } from "../src/generated/prisma/index.js";

const prisma = new PrismaClient();
const resourceId = process.argv[2];
if (!resourceId) throw new Error("物件のUUIDを引数に渡してください");

const acquire = (userId, hash) => prisma.$queryRaw`
  INSERT INTO "edit_locks" ("id","resource_type","resource_id","user_id","screen_token_hash","acquired_at","heartbeat_at","activity_at")
  VALUES (gen_random_uuid(), 'property'::"EditLockResource", ${resourceId}::uuid, ${userId}::uuid, ${hash}, now(), now(), now())
  ON CONFLICT ("resource_type","resource_id") DO UPDATE
  SET "id" = gen_random_uuid(), "user_id" = EXCLUDED."user_id", "screen_token_hash" = EXCLUDED."screen_token_hash",
      "acquired_at" = now(), "heartbeat_at" = now(), "activity_at" = now(),
      "force_released_at" = NULL, "force_released_by" = NULL
  WHERE "edit_locks"."force_released_at" IS NOT NULL
     OR "edit_locks"."heartbeat_at" < now() - make_interval(secs => 300)
     OR "edit_locks"."activity_at" < now() - make_interval(secs => 3600)
     OR ("edit_locks"."user_id" = EXCLUDED."user_id" AND "edit_locks"."screen_token_hash" = EXCLUDED."screen_token_hash")
  RETURNING "id"
`;

const [u1, u2] = await prisma.user.findMany({ take: 2, select: { id: true } });
await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
const [a, b] = await Promise.all([acquire(u1.id, "screen-a"), acquire(u2.id, "screen-b")]);
console.log("取得できた本数:", [a, b].filter((r) => r.length > 0).length, "(1 なら正しい)");
await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
await prisma.$disconnect();
```

- [ ] **Step 4: 全ゲートを通す**

```bash
npx vitest run
npx tsc --noEmit
npx eslint src/lib/edit-lock src/app/api/edit-locks
npm run build
```
Expected: テスト全緑 / 型エラー0 / lint エラー0 / build 成功

**手動ゲート(実DB・1回)**: ローカルの開発DBに `npx prisma migrate dev` を当て、`node scripts/edit-lock-concurrency-check.mjs <物件UUID>` が「取得できた本数: 1」を出すことを確認し、**出力をPRに貼る**。

- [ ] **Step 5: コミット**

```bash
git add "src/app/api/properties/[id]/route.ts" "src/app/api/admin/owners/[id]/correction/archive/route.ts" "src/app/api/admin/owners/correction/merge/route.ts" "src/app/api/import/jobs/[jobId]/rollback/route.ts" src/lib/edit-lock/__tests__/cleanup-paths-scan.test.ts scripts/edit-lock-concurrency-check.mjs
git commit -m "feat(edit-lock): 資源を消すときの後始末と同時取得の実DB確認スクリプト"
```

---

### Task 9: 版番号を進めない書き込みが無いことの確認(仕様 5.4)

**Files:**
- Create: `docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md`(洗い出しの結果)
- Create: `src/lib/edit-lock/__tests__/version-increment-scan.test.ts`
- Modify: 洗い出しで見つかった「版番号を進めていない経路」(あれば)

**Interfaces:**
- Consumes: なし
- Produces: 走査テスト。「物件・所有者の"編集で変える項目"を書く経路は、すべて `version: { increment: 1 }` を伴う(例外は理由つきの許可リスト)」

**なぜ要るか:** 「鍵で止めない書き込みは、既存の409(版番号)で守られる」という仕様の前提は、**その書き込みが版番号を進めるときだけ**成り立つ。Task 7 で直した取込の法人番号は、進めていなかった実例(編集画面の古い内容で黙って消えていた)。同じ抜けが他に無いことを固定する。

- [ ] **Step 1: 洗い出す**

```bash
grep -rn "property\.update\|property\.updateMany\|owner\.update\|owner\.updateMany" src --include=*.ts | grep -v __tests__ > /tmp/writes.txt
wc -l /tmp/writes.txt
```

1件ずつ開き、**その呼び出しの引数そのもの**(近くの行ではなく、その `data:` の中身)を読んで、次の表を
`docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md` に作る。同じ内容を走査テストの `VERSIONED` /
`ALLOWED_WITHOUT_VERSION` にも写す(テストは「検出した箇所が1件残らず一覧にあるか」だけを機械的に見る)。

| ファイル:行 | 書く項目 | 版番号 | 判定 |
|---|---|---|---|
| (例) `src/lib/registry-pdf/process.ts:258` | `corporateNumber` | 進めない→Task 7 で修正済 | 対応済 |

判定は3つだけ:
- **要修正** = 編集画面で変えられる項目を書くのに版番号を進めていない → この Task で `version: { increment: 1 }` を足す
- **対象外(許可)** = 編集画面で変えられない項目だけを書く(例: `dmUndeliverableAt`・`registryStatus`・`isArchived` のような運用フラグ) → 理由を書いて許可リストへ
- **対応済** = 既に進めている

- [ ] **Step 2: 失敗する走査テストを書く**

```ts
// src/lib/edit-lock/__tests__/version-increment-scan.test.ts
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

/**
 * 物件・所有者の「編集で変える項目」を書く経路は、必ず版番号を進める。
 * 進めない経路は、編集画面で変えられない項目だけを書くものに限り、ここに理由つきで載せる。
 * ⚠新しい書き込みを足したら、版番号を進めるか、この一覧に理由つきで足すかのどちらか。
 */
/** 版番号を進める書き込み(人が編集できる項目を書く)。値は「何を書くか」の説明。 */
const VERSIONED: Record<string, string> = {
  // 例: "src/app/api/properties/[id]/route.ts:352": "編集ウィンドウの保存",
};

/** 版番号を進めない書き込み。**編集画面で変えられない項目だけ**を書くものに限る。値は理由。 */
const ALLOWED_WITHOUT_VERSION: Record<string, string> = {
  // 例: "src/lib/dm/undeliverable.ts:42": "宛先不明フラグのみ。編集画面の項目ではない",
};

/**
 * 検出は**広めに**取る(@codex R6 P2)。Prisma の呼び方だけでなく、生SQLの UPDATE も拾う。
 * 検出した箇所は**1件残らず**一覧(下の INVENTORY)に載っていること、が合格条件。
 * 「近くに increment があるか」では、別の更新の increment を誤って自分のものと数えるため使わない。
 */
function writeSites(): string[] {
  const pattern = [
    "(property|owner)\\.(update|updateMany|upsert)\\(",
    'UPDATE "?(properties|owners)"?',
  ].join("|");
  const out = execSync(`grep -rnE '${pattern}' src --include=*.ts`, { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter((l) => l && !l.includes("__tests__"))
    .map((l) => l.split(":").slice(0, 2).join(":"));
}

describe("版番号の走査", () => {
  it("物件・所有者を書き換える箇所は、1件残らず一覧に載っている", () => {
    const known = new Set([...Object.keys(VERSIONED), ...Object.keys(ALLOWED_WITHOUT_VERSION)]);
    const unknown = writeSites().filter((k) => !known.has(k));
    // 新しい書き込みを足したら、この一覧にも足す(版番号を進めるか、理由つきで除外するか)。
    expect(unknown).toEqual([]);
  });

  it("一覧に載っている行は、今もその場所に存在する(行のずれを検出する)", () => {
    const sites = new Set(writeSites());
    const stale = [...Object.keys(VERSIONED), ...Object.keys(ALLOWED_WITHOUT_VERSION)].filter((k) => !sites.has(k));
    expect(stale).toEqual([]);
  });
});
```

⚠`grep`/`sed` は Git Bash 前提。CI(ubuntu)でも同じに動く。Windows のネイティブ環境で落ちる場合は `node:fs` で読む形に置き換える(判定内容は変えない)。

- [ ] **Step 3: 落ちた経路を直すか、理由つきで許可する**

洗い出しの表の「要修正」に `version: { increment: 1 }` を足す。「対象外」は `ALLOWED_WITHOUT_VERSION` に**1行ずつ理由を書いて**載せる(理由の無い登録は禁止)。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/edit-lock/__tests__/version-increment-scan.test.ts && npx vitest run`
Expected: PASS(全体も緑)

- [ ] **Step 5: コミット**

```bash
git add src/lib/edit-lock/__tests__/version-increment-scan.test.ts docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md
git commit -m "test(edit-lock): 版番号を進めない書き込みが無いことを走査で固定"
```

---

## 第1段の完了条件

- [ ] 9タスクすべてコミット済み
- [ ] `npx vitest run` 全緑・`tsc --noEmit` 0・`eslint` 0・`npm run build` 成功
- [ ] 実DBでの同時取得の確認の出力をPRに貼った
- [ ] **画面はまだ鍵を取らない**ことを、`src/app`(dashboard 配下)に `acquire` を呼ぶコードが無いことで確認
- [ ] ⚠**「挙動はまったく変わらない」とは言わない**(@codex R6 P2)。第1段で実際に変わるのは次の2点。発注者への説明と実機確認に含める。
  1. **謄本PDF取込・謄本の自動取得が、所有者の法人番号を埋めるときに版番号を進める**ようになる。取込の前から所有者の編集画面を開いていた人の保存が、これまで(黙って上書き)から**409(先に更新されています)**に変わる。これは修正であって退行ではない
  2. **鍵の窓口は動いている**ので、画面を介さず窓口を直接呼べば鍵を作れる。その状態では保存が423になりうる。通常の利用では起こらないが、「鍵は1本も生まれない」と断言はしない
- [ ] PR を作成し、`@codex review` の指摘に対応

## この計画に含めないもの(第2段)

画面の鍵の取得・合図・帯の表示・管理者の「鍵を外す」ボタン・6入口への `X-Edit-Screen` の付与・タブの複製の判別・Playwright の2ブラウザ試験・実機確認の項目。第2段は別の計画にする。
