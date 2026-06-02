/**
 * S1b-2: 透かし Provider / Overlay の配線を source-assertion で検証する
 * （repo に jsdom / RTL が無いため、レンダリングではなくソース内容を確認する）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const helperSrc = read("src/lib/screen-protection.ts");
const providerSrc = read(
  "src/components/screen-protection/screen-protection-provider.tsx",
);
const overlaySrc = read(
  "src/components/screen-protection/watermark-overlay.tsx",
);
const layoutSrc = read("src/components/layout/dashboard-layout.tsx");
const globalsSrc = read("src/app/globals.css");
const loginPageSrc = read("src/app/(auth)/login/page.tsx");

describe("S1b-2: dashboard-layout への mount", () => {
  it("ScreenProtectionProvider を import している", () => {
    expect(layoutSrc).toMatch(
      /import\s+ScreenProtectionProvider\s+from\s+["']@\/components\/screen-protection\/screen-protection-provider["']/,
    );
  });

  it("dashboard 全体を ScreenProtectionProvider で包んでいる", () => {
    expect(layoutSrc).toMatch(/<ScreenProtectionProvider>/);
    expect(layoutSrc).toMatch(/<\/ScreenProtectionProvider>/);
  });

  it("login ページには mount しない（(dashboard) 限定）", () => {
    expect(loginPageSrc).not.toMatch(/ScreenProtectionProvider/);
  });
});

describe("S1b-2: bypass 判定 / 権限取得", () => {
  it("provider が /api/me/permissions を 1 回 fetch する", () => {
    expect(providerSrc).toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
  });

  it("isScreenProtectionBypassed で bypass を判定する", () => {
    expect(providerSrc).toMatch(/isScreenProtectionBypassed/);
  });

  it("helper は screen_protection:bypass を見る", () => {
    expect(helperSrc).toMatch(/"screen_protection"\s*,\s*"bypass"/);
  });

  it("fail-safe: bypass の初期値は false（= 透かし表示）", () => {
    expect(providerSrc).toMatch(/useState\(false\)/);
  });
});

describe("S1b-2: 透かし内容 / 属性", () => {
  it("session.user の name / email / role を使う", () => {
    expect(providerSrc).toMatch(/session\?\.user\?\.name/);
    expect(providerSrc).toMatch(/session\?\.user\?\.email/);
    expect(providerSrc).toMatch(/role/);
  });

  it("buildWatermarkText を使う", () => {
    expect(providerSrc).toMatch(/buildWatermarkText/);
  });

  it("overlay は pointer-events-none / aria-hidden / select-none / 低透過", () => {
    expect(overlaySrc).toMatch(/pointer-events-none/);
    expect(overlaySrc).toMatch(/aria-hidden="true"/);
    expect(overlaySrc).toMatch(/select-none/);
    expect(overlaySrc).toMatch(/opacity-\[0\.0\d\]/);
  });
});

describe("S1b-2: globals.css の印刷ルール", () => {
  it("@media print で透かしを残す最小ルールがある", () => {
    expect(globalsSrc).toMatch(/@media print/);
    expect(globalsSrc).toMatch(/screen-protection-watermark/);
  });
});

describe("S1b-2: スコープ限定（透かしのみ・enforcement / 監査なし）", () => {
  it("copy/cut/contextmenu/print 抑止や preventDefault を含まない", () => {
    for (const src of [helperSrc, providerSrc, overlaySrc]) {
      expect(src).not.toMatch(/onCopy|onCut|onContextMenu|oncopy|oncontextmenu/);
      expect(src).not.toMatch(/beforeprint|onbeforeprint/);
      expect(src).not.toMatch(/preventDefault/);
    }
  });

  it("クライアント監査 / Content-Disposition / uploads を含まない", () => {
    for (const src of [helperSrc, providerSrc, overlaySrc]) {
      expect(src).not.toMatch(/audit/i);
      expect(src).not.toMatch(/Content-Disposition/);
      expect(src).not.toMatch(/\/uploads/);
    }
  });

  it("visibilitychange / blur リスナを使わない（S1b-2 範囲外）", () => {
    expect(providerSrc).not.toMatch(/visibilitychange/);
    expect(providerSrc).not.toMatch(/addEventListener\(\s*["']blur/);
  });
});
