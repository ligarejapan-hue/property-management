/**
 * S1b-2: 画面保護の純ロジック（node 環境・新規 devDependency なし）。
 */
import { describe, it, expect } from "vitest";
import {
  isScreenProtectionBypassed,
  buildWatermarkText,
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

  it("name 欠損時は 'ユーザー' にフォールバックする", () => {
    expect(
      buildWatermarkText({ name: null, email: "a@b.co", role: "admin", now }),
    ).toMatch(/^ユーザー /);
  });

  it("email / role 欠損時は該当部分を省く", () => {
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
