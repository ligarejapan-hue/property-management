import { describe, it, expect } from "vitest";
import {
  planRegistryNameSearch,
  jstDayRangeUtc,
} from "../registry-name-search";
import { registryDisplayName } from "../registry-display-name";

describe("planRegistryNameSearch（画面に出ている名前でも探せるようにする）", () => {
  it("「謄本」だけなら、自動取得の謄本すべてが対象", () => {
    expect(planRegistryNameSearch("謄本")).toEqual({
      certificateTypes: ["owner", "all"],
      jstDate: null,
    });
  });

  it("種別まで入れると、その種別だけに絞る", () => {
    expect(planRegistryNameSearch("所有者事項")).toEqual({
      certificateTypes: ["owner"],
      jstDate: null,
    });
    expect(planRegistryNameSearch("謄本(全部事項)")).toEqual({
      certificateTypes: ["all"],
      jstDate: null,
    });
  });

  it("日付だけでも探せる", () => {
    expect(planRegistryNameSearch("2026-08-25")).toEqual({
      certificateTypes: ["owner", "all"],
      jstDate: "2026-08-25",
    });
  });

  it("画面に出ている名前をそのまま貼り付けても当たる", () => {
    const shown = registryDisplayName("owner", new Date("2026-08-25T03:00:00.000Z"));
    expect(shown).toBe("謄本(所有者事項)_2026-08-25.pdf");
    expect(planRegistryNameSearch(shown)).toEqual({
      certificateTypes: ["owner"],
      jstDate: "2026-08-25",
    });
    const shownAll = registryDisplayName("all", new Date("2026-08-25T03:00:00.000Z"));
    expect(planRegistryNameSearch(shownAll)).toEqual({
      certificateTypes: ["all"],
      jstDate: "2026-08-25",
    });
  });

  it("種別の記録が無い分の表示名（謄本_日付.pdf）も当たる", () => {
    const shown = registryDisplayName(null, new Date("2026-08-25T03:00:00.000Z"));
    expect(shown).toBe("謄本_2026-08-25.pdf");
    expect(planRegistryNameSearch(shown)).toEqual({
      certificateTypes: ["owner", "all"],
      jstDate: "2026-08-25",
    });
  });

  it("表示名と関係ない語は、この上乗せの対象にしない（生の名前の検索だけが効く）", () => {
    expect(planRegistryNameSearch("世田谷区")).toBeNull();
    expect(planRegistryNameSearch("見積書")).toBeNull();
    expect(planRegistryNameSearch("registry-auto-2024")).toBeNull();
    expect(planRegistryNameSearch("謄本X")).toBeNull();
    expect(planRegistryNameSearch("所有者事項の控え")).toBeNull();
  });

  it("空・空白だけのときは何もしない", () => {
    expect(planRegistryNameSearch("")).toBeNull();
    expect(planRegistryNameSearch("   ")).toBeNull();
  });

  it("実在しない日付は日付として扱わない", () => {
    expect(planRegistryNameSearch("2026-99-99")).toBeNull();
    expect(planRegistryNameSearch("謄本_2026-02-31.pdf")).toBeNull();
  });

  it("大文字小文字は .pdf の部分だけ揺れても当たる", () => {
    expect(planRegistryNameSearch("謄本(所有者事項)_2026-08-25.PDF")).toEqual({
      certificateTypes: ["owner"],
      jstDate: "2026-08-25",
    });
  });
});

describe("jstDayRangeUtc（日本時間の1日を、保存されている時刻の範囲へ直す）", () => {
  it("日本時間の0時〜24時を、UTCの前日15時〜当日15時にする", () => {
    expect(jstDayRangeUtc("2026-08-25")).toEqual({
      gte: new Date("2026-08-24T15:00:00.000Z"),
      lt: new Date("2026-08-25T15:00:00.000Z"),
    });
  });

  it("その日の端の時刻が、ちゃんと範囲に入る／外れる", () => {
    const { gte, lt } = jstDayRangeUtc("2026-08-25")!;
    // JST 2026-08-25 00:00:00 = UTC 2026-08-24 15:00:00
    expect(new Date("2026-08-24T15:00:00.000Z") >= gte).toBe(true);
    // JST 2026-08-24 23:59:59 は前日なので範囲外
    expect(new Date("2026-08-24T14:59:59.000Z") >= gte).toBe(false);
    // JST 2026-08-26 00:00:00 は翌日なので範囲外
    expect(new Date("2026-08-25T15:00:00.000Z") < lt).toBe(false);
  });

  it("月またぎ・年またぎでもずれない", () => {
    expect(jstDayRangeUtc("2026-01-01")).toEqual({
      gte: new Date("2025-12-31T15:00:00.000Z"),
      lt: new Date("2026-01-01T15:00:00.000Z"),
    });
  });

  it("読めない日付は null", () => {
    expect(jstDayRangeUtc("2026-99-99")).toBeNull();
    expect(jstDayRangeUtc("")).toBeNull();
  });
});
