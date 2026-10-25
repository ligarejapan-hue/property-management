/**
 * 謄本から読めた面積で物件の空の欄を埋める共通処理(fill-areas.ts・2026-10-25)。
 * 物件の画面の添付・謄本PDFの一括取込・物件を指定しない取込から呼ぶ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = { property: { findUnique: vi.fn(), updateMany: vi.fn() } };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ isResourceEditLocked: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn(), PROPERTY_TRACKED_FIELDS: ["landArea"] }));
vi.mock("@/lib/pdf-extract", () => ({ extractHeadTextFromPdf: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));

import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { recordChanges } from "@/lib/change-log";
import { extractHeadTextFromPdf as extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { fillAreasFromRegistryPdfBestEffort, fillPropertyAreasFromRegistry } from "@/lib/registry-pdf/fill-areas";
import type { RegistryAreas } from "@/lib/registry-area";

const pm = prisma as unknown as { $transaction: Mock; property: { findUnique: Mock; updateMany: Mock } };
const HOUSE = {
  version: 3,
  propertyType: "house",
  exclusiveAreaRegistry: null,
  landArea: null,
  landAreaMethod: null,
  totalFloorArea: null,
};
const AREAS: RegistryAreas = { unitFloorArea: null, landArea: "120.50", buildingFloorArea: null };
const run = (areas = AREAS) => fillPropertyAreasFromRegistry({ propertyId: "p-1", areas, changedBy: "u-1" });

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({ ...HOUSE });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
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

describe("PDF を読んで入れる(失敗しても投げない)", () => {
  it("PDF の文字を読み、謄本として読んだ面積で入れる", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("text");
    (parseRegistryText as Mock).mockReturnValue({ landAreaRegistry: "120.50" });
    const r = await fillAreasFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" });
    expect(r.filled).toContain("landArea");
  });

  it("★PDF が読めなくても投げない(添付・取込そのものは成功させる)", async () => {
    (extractTextFromPdf as Mock).mockRejectedValue(new Error("broken pdf"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      fillAreasFromRegistryPdfBestEffort({ propertyId: "p-1", pdf: Buffer.from("x"), changedBy: "u-1" }),
    ).resolves.toEqual({ filled: [], skippedByEditLock: false });
    spy.mockRestore();
  });
});
