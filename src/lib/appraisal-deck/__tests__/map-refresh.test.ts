/**
 * 周辺地図を入れる・作り直す(2026-11-11)。DB・国土地理院への通信はテストの中で差し替える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, audit, fetchTiles, buildMap, geocode } = vi.hoisted(() => ({
  db: {
    appraisalDeck: { findFirst: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    property: { findUnique: vi.fn() },
  },
  audit: vi.fn(),
  fetchTiles: vi.fn(),
  buildMap: vi.fn(),
  geocode: vi.fn(),
}));
vi.mock("../map/geocode", () => ({ geocodeAddress: geocode }));
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
  db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "draft", extracted: { station: "見本駅" } });
  db.appraisalDeck.count.mockResolvedValue(0);
  db.appraisalDeck.updateMany.mockResolvedValue({ count: 1 });
  db.property.findUnique.mockResolvedValue({ gpsLat: "35.6447123", gpsLng: "139.6992456" });
  fetchTiles.mockResolvedValue([]);
  buildMap.mockReturnValue(MAP);
  geocode.mockResolvedValue(null);
});

describe("refreshDeckMap", () => {
  it("手動: 物件の座標を中心に作り、下書きに戻す・AuditLog は件数と結果だけ(座標は残さない)", async () => {
    const r = await refreshDeckMap({ ...IN, mode: "manual" });
    expect(r).toEqual({ ok: true, buildings: 1 });
    expect(fetchTiles.mock.calls[0][0]).toEqual({ lat: 35.6447123, lng: 139.6992456 });
    expect(db.appraisalDeck.updateMany).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { mapData: { ...MAP, loc: "gps" }, updatedBy: "u1", status: "draft", confirmedBy: null, confirmedAt: null },
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
    expect(arg.data).toEqual({ mapData: { ...MAP, loc: "gps" } });
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
  it("徒歩ルートの行き先に査定書の最寄駅を渡す(2026-11-11)", async () => {
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(buildMap.mock.calls[0][3]).toEqual({ station: "見本駅", extent: { ex: 1000, ey: 650 } });
  });
  it("担当者が最寄駅を直していれば、直した駅へのルートにする(@codex #707)", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "draft", extracted: { station: "見本駅" }, overrides: { station: "別駅" } });
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(buildMap.mock.calls[0][3]).toMatchObject({ station: "別駅" });
  });
  it("GPS 座標があれば住所は調べない(印は物件の建物に付く)", async () => {
    db.property.findUnique.mockResolvedValue({ gpsLat: "35.6447123", gpsLng: "139.6992456", address: "東京都架空区見本町4-5-6" });
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(geocode).not.toHaveBeenCalled();
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].data.mapData).toMatchObject({ loc: "gps", p: 0 });
  });
  it("GPS 座標がなければ住所から求めて作る(目安=物件の建物は塗らない・物件の座標には保存しない・2026-11-11)", async () => {
    db.property.findUnique.mockResolvedValue({ gpsLat: null, gpsLng: null, address: "東京都架空区見本町4-5-6" });
    geocode.mockResolvedValue({ lat: 35.65, lng: 139.7 });
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: true, buildings: 1 });
    expect(geocode.mock.calls[0][0]).toBe("東京都架空区見本町4-5-6");
    expect(fetchTiles.mock.calls[0][0]).toEqual({ lat: 35.65, lng: 139.7 });
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].data.mapData).toMatchObject({ loc: "address", p: -1 });
    expect(db.property).not.toHaveProperty("update");
    const logged = JSON.stringify(audit.mock.calls);
    expect(logged).toContain('"loc":"address"');
    expect(logged).not.toContain("見本町");
    expect(logged).not.toContain("35.65");
  });
  it("座標がなく、住所からも求められないときは作らない", async () => {
    db.property.findUnique.mockResolvedValue({ gpsLat: null, gpsLng: null, address: "東京都架空区見本町4-5-6" });
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: false, reason: "no_location" });
    db.property.findUnique.mockResolvedValue({ gpsLat: "0", gpsLng: "0", address: "" });
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
  it("範囲は周辺施設が入る大きさ(2026-11-12)", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({
      id: "d1",
      status: "draft",
      extracted: { station: "見本駅", facilities: [{ x: -1100, y: 300 }, { x: 0, y: -700 }, { x: null, y: null }] },
    });
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(fetchTiles.mock.calls[0][2]).toEqual({ ex: 1300, ey: 900 });
    expect(buildMap.mock.calls[0][3].extent).toEqual({ ex: 1300, ey: 900 });
  });
  it("駅が範囲の外なら、駅まで広げて取り足し、作り直す(取ったタイルは取り直さない・2026-11-12)", async () => {
    const tiles0 = [{ x: 1, y: 1, buf: null }];
    fetchTiles.mockResolvedValueOnce(tiles0).mockResolvedValueOnce([...tiles0, { x: 1, y: 2, buf: null }]);
    const st = { n: "経堂駅", x: 254, y: 764 };
    buildMap.mockReturnValueOnce({ ...MAP, st, rt: [0, 0, 1, 1], rtm: 891 }).mockReturnValueOnce({ ...MAP, ey: 950, st, rt: [0, 0, 2, 2], rtm: 891 });
    expect(await refreshDeckMap({ ...IN, mode: "manual" })).toEqual({ ok: true, buildings: 1 });
    expect(fetchTiles.mock.calls[1][2]).toEqual({ ex: 1000, ey: 950 });
    expect(fetchTiles.mock.calls[1][3]).toBe(tiles0);
    expect(buildMap.mock.calls[1][3].extent).toEqual({ ex: 1000, ey: 950 });
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].data.mapData).toMatchObject({ ey: 950, st, rt: [0, 0, 2, 2] });
  });
  it("駅が範囲の中なら広げない", async () => {
    buildMap.mockReturnValue({ ...MAP, st: { n: "見本駅", x: 200, y: 300 }, rt: [0, 0], rtm: 400 });
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(fetchTiles).toHaveBeenCalledTimes(1);
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].data.mapData.st).toEqual({ n: "見本駅", x: 200, y: 300 });
  });
  it("広げても地図に収まらない遠い駅には徒歩ルートを付けない(地図の外を写さない)", async () => {
    const far = { ...MAP, st: { n: "遠い駅", x: 0, y: 1900 }, rt: [0, 0], rtm: 2100 };
    buildMap.mockReturnValueOnce(far).mockReturnValueOnce({ ...far, ey: 1300 });
    await refreshDeckMap({ ...IN, mode: "manual" });
    expect(fetchTiles.mock.calls[1][2]).toEqual({ ex: 1600, ey: 1300 });
    const saved = db.appraisalDeck.updateMany.mock.calls[0][0].data.mapData;
    expect(saved.st).toBeUndefined();
    expect(saved.rt).toBeUndefined();
    expect(saved.rtm).toBeUndefined();
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
    expect(parseDeckMapData({ ...MAP, loc: "address" })).toMatchObject({ loc: "address" });
    expect(parseDeckMapData({ ...MAP, loc: "<x>" })).toBeNull();
    expect(parseDeckMapData({ ...MAP, st: { n: "見本駅", x: 1, y: -2 }, rt: [0, 0, 2, 2], rtm: 120 })).toMatchObject({ rtm: 120 });
    expect(parseDeckMapData({ ...MAP, st: { n: "x", x: 1, y: 2, lat: 35 } })).toBeNull();
  });
});
