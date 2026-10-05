import { describe, it, expect, vi } from "vitest";

// applyBuildingLink を実物で通すための周辺 mock(apply.test.ts と同じ)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { buildPropertyCreateData, buildingChoiceFromRow } from "@/lib/import-row-field-map";
import { applyBuildingLink } from "@/lib/building-link/apply";

describe("取込行の確定で棟を落とさない", () => {
  it("マンション名の列を物件名にし、区分マンションで作る", () => {
    const d = buildPropertyCreateData({ "住所": "東京都大田区南雪谷1丁目1", "マンション名": "パーク第一" }, "u");
    expect(d).toMatchObject({ propertyType: "apartment_unit", buildingName: "パーク第一" });
  });
  it("棟名の列も物件名にし、区分マンションで作る", () => {
    const d = buildPropertyCreateData({ "住所": "東京都大田区南雪谷1丁目1", "棟名": "パーク第一" }, "u");
    expect(d).toMatchObject({ propertyType: "apartment_unit", buildingName: "パーク第一" });
  });
  it("選んだ棟は existing(小文字)", () => {
    expect(buildingChoiceFromRow({ __resolved_building_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))
      .toEqual({ kind: "existing", buildingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });
  it("無い・形が違うなら auto", () => {
    expect(buildingChoiceFromRow({})).toEqual({ kind: "auto" });
    expect(buildingChoiceFromRow({ __resolved_building_id: "x" })).toEqual({ kind: "auto" });
  });
});

describe("「物件名」列は棟名として読まない(CSV 取込 api/import/csv と同じ規則)", () => {
  // 不動産業者形式のひな形は汎用の「物件名」列を持ち、戸建・土地も入る。
  // 物件名=区分扱いにすると、戸建が黙って区分になり棟まで自動で作られてしまう。
  const raw = { "住所": "東京都大田区南雪谷1丁目1-1", "物件名": "山田邸", "種別": "house" };

  it("戸建のまま作り、物件名(buildingName)を入れない", () => {
    const d = buildPropertyCreateData(raw, "u");
    expect(d.propertyType).toBe("house");
    expect(d).not.toHaveProperty("buildingName");
  });

  it("棟の選び方は auto、apply は棟を作らず・つながない", async () => {
    const d = buildPropertyCreateData(raw, "u");
    const choice = buildingChoiceFromRow(raw);
    expect(choice).toEqual({ kind: "auto" });
    const tx = {
      $executeRaw: vi.fn(),
      building: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
      property: { update: vi.fn() },
    };
    const outcome = await applyBuildingLink(tx as never, {
      propertyId: "p1",
      propertyType: d.propertyType as string,
      buildingName: (d.buildingName as string | undefined) ?? null,
      address: d.address as string,
      buildingNumber: null,
      choice,
      currentBuildingId: null,
      userId: "u",
    });
    expect(outcome.action).toBe("none");
    expect(outcome.building).toBeNull();
    expect(tx.building.create).not.toHaveBeenCalled();
    expect(tx.property.update).not.toHaveBeenCalled();
  });
});
