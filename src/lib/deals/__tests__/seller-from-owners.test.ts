import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ default: {} }));
import {
  ownersExceptCompany,
  sellerAccessOf,
  sellerPartiesFromOwners,
  withSharesCombinedByName,
  type OwnerForSeller,
} from "../seller-from-owners";

const owner = (over: Record<string, unknown> = {}): OwnerForSeller => ({
  name: "試験 太郎", phone: "03-0000-0000", address: "東京都試験区1-2-3", currentAddress: null,
  corporateNumber: null, companyRegistryNumber: null, ...over,
});
const ALL = { name: true, address: true, phone: true };

describe("物件の所有者を売主にする", () => {
  it("★氏名・住所・電話を入れる", () => {
    expect(sellerPartiesFromOwners([owner()], [], ALL)).toEqual([
      { role: "seller", partyType: "individual", name: "試験 太郎", address: "東京都試験区1-2-3", phone: "03-0000-0000", isSelf: false, shareNum: null, shareDen: null },
    ]);
  });

  it("★持分は登記上の記載の合計を入れる(2026-11-12 発注者決定)・分からなければ空のまま", () => {
    // 2/10+3/10+2/10 の人は 7/10(約分しない)。合計は呼び出し側が所有者事項の行から出して渡す。
    const [p] = sellerPartiesFromOwners([owner({ share: { num: 7, den: 10 } })], [], ALL);
    expect([p.shareNum, p.shareDen]).toEqual([7, 10]);
    const [none] = sellerPartiesFromOwners([owner({ share: null })], [], ALL);
    expect([none.shareNum, none.shareDen]).toEqual([null, null]);
    // 共有: それぞれの持分が入る
    const both = sellerPartiesFromOwners(
      [owner({ share: { num: 7, den: 10 } }), owner({ name: "試験 花子", share: { num: 3, den: 10 } })],
      [],
      ALL,
    );
    expect(both.map((x) => `${x.name}=${x.shareNum}/${x.shareDen}`)).toEqual(["試験 太郎=7/10", "試験 花子=3/10"]);
  });

  it("⚠氏名が見られない人の操作では、持分も入らない(誰も足さない)", () => {
    expect(
      sellerPartiesFromOwners([owner({ share: { num: 7, den: 10 } })], [], { name: false, address: true, phone: true }),
    ).toEqual([]);
  });

  it("★同じ名前の所有者が2人残っていても売主は1人・持分は2人分を足す(1人目の分だけにしない)", () => {
    const [p, ...rest] = sellerPartiesFromOwners(
      withSharesCombinedByName([
        owner({ share: { num: 2, den: 10 } }),
        owner({ name: "試験　太郎", share: { num: 5, den: 10 } }),
      ]),
      [],
      ALL,
    );
    expect(rest).toHaveLength(0);
    expect([p.shareNum, p.shareDen]).toEqual([7, 10]);
    // 片方の持分が分からなければ、合計は入れない(一部だけを正しい持分として入れない)
    const [q] = sellerPartiesFromOwners(
      withSharesCombinedByName([owner({ share: { num: 2, den: 10 } }), owner({ share: null })]),
      [],
      ALL,
    );
    expect([q.shareNum, q.shareDen]).toEqual([null, null]);
  });

  it("★合計が1を超えるなど、あり得ない持分は入れない", () => {
    const [p] = sellerPartiesFromOwners(
      withSharesCombinedByName([owner({ share: { num: 2, den: 3 } }), owner({ share: { num: 2, den: 3 } })]),
      [],
      ALL,
    );
    expect([p.shareNum, p.shareDen]).toEqual([null, null]);
  });

  it("⚠同じ名前の人の持分は、選ぶ前の全員で足す=1人目だけを選んでも合計が入る(@codex #717 P2)", () => {
    // 候補の一覧は同じ名前の1人目の ID だけを出し、足す処理は選ばれた人だけに絞る。
    // 絞る前に全員で足しておけば、1人目だけ渡されても 2/10+5/10=7/10 になる。
    const all = withSharesCombinedByName([
      owner({ id: "a", share: { num: 2, den: 10 } }),
      owner({ id: "b", name: "試験　太郎", share: { num: 5, den: 10 } }),
      owner({ id: "c", name: "試験 花子", share: { num: 3, den: 10 } }),
    ]);
    expect(all.map((o) => o.share)).toEqual([
      { num: 7, den: 10 },
      { num: 7, den: 10 },
      { num: 3, den: 10 },
    ]);
    const onlyFirst = all.filter((o) => (o as { id?: string }).id === "a");
    const [p] = sellerPartiesFromOwners(onlyFirst, [], ALL);
    expect([p.shareNum, p.shareDen]).toEqual([7, 10]);
    // 選ばれなかった方の持分が分からないときは、選んだ方も空(一部だけを入れない)
    const unknown = withSharesCombinedByName([
      owner({ id: "a", share: { num: 2, den: 10 } }),
      owner({ id: "b", share: null }),
    ]).filter((o) => (o as { id?: string }).id === "a");
    const [q] = sellerPartiesFromOwners(unknown, [], ALL);
    expect([q.shareNum, q.shareDen]).toEqual([null, null]);
  });

  it("★現住所があれば現住所を入れる", () => {
    expect(sellerPartiesFromOwners([owner({ currentAddress: "東京都新区9-9" })], [], ALL)[0].address).toBe("東京都新区9-9");
    expect(sellerPartiesFromOwners([owner({ currentAddress: "  " })], [], ALL)[0].address).toBe("東京都試験区1-2-3");
  });

  it("★すでに売主にいる人は足さない(表記の違いは同じ人とみなす)・共有なら全員", () => {
    const owners = [owner({ name: "試験　太郎" }), owner({ name: "試験 花子" })];
    expect(sellerPartiesFromOwners(owners, ["試験 太郎"], ALL).map((p) => p.name)).toEqual(["試験 花子"]);
    expect(sellerPartiesFromOwners([owner(), owner()], [], ALL)).toHaveLength(1);
  });

  it("★見られない項目は入れない・氏名が見られなければ誰も入れない", () => {
    const p = sellerPartiesFromOwners([owner()], [], { name: true, address: false, phone: false })[0];
    expect(p.address).toBeNull();
    expect(p.phone).toBeNull();
    expect(sellerPartiesFromOwners([owner()], [], { name: false, address: true, phone: true })).toEqual([]);
  });

  it("法人を見分ける", () => {
    const type = (o: Record<string, unknown>) => sellerPartiesFromOwners([owner(o)], [], ALL)[0].partyType;
    expect(type({ name: "試験不動産株式会社" })).toBe("corporation");
    expect(type({ name: "（株）試験" })).toBe("corporation");
    expect(type({ name: "試験", corporateNumber: "1234567890123" })).toBe("corporation");
    expect(type({ name: "株田 太郎" })).toBe("individual");
  });

  it("★欄に入らない長さは保存で落ちないように扱う", () => {
    const long = sellerPartiesFromOwners([owner({ address: "あ".repeat(301), phone: "1".repeat(51) })], [], ALL)[0];
    expect(long.address).toBeNull();
    expect(long.phone).toBeNull();
    expect(sellerPartiesFromOwners([owner({ name: "あ".repeat(201) })], [], ALL)).toEqual([]);
    expect(sellerPartiesFromOwners([owner({ name: "  " })], [], ALL)).toEqual([]);
  });
});

describe("売主に入れてよい範囲(依頼文の差し込みと同じ決まり)", () => {
  it("所有者を読めない人は何も入れない", () => {
    expect(sellerAccessOf([])).toEqual({ name: false, address: false, phone: false });
  });
});

describe("自社の名前の所有者", () => {
  it("空白や(株)の書き方が違っても除く", () => {
    const owners = [owner({ name: "リガーレ 株式会社" }), owner({ name: "(株)リガーレ" }), owner()];
    expect(ownersExceptCompany(owners, "株式会社リガーレ").map((o) => o.name)).toEqual(["リガーレ 株式会社", "試験 太郎"]);
    expect(ownersExceptCompany(owners, "リガーレ株式会社").map((o) => o.name)).toEqual(["(株)リガーレ", "試験 太郎"]);
  });
});
