import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const page = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/admin/mail-settings/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(process.cwd(), "src/components/layout/sidebar-model.tsx"), "utf8");

describe("メール送信設定の画面", () => {
  it("パスワード欄は type=password・値を画面に戻さない(placeholder で設定済みを示す)", () => {
    expect(page).toContain('type="password"');
    expect(page).toContain("設定済み(変更する場合のみ入力)");
    expect(page).not.toMatch(/value=\{[^}]*smtpPass/);
  });
  it("テスト送信・通知先未設定の案内・Xserver の既定値の説明", () => {
    expect(page).toContain("テスト送信");
    expect(page).toContain("通知先が未設定です");
    expect(page).toContain("465");
  });
  it("サイドバー: DM グループに admin 限定で出す", () => {
    expect(sidebar).toMatch(/label:\s*"メール送信設定",\s*href:\s*"\/admin\/mail-settings"[^}]*minRole:\s*"admin"/);
  });
  it("生の h1 を使わない", () => {
    expect(page).not.toContain("<h1");
  });
});

// fix round 1(レビュー指摘): 接続方式(SSL/STARTTLS)とポートの連動 + smtpCodeHint の RESET 系。
describe("接続方式とポートの連動(fix round 1・Important)", () => {
  it("接続方式の select は専用ハンドラを呼び、そのハンドラがポートも書き換える", () => {
    expect(page).toMatch(/onChange=\{\(e\) => handleSmtpSecureChange\(/);
    const start = page.indexOf("const handleSmtpSecureChange = ");
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf("\n  };", start);
    const fn = page.slice(start, end === -1 ? start + 600 : end);
    // 既知の既定値(465/587)または空欄のときだけ書き換える(手入力の別ポートは変えない)。
    expect(fn).toContain("setSmtpPort(");
    expect(fn).toContain("KNOWN_DEFAULT_PORTS");
    expect(fn).toContain('trimmed === ""');
  });

  it("読み込み時(applySettings)はポートを書き換えない=select を変えたときだけ", () => {
    const applyStart = page.indexOf("const applySettings = ");
    const applyEnd = page.indexOf("\n  };", applyStart);
    const applyFn = page.slice(applyStart, applyEnd);
    expect(applyFn).not.toContain("handleSmtpSecureChange");
    expect(applyFn).not.toContain("KNOWN_DEFAULT_PORTS");
  });

  it("食い違い(secure=true×587 / secure=false×465)のときだけ、保存を止めない黄色いヒントを出す", () => {
    expect(page).toContain("この接続方式では通常 465 を使います(587 のままでも保存はできます)");
    expect(page).toContain("この接続方式では通常 587 を使います(465 のままでも保存はできます)");
    // 判定条件そのもの(secure と 587/465 の組み合わせ)。
    expect(page).toMatch(/smtpSecure\s*&&\s*trimmedPort\s*===\s*"587"/);
    expect(page).toMatch(/!smtpSecure\s*&&\s*trimmedPort\s*===\s*"465"/);
  });
});

describe("smtpCodeHint の RESET 系(fix round 1・Minor)", () => {
  it("ECONNRESET 等(RESET を含むコード)は接続系の案内と同じ枝に入る", () => {
    const start = page.indexOf("function smtpCodeHint");
    const end = page.indexOf("\n}", start);
    const fn = page.slice(start, end);
    const connBranchStart = fn.indexOf('code.includes("ECONNREFUSED")');
    const connBranchEnd = fn.indexOf("return", connBranchStart);
    expect(connBranchStart).toBeGreaterThan(-1);
    // ECONNREFUSED / ENOTFOUND と同じ if の中に RESET も入っている(別枝に分けていない)。
    const resetIndex = fn.indexOf('code.includes("RESET")');
    expect(resetIndex).toBeGreaterThan(connBranchStart);
    expect(resetIndex).toBeLessThan(connBranchEnd);
  });
});
