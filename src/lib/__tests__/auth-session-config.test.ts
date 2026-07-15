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
  it("無操作ログアウトは1時間、延長間隔は5分", () => {
    expect(src).toMatch(/IDLE_TIMEOUT_SEC\s*=\s*60\s*\*\s*60\b/);
    expect(src).toMatch(/REFRESH_INTERVAL_SEC\s*=\s*5\s*\*\s*60\b/);
  });

  it("maxAge は IDLE+REFRESH のバッファ込み(境界での cookie 失効を防ぐ・@codex R6)", () => {
    // cookie は最後の操作+IDLE まで生存させるため、延長間隔ぶんのバッファを足す。
    expect(src).toMatch(
      /SESSION_MAX_AGE_SEC\s*=\s*IDLE_TIMEOUT_SEC\s*\+\s*REFRESH_INTERVAL_SEC/,
    );
  });

  it("updateAge(スライド延長)が設定されている", () => {
    expect(src).toMatch(/SESSION_UPDATE_AGE_SEC\s*=\s*REFRESH_INTERVAL_SEC/);
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
    // maxAge が 30*60 の即値に戻っていないこと(ログイン失敗ロックの 30 分は別定数なので許容)。
    expect(src).not.toMatch(/SESSION_MAX_AGE_SEC\s*=\s*30\s*\*\s*60\b/);
  });

  it("JWT回転時にDBでユーザーを再検証し無効化ユーザーを失効させる(@codex R7 P1)", () => {
    // jwt callback(user 無し=既存トークンの検証/回転)で DB 再検証する。
    const jwtBlock = src.slice(src.indexOf("async jwt"), src.indexOf("async session"));
    expect(jwtBlock.length).toBeGreaterThan(0);
    expect(jwtBlock).toContain("prisma.user.findUnique");
    // 無効化/削除で null を返す(next-auth v5: cookie クリア=失効)。
    expect(jwtBlock).toMatch(/!dbUser\s*\|\|\s*!dbUser\.isActive[\s\S]{0,40}return null/);
    // ロール変更(降格/昇格)を反映。
    expect(jwtBlock).toMatch(/token\.role\s*=\s*dbUser\.role/);
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
    // 直近操作あり時にセッション延長(素のfetchでendpointを叩く=ブロードキャストしない)。
    expect(guardSrc).toContain('fetch("/api/auth/session"');
    // getSession(broadcastする)は import しない=一時失敗でUIをログアウト化しない(@codex R4)。
    expect(guardSrc).toMatch(
      /import\s*\{\s*signOut\s*\}\s*from\s*"next-auth\/react"/,
    );
    // 操作検知イベントを購読している(内側スクロール対策で wheel/scroll も)。
    for (const ev of ["mousemove", "keydown", "scroll", "wheel", "touchstart"]) {
      expect(guardSrc).toContain(`"${ev}"`);
    }
  });

  it("内側スクロールを拾うため capture フェーズで購読する(@codex R2)", () => {
    expect(guardSrc).toMatch(/capture:\s*true/);
  });

  it("タブ間で最終操作を共有し、放置タブの誤ログアウトを防ぐ(@codex R2)", () => {
    // 共有ヘルパは session-activity に集約(localStorage + キー)。
    const activitySrc = readFileSync(
      resolve(__dirname, "../session-activity.ts"),
      "utf-8",
    );
    expect(activitySrc).toContain("localStorage");
    expect(activitySrc).toContain("pm:session:last-activity");
    // guard は共有値を読み、自タブと最大値で idle 判定する。
    expect(guardSrc).toContain("readSharedLastActivity");
    expect(guardSrc).toMatch(/Math\.max\(\s*lastActivityRef\.current/);
  });

  it("マウント時に共有の最終操作が無操作上限超過なら signOut(リロード免脱防止・@codex R7 P2)", () => {
    // startNow で無条件上書きせず、stored 起点(effectiveLast)で超過判定して signOut。
    expect(guardSrc).toContain("effectiveLast");
    expect(guardSrc).toMatch(
      /startNow\s*-\s*effectiveLast\s*>=\s*IDLE_TIMEOUT_MS[\s\S]{0,90}signOut/,
    );
    // 既存の直近値を startNow で潰さない(seed は空のときだけ)。
    expect(guardSrc).toMatch(/storedLast\s*<=\s*0[\s\S]{0,40}writeSharedLastActivity\(startNow\)/);
  });

  it("ログイン成功時に最終操作を seed する(新規ログイン直後の誤ログアウト防止・@codex R7 P2)", () => {
    const loginSrc = readFileSync(
      resolve(__dirname, "../../app/(auth)/login/page.tsx"),
      "utf-8",
    );
    expect(loginSrc).toContain("writeSharedLastActivity");
    // 認証成功ブランチ(error でない)で seed していること。
    expect(loginSrc).toMatch(/else\s*\{[\s\S]{0,200}writeSharedLastActivity\(Date\.now\(\)\)/);
  });

  it("操作再開の瞬間に即延長する(境界の誤ログアウト防止・@codex R3)", () => {
    // markActivity から延長を発火(tick 待ちにしない)。
    const markBody = guardSrc.match(/const markActivity[\s\S]*?\n {4}\};/);
    expect(markBody).not.toBeNull();
    expect(markBody![0]).toContain("maybeRefreshSession");
  });

  it("モック時(NEXT_PUBLIC_USE_MOCK)はガードを無効化する(@codex R4 P3)", () => {
    expect(guardSrc).toMatch(
      /NEXT_PUBLIC_USE_MOCK[\s\S]{0,40}===\s*"true"[\s\S]{0,20}return/,
    );
  });

  it("スリープ復帰時は最終操作を上書きする前に超過判定して signOut(@codex R5 P1)", () => {
    // markActivity の中で、lastActivityRef を更新する前に IDLE_TIMEOUT 超過を判定して signOut。
    const markBody = guardSrc.match(/const markActivity[\s\S]*?\n {4}\};/);
    expect(markBody).not.toBeNull();
    const body = markBody![0];
    const guardIdx = body.indexOf("IDLE_TIMEOUT_MS");
    const assignIdx = body.indexOf("lastActivityRef.current = now");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(assignIdx).toBeGreaterThan(guardIdx); // 判定が上書きより前
    expect(body).toMatch(/prevLastActivity[\s\S]{0,40}signOut/);
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
