/**
 * 周辺地図を入れる・作り直す(2026-11-11)。DB・国土地理院への通信はテストの中で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, audit, fetchTiles, buildMap } = vi.hoisted(() => ({
  db: {
    appraisalDeck: { findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    property: { findUnique: vi.fn() },
  },
  audit: vi.fn(),
  fetchTiles: vi.fn(),
  buildMap: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: audit }));
vi.mock("../map/build", async (orig) => ({
  ...(await orig<typeof import("../map/build")>()),
  fetchGsiTiles: fetchTiles,
  buildMapFromTiles: buildMap,
}));

import { refreshDeckMap, parseDeckMapData } from "../map/refresh";

const MAP = { version: 1, builtAt: "2026-11-11T00:00:00.000Z", ex: 1000, ey: 650, b: [[8, 0, 1, 1, 2, 0, 0, 2]], p: 0, r: [], w: [], v: [], t: [], bh: [], wh: [] };
const IN = { deckId: "d1", propertyId: "p1", userId: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "draft" });
  db.appraisalDeck.count.mockResolvedValue(0);
  db.appraisalDeck.updateMany.mockResolvedValue({ count: 1 });
  db.property.findUnique.mockResolvedValue({ gpsLat: "35.6447123", gpsLng: "139.6992456" });
  fetchTiles.mockResolvedValue([]);
  buildMap.mockReturnValue(MAP);
});

describe("refreshDeckMap", () => {
  it("手動: 物件の座標を中心に作り、下書きに戻す・AuditLog は件数と結果だけ(座標は残さない)", async () => {
    const r = await refreshDeckMap({ ...IN, mode: "manual" });
    expect(r).toEqual({ ok: true, buildings: 1 });
    expect(fetchTiles.mock.calls[0][0]).toEqual({ lat: 35.6447123, lng: 139.6992456 });
    expect(db.appraisalDeck.updateMany).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { mapData: MAP, updatedBy: "u1", status: "draft", confirmedBy: null, confirmedAt: null },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "appraisal_deck_map_build", targetTable: "appraisal_decks", targetId: "d1" }),
    );
    const logged = JSON.stringify(audit.mock.calls);
    expect(logged).not.toContain("35.64");
    expect(logged).not.toContain("139.69");
  });
  it("自動: 地図がもうあれば作らない(担当者が作り直した地図を上書きしない)", async () => {
    db.appraisalDeck.count.mockResolvedValue(1);
    expect(await refreshDeckMap({ ...IN, mode: "auto" })).toEqual({ ok: false, reason: "already_has_map" });
    expect(fetchTiles).not.toHaveBeenCalled();
  });
  it("自動: 状態は変えず、取りに行っている間に地図が作られた・確認済みにされたら足さない(@codex #701)", async () => {
    db.appraisalDeck.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await refreshDeckMap({ ...IN, mode: "auto" })).toEqual({ ok: false, reason: "not_draft" });
    const arg = db.appraisalDeck.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ mapData: MAP });
    expect(arg.where.id).toBe("d1");
    expect(arg.where.status).toBe("draft");
    expect(arg.where.mapData).toBeDefined();
  });
  it("自動: 確認済みの資料には最初から作りに行かない", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "confirmed" });
    expect(await refreshDeckMap({ ...IN, mode: "auto" })).toEqual({ ok: false, reason: "not_draft" });
    expect(fetchTiles).not.toHaveBeenCalled();
    expect(db.appraisalDeck.updateMany).not.toHaveBeenCalled();
  });
  it("座標がない・おかしいときは作らない", async () => {
    db.property.findUnique.mockResolvedValue({ gpsLat: null, gpsLng: null });
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: false, reason: "no_location" });
    db.property.findUnique.mockResolvedValue({ gpsLat: "0", gpsLng: "0" });
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: false, reason: "no_location" });
    expect(fetchTiles).not.toHaveBeenCalled();
    expect(db.appraisalDeck.updateMany).not.toHaveBeenCalled();
  });
  it("取れなければ fetch_failed(資料はそのまま)・ログに座標を出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchTiles.mockRejectedValue(new Error("https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/16/58181/25814.pbf"));
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: false, reason: "fetch_failed" });
    expect(db.appraisalDeck.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/58181|35\.64/);
    warn.mockRestore();
  });
  it("別の物件の資料は not_found", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue(null);
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: false, reason: "not_found" });
    expect(db.appraisalDeck.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", propertyId: "p1" } }));
  });
});

describe("parseDeckMapData(資料に入れる前の形の確認)", () => {
  it("正しい形だけ通す", () => {
    expect(parseDeckMapData(MAP)).toEqual(MAP);
    expect(parseDeckMapData(null)).toBeNull();
    expect(parseDeckMapData({ ...MAP, version: 2 })).toBeNull();
    expect(parseDeckMapData({ ...MAP, b: [["<img>"]] })).toBeNull();
    expect(parseDeckMapData({ ...MAP, lat: 35.6 })).toBeNull();
  });
});
