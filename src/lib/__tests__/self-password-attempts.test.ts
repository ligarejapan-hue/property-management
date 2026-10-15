import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reserveSelfPasswordAttempt,
  SELF_PASSWORD_LOCK_MS,
  SELF_PASSWORD_MAX_FAILURES,
  type AttemptDb,
} from "../self-password-attempts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

function fakeDb(rows: number) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: AttemptDb = {
    $executeRaw: vi.fn(async (q: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: q.join("?"), values });
      return rows;
    }),
  };
  return { db, calls };
}

describe("自分のパスワード変更の試行回数(@codex #517 P2)", () => {
  it("ログインと同じ数え・同じ上限(5回で30分)", () => {
    const auth = read("src/lib/auth.ts");
    expect(auth).toContain(`const MAX_LOGIN_FAILURES = ${SELF_PASSWORD_MAX_FAILURES};`);
    expect(auth).toContain("const LOCK_DURATION_MS = 30 * 60 * 1000;");
    expect(SELF_PASSWORD_LOCK_MS).toBe(30 * 60 * 1000);
  });

  it("1文で ロック中でないか確認+1回分+5回目ならロック・時刻はJSで1回だけ作る", async () => {
    const { db, calls } = fakeDb(1);
    const now = new Date("2026-10-15T07:00:00Z");
    expect(await reserveSelfPasswordAttempt(db, "u1", now)).toBe(true);
    expect(calls).toHaveLength(1);
    const { sql, values } = calls[0];
    expect(sql).toContain("login_failed_count = login_failed_count + 1");
    expect(sql).toMatch(/WHEN login_failed_count \+ 1 >= \?\s+THEN \(\?::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(sql).toContain("locked_until IS NULL OR locked_until <= (?::timestamptz AT TIME ZONE 'UTC')");
    expect(sql).toContain("id = ?::uuid");
    expect(sql).toContain("is_active = true");
    expect(sql).not.toMatch(/now\(\)|clock_timestamp/i);
    expect(values).toEqual([5, "2026-10-15T07:30:00.000Z", "u1", "2026-10-15T07:00:00.000Z"]);
  });

  it("ロック中(更新0行)なら予約できない", async () => {
    const { db } = fakeDb(0);
    expect(await reserveSelfPasswordAttempt(db, "u1", new Date())).toBe(false);
  });

  it("API は照合(bcrypt)の前に予約し、ロック中は429・当たったら数えを戻す", () => {
    const api = read("src/app/api/me/change-password/route.ts");
    const reserve = api.indexOf("reserveSelfPasswordAttempt(prisma, session.id, new Date())");
    const check = api.indexOf("compare(data.currentPassword, user.passwordHash)");
    expect(reserve).toBeGreaterThan(0);
    expect(reserve).toBeLessThan(check);
    expect(api).toContain('"TOO_MANY_ATTEMPTS"');
    expect(api).toMatch(/passwordHash,\n\s+mustChangePassword: false,[\s\S]*?loginFailedCount: 0,\n\s+lockedUntil: null,/);
  });
});
