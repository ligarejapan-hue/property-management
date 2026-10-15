import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSelfPasswordLimiter,
  takeSelfPasswordAttempt,
  SELF_PASSWORD_MAX_ATTEMPTS,
  SELF_PASSWORD_WINDOW_MS,
} from "../self-password-attempts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("自分のパスワード変更の試行回数(@codex #517 P2)", () => {
  it("本人ごとに30分で5回まで・6回目は止まり、30分たてば戻る", () => {
    expect(SELF_PASSWORD_MAX_ATTEMPTS).toBe(5);
    expect(SELF_PASSWORD_WINDOW_MS).toBe(30 * 60 * 1000);
    const l = createSelfPasswordLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(l.hit("u1", t0 + i)).toBe(true);
    expect(l.hit("u1", t0 + 10)).toBe(false);
    expect(l.hit("u2", t0 + 10)).toBe(true); // 他の人は巻き込まない
    expect(l.hit("u1", t0 + 29 * 60_000)).toBe(false);
    expect(l.hit("u1", t0 + 30 * 60_000 + 5)).toBe(true);
  });

  it("大文字のIDでも同じ人として数える", () => {
    const id = "ABCDEF00-0000-4000-8000-00000000000a";
    const t0 = 5_000_000;
    for (let i = 0; i < 5; i++) expect(takeSelfPasswordAttempt(i % 2 ? id : id.toLowerCase(), t0 + i)).toBe(true);
    expect(takeSelfPasswordAttempt(id, t0 + 10)).toBe(false);
  });

  it("⚠ログインのロック(login_failed_count / locked_until)には触らない=本人を締め出さない(@codex 2巡目)", () => {
    const lib = read("src/lib/self-password-attempts.ts");
    const api = read("src/app/api/me/change-password/route.ts");
    expect(api).not.toMatch(/loginFailedCount|lockedUntil/);
    expect(lib).not.toMatch(/prisma|\$executeRaw|UPDATE users/);
  });

  it("API は照合(bcrypt)の前に await を挟まず数え、超えたら429", () => {
    const api = read("src/app/api/me/change-password/route.ts");
    const take = api.indexOf("if (!takeSelfPasswordAttempt(session.id))");
    const check = api.indexOf("compare(data.currentPassword, user.passwordHash)");
    expect(take).toBeGreaterThan(0);
    expect(take).toBeLessThan(check);
    expect(api).toContain('"TOO_MANY_ATTEMPTS"');
  });

  it("画面は API の決まった形({ error: { message } })から案内を読む=止まった案内が出る", () => {
    const page = read("src/app/(dashboard)/admin/change-password/page.tsx");
    expect(page).toContain("data?.error?.message");
    expect(read("src/lib/api-helpers.ts")).toMatch(/error:\s*\{[\s\S]*?message/);
  });
});
