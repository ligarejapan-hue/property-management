import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

/** 名簿から棟にした記録(設計 2026-10-18)。名簿の id・どの形か・埋めた欄の名前だけ=非PII。 */
describe("building.catalog_adopt の detail は表示でも消えない", () => {
  it("★catalogId・kind・filled が見える", () => {
    const detail = { catalogId: "0b5e8f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b", kind: "linked", filled: ["totalFloors", "totalUnits"] };
    const out = sanitizeAuditDetail("building.catalog_adopt", detail) as Record<string, unknown>;
    expect(out).toEqual(detail);
    expect(Object.values(out)).not.toContain(REDACTED);
  });
  it("★許したキー以外(住所など)は今まで通り伏せる", () => {
    const out = sanitizeAuditDetail("building.catalog_adopt", { catalogId: "x", address: "東京都葛飾区青戸4丁目2番14号" }) as Record<string, unknown>;
    expect(out.address).not.toBe("東京都葛飾区青戸4丁目2番14号");
  });
});
