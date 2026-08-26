import { describe, it, expect } from "vitest";
import { judgeDuplicates, normalizeForCompare } from "../find-duplicates";

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
