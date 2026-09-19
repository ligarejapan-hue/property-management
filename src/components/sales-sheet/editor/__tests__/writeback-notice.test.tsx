import { describe, it, expect } from "vitest";
import { writebackMessages } from "../WritebackNotice";

describe("writebackMessages — 知らせの文言", () => {
  it("保存できた項目を並べる", () => {
    expect(writebackMessages({ saved: ["価格", "交通"], unreadable: [], conflict: false })).toEqual([
      "価格・交通を物件に保存しました",
    ]);
  });
  it("他の人が先に更新していたとき", () => {
    expect(writebackMessages({ saved: [], unreadable: [], conflict: true })).toEqual([
      "他の人が先に物件を更新していたため、物件には保存していません(図面は作成済みです)",
    ]);
  });
  it("読み取れなかった項目", () => {
    expect(writebackMessages({ saved: ["交通"], unreadable: ["価格", "築年月"], conflict: false })).toEqual([
      "交通を物件に保存しました",
      "価格・築年月は数値や年月として読み取れなかったため、物件には保存していません",
    ]);
  });
  it("何も無ければ空", () => {
    expect(writebackMessages({ saved: [], unreadable: [], conflict: false })).toEqual([]);
  });
});
