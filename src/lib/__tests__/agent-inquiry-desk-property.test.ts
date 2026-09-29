import { describe, it, expect } from "vitest";
import { townOnly, toDeskProperty, DESK_PROPERTY_KEYS, DESK_PROPERTY_SELECT } from "@/lib/agent-inquiry/desk-property";
import { toInquiryView, INQUIRY_LIST_SELECT } from "@/lib/agent-inquiry/inquiry-view";

describe("町名までに切り落とす(設計 §4)", () => {
  it.each([
    ["東京都中野区中野2丁目3-4", "東京都中野区中野2丁目"],
    ["東京都中野区中野二丁目3番4号", "東京都中野区中野二丁目"],
    ["東京都中野区本町３－１－２", "東京都中野区本町"],
    ["東京都青梅市今寺123番地", "東京都青梅市今寺"],
    ["東京都青梅市今寺", "東京都青梅市今寺"],
    ["", ""],
    // 漢数字の番地も落とす(レビュー Important 1=番地が現地スタッフへ漏れていた)
    ["東京都中野区本町三ー一ー二", "東京都中野区本町"],
    ["東京都中野区本町三の五", "東京都中野区本町"],
    ["東京都青梅市今寺千二十番地", "東京都青梅市今寺"],
    ["東京都青梅市今寺一〇二番", "東京都青梅市今寺"],
    ["東京都青梅市今寺百二十三番地の四", "東京都青梅市今寺"],
    // 後ろに何も付かない漢数字の番地も落とす(@codex #454 P1)
    ["東京都青梅市今寺一〇二", "東京都青梅市今寺"],
    ["東京都青梅市今寺百二十 ハイツ青梅", "東京都青梅市今寺"],
    // 建物名が続けて付いていても落とす(@codex #454 R2 P1)=市区より後ろは数字が出たら切る(安全側)
    ["東京都青梅市今寺一〇二ハイツ青梅", "東京都青梅市今寺"],
    ["東京都中野区本町三番地の五コーポ", "東京都中野区本町"],
    ["神奈川県横浜市中区本町一ノ二", "神奈川県横浜市中区本町"],
    ["東京都西多摩郡瑞穂町箱根ケ崎百二十", "東京都西多摩郡瑞穂町箱根ケ崎"],
    ["京都府京都市上京区一条通", "京都府京都市上京区"],
    // 大字(壱弐参)も数字として落とす・数字が読めなくても「番地/番/号」の手前で切る(@codex #454 R10)
    ["東京都青梅市今寺壱弐参番地", "東京都青梅市今寺"],
    ["東京都青梅市今寺拾五", "東京都青梅市今寺"],
    ["東京都青梅市今寺廿番地", "東京都青梅市今寺"],
    ["東京都青梅市今寺ⅩⅡ号", "東京都青梅市今寺"],
    // 市区町村名の数字は切らない
    ["三重県四日市市諏訪町5", "三重県四日市市諏訪町"],
    ["東京都三鷹市下連雀三ー四", "東京都三鷹市下連雀"],
    // 数字を含む町名は切らない
    ["東京都千代田区三番町5-6", "東京都千代田区三番町"],
    ["東京都八王子市元本郷町一丁目", "東京都八王子市元本郷町一丁目"],
    ["新潟県十日町市本町二の3", "新潟県十日町市本町"],
  ])("%s → %s", (a, want) => expect(townOnly(a)).toBe(want));
});

describe("受付の窓に返す物件は許可リストだけ", () => {
  const row = {
    id: "p1", propertyType: "apartment_unit", buildingName: null, roomNo: "305",
    address: "東京都中野区中野2丁目3-4",
    building: { name: "サンライズ中野" },
    adPermissions: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: "ng" }],
  };
  it("棟名を物件名に・町名まで・広告の可否を媒体→値に", () => {
    expect(toDeskProperty(row)).toEqual({
      id: "p1", name: "サンライズ中野", roomNo: "305", town: "東京都中野区中野2丁目",
      propertyType: "apartment_unit", adPermissions: { athome: "ok", flyer: "ng" },
    });
  });
  it("物件名も棟名も無い(戸建・土地)は町名を名前にする", () => {
    expect(toDeskProperty({ ...row, building: null, roomNo: null }).name).toBe("東京都中野区中野2丁目");
  });
  it("余計な列が混ざっても返さない(キー集合が完全一致)", () => {
    const out = toDeskProperty({ ...row, salePrice: 1, lotNumber: "1-2", note: "x", owners: [{ name: "所有者" }] } as never);
    expect(Object.keys(out).sort()).toEqual([...DESK_PROPERTY_KEYS].sort());
  });
  it("DB から読む列も許可リストに必要なものだけ", () => {
    expect(Object.keys(DESK_PROPERTY_SELECT).sort()).toEqual(["address", "adPermissions", "building", "buildingName", "id", "propertyType", "roomNo"].sort());
  });
  it("反響の形でも物件は許可リストだけ", () => {
    const v = toInquiryView({ id: "i", property: { ...row, salePrice: 9, createdBy: "u" } } as never);
    expect(Object.keys(v.property).sort()).toEqual([...DESK_PROPERTY_KEYS].sort());
  });
});

describe("画面が変更に使う版番号を返す(@codex #454 R4)", () => {
  it("反響の一覧・詳細は反響と各内見の version を返す", () => {
    expect(INQUIRY_LIST_SELECT.version).toBe(true);
    expect(INQUIRY_LIST_SELECT.viewings.select.version).toBe(true);
  });
});
