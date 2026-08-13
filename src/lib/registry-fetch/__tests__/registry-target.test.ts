/**
 * 「何を取りに行くか」の分類（設計 §3.1.1 / §3.1.2）。
 *
 * ⚠種別では**止めない**（発注者判断 2026-08-12）。建物でも地番があれば土地の謄本は
 *   取れる。種別は警告の材料にしか使わない。
 */
import { describe, it, expect } from "vitest";
import { classifyRegistryTarget } from "@/lib/registry-fetch/registry-target";

/** 住所は「入っている」を既定にする（住所が無いケースは専用の describe で見る）。 */
const t = (
  propertyType: string,
  lotNumber: string | null,
  buildingNumber: string | null,
  realEstateNumber: string | null = null,
  address: string | null = "神奈川県横浜市南区井土ケ谷中町",
) =>
  classifyRegistryTarget({
    propertyType,
    address,
    lotNumber,
    buildingNumber,
    realEstateNumber,
  });

describe("土地か建物かは持っている番号で決まる（種別では決めない）", () => {
  it("家屋番号があれば建物", () => {
    expect(t("house", "69-2", "12-3").kind).toBe("building");
  });

  it("家屋番号が無く地番があれば土地", () => {
    expect(t("land", "69-2", null).kind).toBe("land");
  });

  it("どちらも無ければ決められない", () => {
    expect(t("land", null, null).kind).toBe("none");
  });

  it("⚠読めない形の番号は取りに行けない（malformed）", () => {
    // 通すと、正規化で潰れた別の筆を取りに行く。
    expect(t("land", "abc1x2", null).kind).toBe("malformed");
  });

  it("⚠読めない家屋番号があるとき、地番へ落とさない（検索と同じ選び方）", () => {
    // 検索の入口は家屋番号を優先し、読めなければ地番へ落とさず弾く。
    // ここだけ落とすと「土地の登記を取得します」と出るのに検索は弾く、
    // という食い違いになる（@codex #372 R2 P2）。
    expect(t("house", "69-2", "abc").kind).toBe("malformed");
    expect(t("land", "69-2", "abc").kind).toBe("malformed");
  });

  it("家屋番号が空なら地番を使う（落とすのは「空」のときだけ）", () => {
    expect(t("house", "69-2", null).kind).toBe("land");
    expect(t("house", "69-2", "   ").kind).toBe("land");
  });

  it("既存の表記（1番地2）は持っている扱い", () => {
    expect(t("land", "1番地2", null).kind).toBe("land");
  });
});

describe("種別と食い違えば警告する（止めない）", () => {
  it("土地の物件に家屋番号が残っている → 建物を取る警告", () => {
    const r = t("land", "69-2", "12-3");
    expect(r.kind).toBe("building");
    expect(r.mismatchWarning).toContain("土地");
    expect(r.mismatchWarning).toContain("建物の登記を取得します");
  });

  it("建物の物件で家屋番号が無い → 土地を取る警告", () => {
    const r = t("house", "69-2", null);
    expect(r.kind).toBe("land");
    expect(r.mismatchWarning).toContain("家屋番号");
  });

  it.each([
    "apartment_unit",
    "apartment_building",
    "apartment_block",
    "store",
    "office",
    "warehouse",
    "factory",
    "building",
    "unit",
  ])("%s も建物として扱う", (pt) => {
    expect(t(pt, "69-2", null).mismatchWarning).not.toBeNull();
  });

  it("食い違わなければ警告は出ない", () => {
    expect(t("land", "69-2", null).mismatchWarning).toBeNull();
    expect(t("house", null, "12-3").mismatchWarning).toBeNull();
  });

  it.each(["parking", "other", "unknown"])(
    "%s は決められないので警告を出さない（何を取りに行くかは kind で分かる）",
    (pt) => {
      const r = t(pt, "69-2", null);
      expect(r.kind).toBe("land");
      expect(r.mismatchWarning).toBeNull();
    },
  );

  it("番号がまったく無いときは警告を出さない（取りに行くものが無い）", () => {
    expect(t("house", null, null).mismatchWarning).toBeNull();
  });
});

describe("⚠警告文に地番の値そのものを載せない（秘匿）", () => {
  it("番号を含まない", () => {
    const r = t("land", "69-2", "12-3");
    expect(r.mismatchWarning).not.toContain("69");
    expect(r.mismatchWarning).not.toContain("12-3");
  });
});

describe("⚠不動産番号があれば所在検索の対象外（設計 §3.1 / §3.1.1）", () => {
  it("番号があれば kind=number（地番を尋ねない）", () => {
    // ⚠"none" にすると「地番が必要です」のポップアップが出てしまい、
    //   利用者は外部の地図で地番を調べて保存したのに、検索は結局
    //   「番号があります」と返す＝**要らない地番が物件に残るだけ**になる。
    expect(t("land", null, null, "0413234567890")).toEqual({
      kind: "number",
      mismatchWarning: null,
    });
  });

  it("番号があれば種別も他の番号も見ない（検索の入口と同じ優先順）", () => {
    expect(t("house", "69-2", "12-3", "0413234567890").kind).toBe("number");
    expect(t("parking", "abc1x2", null, "0413234567890").kind).toBe("number");
  });

  it("空白だけの番号は「無い」と同じ扱い", () => {
    expect(t("land", "69-2", null, "   ").kind).toBe("land");
    expect(t("land", null, null, "").kind).toBe("none");
  });
});

describe("⚠「読めない形」と「入っていない」を分ける（@codex #373 R2 P2）", () => {
  it("読めない家屋番号は malformed（none ではない）", () => {
    // "none" にすると「地番が必要です」のポップアップが出るが、そこは
    // **地番しか保存できない**。読めない家屋番号が残ったままだと分類は
    // 家屋番号を優先し続けるので、正しい地番を入れても同じポップアップが
    // 何度でも出て**先へ進めなくなる**。直すのは入っている番号のほう。
    expect(t("house", "69-2", "abc").kind).toBe("malformed");
    expect(t("land", null, "abc").kind).toBe("malformed");
  });

  it("読めない地番だけのときも malformed", () => {
    expect(t("land", "abc1x2", null).kind).toBe("malformed");
  });

  it("本当に入っていないときだけ none", () => {
    expect(t("land", null, null).kind).toBe("none");
    expect(t("land", "  ", "").kind).toBe("none");
  });

  it("malformed でも種別の警告は出さない（先に番号を直してもらう）", () => {
    expect(t("house", "abc", null).mismatchWarning).toBeNull();
  });
});

describe("⚠住所は番号より先に見る（@codex #373 R4 P2）", () => {
  it("住所が無ければ no_address（地番を尋ねない）", () => {
    // 地番を調べて保存してもらっても、次の検索は住所不足で弾かれる＝二度手間。
    expect(t("land", null, null, null, null).kind).toBe("no_address");
    expect(t("land", "69-2", null, null, "   ").kind).toBe("no_address");
  });

  it("不動産番号のほうがさらに先（検索の入口と同じ順序）", () => {
    expect(t("land", null, null, "0413234567890", null).kind).toBe("number");
  });

  it("住所があれば従来どおり番号で決まる", () => {
    expect(t("land", "69-2", null, null, "横浜市南区").kind).toBe("land");
  });
});

describe("⚠2つの道を出すかの判定（isLandPropertyType・@codex #373 R10 P2）", () => {
  it("土地だけ true", async () => {
    const { isLandPropertyType } = await import(
      "@/lib/registry-fetch/registry-target"
    );
    expect(isLandPropertyType("land")).toBe(true);
  });

  it("⚠決まっていない種別は false＝建物の道も見せる", async () => {
    // 駐車場・その他・不明を「土地」として扱って地番の入力へ直行させると、
    // 建物の謄本が欲しかった人は家屋番号の要ることを知らないまま行き止まる。
    const { isLandPropertyType } = await import(
      "@/lib/registry-fetch/registry-target"
    );
    for (const pt of ["parking", "other", "unknown"] as const) {
      expect(isLandPropertyType(pt)).toBe(false);
    }
  });

  it("建物系も false（従来どおり2つの道）", async () => {
    const { isLandPropertyType } = await import(
      "@/lib/registry-fetch/registry-target"
    );
    for (const pt of ["house", "apartment_unit", "store"] as const) {
      expect(isLandPropertyType(pt)).toBe(false);
    }
  });
});

describe("所在検索を始めてよい分類（isSearchableTarget）", () => {
  it("土地・建物だけ true", async () => {
    const { isSearchableTarget } = await import(
      "@/lib/registry-fetch/registry-target"
    );
    expect(isSearchableTarget("land")).toBe(true);
    expect(isSearchableTarget("building")).toBe(true);
  });

  it("⚠サーバーが必ず弾く分類は false（押しても毎回断られるだけ）", async () => {
    const { isSearchableTarget } = await import(
      "@/lib/registry-fetch/registry-target"
    );
    for (const kind of ["none", "malformed", "number", "no_address"] as const) {
      expect(isSearchableTarget(kind)).toBe(false);
    }
  });
});
