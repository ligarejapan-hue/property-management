/**
 * Google ドライブ連携(第2段 2a): フォルダ名からアプリの物件の候補を出す純関数。
 * 根拠の無い候補は出さない(誤リンク事故の教訓)。
 */
import { describe, it, expect } from "vitest";
import { parseFolderName, matchFolderToProperties, normalizeNameForMatch, type MatchableProperty } from "../folder-match";

describe("parseFolderName(フォルダ名 → 建物名と号室)", () => {
  it.each([
    ["ハマイハイライズ 305", "ハマイハイライズ", "305"],
    ["西荻リリエンハイム　407号室", "西荻リリエンハイム", "407"],
    ["ライオンズマンション目黒 1203号", "ライオンズマンション目黒", "1203"],
    ["コスモ上野　２０１", "コスモ上野", "201"],
    ["流山市鰭ヶ崎2丁目土地戸建", "流山市鰭ヶ崎2丁目土地戸建", null],
    ["パークハウス", "パークハウス", null],
  ])("%s → %s / %s", (name, building, room) => {
    expect(parseFolderName(name)).toEqual({ buildingName: building, roomNo: room });
  });
  it("空・空白だけは建物名も空", () => {
    expect(parseFolderName("  ")).toEqual({ buildingName: "", roomNo: null });
  });
});

describe("normalizeNameForMatch", () => {
  it("全角英数・空白・長音・『マンション』などの揺れを吸収する", () => {
    expect(normalizeNameForMatch("ハマイ ハイライズ")).toBe(normalizeNameForMatch("ハマイハイライズ"));
    expect(normalizeNameForMatch("コスモ上野　２０１")).toBe(normalizeNameForMatch("コスモ上野201"));
    expect(normalizeNameForMatch("パークハウス")).toBe(normalizeNameForMatch("ﾊﾟｰｸﾊｳｽ"));
  });
});

const props: MatchableProperty[] = [
  { id: "p1", buildingName: "ハマイハイライズ", roomNo: "305", address: "東京都大田区大森北1-2-3" },
  { id: "p2", buildingName: "ハマイハイライズ", roomNo: "1203", address: "東京都大田区大森北1-2-3" },
  { id: "p3", buildingName: "西荻リリエンハイム", roomNo: "407", address: "東京都杉並区西荻北2-3-4" },
  { id: "p4", buildingName: null, roomNo: null, address: "千葉県流山市鰭ヶ崎2丁目15-6" },
  { id: "p5", buildingName: "コスモ上野", roomNo: null, address: "東京都台東区上野1-1" },
];

describe("matchFolderToProperties(候補と根拠)", () => {
  it("建物名と号室が一致 → name_room(先頭)。同じ建物の別の部屋は name", () => {
    const r = matchFolderToProperties(parseFolderName("ハマイハイライズ 305"), props);
    expect(r.map((c) => [c.propertyId, c.reason])).toEqual([
      ["p1", "name_room"],
      ["p2", "name"],
    ]);
  });
  it("号室が無いフォルダは建物名一致だけ(name)", () => {
    const r = matchFolderToProperties(parseFolderName("コスモ上野"), props);
    expect(r.map((c) => [c.propertyId, c.reason])).toEqual([["p5", "name"]]);
  });
  it("建物名が無い物件(戸建・土地)は所在地の町名の一致 → address", () => {
    const r = matchFolderToProperties(parseFolderName("流山市鰭ヶ崎2丁目土地戸建"), props);
    expect(r.map((c) => [c.propertyId, c.reason])).toEqual([["p4", "address"]]);
  });
  it("★根拠が無ければ候補ゼロ(似た名前でも推測しない)", () => {
    expect(matchFolderToProperties(parseFolderName("ハマイ"), props)).toEqual([]);
    expect(matchFolderToProperties(parseFolderName("売却"), props)).toEqual([]);
    expect(matchFolderToProperties(parseFolderName(""), props)).toEqual([]);
  });
  it("号室だけ違う(305 vs 1203)を『部屋一致』にしない", () => {
    const r = matchFolderToProperties(parseFolderName("ハマイハイライズ 1203号室"), props);
    expect(r[0]).toMatchObject({ propertyId: "p2", reason: "name_room" });
  });
});
