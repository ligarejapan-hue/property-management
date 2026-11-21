/**
 * ドライブの物件フォルダの自動の紐づけ(2026-11-21 発注者決定: 建物名+号室が1件だけのときだけ)。
 */
import { describe, it, expect } from "vitest";
import { autoLinkDue, AUTO_LINK_INTERVAL_MS, planAutoLinks, unlinkedPropertyIds } from "../auto-link";
import type { MatchableProperty } from "../folder-match";

const P = (id: string, buildingName: string | null, roomNo: string | null, address = "東京都杉並区西荻北1丁目1"): MatchableProperty => ({ id, buildingName, roomNo, address });
const props = [
  P("p1", "西荻リリエンハイム", "407"),
  P("p2", "西荻リリエンハイム", "305"),
  P("p3", "ハマイハイライズ", "305"),
  P("p4", "コスモ上野", "201"),
  P("p5", "コスモ上野", "201"), // 同じ建物名+号室の物件が2つ
  P("p6", "パークハウス", null),
  P("p7", null, null, "千葉県流山市鰭ヶ崎2丁目1"),
];
const none = new Set<string>();
const plan = (folders: { id: string; name: string }[], o: { linkedP?: string[]; linkedF?: string[]; excluded?: string[] } = {}) =>
  planAutoLinks({
    folders,
    properties: props,
    linkedPropertyIds: new Set(o.linkedP ?? []),
    linkedFolderIds: new Set(o.linkedF ?? []),
    excludedPropertyIds: new Set(o.excluded ?? []),
  });

describe("planAutoLinks", () => {
  it("建物名+号室が物件1件とぴったり合うフォルダだけ(全角の空白・号室の書き方の揺れは吸収)", () => {
    expect(plan([{ id: "f1", name: "西荻リリエンハイム　407号室" }, { id: "f2", name: "ハマイハイライズ 305" }])).toEqual([
      { folderId: "f1", propertyId: "p1" },
      { folderId: "f2", propertyId: "p3" },
    ]);
  });

  it("号室が無い・建物名だけ・町名だけのフォルダは自動にしない(人が決める)", () => {
    expect(plan([{ id: "f1", name: "パークハウス" }, { id: "f2", name: "流山市鰭ヶ崎2丁目土地戸建" }, { id: "f3", name: "西荻リリエンハイム" }])).toEqual([]);
  });

  it("号室が物件と違えば自動にしない", () => {
    expect(plan([{ id: "f1", name: "西荻リリエンハイム 999" }])).toEqual([]);
  });

  it("同じ建物名+号室の物件が2つあれば自動にしない", () => {
    expect(plan([{ id: "f1", name: "コスモ上野 201" }])).toEqual([]);
  });

  it("同じ物件に合うフォルダが2つあれば、どちらも自動にしない", () => {
    expect(plan([{ id: "f1", name: "ハマイハイライズ 305" }, { id: "f2", name: "ハマイハイライズ　305号室" }])).toEqual([]);
  });

  it("紐づけ済みの物件・フォルダ、外したことのある物件は自動にしない", () => {
    const fs = [{ id: "f1", name: "西荻リリエンハイム 407" }, { id: "f2", name: "ハマイハイライズ 305" }, { id: "f3", name: "西荻リリエンハイム 305" }];
    expect(plan(fs, { linkedP: ["p1"], linkedF: ["f2"], excluded: ["p2"] })).toEqual([]);
  });

  it("中のフォルダ(仕入/販売・〜契約・写真)は物件フォルダとして扱わない", () => {
    expect(plan([{ id: "f1", name: "売却契約 305" }, { id: "f2", name: "販売" }, { id: "f3", name: "写真 407" }])).toEqual([]);
  });

  it("並びはフォルダの id 順(毎回同じ)", () => {
    expect(plan([{ id: "fz", name: "ハマイハイライズ 305" }, { id: "fa", name: "西荻リリエンハイム 407" }]).map((p) => p.folderId)).toEqual(["fa", "fz"]);
  });

  it("フォルダが無ければ空", () => {
    expect(planAutoLinks({ folders: [], properties: props, linkedPropertyIds: none, linkedFolderIds: none, excludedPropertyIds: none })).toEqual([]);
  });
});

describe("unlinkedPropertyIds(紐づけを外した記録から物件の id)", () => {
  it("propertyId の文字だけを拾う(形の違う detail は無視)", () => {
    expect([...unlinkedPropertyIds([{ propertyId: "p1" }, null, "x", { propertyId: 3 }, { other: "p9" }, { propertyId: "p2" }])]).toEqual(["p1", "p2"]);
  });
});

describe("autoLinkDue(1時間に1回)", () => {
  it("前回から1時間たったら", () => {
    expect(autoLinkDue(0, AUTO_LINK_INTERVAL_MS)).toBe(true);
    expect(autoLinkDue(1000, 1000 + AUTO_LINK_INTERVAL_MS - 1)).toBe(false);
  });
});
