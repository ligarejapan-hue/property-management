/**
 * S1b-2: 透かし Provider / Overlay の配線を source-assertion で検証する
 * （repo に jsdom / RTL が無いため、レンダリングではなくソース内容を確認する）。
 * Codex P2-1（viewport 全面タイル）/ P2-2（汎用透かしを出さない）の対応も検証する。
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

  it("fail-safe: bypass の初期値は false（= 透かし表示側）", () => {
    expect(providerSrc).toMatch(/useState\(false\)/);
  });
});

describe("S1b-2 / Codex P2-2: 汎用透かしを出さない", () => {
  it("session.status が authenticated の場合のみ透かし文言を生成する", () => {
    expect(providerSrc).toMatch(/status\s*}\s*=\s*useSession\(\)|data:\s*session,\s*status/);
    expect(providerSrc).toMatch(/status\s*===\s*["']authenticated["']/);
  });

  it("provider は 汎用フォールバック文字列リテラル \"ユーザー\" を持たない", () => {
    expect(providerSrc).not.toMatch(/["']ユーザー["']/);
  });

  it("helper も 汎用フォールバック文字列リテラル \"ユーザー\" を持たず、null を返す方針", () => {
    expect(helperSrc).not.toMatch(/["']ユーザー["']/);
    expect(helperSrc).toMatch(/return null/);
  });

  it("watermarkText が null でない場合のみ表示する", () => {
    expect(providerSrc).toMatch(/watermarkText\s*!==\s*null/);
  });

  it("session.user の name / email / role を使う", () => {
    expect(providerSrc).toMatch(/session\?\.user\?\.name/);
    expect(providerSrc).toMatch(/session\?\.user\?\.email/);
    expect(providerSrc).toMatch(/role/);
  });

  it("buildWatermarkText を使う", () => {
    expect(providerSrc).toMatch(/buildWatermarkText/);
  });
});

describe("S1b-2 / Codex P2-1: viewport 全体を覆うタイル方式", () => {
  it("固定個数タイル方式（TILE_COUNT / Array(n).map）が残っていない", () => {
    expect(overlaySrc).not.toMatch(/TILE_COUNT/);
    expect(overlaySrc).not.toMatch(/Array\(/);
    expect(overlaySrc).not.toMatch(/\.keys\(\)/);
  });

  it("repeating 背景方式（background-image + bg-repeat + 全面 fixed inset-0）である", () => {
    expect(overlaySrc).toMatch(/fixed\s+inset-0/);
    expect(overlaySrc).toMatch(/bg-repeat/);
    expect(overlaySrc).toMatch(/backgroundImage/);
    expect(overlaySrc).toMatch(/watermarkSvgDataUri/);
  });

  it("helper が viewport タイル用の SVG data URI を提供する", () => {
    expect(helperSrc).toMatch(/export function watermarkSvgDataUri/);
    expect(helperSrc).toMatch(/data:image\/svg\+xml/);
  });
});

describe("S1b-2: 透かしの非干渉属性 / 印刷保持", () => {
  it("overlay は pointer-events-none / aria-hidden / select-none / 低透過", () => {
    expect(overlaySrc).toMatch(/pointer-events-none/);
    expect(overlaySrc).toMatch(/aria-hidden="true"/);
    expect(overlaySrc).toMatch(/select-none/);
    expect(overlaySrc).toMatch(/opacity-\[0\.0\d\]/);
  });

  it("globals.css に @media print で透かしを残す最小ルールがある", () => {
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

  it("透かし overlay/provider は Content-Disposition / uploads(enforcement) を含まない", () => {
    // 注: screen-protection.ts(helper) は S1b-3 で copy/print 監査の純ヘルパを持つため
    // /audit/ は許容する。透かし描画専用の overlay は監査を含まないことを確認する。
    for (const src of [helperSrc, providerSrc, overlaySrc]) {
      expect(src).not.toMatch(/Content-Disposition/);
      expect(src).not.toMatch(/\/uploads/);
    }
    expect(overlaySrc).not.toMatch(/audit/i);
  });

  it("visibilitychange / blur リスナを使わない（S1b-2 範囲外）", () => {
    expect(providerSrc).not.toMatch(/visibilitychange/);
    expect(providerSrc).not.toMatch(/addEventListener\(\s*["']blur/);
  });
});
