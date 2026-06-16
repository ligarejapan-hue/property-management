import { describe, it, expect } from "vitest";
import { decideRegistryAddressCleanup } from "../registry-address-cleanup";

describe("decideRegistryAddressCleanup", () => {
  it("検出なし（正当な住所）→ action none・無変更", () => {
    const p = decideRegistryAddressCleanup({ address: "東京都港区六本木1-2-3" });
    expect(p.action).toBe("none");
    expect(p.changed).toBe(false);
    expect(p.cleanedAddress).toBe("東京都港区六本木1-2-3");
    expect(p.detectedTypes).toEqual([]);
  });

  it("null/空 → action none", () => {
    expect(decideRegistryAddressCleanup({ address: null }).action).toBe("none");
    expect(decideRegistryAddressCleanup({ address: "   " }).action).toBe("none");
  });

  // --- 保守性: 正当な番地・建物名を消さない（最重要の偽陽性防止） ---
  it("正当な『第N号』を含む建物名は除去しない（受付アンカー無し）", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都中央区銀座1-1 第2号棟 501",
    });
    expect(p.action).toBe("none");
    expect(p.cleanedAddress).toBe("東京都中央区銀座1-1 第2号棟 501");
  });

  it("裸の小整数（順位番号らしき数字）は検出しない＝番地を消さない", () => {
    const p = decideRegistryAddressCleanup({ address: "○○市○○町1" });
    expect(p.action).toBe("none");
    expect(p.detectedTypes).toEqual([]);
  });

  // --- T2 受付番号（除去可能） ---
  it("T2 受付番号『受付第12345号』を除去 → cleanup", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都港区六本木1-2-3 受付第12345号",
    });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("receipt_number");
    expect(p.removableTypes).toContain("receipt_number");
    expect(p.cleanedAddress).toBe("東京都港区六本木1-2-3");
    expect(p.changed).toBe(true);
  });

  it("T2 全角『受付番号第１２３４５号』も除去", () => {
    const p = decideRegistryAddressCleanup({
      address: "大阪市北区1-1 受付番号第１２３４５号",
    });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBe("大阪市北区1-1");
  });

  // --- T3 登記日付（除去可能・元号アンカー） ---
  it("T3 和暦日付『令和3年10月15日』を除去", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都新宿区西新宿2-8-1 令和3年10月15日",
    });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("registration_date");
    expect(p.cleanedAddress).toBe("東京都新宿区西新宿2-8-1");
  });

  // --- T4 登記原因（日付+原因キーワード） ---
  it("T4 登記原因『令和3年10月15日売買』を1単位で除去（原因語が孤立しない）", () => {
    const p = decideRegistryAddressCleanup({
      address: "札幌市中央区北1条西2 令和3年10月15日売買",
    });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("registration_cause");
    expect(p.cleanedAddress).toBe("札幌市中央区北1条西2");
  });

  // --- T7 持分（除去可能） ---
  it("T7 持分『持分2分の1』を除去", () => {
    const p = decideRegistryAddressCleanup({
      address: "福岡市博多区博多駅前1-1 持分2分の1",
    });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("share_fraction");
    expect(p.cleanedAddress).toBe("福岡市博多区博多駅前1-1");
  });

  // --- T9 証明書メタ（完全一致辞書） ---
  it("T9 証明書メタ『全部事項証明書』を除去", () => {
    const p = decideRegistryAddressCleanup({
      address: "全部事項証明書 東京都港区1-2",
    });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("certificate_meta");
    expect(p.cleanedAddress).toBe("東京都港区1-2");
  });

  it("除去で住所が空になれば null 化（cleanup・address は nullable）", () => {
    const p = decideRegistryAddressCleanup({ address: "受付第99号" });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBeNull();
  });

  // --- 監査専用（除去しない）類型 ---
  it("T8 不動産番号（ラベル付き13桁）は監査専用＝検出のみ・除去しない・manual", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都港区1-2 不動産番号1300012345678",
    });
    expect(p.detectedTypes).toContain("real_estate_number");
    expect(p.removableTypes).not.toContain("real_estate_number");
    expect(p.action).toBe("manual");
    expect(p.manualReviewRequired).toBe(true);
    expect(p.changed).toBe(false); // 除去しない
    expect(p.cleanedAddress).toBe("東京都港区1-2 不動産番号1300012345678");
  });

  it("T5 地番ラベルは監査専用（番地を消す危険ゆえ除去しない）", () => {
    const p = decideRegistryAddressCleanup({ address: "地番123番4" });
    expect(p.detectedTypes).toContain("parcel_label");
    expect(p.action).toBe("manual");
    expect(p.changed).toBe(false);
  });

  it("T10 床面積は監査専用", () => {
    const p = decideRegistryAddressCleanup({ address: "東京都港区1-2 床面積55.20㎡" });
    expect(p.detectedTypes).toContain("structure_area");
    expect(p.action).toBe("manual");
    expect(p.changed).toBe(false);
  });

  // --- 併存: 除去可能 + 監査専用 ---
  it("除去可能(受付番号)+監査専用(不動産番号)併存 → cleanup かつ manualReviewRequired", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都港区1-2 受付第5号 不動産番号1300012345678",
    });
    expect(p.action).toBe("cleanup");
    expect(p.changed).toBe(true);
    // 受付番号は除去、ラベル付き13桁は残す（監査）
    expect(p.cleanedAddress).toBe("東京都港区1-2 不動産番号1300012345678");
    expect(p.manualReviewRequired).toBe(true);
  });

  it("複数の除去可能類型を一括除去し、余分な空白を畳む", () => {
    const p = decideRegistryAddressCleanup({
      address: "東京都港区六本木1-2-3 令和3年10月15日 受付第12345号 持分2分の1",
    });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBe("東京都港区六本木1-2-3");
  });

  // --- MUST-FIX #1: 受付番号 regex の過検出防止（正当な「受付N号館/棟」を消さない） ---
  it("『受付3号館』は受付番号として検出しない（第なし＝住所の建物名を温存）", () => {
    const p = decideRegistryAddressCleanup({ address: "東京都中央区銀座1-1 受付3号館" });
    expect(p.action).toBe("none");
    expect(p.cleanedAddress).toBe("東京都中央区銀座1-1 受付3号館");
    expect(p.detectedTypes).not.toContain("receipt_number");
  });

  it("『受付1号棟』も温存（受付アンカー単独+第なしでは除去しない）", () => {
    const p = decideRegistryAddressCleanup({ address: "○○市1-2 受付1号棟 301" });
    expect(p.action).toBe("none");
    expect(p.cleanedAddress).toBe("○○市1-2 受付1号棟 301");
  });

  it("『受付 第12345 号』（第+号あり）は従来どおり除去", () => {
    const p = decideRegistryAddressCleanup({ address: "○○市1-2 受付 第12345 号" });
    expect(p.action).toBe("cleanup");
    expect(p.detectedTypes).toContain("receipt_number");
    expect(p.cleanedAddress).toBe("○○市1-2");
  });

  // --- SHOULD-FIX #4: 登記原因スパンは registration_date と二重計上しない ---
  it("登記原因スパンは registration_cause のみ（registration_date と二重検出しない）", () => {
    const p = decideRegistryAddressCleanup({
      address: "札幌市中央区北1条西2 令和3年10月15日売買",
    });
    expect(p.detectedTypes).toContain("registration_cause");
    expect(p.detectedTypes).not.toContain("registration_date");
  });

  it("日付単独（原因語なし）は registration_date を検出", () => {
    const p = decideRegistryAddressCleanup({
      address: "新宿区西新宿2-8-1 令和3年10月15日",
    });
    expect(p.detectedTypes).toContain("registration_date");
    expect(p.detectedTypes).not.toContain("registration_cause");
  });

  // --- SHOULD-FIX #5: 床面積は「床面積」アンカー必須（無アンカーの平米は拾わない） ---
  it("『80平米のマンション』は床面積として検出しない（無アンカー抑止）", () => {
    const p = decideRegistryAddressCleanup({ address: "東京都港区1-2 80平米のマンション" });
    expect(p.detectedTypes).not.toContain("structure_area");
    expect(p.action).toBe("none");
  });
});
