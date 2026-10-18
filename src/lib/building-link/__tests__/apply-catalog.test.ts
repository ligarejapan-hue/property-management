import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
import { applyBuildingLink } from "@/lib/building-link/apply";
import { AUTO_CHOICE } from "@/lib/building-link/resolve";
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import type { CatalogEntry } from "@/lib/mansion-catalog/adopt";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

const ADDR = "東京都葛飾区青戸４丁目２－１４－８０２";
const NAME = "プラウド青砥";
const entry = (id: string): CatalogEntry => ({
  id, name: NAME, address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9, totalFloors: 14,
  basementFloors: null, totalUnits: 155, structureType: "RC", managementCompany: "野村不動産パートナーズ",
  nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
});
let db: FakeDb;
beforeEach(() => {
  db = { buildings: [], properties: [{ id: "p1", buildingId: null, buildingName: NAME }], executed: [], catalog: [entry("c1")] };
});
const input = { propertyId: "p1", propertyType: "apartment_unit", buildingName: NAME, address: ADDR, buildingNumber: null, choice: AUTO_CHOICE, currentBuildingId: null, userId: "u1" };

describe("applyBuildingLink × 名簿", () => {
  it("新しい棟を作るとき、名簿に同じ鍵が1件なら値を入れて catalog_id を付ける(名前・住所は物件のまま)", async () => {
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("created");
    expect(db.buildings[0]).toMatchObject({ name: NAME, catalogId: "c1", builtYear: 2026, builtMonth: 9, totalFloors: 14, totalUnits: 155, managementCompany: "野村不動産パートナーズ" });
    expect(db.buildings[0]).not.toHaveProperty("basementFloors");
  });
  it("★名簿に同じ鍵が2件なら値を入れない(違う建物の値を入れない)", async () => {
    db.catalog = [entry("c1"), entry("c2")];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0].catalogId ?? null).toBeNull();
    expect(db.buildings[0]).not.toHaveProperty("totalFloors");
  });
  it("名簿に無ければ今まで通り", async () => {
    db.catalog = [];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0].catalogId ?? null).toBeNull();
  });
  it("★その名簿の建物がもう別の棟になっていたら(名前を変えた棟など)値を入れず、保存は失敗しない", async () => {
    db.buildings.push({ id: "b9", name: "名前を変えた棟", address: "x", nameKey: "別", areaKey: "別", createdAt: new Date(), createdBy: "u0", catalogId: "c1" });
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("created");
    expect(db.buildings.find((b) => b.id !== "b9")?.catalogId ?? null).toBeNull();
  });
  it("既存の棟につなぐときは名簿を見ない", async () => {
    db.buildings.push({ id: "b1", name: NAME, address: "x", nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR), createdAt: new Date(), createdBy: "u0" });
    const tx = createFakeBuildingTx(db);
    await applyBuildingLink(tx, input);
    expect(tx.mansionCatalog.findMany).not.toHaveBeenCalled();
  });
});
