/**
 * dm-logs-view の PII 保護サーフェス検証（Codex P2 round2）。
 *
 * ScreenProtectionGuard は data-pii-surface の値を /api/me/audit-events に送信し、
 * route 側は surface を z.enum(SCREEN_PROTECTION_SURFACES) で検証する。未登録の
 * surface（例 "dm-logs"）だと copy / cut / contextmenu 時に 400 となり監査イベントが
 * 失われるため、必ず登録済みの surface を使う。ソース上の surface 値が登録済みかを固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SCREEN_PROTECTION_SURFACES } from "@/lib/screen-protection";

const SRC = readFileSync(
  path.resolve(process.cwd(), "src/components/properties/dm-logs-view.tsx"),
  "utf8",
);

describe("dm-logs-view PII 保護サーフェス", () => {
  it("data-pii-protected で PII 領域（note 等）を包む", () => {
    expect(SRC).toContain("data-pii-protected");
  });

  it("data-pii-surface は SCREEN_PROTECTION_SURFACES 登録済みの値（audit-events スキーマ整合）", () => {
    const m = SRC.match(/data-pii-surface="([^"]+)"/);
    expect(m).not.toBeNull();
    const surface = m?.[1] ?? "";
    expect(SCREEN_PROTECTION_SURFACES as readonly string[]).toContain(surface);
  });
});
