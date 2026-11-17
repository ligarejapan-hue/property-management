import { describe, expect, it } from "vitest";
import { buildSnapshot, parseSnapshot, shrinkProblem, type BankSnapshot } from "../snapshot";

describe("shrinkProblem(入れ替えで件数が大きく減るときは止める)", () => {
  it("初めて入れるとき・同じくらいなら問題なし", () => {
    expect(shrinkProblem({ banks: 0, branches: 0 }, { banks: 1146, branches: 28944 })).toBeNull();
    expect(shrinkProblem({ banks: 1146, branches: 28944 }, { banks: 1140, branches: 28800 })).toBeNull();
  });
  it("5%を超えて減るなら理由を返す(控えが途中で切れている疑い)", () => {
    expect(shrinkProblem({ banks: 1146, branches: 28944 }, { banks: 1000, branches: 28944 })).toMatch(/金融機関/);
    expect(shrinkProblem({ banks: 1146, branches: 28944 }, { banks: 1146, branches: 20000 })).toMatch(/支店/);
  });
});

const SOURCE_BANKS = {
  "0001": { code: "0001", name: "みずほ", kana: "ミズホ", hira: "みずほ", roma: "mizuho" },
  "1310": { code: "1310", name: "さわやか信金", kana: "サワヤカシンキン", hira: "さわやかしんきん", roma: "sawayakashinkin" },
};
const SOURCE_BRANCHES = {
  "0001": {
    "100": { code: "100", name: "本店", kana: "ホンテン", hira: "ほんてん", roma: "honten" },
    "108": { code: "108", name: "神田", kana: "カンダ", hira: "かんだ", roma: "kanda" },
  },
  "1310": { "101": { code: "101", name: "大森", kana: "オオモリ", hira: "おおもり", roma: "oomori" } },
};
const META = { source: "https://github.com/zengin-code/source-data", commit: "658711c7", updatedAt: "20260824" };

describe("buildSnapshot(元データ → リポジトリに置く控え)", () => {
  it("略称・読み・ローマ字をコードの順に詰めて持つ(正式な形はまだ作らない)", () => {
    const s = buildSnapshot(SOURCE_BANKS, SOURCE_BRANCHES, META);
    expect(s.version).toBe("zengin-20260824-658711c7");
    expect(s.banks).toEqual([
      ["0001", "みずほ", "みずほ", "mizuho", [["100", "本店", "ほんてん", "honten"], ["108", "神田", "かんだ", "kanda"]]],
      ["1310", "さわやか信金", "さわやかしんきん", "sawayakashinkin", [["101", "大森", "おおもり", "oomori"]]],
    ]);
  });
  it("支店のファイルが無い金融機関は支店なし", () => {
    const s = buildSnapshot(SOURCE_BANKS, { "0001": SOURCE_BRANCHES["0001"] }, META);
    expect(s.banks[1][4]).toEqual([]);
  });
  it("コードの形が違う行があれば止める(壊れた元データを入れない)", () => {
    expect(() => buildSnapshot({ "1": { code: "1", name: "x", kana: "", hira: "x", roma: "x" } }, {}, META)).toThrow(/コード/);
    expect(() => buildSnapshot(SOURCE_BANKS, { "0001": { "1": { code: "1", name: "x", kana: "", hira: "x", roma: "x" } } }, META)).toThrow(/コード/);
  });
});

describe("parseSnapshot(控え → 表に入れる行)", () => {
  const snap: BankSnapshot = buildSnapshot(SOURCE_BANKS, SOURCE_BRANCHES, META);

  it("正式な名前と、検索のための読みを作る", () => {
    const r = parseSnapshot(snap);
    expect(r.version).toBe("zengin-20260824-658711c7");
    expect(r.banks).toEqual([
      { code: "0001", name: "みずほ銀行", shortName: "みずほ", kana: "みずほ", roma: "mizuho" },
      { code: "1310", name: "さわやか信用金庫", shortName: "さわやか信金", kana: "さわやかしんきん", roma: "sawayakashinkin" },
    ]);
    expect(r.branches).toEqual([
      { bankCode: "0001", code: "100", name: "本店", shortName: "本店", kana: "ほんてん", roma: "honten" },
      { bankCode: "0001", code: "108", name: "神田支店", shortName: "神田", kana: "かんだ", roma: "kanda" },
      { bankCode: "1310", code: "101", name: "大森支店", shortName: "大森", kana: "おおもり", roma: "oomori" },
    ]);
  });
  it("形の違う控えは止める", () => {
    expect(() => parseSnapshot({} as BankSnapshot)).toThrow();
    expect(() => parseSnapshot({ ...snap, banks: [["01", "x", "x", "x", []]] } as unknown as BankSnapshot)).toThrow();
  });
  it("同じコードが2回あれば止める", () => {
    expect(() => parseSnapshot({ ...snap, banks: [...snap.banks, snap.banks[0]] })).toThrow(/重複/);
  });
});
