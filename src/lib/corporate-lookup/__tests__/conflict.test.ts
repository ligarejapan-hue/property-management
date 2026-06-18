/**
 * assessCorporateLookupConflict のテスト。
 * 法人名を主信号(明らかな不一致のみ conflict)、住所は補助(単独 mismatch で conflict にしない)。
 */
import { describe, it, expect } from "vitest";
import { assessCorporateLookupConflict } from "../conflict";

describe("assessCorporateLookupConflict", () => {
  it("法人名が同じ → match", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内1-1-1" },
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内一丁目1番1号" },
      ),
    ).toBe("match");
  });

  it("法人種別語(株式会社/(株)/㈱)の有無や全半角差を吸収して match", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "サンプル商事", address: null },
        { name: "株式会社サンプル商事", address: null },
      ),
    ).toBe("match");
    expect(
      assessCorporateLookupConflict(
        { name: "㈱サンプル商事", address: null },
        { name: "サンプル商事(株)", address: null },
      ),
    ).toBe("match");
    expect(
      assessCorporateLookupConflict(
        { name: "ＡＢＣ建設", address: null },
        { name: "ABC建設", address: null },
      ),
    ).toBe("match");
  });

  it("法人名が明らかに別 → conflict", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内1-1-1" },
        { name: "株式会社まったく別の会社", address: "大阪府大阪市北区梅田2-2-2" },
      ),
    ).toBe("conflict");
  });

  it("住所だけ違っても法人名一致なら match(移転・表記揺れで誤検知しない)", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内1-1-1" },
        { name: "株式会社サンプル商事", address: "北海道札幌市中央区北5条2-2" },
      ),
    ).toBe("match");
  });

  it("法人名が判定不能(片方 null)で住所一致 → match", () => {
    expect(
      assessCorporateLookupConflict(
        { name: null, address: "東京都千代田区丸の内1-1-1" },
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内一丁目1番1号" },
      ),
    ).toBe("match");
  });

  it("法人名が判定不能で住所も不一致/不明 → unknown(conflict にしない)", () => {
    // 住所だけ違う → 住所単独 mismatch では conflict にしない → unknown
    expect(
      assessCorporateLookupConflict(
        { name: null, address: "東京都千代田区丸の内1-1-1" },
        { name: "株式会社サンプル商事", address: "大阪府大阪市北区梅田2-2-2" },
      ),
    ).toBe("unknown");
    // 住所も片方 null → unknown
    expect(
      assessCorporateLookupConflict(
        { name: null, address: null },
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内1-1-1" },
      ),
    ).toBe("unknown");
  });

  it("両方の名前が空/null → unknown", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "", address: "" },
        { name: "", address: "" },
      ),
    ).toBe("unknown");
    expect(
      assessCorporateLookupConflict(
        { name: null, address: null },
        { name: null, address: null },
      ),
    ).toBe("unknown");
  });

  it("record 名が null(取得不全) → 名前 unknown、住所一致なら match", () => {
    expect(
      assessCorporateLookupConflict(
        { name: "株式会社サンプル商事", address: "東京都千代田区丸の内1-1-1" },
        { name: null, address: "東京都千代田区丸の内一丁目1番" },
      ),
    ).toBe("match");
  });
});
