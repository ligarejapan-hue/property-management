/**
 * insecure-context preflight banner の配線を固定する source-assertion。
 * vitest は node 環境のため DOM は描画せず、判定ロジックは
 * field-survey-secure-context.test.ts が担保する。本ファイルは
 * 「banner が判定 helper を使い、map page に mount され、機能を止めない」配線を固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const BANNER = "src/components/field-survey/insecure-context-banner.tsx";
const MAP_PAGE = "src/app/(dashboard)/field-survey/map/page.tsx";

describe("insecure-context banner: 配線", () => {
  const banner = read(BANNER);

  it("client component で、判定は純 helper shouldWarnInsecureContext を使う", () => {
    expect(banner).toMatch(/^"use client";/);
    expect(banner).toMatch(
      /import \{ shouldWarnInsecureContext \} from "@\/lib\/field-survey-secure-context"/,
    );
    expect(banner).toMatch(/shouldWarnInsecureContext\(\{/);
  });

  it("window.isSecureContext / protocol / hostname を mount 後の effect で参照する", () => {
    expect(banner).toMatch(/useEffect\(/);
    expect(banner).toMatch(/window\.isSecureContext/);
    expect(banner).toMatch(/window\.location\.protocol/);
    expect(banner).toMatch(/window\.location\.hostname/);
  });

  it("警告しない場合は何も描画しない（表示のみ・機能は止めない）", () => {
    expect(banner).toMatch(/if \(!warn\) return null;/);
    expect(banner).toMatch(/role="alert"/);
    // hostname / protocol / 座標 / APIキーを画面に出さない（生 window 値を JSX に差し込まない）。
    expect(banner).not.toMatch(/\{window\./);
  });

  it("警告文言が HTTPS / localhost / 位置情報・カメラ / 実機検証 の趣旨を含む", () => {
    expect(banner).toMatch(/HTTPS/);
    expect(banner).toMatch(/localhost/);
    expect(banner).toMatch(/位置情報.*カメラ|カメラ.*位置情報/);
    expect(banner).toMatch(/実機/);
  });
});

describe("insecure-context banner: map page への mount", () => {
  const page = read(MAP_PAGE);

  it("map page が banner を import して描画する", () => {
    expect(page).toMatch(
      /import InsecureContextBanner from "@\/components\/field-survey\/insecure-context-banner"/,
    );
    expect(page).toMatch(/<InsecureContextBanner \/>/);
  });

  it("既存の権限ゲート / Maps loader 構造を壊さない（canRead 分岐と client mount を維持）", () => {
    expect(page).toMatch(/hasPermission\(permissions, "field_survey", "read"\)/);
    expect(page).toMatch(/<FieldSurveyMapClient currentUserId=\{currentUserId\} \/>/);
  });
});
