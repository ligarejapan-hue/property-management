/**
 * S1b-2: 画面保護の純ロジック（node 環境・新規 devDependency なし）。
 */
import { describe, it, expect } from "vitest";
import {
  isScreenProtectionBypassed,
  buildWatermarkText,
  watermarkSvgDataUri,
} from "@/lib/screen-protection";

describe("isScreenProtectionBypassed", () => {
  it("screen_protection:bypass=granted なら true", () => {
    expect(
      isScreenProtectionBypassed([
        { resource: "screen_protection", action: "bypass", granted: true },
      ]),
    ).toBe(true);
  });

  it("未付与は default-deny=false（= 保護対象 = 透かし表示）", () => {
    expect(isScreenProtectionBypassed([])).toBe(false);
  });

  it("granted=false なら false", () => {
    expect(
      isScreenProtectionBypassed([
        { resource: "screen_protection", action: "bypass", granted: false },
      ]),
    ).toBe(false);
  });

  it("無関係な権限だけなら false", () => {
    expect(
      isScreenProtectionBypassed([
        { resource: "property", action: "read", granted: true },
        { resource: "registry_pdf", action: "download", granted: true },
      ]),
    ).toBe(false);
  });
});

describe("buildWatermarkText", () => {
  const now = new Date(2026, 5, 3, 14, 30); // 2026-06-03 14:30（月は 0 始まりで 5=6月）

  it("氏名 <email> [role] 日時 を整形する", () => {
    expect(
      buildWatermarkText({
        name: "山田太郎",
        email: "yamada@example.com",
        role: "admin",
        now,
      }),
    ).toBe("山田太郎 <yamada@example.com> [admin] 2026-06-03 14:30");
  });

  it("email を必ず含める（指定があれば）", () => {
    expect(
      buildWatermarkText({
        name: "A",
        email: "a@b.co",
        role: "office_staff",
        now,
      }),
    ).toContain("<a@b.co>");
  });

  // Codex P2-2: 識別情報が無ければ汎用透かしを作らない（null）。
  it("name / email / role が全て無ければ null を返す（汎用透かしを出さない）", () => {
    expect(buildWatermarkText({ name: null, email: null, role: null, now })).toBeNull();
    expect(
      buildWatermarkText({ name: "", email: "   ", role: undefined, now }),
    ).toBeNull();
  });

  it("name 欠損でも email / role があれば生成し、'ユーザー' を含めない", () => {
    const result = buildWatermarkText({
      name: null,
      email: "a@b.co",
      role: null,
      now,
    });
    expect(result).toBe("<a@b.co> 2026-06-03 14:30");
    expect(result).not.toContain("ユーザー");
  });

  it("email / role 欠損時は該当部分を省く（name あり）", () => {
    expect(
      buildWatermarkText({ name: "A", email: null, role: undefined, now }),
    ).toBe("A 2026-06-03 14:30");
  });

  it("時刻はゼロ埋めされる", () => {
    const d = new Date(2026, 0, 5, 9, 7); // 2026-01-05 09:07
    expect(
      buildWatermarkText({ name: "A", email: "", role: "", now: d }),
    ).toBe("A 2026-01-05 09:07");
  });
});

describe("watermarkSvgDataUri (Codex P2-1: viewport 全体タイル)", () => {
  it("background-image に渡せる data:image/svg+xml の url を返す", () => {
    const uri = watermarkSvgDataUri("A <a@b.co> [admin] 2026-06-03 14:30");
    expect(uri.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(uri.endsWith('")')).toBe(true);
  });

  it("SVG 構造を保ちつつ、テキストの山括弧を XML エスケープする（インジェクション防止）", () => {
    const uri = watermarkSvgDataUri("X <a@b.co> [r] 2026-01-01 00:00");
    const decoded = decodeURIComponent(uri);
    // SVG タグ自体は残る
    expect(decoded).toContain("<svg");
    expect(decoded).toContain("<text");
    // 動的テキスト内の山括弧はエスケープされ、生タグとして注入されない
    expect(decoded).toContain("&lt;a@b.co&gt;");
    expect(decoded).not.toContain("<a@b.co>");
  });

  it("回転（タイル繰り返し用）を含む", () => {
    const decoded = decodeURIComponent(watermarkSvgDataUri("A 2026"));
    expect(decoded).toContain("rotate(");
  });
});
