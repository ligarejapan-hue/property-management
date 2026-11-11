/**
 * 住所から地図の中心を求める(国土地理院の住所検索・2026-11-11)。通信はテストの中で差し替える。
 */
import { describe, it, expect, vi } from "vitest";
import { geocodeAddress } from "../map/geocode";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status === 200, status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer }));

describe("geocodeAddress", () => {
  it("国土地理院の住所検索だけに問い合わせ、最初の結果の座標を返す", async () => {
    const f = reply(200, [{ geometry: { coordinates: [139.7, 35.65] }, properties: { title: "東京都架空区見本町四丁目" } }]);
    expect(await geocodeAddress(" 東京都架空区見本町4-5-6 ", f)).toEqual({ lat: 35.65, lng: 139.7 });
    const url = (f.mock.calls[0] as unknown as [string])[0];
    expect(url.startsWith("https://msearch.gsi.go.jp/address-search/AddressSearch?q=")).toBe(true);
    expect(decodeURIComponent(url.split("q=")[1])).toBe("東京都架空区見本町4-5-6");
  });
  it("見つからない・失敗・おかしな座標は null(資料は地図なし)", async () => {
    expect(await geocodeAddress("x", reply(200, []))).toBeNull();
    expect(await geocodeAddress("x", reply(500, []))).toBeNull();
    expect(await geocodeAddress("x", reply(200, [{ geometry: { coordinates: [0, 0] } }]))).toBeNull();
    expect(await geocodeAddress("x", reply(200, { error: 1 }))).toBeNull();
    expect(await geocodeAddress("x", vi.fn(async () => { throw new Error("net"); }))).toBeNull();
  });
  it("住所がなければ問い合わせない", async () => {
    const f = reply(200, []);
    expect(await geocodeAddress("  ", f)).toBeNull();
    expect(await geocodeAddress(null, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
