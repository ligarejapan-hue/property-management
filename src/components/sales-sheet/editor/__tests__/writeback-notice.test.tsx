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

// [@codex P2] 棟に紐づいていない区分では、棟の列へ入る項目(築年月・地下階)は行き先が無い。
// 「保存した」とも「読めなかった」とも言わないまま値だけ消えるのを防ぐ。
describe("writebackMessages — 保存先が無い項目(@codex P2)", () => {
  it("棟に紐づいていないため保存していない、と伝える", () => {
    expect(
      writebackMessages({
        saved: ["価格"],
        unreadable: [],
        noTarget: ["地下階", "築年月"],
        conflict: false,
      }),
    ).toEqual([
      "価格を物件に保存しました",
      "地下階・築年月は棟に保存する項目ですが、この物件は棟に紐づいていないため保存していません",
    ]);
  });

  it("noTarget が空なら何も足さない", () => {
    expect(
      writebackMessages({ saved: ["価格"], unreadable: [], noTarget: [], conflict: false }),
    ).toEqual(["価格を物件に保存しました"]);
  });

  it("反映前に作られた知らせ(noTarget が無い)でも壊れない", () => {
    expect(writebackMessages({ saved: ["価格"], unreadable: [], conflict: false })).toEqual([
      "価格を物件に保存しました",
    ]);
  });
});
