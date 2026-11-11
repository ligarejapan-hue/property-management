import { describe, it, expect } from "vitest";
import { NAME_VARIANTS, foldVariantChar, nameVariantSpellings, variantSpellings } from "@/lib/name-variants";
import { containsVariants, nameContainsVariants, nameSearchVariants } from "@/lib/notation";
import { foldNameVariants } from "@/lib/deals/crosscheck";
import { compareRegistryOwners } from "@/lib/registry-owner-check/compare";

// 2026-11-11 発注者決定「異体字で表示・普通の字で検索」。表示・保存の名前は変えず、比べる・探すときだけそろえる。
const YOSHI = String.fromCodePoint(0x20bb7); // 𠮷(サロゲートペア)
const PUA = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]`);

describe("異体字の表(name-variants.ts)の決まり", () => {
  const entries = Object.entries(NAME_VARIANTS);

  it("左右とも1文字(DM の業者の名前の照合は SQL の translate で1字ずつ置き換える)", () => {
    for (const [v, base] of entries) {
      expect(Array.from(v), v).toHaveLength(1);
      expect(Array.from(base), base).toHaveLength(1);
    }
  });

  it("左の字は NFKC で変わらない(比べる前に NFKC をかけるので、変わる字は表に入れても当たらない)", () => {
    for (const [v] of entries) expect(v.normalize("NFKC"), v).toBe(v);
  });

  it("連鎖させない(そろえる先を左に書かない)・自分自身にしない", () => {
    for (const [v, base] of entries) {
      expect(NAME_VARIANTS[base], `${v}→${base}`).toBeUndefined();
      expect(v).not.toBe(base);
    }
  });

  it("謄本の外字(私用領域の字)を入れない(外字の置き換えは別の対応表で行う)", () => {
    for (const [v, base] of entries) {
      expect(PUA.test(v + base)).toBe(false);
    }
  });

  it("前からの5字は残っている", () => {
    expect(NAME_VARIANTS).toMatchObject({ "髙": "高", "﨑": "崎", "齋": "斎", "邊": "辺", "邉": "辺" });
  });
});

describe("1字のそろえ方と候補", () => {
  it("異体字は普通の字に、普通の字・表に無い字はそのまま", () => {
    expect(foldVariantChar("澤")).toBe("沢");
    expect(foldVariantChar(YOSHI)).toBe("吉");
    expect(foldVariantChar("沢")).toBe("沢");
    expect(foldVariantChar("田")).toBe("田");
  });

  it("候補は打った字を先頭に、同じ組の字を重ねずに並べる", () => {
    expect(variantSpellings("崎")).toEqual(["崎", "﨑", "嵜", "碕"]);
    expect(variantSpellings("﨑")).toEqual(["﨑", "崎", "嵜", "碕"]);
    expect(variantSpellings("田")).toEqual(["田"]);
  });
});

describe("名前の検索語の候補", () => {
  it("「山崎」で「山﨑」なども探す・異体字の無い語はそのまま", () => {
    expect(nameVariantSpellings("山崎")).toEqual(["山崎", "山﨑", "山嵜", "山碕"]);
    expect(nameVariantSpellings("田中")).toEqual(["田中"]);
  });

  it("「𠮷田」(サロゲートペア)でも「吉田」でも互いに探せる", () => {
    expect(nameVariantSpellings("吉田")).toContain(`${YOSHI}田`);
    expect(nameVariantSpellings(`${YOSHI}田`)).toContain("吉田");
  });

  it("異体字のある字は先頭から3つまで広げる(候補が増えすぎない)", () => {
    // 4字とも異体字あり: 先頭の3字ぶんだけ広がる(沢・浜・高=2×2×2 = 8)。4字目(崎)は打った字のまま。
    const got = nameVariantSpellings("沢浜高崎");
    expect(got).toHaveLength(8);
    expect(got.every((s) => s.endsWith("崎"))).toBe(true);
  });

  it("名前の検索はケ・数字の幅の候補にも異体字を足す。住所の検索(containsVariants)は広げない", () => {
    expect(nameSearchVariants("渡邊")).toEqual(["渡邊", "渡辺", "渡邉"]);
    expect(containsVariants("address", "渡邊")).toEqual([{ address: { contains: "渡邊" } }]);
    expect(nameContainsVariants("name", "渡辺", "insensitive")).toEqual([
      { name: { contains: "渡辺", mode: "insensitive" } },
      { name: { contains: "渡邊", mode: "insensitive" } },
      { name: { contains: "渡邉", mode: "insensitive" } },
    ]);
  });
});

describe("名前を比べるとき(謄本の名義の確認・取引の照合)は異体字をそろえる", () => {
  it("広げた字もそろう", () => {
    expect(foldNameVariants("澤田 太郎")).toBe(foldNameVariants("沢田太郎"));
    expect(foldNameVariants(`${YOSHI}田花子`)).toBe(foldNameVariants("吉田花子"));
    expect(foldNameVariants("廣瀬")).toBe(foldNameVariants("広瀬"));
  });

  it("謄本の名義の確認: 異体字だけの違いは「表記の違い」(同じ人)・別の字は「違う」", () => {
    expect(compareRegistryOwners([`${YOSHI}田一郎`], ["吉田一郎"])).toBe("same_notation");
    expect(compareRegistryOwners(["澤田花子", "嶋村次郎"], ["沢田花子", "島村次郎"])).toBe("same_notation");
    expect(compareRegistryOwners(["澤田花子"], ["沢井花子"])).toBe("mismatch");
  });
});
