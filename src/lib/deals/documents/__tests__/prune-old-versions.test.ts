import { describe, expect, it, vi } from "vitest";
import { keepsAllVersions, pruneOlderVersions } from "../prune-old-versions";

const T = { dealId: "d1", docType: "settlement_guide", variant: "default", keepVersion: 3 };
const rows = [
  { id: "a", version: 2, pdfKey: "deals/d1/a.pdf", xlsxKey: "deals/d1/a.xlsx" },
  { id: "b", version: 1, pdfKey: "deals/d1/b.pdf", xlsxKey: null },
];
const fakes = (found = rows) => ({
  db: { dealDocument: { findMany: vi.fn(async (_args: { where: unknown }) => found), deleteMany: vi.fn(async (_args: unknown) => ({ count: found.length })) } },
  storage: { delete: vi.fn(async (_key: string) => undefined) },
});

describe("発行の履歴は書類ごとに最新版だけ残す(2026-11-20 発注者)", () => {
  it("今の版より古い同じ書類(種類+書き分け)の記録を消し、そのあとファイルを消す", async () => {
    const { db, storage } = fakes();
    const out = await pruneOlderVersions(db, storage, T);
    expect(db.dealDocument.findMany.mock.calls[0][0].where).toEqual({ dealId: "d1", docType: "settlement_guide", variant: "default", version: { lt: 3 } });
    expect(db.dealDocument.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] }, dealId: "d1" } });
    expect(storage.delete.mock.calls.map((c) => c[0]).sort()).toEqual(["deals/d1/a.pdf", "deals/d1/a.xlsx", "deals/d1/b.pdf"]);
    expect(out).toEqual({ versions: [1, 2], fileErrors: 0 });
    // 記録を先に消す(ファイルが先に消えて、記録だけ残る形にしない)
    expect(db.dealDocument.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(storage.delete.mock.invocationCallOrder[0]);
  });
  it("領収書(手付金・残金・精算金)は全部の版を残す", async () => {
    for (const k of ["deposit_receipt", "balance_receipt", "settlement_receipt"]) {
      expect(keepsAllVersions(k)).toBe(true);
      const { db, storage } = fakes();
      expect(await pruneOlderVersions(db, storage, { ...T, docType: k })).toEqual({ versions: [], fileErrors: 0 });
      expect(db.dealDocument.findMany).not.toHaveBeenCalled();
      expect(db.dealDocument.deleteMany).not.toHaveBeenCalled();
    }
    expect(keepsAllVersions("settlement_guide")).toBe(false);
    expect(keepsAllVersions("key_receipt")).toBe(false);
  });
  it("古い版が無ければ何も消さない", async () => {
    const { db, storage } = fakes([]);
    expect(await pruneOlderVersions(db, storage, T)).toEqual({ versions: [], fileErrors: 0 });
    expect(db.dealDocument.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it("ファイルが消せなくても止めず、数を返す", async () => {
    const { db, storage } = fakes();
    storage.delete.mockRejectedValueOnce(new Error("gone"));
    expect((await pruneOlderVersions(db, storage, T)).fileErrors).toBe(1);
  });
});
