import { describe, it, expect } from "vitest";
import { parseAppraisalReport, trimToChome, normalizeSreText, APPRAISAL_PARSER_VERSION } from "../parse";

/**
 * 実物(SRE AI査定 CLOUD「不動産価格査定報告書」戸建・マンション・土地 2026-11-10 受領)の
 * pdf-parse 出力の並びを写した見本。
 * ⚠依頼者の氏名・所在地・物件名・担当者・事例はすべて架空。部首の文字(⻄ ⻑)・異体の字(戶)・
 *   タブ区切り・制御文字(\u0001)・目次の「物件詳細」・ページの区切りも実物どおり入れてある。
 */
const HEAD = (title: string) => [
  "山田 太郎 様",
  "不動産価格査定報告書",
  `(${title})`,
  "2026年8月24日",
  "株式会社サンプル不動産",
  "担当：見本 次郎",
  "ごあいさつ",
  "山田 太郎 様",
  "-- 1 of 49 --",
  "1.物件詳細",
  "2.本書の査定方法",
  "3.参考事例(戶建)",
];
const TAIL = [
  "※本書記載内容は、査定日現在のものです。その後の法令改正や市場動向に応じて変化する可能性がございます。",
  "株式会社サンプル不動産 16",
  "-- 16 of 49 --",
  "見本駅のマーケットデータ",
];

const HOUSE = [
  ...HEAD("東京都架空区見本町4丁目26-8"),
  "物件詳細",
  "所有地 \t東京都架空区見本町4丁目26-8",
  "交通 \t架空電鉄見本線「見本⼤橋駅」\u0001徒歩10分",
  "-",
  "土地面積 \t45.59m2\u0001(約13.79坪) \t土地権利 \t所有権",
  "接道状況 \t接道なし",
  "接道 \t-",
  "建蔽率 \t60% \t容積率 \t200%",
  "構造 \t木造(W)",
  "延床面積 \t64.32m2\u0001(約19.46坪)",
  "建築年月 \t1996年11月築",
  "間取り \t- \t階数 \t2階建(地上2階)",
  "特記事項 \t未接道地",
  "株式会社サンプル不動産 4",
  "",
  "本書の査定方法",
  "総合評価",
  "種別 \t合計 \t入力項目",
  "土地 \t-70 \t接道状況/方位",
  "建物 \t+0",
  "総評",
  "担当者も近くに住んでおりましたので周辺環境は熟知しております。",
  "査定結果",
  "東京都架空区見本町4丁目26-8",
  "査定結果 \t査定日:2026年8月24日",
  "スピードプラン",
  "早期売却を優先する方へお勧めするプランです。",
  "1,080 万円",
  "スタンダードプラン",
  "市場で反響がある現実的な販売価格で早期成約を目指",
  "すプランです。 \t1,280 万円",
  "チャレンジプラン",
  "成約時期が遅くなる恐れはありますが、より高値での",
  "販売を目指すプランです。 \t1,480 万円",
  "コメント",
  "これらを総合的に勘案し査定価格1400万円前後(土地293万/坪、建物4万/坪)と考えられます。",
  "株式会社サンプル不動産 15",
  "-- 15 of 49 --",
  "査定結果",
  "成約想定価格 \t1,304 万円 土地 1,214 万円 (\u000188万円/坪\u0001)",
  "建物 90 万円 (\u00014.6万円/坪\u0001)",
  "AI査定価格 \t4,137 万円 土地 4,047 万円 (\u0001293.5万円/坪\u0001)",
  "建物 90 万円 (\u00014.6万円/坪\u0001)",
  "物件評価",
  "ポイント",
  "土地評価 査定額の\u0001-70%",
  "(接道状況/方位)",
  "流通性比率 \t査定額\u0001+\u0001物件評価価格の\u0001±0%",
  ...TAIL,
].join("\n");

const MANSION = [
  ...HEAD("サンプルハイム"),
  "物件詳細",
  "名称 \tサンプルハイム",
  "所有地 \t東京都架空区⻄見本1丁目",
  "交通 \t架空線(快速)「⻄見本駅」\u0001徒歩9分",
  "-",
  "所在階 \t4階∕7階",
  "専有面積 \t67.21m2\u0001(約20.33坪)",
  "バルコニー面積 6.12m2",
  "間取り \t3LDK",
  "構造 \t鉄筋コンクリート(RC)",
  "建築年月 \t1972年9月築",
  "施工会社 \t⻑谷川見本",
  "特記事項 \t-",
  "",
  "査定結果 \t査定日:2026年3月20日",
  "スピードプラン",
  "早期売却 \t5,280 万円 259.7万円/坪",
  "スタンダード",
  "標準的な成約時期と価格 \t4,780 万円 235.1万円/坪",
  "チャレンジプラン",
  "販売価格を優先 \t5,780 万円 284.3万円/坪",
  "成約想定価格 \t5,152 万円\u0001(\u0001253.4万円/坪\u0001)",
  "AI査定価格 \t5,152 万円\u0001(\u0001253.4万円/坪\u0001)",
  ...TAIL,
].join("\n");

const LAND = [
  ...HEAD("東京都架空区見本本町5丁目9-15"),
  "物件詳細",
  "所有地 \t東京都架空区見本本町5丁目9-15",
  "交通 \t架空線「⻄小見本駅」\u0001徒歩4分",
  "-",
  "土地面積 \t42.17m2\u0001(約12.75坪) \t土地権利 \t所有権",
  "接道状況 \t一方",
  "接道 \t4m以上(幅員)\u00013m以上\u00015m未満(接面)\u0001南⻄\u0001公道",
  "特記事項 \t-",
  "株式会社サンプル不動産 4",
  "評価",
  "カテゴリ \t内容 \t評価 \t調整金額 \t備考",
  "土地 \t土地形状 \t-1 \t-100万円 \t間口より奥行きの方が⻑いため",
  "土地 \t日当り・通風 \t+1 \t+100万円 \t南⻄向き",
  "ご査定物件の特質等に応じて、営業部員が-5から+5までの評点を加えさせていただき、",
  "査定結果 \t査定日:2025年7月8日",
  "6,280\u0001万円",
  "492.3万円/坪",
  "6,580\u0001万円",
  "515.8万円/坪",
  "成約想定価格 \t6,114 万円\u0001(\u0001479.3万円/坪\u0001)",
  "AI査定価格 \t5,823 万円\u0001(\u0001456.5万円/坪\u0001)",
  "物件評価",
  "ポイント",
  "土地評価 査定額の\u0001+0万円",
  "(土地形状、日当り・通風)",
  "流通性比率 \t査定額\u0001+\u0001物件評価価格の\u0001+5%",
  ...TAIL,
].join("\n");

describe("parseAppraisalReport(査定報告書から資料の数字を読む)", () => {
  it("戸建: 成約想定価格・AI査定価格の土地と建物、3案、土地の補正を読む", () => {
    const r = parseAppraisalReport(HOUSE);
    expect(r.parserVersion).toBe(APPRAISAL_PARSER_VERSION);
    expect(r.source).toBe("sre");
    expect(r.kind).toBe("house");
    expect(r.appraisedOn).toBe("2026-08-24");
    expect(r.station).toBe("見本大橋駅");
    expect(r.walkMinutes).toBe(10);
    expect(r.landSqm).toBe(45.59);
    expect(r.landTsubo).toBe(13.79);
    expect(r.floorSqm).toBe(64.32);
    expect(r.builtYearMonth).toBe("1996-11");
    expect(r.roadAccess).toBe("接道なし");
    expect(r.roadDetail).toBeNull();
    expect(r.notes).toBe("未接道地");
    expect(r.expected).toEqual({ total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 });
    expect(r.ai).toEqual({ total: 4137, tsubo: null, land: 4047, landTsubo: 293.5, building: 90, buildingTsubo: 4.6 });
    expect(r.plans).toEqual([
      { name: "speed", price: 1080, tsubo: null },
      { name: "standard", price: 1280, tsubo: null },
      { name: "challenge", price: 1480, tsubo: null },
    ]);
    expect(r.range).toBeNull();
    expect(r.adjustment.landPercent).toBe(-70);
    expect(r.adjustment.landAmount).toBeNull();
    expect(r.adjustment.landReason).toBe("接道状況/方位");
    expect(r.adjustment.liquidityPercent).toBe(0);
    expect(r.adjustment.items).toEqual([{ category: "土地", label: "接道状況/方位", score: -70, amount: null }]);
    expect(r.warnings).toEqual([]);
  });

  it("コメントの「査定価格1400万円前後」を3案の価格に取り違えない", () => {
    const r = parseAppraisalReport(HOUSE);
    expect(r.plans.map((p) => p.price)).not.toContain(1400);
  });

  it("マンション: 総額と坪単価、3案の坪単価を読み、部首の字を直す", () => {
    const r = parseAppraisalReport(MANSION);
    expect(r.kind).toBe("mansion");
    expect(r.area).toBe("東京都架空区西見本1丁目");
    expect(r.station).toBe("西見本駅");
    expect(r.railLine).toBe("架空線(快速)");
    expect(r.exclusiveSqm).toBe(67.21);
    expect(r.layout).toBe("3LDK");
    expect(r.floorInfo).toBe("4階/7階");
    expect(r.expected).toEqual({ total: 5152, tsubo: 253.4, land: null, landTsubo: null, building: null, buildingTsubo: null });
    expect(r.ai.total).toBe(5152);
    expect(r.plans).toEqual([
      { name: "speed", price: 5280, tsubo: 259.7 },
      { name: "standard", price: 4780, tsubo: 235.1 },
      { name: "challenge", price: 5780, tsubo: 284.3 },
    ]);
  });

  it("マンション: スタンダードがスピードより安いときは plan_order で知らせる(直さない)", () => {
    const r = parseAppraisalReport(MANSION);
    expect(r.warnings).toContain("plan_order");
    expect(r.plans.find((p) => p.name === "standard")?.price).toBe(4780);
  });

  it("土地: 3案ではなく価格の幅、評価の表、流通性比率を読む", () => {
    const r = parseAppraisalReport(LAND);
    expect(r.kind).toBe("land");
    expect(r.appraisedOn).toBe("2025-07-08");
    expect(r.roadDetail).toBe("4m以上(幅員) 3m以上 5m未満(接面) 南西 公道");
    expect(r.plans).toEqual([]);
    expect(r.range).toEqual({ min: 6280, max: 6580, minTsubo: 492.3, maxTsubo: 515.8 });
    expect(r.expected.total).toBe(6114);
    expect(r.expected.tsubo).toBe(479.3);
    expect(r.ai.total).toBe(5823);
    expect(r.adjustment.landAmount).toBe(0);
    expect(r.adjustment.landPercent).toBeNull();
    expect(r.adjustment.liquidityPercent).toBe(5);
    expect(r.adjustment.items).toEqual([
      { category: "土地", label: "土地形状", score: -1, amount: -100 },
      { category: "土地", label: "日当り・通風", score: 1, amount: 100 },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("依頼者の氏名・番地・担当者・総評は結果に入れない", () => {
    for (const text of [HOUSE, MANSION, LAND]) {
      const json = JSON.stringify(parseAppraisalReport(text));
      expect(json).not.toContain("山田");
      expect(json).not.toContain("様");
      expect(json).not.toContain("26-8");
      expect(json).not.toContain("9-15");
      expect(json).not.toContain("見本 次郎");
      expect(json).not.toContain("熟知");
      expect(json).not.toContain("サンプルハイム");
    }
  });

  it("SRE の書式でない・数字が無いときは warnings で知らせる", () => {
    const r = parseAppraisalReport("見積書\n合計 100万円");
    expect(r.source).toBe("unknown");
    expect(r.kind).toBeNull();
    expect(r.warnings).toEqual(
      expect.arrayContaining(["not_sre", "unknown_kind", "missing_expected", "missing_ai", "missing_plans"]),
    );
  });

  it("目次の「1.物件詳細」だけでは物件詳細を読まない", () => {
    const r = parseAppraisalReport(["不動産価格査定報告書", "1.物件詳細", "所有地 \t東京都架空区1丁目"].join("\n"));
    expect(r.area).toBeNull();
  });
});

describe("価格の幅とコメント(@codex #690)", () => {
  it("価格の幅のあとのコメントの金額を上限に取り違えない", () => {
    const text = LAND.replace(
      "成約想定価格 \t6,114",
      ["コメント", "査定価格6400万円前後と考えられます。", "成約想定価格 \t6,114"].join("\n"),
    );
    const r = parseAppraisalReport(text);
    expect(r.range).toEqual({ min: 6280, max: 6580, minTsubo: 492.3, maxTsubo: 515.8 });
  });
  it("金額が3つ以上並んで何の幅か分からないときは読まず missing_plans で知らせる", () => {
    const text = LAND.replace("515.8万円/坪", "515.8万円/坪\n6,900\u0001万円");
    const r = parseAppraisalReport(text);
    expect(r.range).toBeNull();
    expect(r.warnings).toContain("missing_plans");
  });
});

describe("trimToChome(所在地を町丁目までにする)", () => {
  it.each([
    ["東京都架空区見本町4丁目26-8", "東京都架空区見本町4丁目"],
    ["東京都架空区見本町4丁目", "東京都架空区見本町4丁目"],
    ["東京都架空区見本町2-3-4", "東京都架空区見本町"],
    ["東京都架空区見本町", "東京都架空区見本町"],
    ["東京都架空区見本町四丁目二十六番八号", "東京都架空区見本町四丁目"],
    ["東京都架空区六本木見本1-2-3", "東京都架空区六本木見本"],
  ])("%s → %s", (input, out) => {
    expect(trimToChome(input)).toBe(out);
  });
  it("空・null は null", () => {
    expect(trimToChome(null)).toBeNull();
    expect(trimToChome("12-3")).toBeNull();
  });
});

describe("normalizeSreText", () => {
  it("部首・異体の字と制御文字を直す", () => {
    expect(normalizeSreText("⻄荻\u0001⻑谷川\u0001戶建 ⼤橋")).toBe("西荻 長谷川 戸建 大橋");
  });
});
