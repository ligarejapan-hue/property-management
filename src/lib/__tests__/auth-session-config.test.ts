/**
 * セッション設定(無操作1時間でログアウトのスライド式)の source-assertion テスト。
 *
 * auth.ts は NextAuth(next-auth) を実体 import するため vitest(env=node)での実行は避け、
 * リポ慣行に従いソース文字列で設定値を検証する(config は挙動が next-auth 内部依存で
 * 単体テストしづらいため)。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../auth.ts"), "utf-8");

describe("セッション設定: 無操作1時間でログアウト(スライド式)", () => {
  it("maxAge は 1 時間(60*60秒)", () => {
    expect(src).toMatch(/SESSION_MAX_AGE_SEC\s*=\s*60\s*\*\s*60\b/);
  });

  it("updateAge(スライド延長)が設定されている", () => {
    expect(src).toMatch(/SESSION_UPDATE_AGE_SEC\s*=\s*5\s*\*\s*60\b/);
    expect(src).toMatch(/updateAge:\s*SESSION_UPDATE_AGE_SEC/);
  });

  it("session は jwt 戦略で maxAge/updateAge を両方持つ", () => {
    const sessionBlock = src.match(/session:\s*\{[\s\S]*?\}/);
    expect(sessionBlock).not.toBeNull();
    expect(sessionBlock![0]).toContain('strategy: "jwt"');
    expect(sessionBlock![0]).toContain("maxAge: SESSION_MAX_AGE_SEC");
    expect(sessionBlock![0]).toContain("updateAge: SESSION_UPDATE_AGE_SEC");
  });

  it("旧30分固定(30 * 60 の maxAge・updateAgeなし)ではない", () => {
    // maxAge が 30*60 に戻っていないこと(ログイン失敗ロックの 30 分は別定数なので許容)。
    expect(src).not.toMatch(/SESSION_MAX_AGE_SEC\s*=\s*30\s*\*\s*60\b/);
  });
});

describe("アイドルガード: 実際に効く延長/失効の配線(@codex #290 P2)", () => {
  const guardSrc = readFileSync(
    resolve(__dirname, "../../components/auth/idle-session-guard.tsx"),
    "utf-8",
  );
  const layoutSrc = readFileSync(
    resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
    "utf-8",
  );

  it("無操作1時間で signOut、操作中は getSession で延長する", () => {
    expect(guardSrc).toMatch(/IDLE_TIMEOUT_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(guardSrc).toMatch(/REFRESH_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
    // 無操作上限超過で signOut。
    expect(guardSrc).toMatch(/idleFor\s*>=\s*IDLE_TIMEOUT_MS[\s\S]{0,80}signOut/);
    // 直近操作あり時にセッション延長(getSession)。
    expect(guardSrc).toContain("getSession()");
    // 操作検知イベントを購読している。
    for (const ev of ["mousemove", "keydown", "scroll", "touchstart"]) {
      expect(guardSrc).toContain(`"${ev}"`);
    }
  });

  it("dashboard layout に IdleSessionGuard が配線されている", () => {
    expect(layoutSrc).toContain("IdleSessionGuard");
    expect(layoutSrc).toMatch(/<IdleSessionGuard\s*\/>/);
    // SessionProvider 配下(getSession が Provider 前提)であること。
    const provIdx = layoutSrc.indexOf("<SessionProvider>");
    const guardIdx = layoutSrc.indexOf("<IdleSessionGuard");
    expect(provIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(provIdx);
  });
});
