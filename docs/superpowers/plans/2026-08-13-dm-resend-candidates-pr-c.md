# DM再送候補(PR-C) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物件一覧に「再送候補のみ」の絞り込みを追加し、前回送付から一定期間が過ぎ、拒否・宛先不明・連絡ありの反響が付いていない物件だけを、既存の「DM差込CSV出力 → 送付の確定」の流れにそのまま乗せられるようにする。

**Architecture:** 判定規則は新規の純関数モジュール `src/lib/dm-resend/candidacy.ts` に集約する。同モジュールが (a) 表示・再評価用の `decideResendCandidacy` と (b) 一覧 where 用の Prisma 断片 `buildResendCandidateWhere` の**両方**を出し、規則を1箇所で対に保つ。一覧の where は既存の単一定義元 `buildPropertyListWhere` に足すため、一覧・CSV出力・宛名CSV控え作成の3経路が自動的に同じ条件になる。控えには由来を `DmExportBatch.resendFilterApplied`(既存列)で刻み、ダウンロード時に既存の資格検査 `checkBatchEligibility` の検査(5)として候補述語を再評価する。

**Tech Stack:** Next.js App Router / TypeScript / Prisma(PostgreSQL) / Vitest / zod

## Global Constraints

- 設計の正本 = `docs/superpowers/specs/2026-08-08-dm-sending-management-design.md` **§4**。本計画は §4 を実装するものであり、**§4 の述語を勝手に足し引きしない**。
- **migration は作らない**。必要な列(`dm_export_batches.resend_filter_applied` / `property_dm_logs.reaction_status` + `@@index([reactionStatus])`)は PR-A/PR-B で適用済み。`prisma/schema.prisma` も変更しない。
- **新しい依存パッケージを入れない。新しい env を必須にしない**(`DM_RESEND_COOLDOWN_DAYS` は任意の上書きで、未設定時は既定 90 日)。
- **新しい permission を作らない**。この機能は既存の物件一覧・DM差込CSVの権限をそのまま使う(設計 ground truth: 新 slug は課金/PII外部送信級のみ)。
- 判定の非対称ルール(§4・@codex R4 P2): **誤って候補から外れるのは許容、誤って候補に入るのは不可**。迷ったら「除外する側」に倒す。
- 反響4種の値と terminal 判定は `src/lib/dm-reaction/core.ts` の `REACTION_STATUSES` / `TERMINAL_REACTIONS` を**唯一の出所**として import する(文字列リテラルを新たに書かない)。
- 日付は `@db.Date` の `PropertyDmLog.sentAt`(JST暦日を UTC 真夜中で保持)に合わせ、**cutoff も JST 暦日から導出**する(@codex R38 P2)。
- コミットは日本語 conventional commits(`feat(dm): ...` / `test(dm): ...`)。**amend しない**(指摘対応も常に新規コミット)。
- 作業は専用 worktree で行う(`property-management-worktrees/dm-resend-candidates` / branch `feat/dm-resend-candidates`)。

---

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `src/lib/dm-resend/candidacy.ts` | 再送候補の判定規則の**単一定義元**。cooldown 日数の解決・cutoff 導出・純関数判定・Prisma where 断片。DBに触れない |
| `src/lib/dm-resend/__tests__/candidacy.test.ts` | 上の振る舞いテスト(境界・JST・env・除外理由) |
| `src/lib/__tests__/property-list-query-resend.test.ts` | 一覧 where に述語が乗ることのテスト(既存 `property-list-query-undeliverable.test.ts` の型) |
| `src/lib/__tests__/properties-page-resend-ui.test.ts` | 一覧画面のトグル配線の source assertion(既存 `properties-page-mgmt-id-ui.test.ts` の型) |

**変更**

| ファイル | 変更内容 |
|---|---|
| `src/lib/validators.ts` | `propertyListQuerySchema` に `resendOnly` を追加 |
| `src/lib/property-list-query.ts` | `resendOnly === "1"` のとき候補述語を `where.AND` に足す |
| `src/app/(dashboard)/properties/page.tsx` | 「再送候補のみ」トグル(state / fetch params / URL sync / リセット / 有効フィルタ判定) |
| `src/app/api/properties/dm-batches/route.ts` | `AUDIT_FILTER_KEYS` に `resendOnly` を追加し、控え作成時に `resendFilterApplied` を保存 |
| `src/lib/dm-batch/eligibility.ts` | 検査(5)=候補述語の再評価を追加(`recentlySentPropertyIds` 引数・`resendStaleCount` 返却) |
| `src/app/api/properties/dm-batches/[id]/csv/route.ts` | 控えが再送候補由来なら cutoff より新しい送付記録を読み、検査(5)へ渡して 409 |
| `src/lib/dm-batch/__tests__/eligibility.test.ts` | 検査(5)のテストを追加 |

---

### Task 1: 判定の単一定義元(純関数・cutoff・cooldown)

**Files:**
- Create: `src/lib/dm-resend/candidacy.ts`
- Test: `src/lib/dm-resend/__tests__/candidacy.test.ts`

**Interfaces:**
- Consumes: `src/lib/dm-reaction/core.ts` の `TERMINAL_REACTIONS`(`ReadonlySet<string>`)・`jstCalendarDay(at: Date): string`
- Produces(以降のタスクが使う):
  - `DEFAULT_RESEND_COOLDOWN_DAYS: number`
  - `getResendCooldownDays(): number`
  - `resendCutoff(now: Date, cooldownDays: number): Date`
  - `TERMINAL_REACTION_VALUES: readonly string[]`
  - `decideResendCandidacy(input: ResendCandidacyInput, now: Date, options?: { cooldownDays?: number }): ResendCandidacyResult`
  - `buildResendCandidateWhere(now: Date, cooldownDays: number): unknown[]`
  - 型 `ResendCandidacyInput` / `ResendCandidacyResult` / `ResendIneligibleReason`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/dm-resend/__tests__/candidacy.test.ts` を新規作成:

```ts
import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_RESEND_COOLDOWN_DAYS,
  buildResendCandidateWhere,
  decideResendCandidacy,
  getResendCooldownDays,
  resendCutoff,
  type ResendCandidacyInput,
} from "../candidacy";

// 設計 §4。sentAt は @db.Date(JST暦日を UTC 真夜中で保持)なので、テストも同じ表現で書く。
// JST 2026-08-13 から 90 日戻すと 2026-05-15(手計算で固定する=実装の式を書き写さない)。
const CUTOFF_DAY = "2026-05-15T00:00:00.000Z";

function log(day: string, reactionStatus = "no_response") {
  return { sentAt: new Date(`${day}T00:00:00.000Z`), reactionStatus };
}

function input(over: Partial<ResendCandidacyInput> = {}): ResendCandidacyInput {
  return {
    dmStatus: "send",
    logs: [log("2026-01-10")],
    ownerHasTerminalReaction: false,
    ...over,
  };
}

describe("resendCutoff", () => {
  it("JST の今日の暦日から cooldownDays 戻した UTC 真夜中を返す", () => {
    // 2026-08-13T00:30Z = JST 2026-08-13 09:30
    expect(resendCutoff(new Date("2026-08-13T00:30:00.000Z"), 90).toISOString()).toBe(
      CUTOFF_DAY,
    );
  });

  it("JST の深夜(UTC では前日)でも JST 暦日で導出する", () => {
    // 2026-08-12T16:30Z = JST 2026-08-13 01:30 → 上と同じ cutoff でなければならない
    expect(resendCutoff(new Date("2026-08-12T16:30:00.000Z"), 90).toISOString()).toBe(
      CUTOFF_DAY,
    );
  });
});

describe("getResendCooldownDays", () => {
  afterEach(() => {
    delete process.env.DM_RESEND_COOLDOWN_DAYS;
  });

  it("未設定なら既定 90 日", () => {
    delete process.env.DM_RESEND_COOLDOWN_DAYS;
    expect(getResendCooldownDays()).toBe(90);
    expect(DEFAULT_RESEND_COOLDOWN_DAYS).toBe(90);
  });

  it("env で上書きできる", () => {
    process.env.DM_RESEND_COOLDOWN_DAYS = "30";
    expect(getResendCooldownDays()).toBe(30);
  });

  it("数値でない/0以下の env は無視して既定に戻す", () => {
    process.env.DM_RESEND_COOLDOWN_DAYS = "abc";
    expect(getResendCooldownDays()).toBe(90);
    process.env.DM_RESEND_COOLDOWN_DAYS = "0";
    expect(getResendCooldownDays()).toBe(90);
    process.env.DM_RESEND_COOLDOWN_DAYS = "-5";
    expect(getResendCooldownDays()).toBe(90);
  });
});

describe("decideResendCandidacy", () => {
  const now = new Date("2026-08-13T00:30:00.000Z");
  const opts = { cooldownDays: 90 };

  it("送付済み・反響なし・90日超なら候補", () => {
    expect(decideResendCandidacy(input(), now, opts)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it("ちょうど 90 日前(cutoff 当日)の送付は候補に入る", () => {
    expect(
      decideResendCandidacy(input({ logs: [log("2026-05-15")] }), now, opts).eligible,
    ).toBe(true);
  });

  it("89 日前(cutoff の翌日)の送付は候補に入らない", () => {
    expect(decideResendCandidacy(input({ logs: [log("2026-05-16")] }), now, opts)).toEqual(
      { eligible: false, reason: "within_cooldown" },
    );
  });

  it("古い送付が複数あっても、1件でも期間内なら候補に入らない", () => {
    expect(
      decideResendCandidacy(
        input({ logs: [log("2026-01-10"), log("2026-08-01")] }),
        now,
        opts,
      ).reason,
    ).toBe("within_cooldown");
  });

  it("dmStatus が send 以外なら候補に入らない", () => {
    expect(decideResendCandidacy(input({ dmStatus: "hold" }), now, opts)).toEqual({
      eligible: false,
      reason: "dm_status_not_send",
    });
  });

  it("送付記録が1件も無ければ候補に入らない", () => {
    expect(decideResendCandidacy(input({ logs: [] }), now, opts)).toEqual({
      eligible: false,
      reason: "never_sent",
    });
  });

  it("拒否・宛先不明・連絡ありの反響が付いた記録があれば候補に入らない", () => {
    for (const status of ["refused", "undeliverable", "replied"]) {
      expect(
        decideResendCandidacy(input({ logs: [log("2026-01-10", status)] }), now, opts),
      ).toEqual({ eligible: false, reason: "terminal_reaction" });
    }
  });

  it("所有者が他物件で拒否・宛先不明なら候補に入らない", () => {
    expect(
      decideResendCandidacy(input({ ownerHasTerminalReaction: true }), now, opts),
    ).toEqual({ eligible: false, reason: "owner_terminal_reaction" });
  });

  it("options 未指定なら env/既定の cooldown を使う", () => {
    expect(decideResendCandidacy(input({ logs: [log("2026-05-16")] }), now).eligible).toBe(
      false,
    );
  });
});

describe("buildResendCandidateWhere", () => {
  const fragments = buildResendCandidateWhere(
    new Date("2026-08-13T00:30:00.000Z"),
    90,
  ) as Array<Record<string, any>>;

  // §4 の5条件が where にすべて現れることを構造で固定する(1つ落ちたら落ちる)。
  it("§4-1 dmStatus=send を強制する", () => {
    expect(fragments).toContainEqual({ dmStatus: "send" });
  });

  it("§4-2 送付記録が1件以上あることを要求する", () => {
    expect(fragments).toContainEqual({ dmLogs: { some: {} } });
  });

  it("§4-3 cutoff より新しい送付記録が無いことを要求する", () => {
    expect(fragments).toContainEqual({
      dmLogs: { none: { sentAt: { gt: new Date(CUTOFF_DAY) } } },
    });
  });

  it("§4-4 物件の記録に terminal/replied の反響が無いことを要求する", () => {
    const f = fragments.find(
      (x) => x.dmLogs?.none?.reactionStatus?.in !== undefined,
    );
    expect(f).toBeDefined();
    expect([...f!.dmLogs.none.reactionStatus.in].sort()).toEqual([
      "refused",
      "replied",
      "undeliverable",
    ]);
  });

  it("§4-5 所有者の他物件も含めた拒否/宛先不明を、代表と共有者連関の両経路で見る", () => {
    const f = fragments.find((x) => x.propertyOwners?.none !== undefined);
    expect(f).toBeDefined();
    const or = f!.propertyOwners.none.owner.OR;
    expect(or).toHaveLength(2);
    // ⚠`.sort()` は破壊的。where 断片の配列をその場で並べ替えないよう必ずコピーしてから。
    expect([...or[0].dmLogs.some.reactionStatus.in].sort()).toEqual([
      "refused",
      "undeliverable",
    ]);
    expect([...or[1].dmLogOwners.some.log.reactionStatus.in].sort()).toEqual([
      "refused",
      "undeliverable",
    ]);
  });

  it("5条件ちょうど(条件の増減に気づける)", () => {
    expect(fragments).toHaveLength(5);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/dm-resend/__tests__/candidacy.test.ts`
Expected: FAIL（`Failed to resolve import "../candidacy"`）

- [ ] **Step 3: 最小の実装を書く**

`src/lib/dm-resend/candidacy.ts` を新規作成:

```ts
/**
 * 再送候補の判定(設計 2026-08-08-dm-sending-management-design.md §4)。
 *
 * 判定規則の**単一定義元**。一覧の where(buildResendCandidateWhere)と、
 * DL時の再評価・表示(decideResendCandidacy)を**同じファイルで対に維持する**
 * (同じ判定を2か所に書くとずれる=既知の失敗型)。
 * DB を触らない純関数のみ。クエリ発行とロック規約は呼び出し側 route の責務。
 *
 * 非対称の原則(@codex R4 P2): 誤って候補から**外れる**のは許容、
 * 誤って候補に**入る**のは不可。迷ったら除外側へ倒す。
 */
import { TERMINAL_REACTIONS, jstCalendarDay } from "@/lib/dm-reaction/core";

/** 再送候補に出るまでの間隔(日)。発注者決定=90日(設計§0)。上限(cap)は作らない。 */
export const DEFAULT_RESEND_COOLDOWN_DAYS = 90;

/**
 * cooldown 日数。env `DM_RESEND_COOLDOWN_DAYS` があればそれ(正の整数のみ)、
 * 無ければ既定 90。業務値の変更にリリースを要らなくするための上書き口(設計§4)。
 * ⚠ブラウザ側では process.env が無いため既定値になる=画面に日数を出さない
 * (出すと env を変えたときに文言だけ取り残される)。
 */
export function getResendCooldownDays(): number {
  const raw = process.env.DM_RESEND_COOLDOWN_DAYS;
  const parsed = raw ? Number(raw) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_RESEND_COOLDOWN_DAYS;
}

/**
 * 「これより新しい送付があれば候補に入らない」境界。
 * ⚠`PropertyDmLog.sentAt` は `@db.Date`(JST暦日を UTC 真夜中で保持)なので、
 * cutoff も **JST の今日の暦日**から日数を戻した UTC 真夜中に揃える。
 * 素の instant 演算だと JST 0〜9時の判定が1日ずれる(@codex R38 P2)。
 * 比較は `sentAt > cutoff`(cutoff 当日ちょうどは「経過した」扱い=候補に入る)。
 */
export function resendCutoff(now: Date, cooldownDays: number): Date {
  const base = Date.parse(`${jstCalendarDay(now)}T00:00:00.000Z`);
  return new Date(base - cooldownDays * 86_400_000);
}

/** Prisma の `in` に渡す配列形(集合の出所は dm-reaction/core.ts に一本化)。 */
export const TERMINAL_REACTION_VALUES: readonly string[] = [...TERMINAL_REACTIONS];

/**
 * 物件自身の記録で候補から外す反響。
 * terminal(拒否・宛先不明)に加えて **replied(連絡あり)** も外す
 * =連絡が来ている相手は人が個別対応する(設計§4「replied を除外する理由」)。
 */
export const SELF_EXCLUDING_REACTION_VALUES: readonly string[] = [
  ...TERMINAL_REACTION_VALUES,
  "replied",
];

export type ResendIneligibleReason =
  | "dm_status_not_send"
  | "never_sent"
  | "within_cooldown"
  | "terminal_reaction"
  | "owner_terminal_reaction";

export interface ResendCandidacyLog {
  sentAt: Date;
  reactionStatus: string;
}

export interface ResendCandidacyInput {
  dmStatus: string;
  /** その物件の送付記録(PropertyDmLog)。 */
  logs: ResendCandidacyLog[];
  /**
   * その物件の所有者の誰かに、**他物件も含めて** 拒否/宛先不明があるか(設計§4-5)。
   * 呼び出し側が §4-5 と同じクエリで計算して渡す(@codex R9 P2)。
   */
  ownerHasTerminalReaction: boolean;
}

export interface ResendCandidacyResult {
  eligible: boolean;
  reason: ResendIneligibleReason | null;
}

/** 設計§4 の5条件をこの順で見る(理由の粒度は表示・ログ用)。 */
export function decideResendCandidacy(
  input: ResendCandidacyInput,
  now: Date,
  options: { cooldownDays?: number } = {},
): ResendCandidacyResult {
  const cooldownDays = options.cooldownDays ?? getResendCooldownDays();
  const cutoff = resendCutoff(now, cooldownDays);

  if (input.dmStatus !== "send") {
    return { eligible: false, reason: "dm_status_not_send" };
  }
  if (input.logs.length === 0) {
    return { eligible: false, reason: "never_sent" };
  }
  if (input.logs.some((l) => l.sentAt.getTime() > cutoff.getTime())) {
    return { eligible: false, reason: "within_cooldown" };
  }
  if (
    input.logs.some((l) =>
      SELF_EXCLUDING_REACTION_VALUES.includes(l.reactionStatus),
    )
  ) {
    return { eligible: false, reason: "terminal_reaction" };
  }
  if (input.ownerHasTerminalReaction) {
    return { eligible: false, reason: "owner_terminal_reaction" };
  }
  return { eligible: true, reason: null };
}

/**
 * 一覧 where 用の Prisma 断片(AND で足す)。上の decideResendCandidacy と**同じ5条件**。
 * ⚠§4-5 は代表(`Owner.dmLogs`)と共有者連関(`Owner.dmLogOwners`)の**両経路**を見る。
 * 片方だけだと、共有者としてだけ拒否された相手の別物件が候補に残る。
 * ⚠isArchived で絞らない=archive 済み所有者に拒否が残っていても除外側に倒す(非対称の原則)。
 */
export function buildResendCandidateWhere(
  now: Date,
  cooldownDays: number,
): unknown[] {
  const cutoff = resendCutoff(now, cooldownDays);
  const terminalIn = { in: [...TERMINAL_REACTION_VALUES] };
  return [
    { dmStatus: "send" },
    { dmLogs: { some: {} } },
    { dmLogs: { none: { sentAt: { gt: cutoff } } } },
    {
      dmLogs: {
        none: { reactionStatus: { in: [...SELF_EXCLUDING_REACTION_VALUES] } },
      },
    },
    {
      propertyOwners: {
        none: {
          owner: {
            OR: [
              { dmLogs: { some: { reactionStatus: terminalIn } } },
              { dmLogOwners: { some: { log: { reactionStatus: terminalIn } } } },
            ],
          },
        },
      },
    },
  ];
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/dm-resend/__tests__/candidacy.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 5: コミット**

```bash
git add src/lib/dm-resend/candidacy.ts src/lib/dm-resend/__tests__/candidacy.test.ts
git commit -m "feat(dm): 再送候補の判定規則を純関数に集約する(設計§4)"
```

---

### Task 2: 一覧の絞り込み述語

**Files:**
- Modify: `src/lib/validators.ts`（`propertyListQuerySchema` の `undeliverable` の直後）
- Modify: `src/lib/property-list-query.ts:66-82`（分割代入）, `src/lib/property-list-query.ts:181-183`（`dmSentMax` の直後）
- Test: `src/lib/__tests__/property-list-query-resend.test.ts`

**Interfaces:**
- Consumes: Task 1 の `buildResendCandidateWhere` / `getResendCooldownDays`
- Produces: クエリパラメータ `resendOnly=1`（一覧 API・CSV export・宛名CSV控え作成の3経路が共有する）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/property-list-query-resend.test.ts` を新規作成:

```ts
import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。
const adminSession = { id: "u1", role: "admin" } as never;

describe("buildPropertyListWhere resendOnly filter", () => {
  it("resendOnly=1 で §4 の5条件を where.AND に足す", async () => {
    const query = propertyListQuerySchema.parse({ resendOnly: "1" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as Array<Record<string, any>>;
    expect(and).toContainEqual({ dmStatus: "send" });
    expect(and).toContainEqual({ dmLogs: { some: {} } });
    expect(and.some((f) => f.dmLogs?.none?.sentAt?.gt instanceof Date)).toBe(true);
    expect(and.some((f) => f.dmLogs?.none?.reactionStatus?.in)).toBe(true);
    expect(and.some((f) => f.propertyOwners?.none?.owner?.OR)).toBe(true);
  });

  it("resendOnly 未指定なら候補条件を足さない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as Array<Record<string, any>>;
    expect(and.some((f) => f.dmLogs?.some !== undefined)).toBe(false);
    expect(and.some((f) => f.propertyOwners?.none !== undefined)).toBe(false);
  });

  it("dmStatus=hold を併用しても dmStatus=send の強制は残る(候補に入る側へは倒さない)", async () => {
    const query = propertyListQuerySchema.parse({
      resendOnly: "1",
      dmStatus: "hold",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmStatus).toBe("hold");
    expect((where.AND ?? []) as unknown[]).toContainEqual({ dmStatus: "send" });
  });

  it("既存の絞り込み(未送信0回)と併用しても両方残る", async () => {
    const query = propertyListQuerySchema.parse({
      resendOnly: "1",
      dmSentMax: "0",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as Array<Record<string, any>>;
    expect(and).toContainEqual({ dmLogs: { none: {} } });
    expect(and).toContainEqual({ dmLogs: { some: {} } });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-resend.test.ts`
Expected: FAIL（1つ目のテストで `and` に条件が入っておらず `toContainEqual` が失敗）

- [ ] **Step 3: スキーマに `resendOnly` を足す**

`src/lib/validators.ts` の `propertyListQuerySchema` 内、`undeliverable` の定義の直後に追加:

```ts
  // 再送候補のみ(設計§4)。"1" のときだけ有効(undeliverable と同じ文字列クエリ規約)。
  // 判定規則の定義元は src/lib/dm-resend/candidacy.ts。
  resendOnly: z.enum(["1"]).optional(),
```

- [ ] **Step 4: where に述語を足す**

`src/lib/property-list-query.ts`:

1. import を追加（`resolveMgmtIdMatches` の import の下）:

```ts
import {
  buildResendCandidateWhere,
  getResendCooldownDays,
} from "@/lib/dm-resend/candidacy";
```

2. 分割代入に `resendOnly` を足す（`undeliverable,` の直後）:

```ts
    undeliverable,
    resendOnly,
```

3. `dmSentMax === 0` のブロックの直後（`return {` の直前）に追加:

```ts
  // 再送候補のみ(設計§4)。5条件は dm-resend/candidacy.ts が単一定義元。
  // ⚠dmStatus=send は AND で**強制**する(URL直打ちで dmStatus=hold を混ぜても
  //   候補に入らない=「候補から外れるのは許容・候補に入るのは不可」の非対称)。
  //   条件が矛盾したときは 0 件になるが、それは安全側の失敗。
  if (resendOnly === "1") {
    where.AND = [
      ...(where.AND ?? []),
      ...(buildResendCandidateWhere(new Date(), getResendCooldownDays()) as any[]),
    ];
  }
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-resend.test.ts`
Expected: PASS（4件）

- [ ] **Step 6: 既存の一覧テストが壊れていないことを確認**

Run: `npx vitest run src/lib/__tests__/property-list-query-undeliverable.test.ts src/lib/__tests__/property-list-query-dm-send-count.test.ts src/lib/__tests__/property-list-query-date-tz.test.ts src/lib/__tests__/properties-route-mgmt-id.test.ts`
Expected: PASS（`resendOnly` 未指定時に where が従来と同一であること）

- [ ] **Step 7: コミット**

```bash
git add src/lib/validators.ts src/lib/property-list-query.ts src/lib/__tests__/property-list-query-resend.test.ts
git commit -m "feat(dm): 物件一覧を再送候補だけに絞り込めるようにする"
```

---

### Task 3: 一覧画面のトグル

**Files:**
- Modify: `src/app/(dashboard)/properties/page.tsx`（state / fetch params / URL sync / リセット / 有効フィルタ判定 / トグルUI の6箇所）
- Test: `src/lib/__tests__/properties-page-resend-ui.test.ts`

**Interfaces:**
- Consumes: Task 2 のクエリパラメータ `resendOnly=1`
- Produces: なし（画面のみ）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/properties-page-resend-ui.test.ts` を新規作成:

```ts
/**
 * 物件一覧ページ「再送候補のみ」トグルの source assertion。
 *
 * ⚠この画面はフィルタを **2箇所**(fetch 用 buildFilterParams / URL sync)で組み立てる。
 * 片方に足し忘れると「絞り込めない」または「共有したURLで再現しない」ので、
 * 両方に現れることを別々に固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);

describe("properties page: 再送候補のみトグル", () => {
  it("resendOnly state を URL から初期化する", () => {
    expect(pageSrc).toMatch(/setResendOnly/);
    expect(pageSrc).toMatch(/sp\.get\("resendOnly"\)\s*===\s*"1"/);
  });

  it("fetchProperties のクエリに resendOnly を送る", () => {
    expect(pageSrc).toMatch(/params\.resendOnly\s*=\s*"1"/);
  });

  it("URL query にも resendOnly を sync する", () => {
    expect(pageSrc).toMatch(/params\.set\("resendOnly",\s*"1"\)/);
  });

  it("リセットで resendOnly も消える", () => {
    expect(pageSrc).toMatch(/setResendOnly\(false\)/);
  });

  it("有効フィルタ判定に resendOnly が入っている", () => {
    expect(pageSrc).toMatch(/warningOnly \|\| undeliverableOnly \|\| resendOnly/);
  });

  it("チェックボックスのラベルが「再送候補のみ」", () => {
    expect(pageSrc).toMatch(/再送候補のみ/);
  });

  it("トグルONで DM状況 を「送る」に合わせる(0件になる組み合わせを画面から作らせない)", () => {
    expect(pageSrc).toMatch(/setResendOnly\(next\);[\s\S]{0,200}setDmFilter\("send"\)/);
  });

  it("日数を画面の文言に焼き込んでいない(env で変えられるため)", () => {
    expect(pageSrc).not.toMatch(/90日/);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/properties-page-resend-ui.test.ts`
Expected: FAIL（`setResendOnly` が無い）

- [ ] **Step 3: state を足す**

`src/app/(dashboard)/properties/page.tsx:139`（`undeliverableOnly` の宣言）の直後に追加:

```tsx
  const [resendOnly, setResendOnly] = useState(() => sp.get("resendOnly") === "1");
```

- [ ] **Step 4: fetch params に足す**

`buildFilterParams` の `if (undeliverableOnly) params.undeliverable = "1";` の直後に追加し、依存配列にも `resendOnly` を足す:

```tsx
    if (resendOnly) params.resendOnly = "1";
```

依存配列（同 `useCallback` の末尾）: `undeliverableOnly,` の直後に `resendOnly,` を挿入する。

- [ ] **Step 5: URL sync に足す**

`if (undeliverableOnly) params.set("undeliverable", "1");` の直後に追加し、こちらの `useEffect` 依存配列にも `resendOnly` を足す:

```tsx
    if (resendOnly) params.set("resendOnly", "1");
```

- [ ] **Step 6: リセットと有効フィルタ判定に足す**

`handleResetFilters` の `setUndeliverableOnly(false);` の直後:

```tsx
    setResendOnly(false);
```

`hasActiveFilter` の該当行を次に置き換える:

```tsx
    warningOnly || undeliverableOnly || resendOnly || !!sendCountMaxFilter || sort !== "updatedAt:desc";
```

- [ ] **Step 7: トグルUIを足す**

「宛先不明のみ」の `</label>` の直後に追加:

```tsx
        <label
          className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300"
          title="前回の送付から一定期間が過ぎていて、拒否・宛先不明・連絡ありの反響が付いていない物件だけを表示します。所有者が他の物件で拒否・宛先不明になっている場合も除きます。"
        >
          <input
            type="checkbox"
            checked={resendOnly}
            onChange={(e) => {
              const next = e.target.checked;
              setResendOnly(next);
              // 再送候補は「送る」の物件だけが対象(設計§4-1)。ONにしたら DM状況 も
              // 合わせて、必ず0件になる組み合わせを画面から作れないようにする。
              if (next) setDmFilter("send");
              setPage(1);
            }}
            className="rounded border-emerald-300"
          />
          再送候補のみ
        </label>
```

- [ ] **Step 8: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/properties-page-resend-ui.test.ts`
Expected: PASS（8件）

- [ ] **Step 9: 型と lint を確認**

Run: `npx tsc --noEmit`
Expected: エラー 0

Run: `npx eslint "src/app/(dashboard)/properties/page.tsx"`
Expected: error 0（`react-hooks/exhaustive-deps` の warning が出たら Step 4/5 の依存配列の足し忘れ）

- [ ] **Step 10: コミット**

```bash
git add "src/app/(dashboard)/properties/page.tsx" src/lib/__tests__/properties-page-resend-ui.test.ts
git commit -m "feat(dm): 物件一覧に「再送候補のみ」の絞り込みを追加する"
```

---

### Task 4: 控えに「再送候補由来」を記録する

**Files:**
- Modify: `src/app/api/properties/dm-batches/route.ts:51-64`（`AUDIT_FILTER_KEYS`）, `:422-431`（`dmExportBatch.create`）
- Test: `src/lib/__tests__/dm-batches-post-route.test.ts`（既存に追記）

**Interfaces:**
- Consumes: Task 2 の `resendOnly` クエリパラメータ（`body.filters` 経由で `propertyListQuerySchema.parse` に入る）
- Produces: `DmExportBatch.resendFilterApplied`（Task 5 がダウンロード時に読む）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/dm-batches-post-route.test.ts` の末尾（最後の `});` の直前）に追記:

```ts
describe("dm-batches POST: 再送候補由来の控え", () => {
  it("AUDIT_FILTER_KEYS に resendOnly が入っている", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/api/properties/dm-batches/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/AUDIT_FILTER_KEYS[\s\S]{0,400}"resendOnly"/);
  });

  it("控えの作成で resendFilterApplied を保存する", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/api/properties/dm-batches/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/resendFilterApplied:\s*query\.resendOnly === "1"/);
  });
});
```

⚠この追記は `fs` / `path` の import を必要とする。ファイル先頭に無ければ次を足す:

```ts
import * as fs from "fs";
import * as path from "path";
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/__tests__/dm-batches-post-route.test.ts`
Expected: FAIL（新しい2件が失敗・既存は PASS）

- [ ] **Step 3: 実装する**

`src/app/api/properties/dm-batches/route.ts`:

1. `AUDIT_FILTER_KEYS` の `"dmSentMax",` の直後に追加:

```ts
  "resendOnly",
```

2. `tx.dmExportBatch.create` の `data` に1行追加（`attemptKey` の直後）:

```ts
            // 再送候補の絞り込みから作られた控えか(設計§4)。初回DL時に候補述語を
            // 再評価する材料(Task 5)=作成〜DLの間に送付が入った宛先を配らない。
            resendFilterApplied: query.resendOnly === "1",
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/dm-batches-post-route.test.ts`
Expected: PASS（全件）

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/dm-batches/route.ts src/lib/__tests__/dm-batches-post-route.test.ts
git commit -m "feat(dm): 宛名CSVの控えに再送候補由来かどうかを残す"
```

---

### Task 5: ダウンロード時の候補再評価（資格検査(5)）

**Files:**
- Modify: `src/lib/dm-batch/eligibility.ts:44`（コメント）, `:63-69`（`EligibilityResult`）, `:71-80`（引数）, `:100-108`（判定の挿入）
- Modify: `src/app/api/properties/dm-batches/[id]/csv/route.ts:218-232`（検査呼び出し）と、その直前の集合構築
- Test: `src/lib/dm-batch/__tests__/eligibility.test.ts`（既存に追記）

**Interfaces:**
- Consumes: Task 1 の `resendCutoff` / `getResendCooldownDays`、Task 4 の `DmExportBatch.resendFilterApplied`
- Produces: `checkBatchEligibility(..., recentlySentPropertyIds?: ReadonlySet<string>)` の第7引数と、`EligibilityResult.resendStaleCount: number`

**なぜ cooldown だけを再評価するのか（実装前に読む）**

控え作成〜ダウンロードの間に変わりうる §4 の条件のうち、

- §4-1 dmStatus / archived → 既存の検査(3)が見ている
- §4-4/§4-5 拒否・宛先不明 → 既存の検査(2)が見ている
- §4-2 送付記録が1件以上 → 記録が消えても「送りすぎ」にはならない（初回DMを送るのと同じ）
- **§4-3 90日以内の送付が無い → どこも見ていない。ここだけが「二重に送る」事故になる**

ので、検査(5) は §4-3 の再評価に限定する。**この限定は意図的**（非対称の原則で、送りすぎだけを止める）。

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/dm-batch/__tests__/eligibility.test.ts` の末尾に追記:

```ts
describe("checkBatchEligibility 検査(5) 再送候補の再評価", () => {
  it("cutoff より新しい送付が入った物件の item を resendStaleCount に数える", () => {
    const items: BatchItemForCheck[] = [
      { id: "i1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1"] },
    ];
    const properties = new Map([["p1", prop()]]);
    const res = checkBatchEligibility(
      items,
      properties,
      ADMIN,
      new Set(),
      new Set(),
      new Set(["p1"]),
    );
    expect(res.resendStaleCount).toBe(1);
  });

  it("空集合(=再送候補由来でない控え)なら何も落とさない", () => {
    const items: BatchItemForCheck[] = [
      { id: "i1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1"] },
    ];
    const properties = new Map([["p1", prop()]]);
    const res = checkBatchEligibility(items, properties, ADMIN, new Set(), new Set());
    expect(res.resendStaleCount).toBe(0);
    expect(res.stateIssueCount).toBe(0);
  });

  it("terminal 反響の検出より後ろに置かない(理由が置き換わらない)", () => {
    const items: BatchItemForCheck[] = [
      { id: "i1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1"] },
    ];
    const properties = new Map([["p1", prop()]]);
    const res = checkBatchEligibility(
      items,
      properties,
      ADMIN,
      new Set(["o1"]),
      new Set(),
      new Set(["p1"]),
    );
    expect(res.terminalReactionCount).toBe(1);
    expect(res.resendStaleCount).toBe(0);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run src/lib/dm-batch/__tests__/eligibility.test.ts`
Expected: FAIL（`resendStaleCount` が `undefined`）

- [ ] **Step 3: eligibility.ts を実装する**

1. ヘッダコメントの `// (5) 再送候補述語の再評価は PR-C でこの関数に追加する。` を次に置き換える:

```ts
//   (5) 再送候補由来の控え(resend_filter_applied)だけ: 作成〜DLの間に **cutoff より
//       新しい送付記録**が入った物件 → 409(resendStaleCount)。§4 の他の条件は
//       (2)(3)が既に見ており、記録が消えた場合は「送りすぎ」にならないので見ない
//       (誤って外れるのは許容・入るのは不可の非対称=設計§4)。
```

2. `EligibilityResult` に1フィールド追加（`terminalReactionCount` の直後）:

```ts
  /** (5) 再送候補の条件から外れた(期間内に送付が入った)item 数 → 409(PR-C) */
  resendStaleCount: number;
```

3. 引数に第7引数を追加（`terminalPropertyIds` の直後）:

```ts
  /** (5) cutoff より新しい送付記録がある物件 id 集合。再送候補由来の控えのときだけ
   *  呼び出し側が渡す(省略時=検査(5)なし)。 */
  recentlySentPropertyIds: ReadonlySet<string> = new Set(),
```

4. カウンタ初期化に1行追加:

```ts
  let resendStaleCount = 0;
```

5. 検査(2) の直後・検査(3) の直前に判定を挿入:

```ts
    // (5) 再送候補由来の控えのみ: 作成〜DLの間に送付が入っていたら二重送付になる(PR-C)。
    if (recentlySentPropertyIds.has(it.propertyId)) {
      resendStaleCount += 1;
      continue;
    }
```

6. `return` に1フィールド追加:

```ts
    resendStaleCount,
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/dm-batch/__tests__/eligibility.test.ts`
Expected: PASS（既存＋新規3件）

- [ ] **Step 5: CSV route を配線する**

`src/app/api/properties/dm-batches/[id]/csv/route.ts`:

1. import を追加（`checkBatchEligibility` の import の近く）:

```ts
import {
  getResendCooldownDays,
  resendCutoff,
} from "@/lib/dm-resend/candidacy";
```

2. `const elig = checkBatchEligibility(` の直前に、集合の構築を追加:

```ts
      // (5) 再送候補由来の控えだけ、候補述語のうち「期間内の送付が無い」を再評価する(PR-C)。
      // 控えを作った後・配る前に誰かが送っていたら、この控えを配ると二重送付になる。
      // Owner/物件を FOR SHARE で保持したままこの tx 内で読む=確定(ログ書込)と直列化される。
      const recentlySentPropertyIds = new Set<string>();
      if (batchRow.resend_filter_applied && allPropertyIds.length > 0) {
        const cutoff = resendCutoff(new Date(), getResendCooldownDays());
        const recentLogs = await tx.propertyDmLog.findMany({
          where: { propertyId: { in: allPropertyIds }, sentAt: { gt: cutoff } },
          select: { propertyId: true },
        });
        for (const l of recentLogs) {
          if (l.propertyId) recentlySentPropertyIds.add(l.propertyId);
        }
      }
```

3. `checkBatchEligibility(` の呼び出しに第7引数を足す:

```ts
      const elig = checkBatchEligibility(
        items,
        properties,
        session,
        terminalOwnerIds,
        terminalPropertyIds,
        recentlySentPropertyIds,
      );
```

4. `elig.terminalReactionCount > 0` の分岐の直後に、新しい分岐を追加:

```ts
      if (elig.resendStaleCount > 0) {
        throw new ApiError(
          409,
          `この控えを作ったあとに送付された宛先が含まれています(${elig.resendStaleCount}件)。再送候補で出し直してください`,
          "RESEND_STALE",
        );
      }
```

- [ ] **Step 6: CSV route のテストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/dm-batch-csv-route.test.ts src/lib/dm-batch/__tests__/eligibility.test.ts`
Expected: PASS（既存の検査が壊れていないこと。`resendStaleCount` は既存テストでは常に 0）

- [ ] **Step 7: コミット**

```bash
git add src/lib/dm-batch/eligibility.ts "src/app/api/properties/dm-batches/[id]/csv/route.ts" src/lib/dm-batch/__tests__/eligibility.test.ts
git commit -m "feat(dm): 再送候補の控えは配る直前にもう一度期間を確かめる"
```

---

### Task 6: 全ゲートと提出

**Files:**
- Modify: なし（確認と提出のみ。指摘が出たら該当ファイル）

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces: レビュー可能な PR

- [ ] **Step 1: 制御文字・バイナリ混入の確認**

Run: `git diff --stat main...HEAD`
Expected: `Bin` と表示される行が**無い**こと（NUL 混入で git がバイナリ扱いすると、PR の diff から消えてレビューの死角になる）

Run: `git grep -Pn "\x00" -- src docs || echo "NUL なし"`
Expected: `NUL なし`

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー 0

- [ ] **Step 3: lint（差分ファイルのみ）**

Run: `npx eslint src/lib/dm-resend src/lib/property-list-query.ts src/lib/validators.ts src/lib/dm-batch/eligibility.ts "src/app/(dashboard)/properties/page.tsx" src/app/api/properties/dm-batches`
Expected: error 0

- [ ] **Step 4: フルテスト**

Run: `npx vitest run`
Expected: 全件 PASS（対象を絞ったテストで「緑」と報告しない。件数は前回 11,045 件から今回の追加分だけ増える）

- [ ] **Step 5: 本番ビルド**

Run: `npm run build`
Expected: 成功。新しいルートは**増えない**（画面と既存APIの変更のみ）

- [ ] **Step 6: 提出前の自己レビュー**

`feature-dev:code-reviewer` に次の観点を明示して投げ、P1/P2 がゼロであることを確認する:
1. 一覧 where と `decideResendCandidacy` の条件が食い違っていないか
2. §4-5 の所有者横断が代表・共有者連関の**両経路**を見ているか
3. JST 境界（深夜0〜9時）で cutoff が1日ずれないか
4. 検査(5) が既存の検査(1)〜(4)(6)(7)の順序・理由を壊していないか
5. 画面の2つのパラメータ組み立て（fetch / URL）の両方に入っているか

- [ ] **Step 7: PR を作成して @codex を起動**

```bash
git push -u origin feat/dm-resend-candidates
gh pr create --title "feat(dm): 再送候補(前回送付から一定期間・反響で自動除外)" --body "$(cat <<'EOF'
## 何ができるようになるか
物件一覧の「再送候補のみ」で、前回の送付から一定期間が過ぎていて、拒否・宛先不明・連絡ありの反響が付いていない物件だけを絞り込めます。そのまま既存の「DM差込CSV出力 → 送付の確定」に乗ります。

## 設計
`docs/superpowers/specs/2026-08-08-dm-sending-management-design.md` §4（@codex 53巡で確定済み）の実装です。判定規則は `src/lib/dm-resend/candidacy.ts` に集約し、一覧の where と再評価を同じファイルで対に維持しています。

## 安全側の作り
- 誤って候補から**外れる**のは許容、誤って候補に**入る**のは不可（設計の非対称原則）
- `dmStatus=send` は where で強制（URL 直打ちで別の状態を混ぜても候補に入らない）
- 控えを作ったあと・配る前に送付が入っていたら、ダウンロードを 409 で止める（二重送付の防止）

## 変更しないもの
migration なし・新規依存なし・新しい権限なし・新しいルートなし。`DM_RESEND_COOLDOWN_DAYS` は任意の上書きで、未設定なら既定 90 日。

## ゲート
tsc 0 / フル vitest 緑 / eslint error 0 / build 成功
EOF
)"
gh pr comment "$(gh pr view --json number --jq .number)" --body "@codex review"
```

- [ ] **Step 8: レビューの到着監視を張る**

`codex-triage` スキルに従い、3系統（issue comments / reviews / inline）を既知ID控えつきで監視する。**修正 push 後の再起動は自分で投稿する。マージはユーザー。**

---

## Self-Review（この計画を書いたあとの確認結果）

**1. 仕様カバレッジ（設計§4 の各項目 → タスク）**

| §4 の項目 | 実装タスク |
|---|---|
| 定義1 `dmStatus="send"` | Task 1(純関数)・Task 2(where で強制)・Task 3(UIで整合) |
| 定義2 送付記録が1件以上 | Task 1・Task 2 |
| 定義3 90日以内の送付が無い（JST cutoff） | Task 1(`resendCutoff`)・Task 2・Task 5(再評価) |
| 定義4 terminal 反響が付いた記録が無い | Task 1・Task 2 |
| 定義5 所有者単位の除外（他物件も含む・代表と共有者連関の両経路） | Task 1・Task 2 |
| 5b/5c/5d（名寄せとの直列化・付け替え） | **PR-A で実装済み**（本計画のスコープ外。Task 5 の tx は既存の Owner FOR SHARE の中で読む） |
| replied を除外する理由 | Task 1（`SELF_EXCLUDING_REACTION_VALUES` に `replied` を含める） |
| `COOLDOWN_DAYS=90` + env 上書き・cap なし | Task 1 |
| 純関数 `decideResendCandidacy` を単一情報源に | Task 1 |
| UI「再送候補のみ」トグル → 既存の流れに乗る | Task 3 |
| 再送候補バッチは §4 述語を再評価（`resendFilterApplied`） | Task 4（記録）・Task 5（再評価） |

**2. プレースホルダ走査:** 「TBD」「適切に」「同様に」「上記のテストを書く」は無し。すべての手順に実コードを載せた。

**3. 型の一貫性:** `resendStaleCount`（Task 5 で一貫）・`recentlySentPropertyIds`（Task 5 で一貫）・`buildResendCandidateWhere` / `getResendCooldownDays` / `resendCutoff`（Task 1 で定義 → Task 2・Task 5 で同名使用）・`resendOnly`（Task 2 で定義 → Task 3・Task 4 で同名使用）を確認した。

**4. 意図的にスコープから外したもの（レビューで指摘されうるので明記）**
- **画面に「90日」という数字を出さない**。env で変えられる値なので、文言に焼き込むと env を変えたときに画面だけ嘘になる。数字を出す必要が出たら、一覧 API の応答に含めて画面へ渡す（別PR）。
- **検査(5)は §4-3 のみ**。理由は Task 5 の前書きに記載。
- **候補から外れた理由の一覧表示**は作らない。§4 は「絞り込み」であって「診断画面」ではない（`decideResendCandidacy` は理由を返せる形にしてあるので、必要になれば足せる）。
