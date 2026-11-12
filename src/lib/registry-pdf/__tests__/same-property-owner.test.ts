import { describe, it, expect } from "vitest";
import {
  samePropertyNameKey,
  pickSamePropertyOwner,
  planSamePropertyAddressReplace,
  type LinkedOwnerCandidate,
} from "@/lib/registry-pdf/owner-reuse";

/**
 * 同じ物件の中では、名前が同じ所有者を同じ人として使い回す(2026-11-12 発注者決定)。
 *
 * 背景: 取り込みは「名前+住所が同じ」ときだけ既存の所有者を使い回す。謄本には同じ人が
 * 住所違いで2回載ることがある(持分を別の時期に取得・住所変更の登記をしていない)ため、
 * 同じ物件に同じ人が2人できていた(本番で285組)。
 * ⚠物件をまたぐ照合は従来どおり名前+住所(別の物件の同姓同名は別人であり得る)。
 */
const owner = (o: Partial<LinkedOwnerCandidate>): LinkedOwnerCandidate => ({
  id: "o1",
  name: "山田太郎",
  address: "東京都港区芝1-2-3",
  isArchived: false,
  corporateNumber: null,
  ...o,
});

describe("samePropertyNameKey", () => {
  it("全角半角・空白・異体字をそろえる", () => {
    expect(samePropertyNameKey("髙橋　一郎")).toBe(samePropertyNameKey("高橋一郎"));
    expect(samePropertyNameKey("𠮷田 花子")).toBe(samePropertyNameKey("吉田花子"));
    expect(samePropertyNameKey("ＡＢＣ商事")).toBe(samePropertyNameKey("abc商事"));
  });

  it("違う名前はそろえても違う", () => {
    expect(samePropertyNameKey("山田太郎")).not.toBe(samePropertyNameKey("山田太朗"));
  });
});

describe("pickSamePropertyOwner", () => {
  it("同じ物件に同じ名前の人がいれば、住所が違っても使い回す", () => {
    const hit = pickSamePropertyOwner(
      [owner({ id: "a", address: "大阪市北区1-1" })],
      "山田 太郎",
    );
    expect(hit?.id).toBe("a");
  });

  it("異体字だけ違う名前も同じ人として使い回す", () => {
    expect(pickSamePropertyOwner([owner({ id: "a", name: "髙橋一郎" })], "高橋一郎")?.id).toBe("a");
  });

  it("名前が違えば使い回さない", () => {
    expect(pickSamePropertyOwner([owner({ name: "鈴木一郎" })], "山田太郎")).toBeNull();
  });

  it("保管(アーカイブ)した人は使い回さない", () => {
    expect(pickSamePropertyOwner([owner({ isArchived: true })], "山田太郎")).toBeNull();
  });

  it("名前が空なら使い回さない(読めていない名前どうしを巻き込まない)", () => {
    expect(pickSamePropertyOwner([owner({ name: "" })], " ")).toBeNull();
  });

  it("同じ名前が複数いれば、渡された順の先頭に決める", () => {
    expect(
      pickSamePropertyOwner([owner({ id: "first" }), owner({ id: "second" })], "山田太郎")?.id,
    ).toBe("first");
  });
});

describe("planSamePropertyAddressReplace", () => {
  const cur = { zip: "100-0001", address: "東京都港区芝1-2-3" };

  it("この取り込みで作った人で、住所が違えば新しい住所(郵便番号と組)に替える", () => {
    expect(
      planSamePropertyAddressReplace(cur, { zip: "530-0001", address: "大阪市北区1-1" }, true),
    ).toEqual({ zip: "530-0001", address: "大阪市北区1-1" });
  });

  it("新しい住所に郵便番号が無ければ、郵便番号は空にする(別の場所の郵便番号を残さない)", () => {
    expect(
      planSamePropertyAddressReplace(cur, { zip: null, address: "大阪市北区1-1" }, true),
    ).toEqual({ zip: null, address: "大阪市北区1-1" });
  });

  it("前からいる人の住所は替えない(人が直した住所かもしれない)", () => {
    expect(
      planSamePropertyAddressReplace(cur, { zip: null, address: "大阪市北区1-1" }, false),
    ).toBeNull();
  });

  it("書き方だけ同じ住所なら替えない", () => {
    expect(
      planSamePropertyAddressReplace(cur, { zip: null, address: "東京都港区芝１－２－３" }, true),
    ).toBeNull();
  });

  it("新しい側に住所が無ければ替えない", () => {
    expect(planSamePropertyAddressReplace(cur, { zip: "530-0001", address: null }, true)).toBeNull();
    expect(planSamePropertyAddressReplace(cur, { zip: null, address: "  " }, true)).toBeNull();
  });

  it("今の住所が空なら替える対象にしない(空欄の穴埋めは従来の処理に任せる)", () => {
    expect(
      planSamePropertyAddressReplace({ zip: null, address: null }, { zip: null, address: "大阪市北区1-1" }, true),
    ).toBeNull();
  });
});
