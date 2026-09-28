import { describe, it, expect } from "vitest";
import { writebackMessages, type WritebackSummary } from "../WritebackNotice";

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

// 物件に保存できなかった理由は1つではない。いつも「他の人が先に更新」と言うと、
// 誰も触っていないのに利用者を不安にさせる。理由ごとに正しい文を出す。
describe("writebackMessages — 保存できなかった理由", () => {
  const base: WritebackSummary = { saved: [], unreadable: [], conflict: true };
  it("理由が無い(古い知らせ)・stale は従来どおり「他の人が先に物件を更新」", () => {
    const stale = ["他の人が先に物件を更新していたため、物件には保存していません(図面は作成済みです)"];
    expect(writebackMessages({ ...base })).toEqual(stale);
    expect(writebackMessages({ ...base, conflictReason: "stale" })).toEqual(stale);
  });
  it("missing_version: 最新の状態を確かめられなかった(開き直せば保存できる)", () => {
    expect(writebackMessages({ ...base, conflictReason: "missing_version" })).toEqual([
      "物件の最新の状態を確かめられなかったため、物件には保存していません(図面は作成済みです)。画面を開き直してから作ると保存できます",
    ]);
  });
  it("building_stale: 他の人が先に棟を更新", () => {
    expect(writebackMessages({ ...base, conflictReason: "building_stale" })).toEqual([
      "他の人が先に棟を更新していたため、物件・棟には保存していません(図面は作成済みです)",
    ]);
  });
  it("building_changed: 部屋の所属する棟が変わっていた", () => {
    expect(writebackMessages({ ...base, conflictReason: "building_changed" })).toEqual([
      "この部屋の所属する棟が変わっていたため、物件・棟には保存していません(図面は作成済みです)",
    ]);
  });
});

// 物件の欄に入る文字数を超えた文は、図面にはそのまま載るが物件には保存しない。
// 「数値や年月として読み取れなかった」は的外れなので、別の文で知らせる。
describe("writebackMessages — 長すぎる欄", () => {
  it("長すぎる欄は専用の文で知らせる", () => {
    expect(
      writebackMessages({ saved: ["価格"], unreadable: [], tooLong: ["交通"], conflict: false }),
    ).toEqual([
      "価格を物件に保存しました",
      "交通は物件の欄に入る文字数を超えているため、物件には保存していません(図面にはそのまま載っています)",
    ]);
  });
  it("tooLong が無い(古い知らせ)でも壊れない", () => {
    expect(writebackMessages({ saved: [], unreadable: [], conflict: false })).toEqual([]);
  });
});
