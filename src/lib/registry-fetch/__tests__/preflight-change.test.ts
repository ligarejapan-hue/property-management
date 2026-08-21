import { describe, expect, it } from "vitest";
import { preflightWarningsIncreased } from "@/lib/registry-fetch/preflight-change";

/**
 * 検索の前後で「取得済み・PDF添付あり・所有者あり」の警告が**増えたか**。
 *
 * ⚠なぜ要るか(@codex #399 R2 P1): 所在検索は数十秒〜数分かかる。その間に**別の担当者**が
 *   謄本PDFを添付したり所有者を追加したりすると、検索前に見た警告のまま自動で課金され、
 *   **重複して買ってしまう**。増えていたら自動で進まず、人に確認させる。
 * ⚠確かめられないとき(取得失敗)は**止める側**に倒す（お金は取り消せない）。
 */
const none = {
  registryObtained: false,
  hasRegistryAttachment: false,
  hasOwners: false,
};

describe("preflightWarningsIncreased", () => {
  it("何も変わっていなければ、そのまま進んでよい", () => {
    expect(preflightWarningsIncreased(none, none)).toBe(false);
  });

  it("検索中にPDFが添付されたら止める", () => {
    expect(
      preflightWarningsIncreased(none, { ...none, hasRegistryAttachment: true }),
    ).toBe(true);
  });

  it("検索中に取得済みになったら止める", () => {
    expect(
      preflightWarningsIncreased(none, { ...none, registryObtained: true }),
    ).toBe(true);
  });

  it("検索中に所有者が入ったら止める", () => {
    expect(preflightWarningsIncreased(none, { ...none, hasOwners: true })).toBe(true);
  });

  it("⚠もともと出ていた警告では止めない(検索前に見て進めた人の判断を覆さない)", () => {
    const withOwners = { ...none, hasOwners: true };
    expect(preflightWarningsIncreased(withOwners, withOwners)).toBe(false);
  });

  it("⚠警告が消えた場合は止めない(増えたときだけ)", () => {
    expect(
      preflightWarningsIncreased({ ...none, hasOwners: true }, none),
    ).toBe(false);
  });

  it("⚠確かめられないときは止める(取得に失敗した=null)", () => {
    expect(preflightWarningsIncreased(none, null)).toBe(true);
  });

  it("⚠検索前が読めていないときは、今の警告があれば止める", () => {
    expect(preflightWarningsIncreased(null, { ...none, hasOwners: true })).toBe(true);
    expect(preflightWarningsIncreased(null, none)).toBe(false);
  });
});
