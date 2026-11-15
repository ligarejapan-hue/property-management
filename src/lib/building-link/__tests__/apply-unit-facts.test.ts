/**
 * 新しい棟を作るとき、部屋に入っている棟の項目(構造・階数・総戸数・築年月)を棟へ写す
 * (2026-11-15 発注者決定=案3)。
 *
 * 実機確認: 棟につながっていない区分の編集で、物件名と一緒に建物の項目を入れて保存すると、
 * 新しい棟ができてつながる。棟には名前と住所しか入らず、入れた値が棟の画面・詳細・販売図面で
 * 「-」になっていた。
 */
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
import { unitBuildingFacts } from "@/lib/sales-sheet/unit-building-facts";
import { createFakeBuildingTx, type FakeDb } from "./fake-building-tx";

const ADDR = "東京都葛飾区青戸４丁目２－１４－８０２";
const NAME = "テストマンション青戸";
const UNIT = { structureType: "RC造", aboveFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3 };
const input = {
  propertyId: "p1", propertyType: "apartment_unit", buildingName: NAME, address: ADDR, buildingNumber: null,
  choice: AUTO_CHOICE, currentBuildingId: null, userId: "u1",
};
let db: FakeDb;
beforeEach(() => {
  db = { buildings: [], properties: [{ id: "p1", buildingId: null, buildingName: NAME, ...UNIT }], executed: [] };
});

describe("applyBuildingLink × 部屋に入っている棟の項目", () => {
  it("★新しい棟を作るとき、部屋の値を棟へ写す(地上階は棟の列 totalFloors へ)", async () => {
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("created");
    expect(db.buildings[0]).toMatchObject({
      name: NAME, structureType: "RC造", totalFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3,
    });
  });

  it("★物件名と建物の項目を同時に保存した区分が、販売図面の作成画面と同じ読み方で値を返す", async () => {
    await applyBuildingLink(createFakeBuildingTx(db), input);
    // 図面の作成画面・図面の中身・詳細は unitBuildingFacts(物件, 棟) で読む。
    const building = db.buildings[0] as unknown as Parameters<typeof unitBuildingFacts>[1];
    expect(unitBuildingFacts(UNIT, building)).toEqual({
      structureType: "RC造", totalFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3,
    });
  });

  it("部屋の欄が空なら、棟の欄も入れない(null で埋めない)", async () => {
    db.properties = [{ id: "p1", buildingId: null, buildingName: NAME, totalUnits: 50 }];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0]).toMatchObject({ totalUnits: 50 });
    expect(db.buildings[0]).not.toHaveProperty("structureType");
    expect(db.buildings[0]).not.toHaveProperty("totalFloors");
  });

  it("★すでにある棟へつなぐときは、棟の値に触らない(棟の値が正)", async () => {
    db.buildings = [{
      id: "b1", name: NAME, address: "東京都葛飾区青戸４丁目２－１４", nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
      createdAt: new Date("2026-01-01T00:00:00Z"), createdBy: "u0", structureType: "SRC造", totalFloors: 14,
    }];
    const out = await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(out.action).toBe("linked");
    expect(db.buildings).toHaveLength(1);
    expect(db.buildings[0]).toMatchObject({ structureType: "SRC造", totalFloors: 14 });
    expect(db.buildings[0]).not.toHaveProperty("totalUnits");
  });

  it("★名簿に当たったときは名簿の値が上。名簿に無い欄だけ部屋の値が入る", async () => {
    const entry: CatalogEntry = {
      id: "c1", name: NAME, address: "東京都葛飾区青戸4丁目2番14号", builtYear: 2026, builtMonth: 9, totalFloors: 14,
      basementFloors: null, totalUnits: 155, structureType: "RC", managementCompany: null,
      nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
    };
    db.catalog = [entry];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0]).toMatchObject({
      catalogId: "c1", builtYear: 2026, builtMonth: 9, totalFloors: 14, totalUnits: 155, structureType: "RC",
      // 名簿に地下階が無い → 部屋の値
      basementFloors: 1,
    });
  });

  it("★名簿に築年だけあるとき、部屋の築月を継ぎ足さない(どこにも無い年月を作らない・@codex PR#738 1巡目)", async () => {
    const entry: CatalogEntry = {
      id: "c1", name: NAME, address: "東京都葛飾区青戸4丁目2番14号", builtYear: 1995, builtMonth: null, totalFloors: null,
      basementFloors: null, totalUnits: null, structureType: null, managementCompany: null,
      nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
    };
    db.catalog = [entry];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0]).toMatchObject({ builtYear: 1995, totalFloors: 10 });
    // 部屋は 2001年3月。名簿の 1995年 に 3月 が付いて「1995年3月」になってはいけない。
    expect(db.buildings[0]).not.toHaveProperty("builtMonth");
  });

  it("名簿に築月だけあるときも、部屋の築年を継ぎ足さない", async () => {
    const entry: CatalogEntry = {
      id: "c1", name: NAME, address: "東京都葛飾区青戸4丁目2番14号", builtYear: null, builtMonth: 9, totalFloors: null,
      basementFloors: null, totalUnits: null, structureType: null, managementCompany: null,
      nameKey: buildingNameKey(NAME), areaKey: areaKey(ADDR),
    };
    db.catalog = [entry];
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.buildings[0]).toMatchObject({ builtMonth: 9 });
    expect(db.buildings[0]).not.toHaveProperty("builtYear");
  });

  it("部屋の値は消さない(棟から外したときに戻る・変更履歴と食い違わせない)", async () => {
    await applyBuildingLink(createFakeBuildingTx(db), input);
    expect(db.properties[0]).toMatchObject(UNIT);
  });
});
