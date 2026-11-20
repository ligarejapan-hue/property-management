import { describe, expect, it, vi } from "vitest";
import { deleteDocumentFiles, keepsAllVersions, pruneOlderVersionRows } from "../prune-old-versions";

const T = { dealId: "d1", docType: "settlement_guide", variant: "default", keepVersion: 3 };
const rows = [
  { id: "a", version: 2, pdfKey: "deals/d1/a.pdf", xlsxKey: "deals/d1/a.xlsx" },
  { id: "b", version: 1, pdfKey: "deals/d1/b.pdf", xlsxKey: null },
];
const fakeDb = (found = rows) => ({
  dealDocument: { findMany: vi.fn(async (_args: { where: unknown }) => found), deleteMany: vi.fn(async (_args: unknown) => ({ count: found.length })) },
});

describe("発行の履歴は書類ごとに最新版だけ残す(2026-11-20 発注者)", () => {
  it("今の版より古い同じ書類(種類+書き分け)の記録を消し、あとで消すファイルの鍵を返す", async () => {
    const db = fakeDb();
    const out = await pruneOlderVersionRows(db, T);
    expect(db.dealDocument.findMany.mock.calls[0][0].where).toEqual({ dealId: "d1", docType: "settlement_guide", variant: "default", version: { lt: 3 } });
    expect(db.dealDocument.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] }, dealId: "d1" } });
    expect(out).toEqual({ versions: [1, 2], fileKeys: ["deals/d1/a.pdf", "deals/d1/a.xlsx", "deals/d1/b.pdf"] });
  });
  it("領収書(手付金・残金・精算金)は全部の版を残す", async () => {
    for (const k of ["deposit_receipt", "balance_receipt", "settlement_receipt"]) {
      expect(keepsAllVersions(k)).toBe(true);
      const db = fakeDb();
      expect(await pruneOlderVersionRows(db, { ...T, docType: k })).toEqual({ versions: [], fileKeys: [] });
      expect(db.dealDocument.findMany).not.toHaveBeenCalled();
      expect(db.dealDocument.deleteMany).not.toHaveBeenCalled();
    }
    expect(keepsAllVersions("settlement_guide")).toBe(false);
    expect(keepsAllVersions("key_receipt")).toBe(false);
  });
  it("古い版が無ければ何も消さない", async () => {
    const db = fakeDb([]);
    expect(await pruneOlderVersionRows(db, T)).toEqual({ versions: [], fileKeys: [] });
    expect(db.dealDocument.deleteMany).not.toHaveBeenCalled();
  });
  it("ファイルが消せなくても止めず、数を返す", async () => {
    const storage = { delete: vi.fn(async (_k: string) => undefined) };
    storage.delete.mockRejectedValueOnce(new Error("gone"));
    expect(await deleteDocumentFiles(storage, ["x", "y"])).toBe(1);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });
});
