import { describe, it, expect } from "vitest";
import { judgeDuplicates, normalizeForCompare, findSameContentPropertyIds } from "../find-duplicates";
import { toHalfWidthAddress } from "@/lib/notation";

const P = (
  id: string,
  address: string | null,
  lotNumber: string | null,
  externalLinkKey: string | null = null,
) => ({ id, address, lotNumber, externalLinkKey });

describe("judgeDuplicates（二重登録の判定）", () => {
  it("★外部キーが一致したら登録を止める", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA2608-1234567" },
      [P("p1", "別の住所", null, "SA2608-1234567")],
    );
    expect(v.blocked).toBe(true);
    expect(v.blockedByPropertyId).toBe("p1");
  });

  it("外部キーが違えば止めない", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA-AAA" },
      [P("p1", "東京都A区B1-2-3", null, "SA-BBB")],
    );
    expect(v.blocked).toBe(false);
  });

  it("★住所+地番が一致したら警告するが止めない", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "552-2", externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", "552-2")],
    );
    expect(v.blocked).toBe(false);
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("⚠地番が両方とも無いときは住所だけで似ているとみなす", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("⚠片方だけ地番があるときは似ているとみなさない（別の筆の可能性）", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "552-2", externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual([]);
  });

  it("全角半角・空白・ハイフンのゆれを吸収して比べる", () => {
    const v = judgeDuplicates(
      { address: "東京都Ａ区Ｂ１－２－３", lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B 1-2-3", null)],
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("住所が無ければ何とも比べない", () => {
    const v = judgeDuplicates(
      { address: null, lotNumber: null, externalLinkKey: null },
      [P("p1", "東京都A区B1-2-3", null)],
    );
    expect(v.blocked).toBe(false);
    expect(v.similarPropertyIds).toEqual([]);
  });

  it("外部キーの一致と住所の一致が両方あっても、止める理由は外部キー", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: "SA-1" },
      [P("p1", "東京都A区B1-2-3", null, "SA-1")],
    );
    expect(v.blocked).toBe(true);
    expect(v.blockedByPropertyId).toBe("p1");
  });
});

describe("normalizeForCompare", () => {
  it("空白・全角半角・ハイフン類を均す", () => {
    expect(normalizeForCompare("東京都Ａ区　Ｂ１－２－３")).toBe(
      normalizeForCompare("東京都A区B1-2-3"),
    );
  });
  it("null は空文字", () => {
    expect(normalizeForCompare(null)).toBe("");
  });
});

describe("住所の突き合わせは先頭の郵便番号を無視する（5巡目 ②）", () => {
  const existing = (address: string) => [
    { id: "p1", address, lotNumber: null, externalLinkKey: null },
  ];

  it("★DB側だけ〒付き・全角でも、半角の貼り付けと同じ住所と判定する", () => {
    const v = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: null, externalLinkKey: null },
      existing("〒123-4567 東京都Ａ区Ｂ１－２－３"),
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("★逆に貼り付け側だけ〒付きでも同じ", () => {
    const v = judgeDuplicates(
      { address: "〒123-4567 東京都A区B1-2-3", lotNumber: null, externalLinkKey: null },
      existing("東京都Ａ区Ｂ１－２－３"),
    );
    expect(v.similarPropertyIds).toEqual(["p1"]);
  });

  it("★別の住所は一致にしない（郵便番号を落としたせいで広がっていない）", () => {
    const v = judgeDuplicates(
      { address: "〒123-4567 東京都A区B1-2-3", lotNumber: null, externalLinkKey: null },
      existing("〒123-4567 東京都Ａ区Ｂ９－９－９"),
    );
    expect(v.similarPropertyIds).toEqual([]);
  });

  it("★地番の突き合わせでは郵便番号扱いをしない（`123-4567` の地番が消えない）", () => {
    // normalizeForCompare(住所以外)にこの規則を入れると、地番 `123-4567` が
    // 丸ごと消えて、別の地番と一致してしまう。
    const same = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "123-4567", externalLinkKey: null },
      [{ id: "p1", address: "東京都A区B1-2-3", lotNumber: "123-4567", externalLinkKey: null }],
    );
    expect(same.similarPropertyIds).toEqual(["p1"]);
    const diff = judgeDuplicates(
      { address: "東京都A区B1-2-3", lotNumber: "123-4567", externalLinkKey: null },
      [{ id: "p2", address: "東京都A区B1-2-3", lotNumber: "999-9999", externalLinkKey: null }],
    );
    expect(diff.similarPropertyIds).toEqual([]);
  });
});

describe("findSameContentPropertyIds（査定ナンバーの無い依頼の二重登録・2026-11-15）", () => {
  const E = (over: Partial<Parameters<typeof findSameContentPropertyIds>[1][number]> = {}) => ({
    id: "p1",
    address: "東京都Ａ区Ｂ１－２－３",
    lotNumber: null,
    buildingName: "テストマンション",
    roomNo: "９０１",
    ownerNames: ["調査　太郎"],
    ...over,
  });
  const D = (over: Partial<Parameters<typeof findSameContentPropertyIds>[0]> = {}) => ({
    address: "東京都A区B1-2-3",
    lotNumber: null,
    buildingName: "テストマンション",
    roomNo: "901",
    ownerName: "調査太郎",
    ...over,
  });

  it("★住所・建物名・部屋番号・所有者の名前がすべて同じなら当たる(全角半角・空白のゆれは吸収)", () => {
    expect(findSameContentPropertyIds(D(), [E()])).toEqual(["p1"]);
  });

  it("★同じ建物の別の部屋は当てない", () => {
    expect(findSameContentPropertyIds(D({ roomNo: "902" }), [E()])).toEqual([]);
  });

  it("★片方だけ部屋番号が無いときも当てない", () => {
    expect(findSameContentPropertyIds(D({ roomNo: null }), [E()])).toEqual([]);
    expect(findSameContentPropertyIds(D(), [E({ roomNo: null })])).toEqual([]);
  });

  it("★同じ住所・同じ部屋でも、名前が違えば当てない(別の依頼)", () => {
    expect(findSameContentPropertyIds(D({ ownerName: "別人花子" }), [E()])).toEqual([]);
  });

  it("★所有者の名前が無い登録は見ない", () => {
    expect(findSameContentPropertyIds(D({ ownerName: null }), [E()])).toEqual([]);
    expect(findSameContentPropertyIds(D({ ownerName: "　" }), [E({ ownerNames: [""] })])).toEqual([]);
  });

  it("建物名が違えば当てない・住所が違えば当てない", () => {
    expect(findSameContentPropertyIds(D({ buildingName: "べつのマンション" }), [E()])).toEqual([]);
    expect(findSameContentPropertyIds(D({ address: "東京都A区B9-9-9" }), [E()])).toEqual([]);
  });

  it("地番の決まりは「似た物件」と同じ(片方だけ地番があれば当てない)", () => {
    expect(findSameContentPropertyIds(D({ lotNumber: "552-2" }), [E()])).toEqual([]);
    expect(findSameContentPropertyIds(D({ lotNumber: "552-2" }), [E({ lotNumber: "５５２－２" })])).toEqual(["p1"]);
  });

  it("戸建・土地(建物名も部屋番号も無い)でも、住所と名前が同じなら当たる", () => {
    const land = { buildingName: null, roomNo: null };
    expect(findSameContentPropertyIds(D(land), [E(land)])).toEqual(["p1"]);
  });

  it("「901号室」と「901」は同じ部屋と見る・共有名義のどちらかの名前が同じなら当たる", () => {
    expect(findSameContentPropertyIds(D({ roomNo: "901号室" }), [E({ ownerNames: ["別人花子", "調査太郎"] })])).toEqual(["p1"]);
  });
});

describe("同じ内容を2回貼ったとき(保存で区切りが「-」になる・2026-11-25 @codex)", () => {
  it("★1回目に保存した形(1–2 → 1-2)と2回目の貼り付けを同じ住所として見る", () => {
    for (const d of ["–", "—", "‐", "‑", "‒", "ｰ", "ー", "－", "−", "―"]) {
      const pasted = `東京都A区B1${d}2`;
      const v = judgeDuplicates(
        { address: pasted, lotNumber: null, externalLinkKey: null },
        [P("p1", toHalfWidthAddress(pasted), null)],
      );
      expect(v.similarPropertyIds).toEqual(["p1"]);
    }
  });
});
