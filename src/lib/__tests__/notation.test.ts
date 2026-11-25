import { describe, expect, it } from "vitest";
import { containsVariants, displayHalfWidth, halfWidthDigitsInWrite, savedTextValue, searchVariants, toHalfWidthAddress } from "../notation";
import { buildChangeLogEntries } from "../change-log";

describe("検索の書き方の違い", () => {
  it("★ケ・ヶ・がを同じ地名として探す(井土ヶ谷で井土ケ谷が見つかる)", () => {
    const v = searchVariants("井土ヶ谷");
    expect(v).toEqual(expect.arrayContaining(["井土ヶ谷", "井土ケ谷", "井土が谷"]));
    expect(searchVariants("自由が丘")).toEqual(expect.arrayContaining(["自由ケ丘", "自由ヶ丘"]));
  });

  it("★打った字は必ず候補に残す(ヵ も)", () => {
    expect(searchVariants("三ヵ月ビル")).toEqual(expect.arrayContaining(["三ヵ月ビル", "三ケ月ビル", "三ヶ月ビル"]));
  });

  it("★全角と半角の数字を同じものとして探す", () => {
    expect(searchVariants("１番１")).toEqual(expect.arrayContaining(["1番1", "１番１"]));
    expect(searchVariants("1-2")).toEqual(expect.arrayContaining(["1-2", "１－２"]));
  });

  it("★保存した形でも見つかる(「１－２」は数字だけ半角の「1－2」で入る)", () => {
    const saved = halfWidthDigitsInWrite("property", "create", { data: { address: "東京都１－２" } }).data.address;
    expect(saved).toBe("東京都1-2");
    expect(searchVariants("東京都１－２")).toContain(saved);
    expect(searchVariants("東京都1-2")).toContain("東京都１－２");
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
    expect(searchVariants("井ヶ谷千ヶ谷富ヶ谷１－２").length).toBeLessThanOrEqual(90);
  });

  it("条件にして返す", () => {
    expect(containsVariants("address", "渋谷", "insensitive")).toEqual([{ address: { contains: "渋谷", mode: "insensitive" } }]);
    expect(containsVariants("address", "渋谷")).toEqual([{ address: { contains: "渋谷" } }]);
  });
});

describe("変更履歴は保存される形で比べる", () => {
  it("★全角のまま保存すると半角に変わるので記録し、半角の行へ全角で打っても記録しない", () => {
    const entries = (oldVal: string, newVal: string) =>
      buildChangeLogEntries({ targetTable: "owners", targetId: "o", changedBy: "u", oldValues: { address: oldVal, note: oldVal }, newValues: { address: newVal, note: newVal }, trackedFields: ["address", "note"] });
    expect(entries("１丁目", "１丁目").map((e) => [e.fieldName, e.oldValue, e.newValue])).toEqual([["address", "１丁目", "1丁目"]]);
    expect(entries("1丁目", "１丁目").map((e) => e.fieldName)).toEqual(["note"]);
  });
});

describe("保存する数字を半角に", () => {
  it("★物件の住所・地番・家屋番号・物件名・号室を半角にする", () => {
    const args = { data: { address: "東京都１丁目２－３", lotNumber: "１番１", buildingNumber: "１番１の３", buildingName: "第２ビル", roomNo: "３０５", note: "１２" } };
    expect(halfWidthDigitsInWrite("property", "create", args).data).toEqual({
      address: "東京都1丁目2-3", lotNumber: "1番1", buildingNumber: "1番1の3", buildingName: "第2ビル", roomNo: "305", note: "１２",
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

describe("数字のあいだの「ー」「－」「−」を「-」にそろえる(2026-11-25 発注者「混在しているのは修正して」)", () => {
  it("★数字と数字のあいだの長音・全角ハイフン・マイナス・ダッシュを「-」に", () => {
    expect(toHalfWidthAddress("東京都港区１ー２ー３")).toBe("東京都港区1-2-3");
    expect(toHalfWidthAddress("1－2")).toBe("1-2");
    expect(toHalfWidthAddress("1−2‐3")).toBe("1-2-3");
    expect(toHalfWidthAddress("1―2–3—4")).toBe("1-2-3-4");
    expect(toHalfWidthAddress("1ｰ2")).toBe("1-2");
  });

  it("★「丁目ー2」「番ー3」のように漢字のあとも「-」に", () => {
    expect(toHalfWidthAddress("1丁目ー2")).toBe("1丁目-2");
    expect(toHalfWidthAddress("5番ー3")).toBe("5番-3");
  });

  it("★号室の英字のあいだも(Aー101)", () => {
    expect(toHalfWidthAddress("Aー101")).toBe("A-101");
  });

  it("★カタカナの長音は変えない(センター・コーポ・ハイツー1 の ー は音を伸ばす記号)", () => {
    expect(toHalfWidthAddress("センター1号館")).toBe("センター1号館");
    expect(toHalfWidthAddress("コーポ2")).toBe("コーポ2");
    expect(toHalfWidthAddress("ハイツー1")).toBe("ハイツー1");
    expect(toHalfWidthAddress("スーパー")).toBe("スーパー");
  });

  it("英字どうしのあいだは変えない(Park—Side)", () => {
    expect(toHalfWidthAddress("Park—Side")).toBe("Park—Side");
  });

  it("あとに数字が来ないものは変えない", () => {
    expect(toHalfWidthAddress("1ー")).toBe("1ー");
    expect(toHalfWidthAddress("東京ーあ")).toBe("東京ーあ");
  });

  it("★画面・保存・変更履歴が同じ形になる", () => {
    expect(displayHalfWidth("１ー２")).toBe("1-2");
    expect(savedTextValue("property", "address", "１ー２")).toBe("1-2");
    expect(savedTextValue("property", "note", "１ー２")).toBe("１ー２");
    expect(halfWidthDigitsInWrite("owner", "update", { data: { address: "3ー4" } }).data).toEqual({ address: "3-4" });
  });

  it("★どの書き方で検索しても、どの書き方で入っている行も見つかる", () => {
    for (const stored of ["1-2", "1ー2", "1－2", "1−2", "１－２", "１ー２"]) {
      for (const typed of ["1-2", "1ー2", "１－２", "1−2"]) {
        expect(searchVariants(`港区${typed}`)).toContain(`港区${stored}`);
      }
    }
  });

  it("★区切りが混ざった値は、数字だけ半角・全角にした形も探す(前の保存の形・@codex)", () => {
    expect(searchVariants("港区１－２ー３")).toEqual(expect.arrayContaining(["港区1－2ー3", "港区１－２ー３", "港区1-2-3"]));
    expect(searchVariants("港区1－2ー3")).toContain("港区１－２ー３");
  });

  it("カタカナの長音だけの語は候補を増やさない", () => {
    expect(searchVariants("センター")).toEqual(["センター"]);
  });
});
