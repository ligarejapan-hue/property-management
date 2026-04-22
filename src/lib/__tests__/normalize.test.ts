import { describe, it, expect } from "vitest";
import {
  normalizeAddress,
  normalizeBuildingName,
  normalizeRoomNo,
  buildPropertyDedupeKey,
} from "../normalize";

describe("normalizeAddress", () => {
  it("null/undefined/空文字は空文字を返す", () => {
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress("   ")).toBe("");
  });

  it("前後空白を除去する", () => {
    expect(normalizeAddress("  東京都千代田区1-1-1  ")).toBe(
      "東京都千代田区1-1-1",
    );
  });

  it("連続空白を単一の半角スペースに圧縮する (全角スペース/タブ含む)", () => {
    expect(normalizeAddress("東京都  千代田区\t\t1-1-1")).toBe(
      "東京都 千代田区 1-1-1",
    );
    expect(normalizeAddress("東京都\u3000\u3000千代田区")).toBe(
      "東京都 千代田区",
    );
  });

  it("全角英数字を半角に変換する (NFKC)", () => {
    expect(normalizeAddress("東京都港区ＡＢＣ１２３")).toBe(
      "東京都港区abc123",
    );
  });

  it("英字は lowercase に統一する", () => {
    expect(normalizeAddress("Tokyo-ABC")).toBe("tokyo-abc");
  });

  it("ハイフン類似文字を半角 '-' に統一する", () => {
    // en dash, em dash, minus, fullwidth hyphen, wave dash
    expect(normalizeAddress("千代田区1\u20131\u20141")).toBe("千代田区1-1-1");
    expect(normalizeAddress("千代田区1\u22121\uFF0D1")).toBe("千代田区1-1-1");
    expect(normalizeAddress("千代田区1\u301C2")).toBe("千代田区1-2");
  });

  it("カタカナ長音「ー」は変換しない (地名の意味保持)", () => {
    expect(normalizeAddress("東京都ニューヨーク通り")).toBe(
      "東京都ニューヨーク通り",
    );
  });

  it("住所の意味を変える地名変換はしない", () => {
    // 「1丁目1番地1号」はそのまま残す (数字の半角化のみ)
    expect(normalizeAddress("東京都港区１丁目１番地１号")).toBe(
      "東京都港区1丁目1番地1号",
    );
  });

  it("同値と判定できる表記ゆれが一致する", () => {
    const a = normalizeAddress(" 東京都千代田区　１－１－１ ");
    const b = normalizeAddress("東京都千代田区 1-1-1");
    expect(a).toBe(b);
  });
});

describe("normalizeBuildingName", () => {
  it("null/undefined は空文字", () => {
    expect(normalizeBuildingName(null)).toBe("");
    expect(normalizeBuildingName(undefined)).toBe("");
  });

  it("全角英数を半角+lowercase+trim で統一", () => {
    expect(normalizeBuildingName("  ＡＢＣマンション  ")).toBe(
      "abcマンション",
    );
  });

  it("カタカナ長音「ー」は保持する", () => {
    expect(normalizeBuildingName("パークタワー")).toBe("パークタワー");
  });

  it("連続空白の圧縮", () => {
    expect(normalizeBuildingName("パーク  タワー")).toBe("パーク タワー");
  });

  it("建物名ではハイフン統一は行わない (en dash などはそのまま)", () => {
    // 建物名での dash 変換は誤変換を生みやすいため、基礎正規化のみで保持
    // ただし fullwidth hyphen は NFKC で `-` に変わるため一致する
    expect(normalizeBuildingName("Ｐａｒｋ－Ｔｏｗｅｒ")).toBe("park-tower");
  });
});

describe("normalizeRoomNo", () => {
  it("null/undefined は空文字", () => {
    expect(normalizeRoomNo(null)).toBe("");
    expect(normalizeRoomNo(undefined)).toBe("");
  });

  it("内部空白を含むすべての空白を除去する", () => {
    expect(normalizeRoomNo("101 号室")).toBe("101号室");
    expect(normalizeRoomNo(" 101  号 室 ")).toBe("101号室");
  });

  it("全角数字は半角に変換する", () => {
    expect(normalizeRoomNo("１０１")).toBe("101");
  });

  it("英字は lowercase に統一", () => {
    expect(normalizeRoomNo("A-101")).toBe("a-101");
    expect(normalizeRoomNo("Ａ－１０１")).toBe("a-101");
  });

  it("ハイフン類似文字を統一する", () => {
    expect(normalizeRoomNo("A\u2013101")).toBe("a-101");
    expect(normalizeRoomNo("A\u22121\u20130\u20141")).toBe("a-1-0-1");
  });

  it("表記ゆれが一致する (号室差異・全半角差異・空白差異)", () => {
    const variants = [
      "101号室",
      "101 号室",
      "１０１号室",
      " 101号室 ",
      "１０１　号室",
    ];
    const normalized = variants.map(normalizeRoomNo);
    expect(new Set(normalized).size).toBe(1);
  });
});

describe("buildPropertyDedupeKey", () => {
  it("住所・建物名・部屋番号それぞれの正規化結果を返す", () => {
    const k = buildPropertyDedupeKey({
      address: " 東京都港区１－１－１ ",
      buildingName: "ＡＢＣマンション",
      roomNo: "１０１ 号室",
    });
    expect(k).toEqual({
      address: "東京都港区1-1-1",
      buildingName: "abcマンション",
      roomNo: "101号室",
    });
  });

  it("欠損フィールドは空文字として返す", () => {
    const k = buildPropertyDedupeKey({ address: "東京都港区" });
    expect(k.address).toBe("東京都港区");
    expect(k.buildingName).toBe("");
    expect(k.roomNo).toBe("");
  });

  it("表記ゆれがある2件を同じキーに正規化する", () => {
    const a = buildPropertyDedupeKey({
      address: "東京都千代田区 １－１－１",
      buildingName: "Park Tower",
      roomNo: "A-101",
    });
    const b = buildPropertyDedupeKey({
      address: " 東京都千代田区\t1\u20131\u20141 ",
      buildingName: "ＰＡＲＫ ＴＯＷＥＲ",
      roomNo: "Ａ－１０１",
    });
    expect(a).toEqual(b);
  });
});
