/**
 * 逆ジオコーディング（座標→住居表示）の純関数・provider解決・変換表の検証。
 *
 * ⚠この機能の対象は**住居表示**（町丁目まで）。地番は座標から引けないため対象外。
 * 外部へ送るのは座標のみ（PIIなし）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseGsiResponse,
  lookupMunicipality,
} from "@/lib/reverse-geocode/gsi-provider";
import { GSI_MUNICIPALITIES } from "@/lib/reverse-geocode/municipalities";
import { MockReverseGeocodeProvider } from "@/lib/reverse-geocode/mock-provider";
import {
  isPlausibleJapanCoordinate,
  isReverseGeocodeConfigured,
  reverseGeocode,
  ReverseGeocodeError,
} from "@/lib/reverse-geocode";

describe("変換表（muniCd → 都道府県+市区町村）", () => {
  it("約1,900件が入っている（全国の市区町村+政令市の市/区）", () => {
    expect(Object.keys(GSI_MUNICIPALITIES).length).toBeGreaterThanOrEqual(1900);
  });

  it("実測で確認済みのコードが正しく引ける", () => {
    // 2026-07-30 の API 実測値と対応（東京駅/西荻窪/中之島）。
    expect(GSI_MUNICIPALITIES["13101"]).toBe("東京都千代田区");
    expect(GSI_MUNICIPALITIES["13115"]).toBe("東京都杉並区");
    expect(GSI_MUNICIPALITIES["27127"]).toBe("大阪府大阪市北区");
  });

  it("キーは先頭ゼロなし・値は都道府県名から始まり空が無い", () => {
    for (const [key, value] of Object.entries(GSI_MUNICIPALITIES)) {
      expect(key).toMatch(/^[1-9]\d*$/); // 先頭ゼロなし
      expect(value.length).toBeGreaterThan(3);
      expect(value).toMatch(/^(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/);
      // 「札幌市　中央区」の全角スペースは住所表記に含めない（生成時に除去済み）
      expect(value).not.toContain("　");
    }
  });
});

describe("lookupMunicipality（先頭ゼロの正規化）", () => {
  it("API形式（5桁ゼロ埋め）でも表形式（ゼロなし）でも同じ行に落ちる", () => {
    expect(lookupMunicipality("01101")).toBe("北海道札幌市中央区");
    expect(lookupMunicipality("1101")).toBe("北海道札幌市中央区");
    expect(lookupMunicipality("13115")).toBe("東京都杉並区");
  });

  it("未知のコード・数値でないものは null（新設合併等で表が古い場合の安全側）", () => {
    expect(lookupMunicipality("99999")).toBeNull();
    expect(lookupMunicipality("abc")).toBeNull();
    expect(lookupMunicipality("")).toBeNull();
  });

  it("数字+ゴミの混在コードは null（Codex P2: parseInt の切り詰めで通さない）", () => {
    expect(lookupMunicipality("13115junk")).toBeNull();
    expect(lookupMunicipality("13115 ")).toBeNull();
    expect(lookupMunicipality("1e5")).toBeNull();
    expect(lookupMunicipality("131150")).toBeNull(); // 6桁(5桁上限超)
  });
});

describe("parseGsiResponse（API応答の解釈）", () => {
  it("正常応答 → 住所を組み立てる（都道府県+市区町村+町丁目）", () => {
    const result = parseGsiResponse({
      results: { muniCd: "13115", lv01Nm: "西荻北三丁目" },
    });
    expect(result).toEqual({
      found: true,
      address: "東京都杉並区西荻北三丁目",
      town: "西荻北三丁目",
      municipalityCode: "13115",
    });
  });

  it("空応答 {} = 海上・国外 → found:false（エラーではない・実測済みの失敗モード）", () => {
    expect(parseGsiResponse({})).toEqual({ found: false });
    expect(parseGsiResponse(null)).toEqual({ found: false });
  });

  it("muniCd や町丁目が欠けた応答は found:false（不完全な住所を出さない）", () => {
    expect(parseGsiResponse({ results: { muniCd: "13115" } })).toEqual({
      found: false,
    });
    expect(parseGsiResponse({ results: { lv01Nm: "西荻北三丁目" } })).toEqual({
      found: false,
    });
    expect(
      parseGsiResponse({ results: { muniCd: 13115, lv01Nm: "西荻北三丁目" } }),
    ).toEqual({ found: false }); // 型違いも弾く
  });

  it("変換表に無いコードは found:false（コードだけの住所を出さない）", () => {
    expect(
      parseGsiResponse({ results: { muniCd: "99999", lv01Nm: "どこか" } }),
    ).toEqual({ found: false });
  });

  it("不正な混在コードは found:false（Codex P2: 見かけ上正しい住所を組み立てない）", () => {
    expect(
      parseGsiResponse({ results: { muniCd: "13115junk", lv01Nm: "西荻北三丁目" } }),
    ).toEqual({ found: false });
  });
});

describe("isPlausibleJapanCoordinate（入力検証・上流への無駄打ち防止）", () => {
  it.each([
    [35.68, 139.76, true], // 東京
    [43.06, 141.35, true], // 札幌
    [26.21, 127.68, true], // 那覇
    [0, 0, false], // null island
    [51.5, -0.12, false], // ロンドン
    [NaN, 139, false],
    [35, Infinity, false],
  ])("(%s, %s) → %s", (lat, lng, want) => {
    expect(isPlausibleJapanCoordinate(lat as number, lng as number)).toBe(want);
  });
});

describe("provider 解決（env 未設定なら休眠=fail-closed）", () => {
  const KEYS = ["REVERSE_GEOCODE_PROVIDER", "NEXT_PUBLIC_USE_MOCK"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("未設定 → NOT_CONFIGURED（route が 503 にする）・外部接続しない", async () => {
    await expect(reverseGeocode(35.68, 139.76)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(isReverseGeocodeConfigured()).toBe(false);
  });

  it("未知の値も NOT_CONFIGURED（タイポで意図しない provider に落ちない）", async () => {
    process.env.REVERSE_GEOCODE_PROVIDER = "google"; // 未対応
    await expect(reverseGeocode(35.68, 139.76)).rejects.toBeInstanceOf(
      ReverseGeocodeError,
    );
    expect(isReverseGeocodeConfigured()).toBe(false);
  });

  it("mock モードは外部接続なしで決定的な結果", async () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    const result = await reverseGeocode(35.68, 139.76);
    expect(result).toEqual({
      found: true,
      address: "東京都杉並区西荻北三丁目",
      town: "西荻北三丁目",
      municipalityCode: "13115",
    });
    expect(isReverseGeocodeConfigured()).toBe(true);
  });
});

describe("mock provider", () => {
  it("日本のもっともらしい座標なら固定住所・それ以外は found:false", async () => {
    const mock = new MockReverseGeocodeProvider();
    expect((await mock.reverseGeocode(35.68, 139.76)).found).toBe(true);
    expect((await mock.reverseGeocode(51.5, -0.12)).found).toBe(false);
  });
});
