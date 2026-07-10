import { describe, it, expect } from "vitest";
import * as M from "../option-master";

describe("option-master", () => {
  it("御社Excel準拠の選択肢を持つ", () => {
    expect(M.USE_DISTRICT).toContain("第一種低層住居専用地域");
    expect(M.USE_DISTRICT).toContain("近隣商業地域");
    expect(M.USE_DISTRICT.length).toBe(13);
    expect(M.BUILDING_STRUCTURE).toEqual([
      "木造","ブロック","鉄骨造","RC","SRC","PC","HPC","軽量鉄骨","その他",
    ]);
    expect(M.AREA_METHOD_MANSION).toEqual(["壁芯","内法"]);
    expect(M.MANAGEMENT_FORM).toEqual(["自主管理","一部委託","全部委託"]);
    expect(M.MANAGER_STATUS).toEqual(["常駐","日勤","巡回"]);
    expect(M.PARKING_MANSION).toEqual(["空有","空無","近隣確保","無"]);
    expect(M.TAX).toEqual(["課税","不課税"]);
    expect(M.PRESENCE).toEqual(["あり","なし"]);
    expect(M.LAND_CATEGORY).toContain("宅地");
    expect(M.CITY_PLANNING).toContain("市街化区域");
    expect(M.AREA_ZONE).toContain("防火");
  });

  it("F2売土地分の選択肢を持つ", () => {
    expect(M.PROPERTY_TYPE_LAND).toEqual(["売地", "借地権", "底地権"]);
    expect(M.BEST_USE_LAND).toEqual([
      "住宅用地", "マンション用地", "店舗用地", "事務所用地", "工業用地", "その他",
    ]);
    expect(M.AREA_METHOD_LAND).toEqual(["公簿", "実測"]);
    expect(M.SETBACK_UNIT).toEqual(["m", "㎡"]);
    expect(M.DIRECTION).toEqual(["北", "北東", "東", "南東", "南", "南西", "西", "北西"]);
    expect(M.DIRECTION.length).toBe(8);
    expect(M.LAND_ACT_NOTICE).toEqual(["要", "届出中", "不要"]);
    expect(M.OCCUPANCY_LAND).toEqual(["更地", "上物有"]);
  });

  it("F2売戸建分の選択肢を持つ", () => {
    expect(M.PROPERTY_TYPE_HOUSE).toEqual([
      "新築戸建", "中古戸建", "新築テラスハウス", "中古テラスハウス",
    ]);
    expect(M.BUILDING_CONFIRM).toEqual(["済", "申請中"]);
    expect(M.PARKING_HOUSE).toEqual(["有", "無", "近隣確保"]);
    expect(M.REBUILD_STATUS).toEqual(["再建築可", "再建築不可"]);
  });

  it("F2一棟分の選択肢を持つ", () => {
    expect(M.PROPERTY_TYPE_BUILDING).toEqual([
      "新築一棟マンション", "中古一棟マンション", "新築一棟アパート", "中古一棟アパート", "一棟ビル", "その他",
    ]);
  });
});
