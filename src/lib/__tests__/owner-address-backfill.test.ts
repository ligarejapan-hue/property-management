/**
 * 取込による「空欄補完」の規則（設計 §6.3(1)：ペアを分解しない）。
 *
 * ⚠ここが壊れると、郵便番号だけ新しい値・住所は古いまま、という**ズレたペア**ができる。
 * 刷った封筒は「別の場所の郵便番号 + この人の住所」になり、届かないか別人へ届く。
 */
import { describe, it, expect } from "vitest";
import { resolveAddressPairBackfill } from "@/lib/owner-address-backfill";

describe("resolveAddressPairBackfill", () => {
  it("保存済みが両方空なら、取込のペアをそのまま入れる", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: null },
        { zip: "150-0001", address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({ zip: "150-0001", address: "渋谷区神宮前1-1-1" });
  });

  it("保存済みが両方空で取込に住所しか無ければ、住所だけ入れる", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: null },
        { zip: null, address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({ address: "渋谷区神宮前1-1-1" });
  });

  it("同じ宛先なら、空いている郵便番号だけ入れる", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: "渋谷区神宮前1-1-1" },
        { zip: "150-0001", address: " 渋谷区神宮前1-1-1 " },
      ),
    ).toEqual({ zip: "150-0001" });
  });

  it("⚠住所の途中の空白が違うだけでも「別の宛先」として扱う（安全側）", () => {
    // 「渋谷区 神宮前」と「渋谷区神宮前」を同じ場所と決めつけない。
    // このリポの重複判定（normalizeAddress）と同じ基準に揃えてある。
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: "渋谷区神宮前1-1-1" },
        { zip: "150-0001", address: "渋谷区 神宮前1-1-1" },
      ),
    ).toEqual({});
  });

  it("同じ宛先で郵便番号が既に入っていれば、何も入れない（上書きしない）", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: "150-0001", address: "渋谷区神宮前1-1-1" },
        { zip: "231-0842", address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({});
  });

  it("⚠違う宛先なら、郵便番号も住所も入れない（ズレたペアを作らない）", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: "横浜市南区井土ケ谷中町69-2" },
        { zip: "150-0001", address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({});
  });

  it("⚠取込に住所が無いのに保存済みに住所があるときは、郵便番号を入れない", () => {
    // その郵便番号がこの住所のものだという保証がない。
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: "横浜市南区井土ケ谷中町69-2" },
        { zip: "150-0001", address: null },
      ),
    ).toEqual({});
  });

  it("⚠保存済みが郵便番号だけのときは、住所を入れない（相手不明の番号と組ませない）", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: "231-0842", address: null },
        { zip: null, address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({});
  });

  it("取込が空なら何も入れない", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: null, address: null },
        { zip: "   ", address: "" },
      ),
    ).toEqual({});
  });

  it("郵便番号の書き方違いは同じ値として扱う（入れ直さない）", () => {
    expect(
      resolveAddressPairBackfill(
        { zip: "1500001", address: "渋谷区神宮前1-1-1" },
        { zip: "150-0001", address: "渋谷区神宮前1-1-1" },
      ),
    ).toEqual({});
  });
});
