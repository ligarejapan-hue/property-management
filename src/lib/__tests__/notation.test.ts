import { describe, expect, it } from "vitest";
import { containsVariants, halfWidthDigitsInWrite, searchVariants } from "../notation";

describe("検索の書き方の違い", () => {
  it("★ケ・ヶ・がを同じ地名として探す(井土ヶ谷で井土ケ谷が見つかる)", () => {
    const v = searchVariants("井土ヶ谷");
    expect(v).toEqual(expect.arrayContaining(["井土ヶ谷", "井土ケ谷", "井土が谷"]));
    expect(searchVariants("自由が丘")).toEqual(expect.arrayContaining(["自由ケ丘", "自由ヶ丘"]));
  });

  it("★全角と半角の数字を同じものとして探す", () => {
    expect(searchVariants("１番１")).toEqual(expect.arrayContaining(["1番1", "１番１"]));
    expect(searchVariants("1-2")).toEqual(expect.arrayContaining(["1-2", "１－２"]));
  });

  it("★地名と数字の両方を組み合わせる", () => {
    expect(searchVariants("千駄ヶ谷1丁目")).toEqual(expect.arrayContaining(["千駄ケ谷１丁目", "千駄ヶ谷1丁目", "千駄ケ谷1丁目"]));
  });

  it("漢字の後ろでないケ・がは変えない(ケアハウス・ながの を別の語にしない)", () => {
    expect(searchVariants("ケアハウス")).toEqual(["ケアハウス"]);
    expect(searchVariants("ながの")).toEqual(["ながの"]);
  });

  it("違いが無い語はそのまま1つ・重複を出さない", () => {
    expect(searchVariants("渋谷")).toEqual(["渋谷"]);
    const v = searchVariants("井土ヶ谷3丁目");
    expect(new Set(v).size).toBe(v.length);
  });

  it("★数が増えすぎない(3つ目からのケは変えない)", () => {
    expect(searchVariants("井ヶ谷千ヶ谷富ヶ谷").length).toBeLessThanOrEqual(9);
    expect(searchVariants("井ヶ谷千ヶ谷富ヶ谷１").length).toBeLessThanOrEqual(18);
  });

  it("条件にして返す", () => {
    expect(containsVariants("address", "渋谷", "insensitive")).toEqual([{ address: { contains: "渋谷", mode: "insensitive" } }]);
    expect(containsVariants("address", "渋谷")).toEqual([{ address: { contains: "渋谷" } }]);
  });
});

describe("保存する数字を半角に", () => {
  it("★物件の住所・地番・家屋番号・物件名・号室を半角にする", () => {
    const args = { data: { address: "東京都１丁目２－３", lotNumber: "１番１", buildingNumber: "１番１の３", buildingName: "第２ビル", roomNo: "３０５", note: "１２" } };
    expect(halfWidthDigitsInWrite("property", "create", args).data).toEqual({
      address: "東京都1丁目2－3", lotNumber: "1番1", buildingNumber: "1番1の3", buildingName: "第2ビル", roomNo: "305", note: "１２",
    });
  });

  it("★所有者の氏名は変えない・住所と現住所は半角にする", () => {
    const args = { data: { name: "第１商事", address: "１丁目", currentAddress: { set: "２丁目" } } };
    expect(halfWidthDigitsInWrite("owner", "update", args).data).toEqual({ name: "第１商事", address: "1丁目", currentAddress: { set: "2丁目" } });
  });

  it("★まとめての作成・upsert も半角にする", () => {
    expect(halfWidthDigitsInWrite("dealParty", "createMany", { data: [{ address: "１" }, { address: "２" }] }).data).toEqual([{ address: "1" }, { address: "2" }]);
    expect(halfWidthDigitsInWrite("building", "upsert", { where: { id: "x" }, create: { name: "第１", address: "２" }, update: { name: "第３" } })).toEqual({
      where: { id: "x" }, create: { name: "第1", address: "2" }, update: { name: "第3" },
    });
  });

  it("★検索の条件・読み取りは変えない(全角で入っている行を探せなくしない)", () => {
    const args = { where: { address: "１丁目" } };
    expect(halfWidthDigitsInWrite("property", "findFirst", args)).toBe(args);
    const upd = { where: { address: "１丁目" }, data: { address: "２丁目" } };
    expect(halfWidthDigitsInWrite("property", "updateMany", upd)).toEqual({ where: { address: "１丁目" }, data: { address: "2丁目" } });
  });

  it("対象外の表・空の値はそのまま", () => {
    const args = { data: { fileName: "１.pdf" } };
    expect(halfWidthDigitsInWrite("attachment", "create", args)).toBe(args);
    expect(halfWidthDigitsInWrite("property", "update", { data: { address: null } }).data).toEqual({ address: null });
  });
});
