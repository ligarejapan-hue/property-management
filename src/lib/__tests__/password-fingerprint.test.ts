import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashSync } from "bcryptjs";
import { passwordFingerprint, tokenMatchesPassword } from "../password-fingerprint";

const authSrc = readFileSync(resolve(__dirname, "../auth.ts"), "utf-8").replace(/\r\n/g, "\n");

describe("パスワードを変えたら他のブラウザのログインも切る(@codex #517 P1)", () => {
  it("指紋は16桁で、ハッシュそのものは入れない", () => {
    const h = hashSync("correct horse", 10);
    const fp = passwordFingerprint(h);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain(fp);
    expect(passwordFingerprint(h)).toBe(fp); // 同じハッシュなら同じ
  });

  it("同じパスワードを入れ直しても(塩が違うので)指紋は変わる=必ず切れる", () => {
    const a = hashSync("same-password", 10);
    const b = hashSync("same-password", 10);
    expect(tokenMatchesPassword(passwordFingerprint(a), a)).toBe(true);
    expect(tokenMatchesPassword(passwordFingerprint(a), b)).toBe(false);
  });

  it("指紋の無い古いトークン・形の違う値は合わない扱い", () => {
    const h = hashSync("x", 10);
    for (const v of [undefined, null, "", 123, {}]) expect(tokenMatchesPassword(v, h)).toBe(false);
  });

  it("ログイン時に焼き直し後のハッシュから指紋を入れ、回転のたびに比べて違えば失効", () => {
    const jwt = authSrc.slice(authSrc.indexOf("async jwt"), authSrc.indexOf("async session"));
    const login = jwt.slice(0, jwt.indexOf("return token;"));
    expect(login).toContain("select: { passwordHash: true }");
    expect(login).toContain("token.pwv = passwordFingerprint(fresh.passwordHash)");
    expect(jwt).toContain("select: { isActive: true, role: true, passwordHash: true }");
    expect(jwt).toMatch(/if \(!tokenMatchesPassword\(token\.pwv, dbUser\.passwordHash\)\) \{\n\s+return null;/);
    // 無効化の判定のあと・ロール反映の前
    const iActive = jwt.indexOf("!dbUser.isActive");
    const iPw = jwt.indexOf("tokenMatchesPassword(token.pwv");
    const iRole = jwt.indexOf("token.role = dbUser.role");
    expect(iActive).toBeLessThan(iPw);
    expect(iPw).toBeLessThan(iRole);
  });
});
