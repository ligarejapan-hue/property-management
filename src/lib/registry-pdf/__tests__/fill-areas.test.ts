/**
 * 謄本から読めた面積で物件の空の欄を埋める共通処理(fill-areas.ts・2026-10-25)。
 * 物件の画面の添付・謄本PDFの一括取込・物件を指定しない取込から呼ぶ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(), updateMany: vi.fn() },
    building: { findUnique: vi.fn(), updateMany: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ isResourceEditLocked: vi.fn() }));
vi.mock("@/lib/edit-lock/row-locks", () => ({ lockBuildingRowNoKeyUpdate: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: ["landArea"],
  BUILDING_TRACKED_FIELDS: ["structureType"],
}));
vi.mock("@/lib/pdf-extract", () => ({ extractHeadTextFromPdf: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));

import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { lockBuildingRowNoKeyUpdate } from "@/lib/edit-lock/row-locks";
import { recordChanges } from "@/lib/change-log";
import { extractHeadTextFromPdf as extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { fillBasicInfoFromRegistryPdfBestEffort, fillPropertyFromRegistry } from "@/lib/registry-pdf/fill-areas";
import type { RegistryAreas } from "@/lib/registry-area";

const pm = prisma as unknown as {
  $transaction: Mock;
  property: { findUnique: Mock; updateMany: Mock };
  building: { findUnique: Mock; updateMany: Mock };
};
const HOUSE = {
  version: 3,
  propertyType: "house",
  exclusiveAreaRegistry: null,
  landArea: null,
  landAreaMethod: null,
  totalFloorArea: null,
  buildingId: null,
  lotNumber: null,
  buildingNumber: null,
  structureType: null,
  builtYear: null,
  builtMonth: null,
};
const AREAS: RegistryAreas = { unitFloorArea: null, landArea: "120.50", buildingFloorArea: null };
const run = (areas = AREAS) => fillPropertyFromRegistry({ propertyId: "p-1", values: areas, changedBy: "u-1" });

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({ ...HOUSE });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.building.updateMany.mockResolvedValue({ count: 1 });
  (isResourceEditLocked as Mock).mockResolvedValue(false);
});

describe("面積を空の欄に入れる", () => {
  it("★行ロック→読み直し→版番号つきで書く→変更履歴(謄本の取込)", async () => {
    const r = await run();
    expect(r).toEqual({ filled: ["landArea", "landAreaMethod"], skippedByEditLock: false });
    expect(lockPropertyRow).toHaveBeenCalledWith(expect.anything(), "p-1");
    expect(pm.property.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1", version: 3 },
      data: { landArea: "120.50", landAreaMethod: "公簿", version: { increment: 1 } },
    });
    expect((recordChanges as Mock).mock.calls[0][0]).toMatchObject({
      targetId: "p-1",
      changedBy: "u-1",
      source: "pdf_import",
      newValues: { landArea: "120.50", landAreaMethod: "公簿" },
    });
  });

  it("★読めた面積が無い・埋める欄が無いときはロックも取らない", async () => {
    await run({ unitFloorArea: null, landArea: null, buildingFloorArea: null });
    pm.property.findUnique.mockResolvedValue({ ...HOUSE, landArea: "100" });
    await run();
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("★編集中の鍵の間は見送る(書かない・見送ったことを返す)", async () => {
    (isResourceEditLocked as Mock).mockResolvedValue(true);
    expect(await run()).toEqual({ filled: [], skippedByEditLock: true });
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(recordChanges).not.toHaveBeenCalled();
  });

  it("ロックを待つ間に誰かが入れていたら書かない(読み直した値で決める)", async () => {
    pm.property.findUnique.mockResolvedValueOnce({ ...HOUSE }).mockResolvedValueOnce({ ...HOUSE, landArea: "99" });
    expect((await run()).filled).toEqual([]);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("版番号が合わず書けなかったら、書いたことにしない(変更履歴を残さない)", async () => {
    pm.property.updateMany.mockResolvedValue({ count: 0 });
    expect((await run()).filled).toEqual([]);
    expect(recordChanges).not.toHaveBeenCalled();
  });
});

describe("地番・家屋番号・構造・築年月", () => {
  const VALUES = { lotNumber: "1番1", buildingNumber: "1番1の38", structureType: "RC造5階建", builtYear: 1985, builtMonth: 5 };
  const UNIT = { ...HOUSE, propertyType: "apartment_unit", exclusiveAreaRegistry: null };

  it("★棟なし: 物件の空の欄に入れ、変更履歴に構造と築年月も残す", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT });
    const r = await fillPropertyFromRegistry({ propertyId: "p-1", values: VALUES, changedBy: "u-1" });
    expect(r.filled.sort()).toEqual(["buildingNumber", "builtMonth", "builtYear", "lotNumber", "structureType"]);
    expect(pm.property.updateMany.mock.calls[0][0].data).toMatchObject({ ...VALUES, version: { increment: 1 } });
    expect(pm.building.updateMany).not.toHaveBeenCalled();
    expect((recordChanges as Mock).mock.calls[0][0].trackedFields).toEqual(expect.arrayContaining(["structureType", "builtYear", "builtMonth"]));
  });

  it("★棟に紐づく部屋: 構造と築年月は棟の空の欄へ・部屋の行→棟の行の順でロック・両方の変更履歴", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT, buildingId: "b-1" });
    pm.building.findUnique.mockResolvedValue({ version: 7, structureType: null, builtYear: null, builtMonth: null });
    const r = await fillPropertyFromRegistry({ propertyId: "p-1", values: VALUES, changedBy: "u-1" });
    expect(r.filled.sort()).toEqual(["buildingNumber", "builtMonth", "builtYear", "lotNumber", "structureType"]);
    expect(pm.property.updateMany.mock.calls[0][0].data).toEqual({ lotNumber: "1番1", buildingNumber: "1番1の38", version: { increment: 1 } });
    expect(pm.building.updateMany).toHaveBeenCalledWith({
      where: { id: "b-1", version: 7 },
      data: { structureType: "RC造5階建", builtYear: 1985, builtMonth: 5, version: { increment: 1 } },
    });
    expect((lockPropertyRow as Mock).mock.invocationCallOrder[0]).toBeLessThan((lockBuildingRowNoKeyUpdate as Mock).mock.invocationCallOrder[0]);
    expect((recordChanges as Mock).mock.calls.map((c) => c[0].targetTable)).toEqual(["properties", "buildings"]);
  });

  it("★棟の欄が入っていれば上書きしない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT, buildingId: "b-1", lotNumber: "入", buildingNumber: "入" });
    pm.building.findUnique.mockResolvedValue({ version: 7, structureType: "RC", builtYear: 2000, builtMonth: 1 });
    const r = await fillPropertyFromRegistry({ propertyId: "p-1", values: VALUES, changedBy: "u-1" });
    expect(r).toEqual({ filled: [], skippedByEditLock: false });
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("★編集中の鍵の間は棟にも書かない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT, buildingId: "b-1", lotNumber: "入", buildingNumber: "入" });
    pm.building.findUnique.mockResolvedValue({ version: 7, structureType: null, builtYear: null, builtMonth: null });
    (isResourceEditLocked as Mock).mockResolvedValue(true);
    const r = await fillPropertyFromRegistry({ propertyId: "p-1", values: VALUES, changedBy: "u-1" });
    expect(r).toEqual({ filled: [], skippedByEditLock: true });
    expect(pm.building.updateMany).not.toHaveBeenCalled();
  });

  it("★棟の版番号が合わず書けなければ、棟の分は書いたことにしない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT, buildingId: "b-1", lotNumber: "入", buildingNumber: "入" });
    pm.building.findUnique.mockResolvedValue({ version: 7, structureType: null, builtYear: null, builtMonth: null });
    pm.building.updateMany.mockResolvedValue({ count: 0 });
    const r = await fillPropertyFromRegistry({ propertyId: "p-1", values: VALUES, changedBy: "u-1" });
    expect(r.filled).toEqual([]);
    expect(recordChanges).not.toHaveBeenCalled();
  });

  it("★不動産番号は渡されても書かない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT });
    await fillPropertyFromRegistry({ propertyId: "p-1", values: { ...VALUES, realEstateNumber: "1234567890123" } as never, changedBy: "u-1" });
    expect(pm.property.updateMany.mock.calls[0][0].data).not.toHaveProperty("realEstateNumber");
  });
});

describe("PDF を読んで入れる(失敗しても投げない)", () => {
  it("PDF の文字を読み、謄本として読んだ面積で入れる", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("あ".repeat(200));
    (parseRegistryText as Mock).mockReturnValue({ landAreaRegistry: "120.50" });
    const r = await fillBasicInfoFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" });
    expect(r.filled).toContain("landArea");
    expect(r.unreadable).toBe(false);
  });

  it("★文字がほとんど無い PDF(画像の謄本)・時間切れは「読めない」と返し、何も書かない", async () => {
    for (const text of ["-- 1 of 2 --\n-- 2 of 2 --", "", null]) {
      (extractTextFromPdf as Mock).mockResolvedValue(text);
      const r = await fillBasicInfoFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" });
      expect(r).toEqual({ filled: [], skippedByEditLock: false, unreadable: true });
    }
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("★読めたが保存に失敗: 投げない・「読めない」にしない", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("あ".repeat(200));
    (parseRegistryText as Mock).mockReturnValue({ landAreaRegistry: "120.50" });
    pm.$transaction.mockRejectedValueOnce(new Error("timeout"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await fillBasicInfoFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" });
    expect(r).toEqual({ filled: [], skippedByEditLock: false, unreadable: false, failed: true });
    spy.mockRestore();
  });

  it("★PDF が読めなくても投げない(添付・取込そのものは成功させる)", async () => {
    (extractTextFromPdf as Mock).mockRejectedValue(new Error("broken pdf"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      fillBasicInfoFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" }),
    ).resolves.toEqual({ filled: [], skippedByEditLock: false, unreadable: true });
    spy.mockRestore();
  });
});
