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
});
