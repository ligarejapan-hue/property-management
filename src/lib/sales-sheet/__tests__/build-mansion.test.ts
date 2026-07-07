import { describe, it, expect } from "vitest";
import { buildSaleMansionDocument } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";
import { mapOccupancyStatusToMansionOccupancy } from "../occupancy";

const base = {
  property: {
    address: "東京都杉並区西荻北1-4-3",
    zoningDistrict: "第一種中高層住居専用地域",
    exclusiveArea: "67.21",
    layoutType: "3LDK",
    occupancyStatus: "vacant",
  },
  building: { name: "西荻リリエンハイム", totalFloors: 7, builtYear: 1972, structureType: "RC" },
  photos: [{ fileUrl: "/uploads/a.jpg" }],
};

// 既存 build-document-templates.test.ts の tableRow/texts/imageCount と同じ緩い型で
// element 配列を検査するローカルヘルパ（このファイル固有・他ビルダーには使わない）。
const tableRow = (doc: { elements: unknown[] }, label: string): string | undefined => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") {
      const r = el.rows?.find((row) => row.label === label);
      if (r) return r.value;
    }
  }
  return undefined;
};
const tableLabels = (doc: { elements: unknown[] }): string[] => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") return (el.rows ?? []).map((row) => row.label);
  }
  return [];
};
const imageCount = (doc: { elements: { type: string }[] }) =>
  doc.elements.filter((e) => e.type === "image").length;

const findEl = (doc: { elements: unknown[] }, id: string) =>
  (doc.elements as { id: string }[]).find((e) => e.id === id);

describe("buildSaleMansionDocument（自社マイソク様式）", () => {
  it("スペック表に主要行が入り、キャッチ帯要素を含む", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { price: "6590", tax: "不課税", catchCopy: "北東角部屋" },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("用途地域");
    expect(labels).toContain("専有面積");
    expect(labels).not.toContain("うち消費税"); // 不課税
    // キャッチ帯(shape or text)が存在
    expect(doc.elements.some((e) => e.type === "shape")).toBe(true);
    expect(doc.elements.some((e) => e.type === "text" && e.content.includes("北東角部屋"))).toBe(true);
  });

  it("課税ならうち消費税行が出る", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { price: "6590", tax: "課税", taxAmount: "300" },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("うち消費税");
    expect(tableRow(doc, "うち消費税")).toBe("300万円");
  });

  it("会社セクション(取引態様/報酬/広告/担当/取引士/特記)はスペック表の行にならず、フッターに出す", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: {
        transactionType: "専任媒介",
        compensation: "分かれ",
        adType: "広告可",
        staff: "山田",
        agent: "佐藤",
        specialNotes: "ペット相談可",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).not.toContain("取引態様");
    expect(labels).not.toContain("報酬");
    expect(labels).not.toContain("広告");
    expect(labels).not.toContain("担当者");
    expect(labels).not.toContain("取引士");
    expect(labels).not.toContain("特記事項");
    const json = JSON.stringify(doc.elements);
    expect(json).toContain("専任媒介");
    expect(json).toContain("山田");
    expect(json).toContain("ペット相談可");
  });

  it("用途地域は自動反映(zoningDistrict)+overridesの追加選択を併記する", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { useDistrict: ["近隣商業地域"] },
    });
    expect(tableRow(doc, "用途地域")).toBe("第一種中高層住居専用地域 / 近隣商業地域");
  });

  it("築年月はoverride優先、無ければbuilding.builtYearから自動反映", () => {
    const auto = buildSaleMansionDocument({ ...base, overrides: {} });
    expect(tableRow(auto, "築年月")).toBe("1972年");
    const overridden = buildSaleMansionDocument({
      ...base,
      overrides: { builtYearMonth: "1972年5月" },
    });
    expect(tableRow(overridden, "築年月")).toBe("1972年5月");
  });

  it("管理費/修繕積立金/所在階/地上階/現況を自動反映して整形する", () => {
    const doc = buildSaleMansionDocument({
      property: {
        ...base.property,
        floorNo: 4,
        managementFee: 12000,
        repairReserveFee: 8500,
        occupancyStatus: "occupied",
      },
      building: { ...base.building, managementCompany: "リガーレ管理", totalUnits: 24 },
      photos: base.photos,
    });
    expect(tableRow(doc, "管理費")).toBe("12,000円/月");
    expect(tableRow(doc, "修繕積立金")).toBe("8,500円/月");
    expect(tableRow(doc, "所在階")).toBe("4階");
    expect(tableRow(doc, "地上階")).toBe("7階");
    expect(tableRow(doc, "総戸数")).toBe("24戸");
    expect(tableRow(doc, "管理会社")).toBe("リガーレ管理");
    // mapOccupancyStatusToMansionOccupancy(occupied) = "居住中"（売マンションの選択肢語彙。
    // 旧: localizeOccupancy(occupied) = "入居中" だった → @codex P2 fix で語彙を統一）。
    expect(tableRow(doc, "現況")).toBe("居住中");
  });

  it("物件種目(propertyType)は自動反映元が無く、overrideのみで反映される([T4→T5]で新規配線)", () => {
    const withOverride = buildSaleMansionDocument({
      ...base,
      overrides: { propertyType: "中古マンション" },
    });
    expect(tableRow(withOverride, "物件種目")).toBe("中古マンション");
    const withoutOverride = buildSaleMansionDocument({ ...base, overrides: {} });
    expect(tableRow(withoutOverride, "物件種目")).toBe("");
  });

  it("現況(occupancy)はoverride優先、無ければmapOccupancyStatusToMansionOccupancyの決定的デフォルト(@codex P2 fix: 売マンションの選択肢語彙に統一)", () => {
    const overridden = buildSaleMansionDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: { occupancy: "賃貸中" },
    });
    expect(tableRow(overridden, "現況")).toBe("賃貸中");
    const auto = buildSaleMansionDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: {},
    });
    // mapOccupancyStatusToMansionOccupancy(vacant) = "空家"。
    // 旧: localizeOccupancy(vacant) = "空室"（マイソクの選択肢[居住中/空家/賃貸中/未完成]に無い語彙だった）。
    expect(tableRow(auto, "現況")).toBe("空家");
  });

  it.each([
    ["vacant", "空家"],
    ["occupied", "居住中"],
  ] as const)(
    "現況(%s): overrideを省略した作成は、作成ダイアログが自動反映値をoverrideとして明示送信した場合と同じ現況(%s)になる(@codex P2: フェッチのタイミング非依存の直接検証)",
    (occupancyStatus, expected) => {
      // 「フェッチが submit に間に合わなかった/未指定」ケース = overrides.occupancy 省略。
      const withoutOverride = buildSaleMansionDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: {},
      });
      // 「フェッチが submit に間に合い、ダイアログが自動反映値をoverrideとして送った」ケース
      // = 作成ダイアログ(SalesSheetCreateButton.tsx)と同一の共有関数で求めた値を明示的に送る。
      const withAutoSeededOverride = buildSaleMansionDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: { occupancy: mapOccupancyStatusToMansionOccupancy(occupancyStatus) },
      });
      expect(tableRow(withoutOverride, "現況")).toBe(expected);
      // タイミングに関わらず同一物件は同一の現況になる（本 P2 fix の核心）。
      expect(tableRow(withoutOverride, "現況")).toBe(tableRow(withAutoSeededOverride, "現況"));
    },
  );

  it("専有面積は面積計測方式(壁芯/内法)を括弧書きで併記する(@codex P2 fix: 従来はcontrolOnlyのため選択値が図面から消えていた)", () => {
    const withMethod = buildSaleMansionDocument({
      ...base,
      overrides: { areaMethod: "壁芯" },
    });
    expect(tableRow(withMethod, "専有面積")).toBe("67.21㎡（壁芯）");

    const withOtherMethod = buildSaleMansionDocument({
      ...base,
      overrides: { areaMethod: "内法" },
    });
    expect(tableRow(withOtherMethod, "専有面積")).toBe("67.21㎡（内法）");
  });

  it("専有面積は面積計測方式が未選択なら括弧を付けない", () => {
    const withoutMethod = buildSaleMansionDocument({ ...base, overrides: {} });
    expect(tableRow(withoutMethod, "専有面積")).toBe("67.21㎡");
  });

  it("専有面積が無ければ、面積計測方式の指定有無に関わらず空文字", () => {
    const noArea = buildSaleMansionDocument({
      ...base,
      property: { ...base.property, exclusiveArea: null },
      overrides: { areaMethod: "内法" },
    });
    expect(tableRow(noArea, "専有面積")).toBe("");
  });

  it("写真3枚→image要素3、0枚→0", () => {
    const photos3 = [
      { fileUrl: "/uploads/1.jpg" },
      { fileUrl: "/uploads/2.jpg" },
      { fileUrl: "/uploads/3.jpg" },
    ];
    expect(imageCount(buildSaleMansionDocument({ ...base, photos: photos3 }))).toBe(3);
    expect(imageCount(buildSaleMansionDocument({ ...base, photos: [] }))).toBe(0);
  });

  it("間取り画像を渡すと image 要素が追加される(任意・未指定なら追加されない)", () => {
    const withPlan = buildSaleMansionDocument({
      ...base,
      floorPlanImage: { fileUrl: "/uploads/plan.jpg" },
    });
    const withoutPlan = buildSaleMansionDocument({ ...base });
    expect(withPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(true);
    expect(withoutPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(
      false,
    );
    expect(salesSheetDocumentSchema.safeParse(withPlan).success).toBe(true);
  });

  it("会社定数(COMPANY)がフッターに含まれる", () => {
    const doc = buildSaleMansionDocument({ ...base });
    expect(JSON.stringify(doc.elements)).toContain("株式会社リガーレジャパン");
  });

  it("価格にすでに「万円」が付いていても二重化しない(売土地と共有するfmtManYenのガード・@codex Important fix)", () => {
    const doc = buildSaleMansionDocument({ ...base, overrides: { price: "6590万円" } });
    expect(findEl(doc, "price")).toMatchObject({ content: "6590万円" });
  });

  // 版面レイアウトを buildSpecSheetDocument へ抽出する前の固定（特性化テスト）。
  // catch-band/catch-copy/heading/price/overview/sales-points/company/company-details の
  // id・座標(x/y/w/h/z)・スタイルが既知値であることを固定し、抽出後もこの値が
  // 変わらないことを保証する（[F2-A Task1]）。
  it("レイアウト: catch-band/heading/price/overview/sales-points/company/company-details のid・座標・スタイルが既知値(抽出前の固定・リグレッション用)", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: {
        price: "6590",
        catchCopy: "北東角部屋",
        salesPoints: ["リノベ済"],
        transactionType: "専任媒介",
      },
    });

    expect(findEl(doc, "catch-band")).toMatchObject({
      type: "shape",
      x: 10,
      y: 8,
      w: 277,
      h: 16,
      z: 1,
      shape: "rect",
      fill: "#15324f",
    });

    expect(findEl(doc, "catch-copy")).toMatchObject({
      type: "text",
      x: 16,
      y: 8,
      w: 265,
      h: 16,
      z: 2,
      content: "北東角部屋",
      style: { fontSizePt: 13, bold: true, color: "#ffffff", align: "center" },
    });

    expect(findEl(doc, "heading")).toMatchObject({
      type: "text",
      x: 10,
      y: 26,
      w: 94,
      h: 7,
      z: 2,
      content: "西荻リリエンハイム",
      style: { fontSizePt: 11, bold: true, color: "#15324f" },
    });

    expect(findEl(doc, "price")).toMatchObject({
      type: "text",
      x: 10,
      y: 33,
      w: 94,
      h: 12,
      z: 2,
      content: "6590万円",
      style: { fontSizePt: 20, bold: true, color: "#d0331a" },
    });

    expect(findEl(doc, "overview")).toMatchObject({
      type: "table",
      x: 150,
      y: 26,
      w: 137,
      h: 167,
      z: 1,
      style: { fontSizePt: 7, borderColor: "#cccccc", labelColor: "#15324f" },
    });

    expect(findEl(doc, "sales-points")).toMatchObject({
      type: "text",
      x: 10,
      y: 187,
      w: 136,
      h: 7,
      z: 2,
      content: "◆リノベ済",
      style: { fontSizePt: 9, bold: true, color: "#15324f" },
    });

    expect(findEl(doc, "company")).toMatchObject({
      type: "text",
      x: 10,
      y: 195,
      w: 277,
      h: 6,
      z: 2,
      content: "株式会社リガーレジャパン Ligare Japan　TEL 03-6823-2760",
      style: { fontSizePt: 9, color: "#15324f" },
    });

    expect(findEl(doc, "company-details")).toMatchObject({
      type: "text",
      x: 10,
      y: 201,
      w: 277,
      h: 7,
      z: 2,
      content: "取引態様：専任媒介",
      style: { fontSizePt: 8, color: "#15324f" },
    });
  });

  it("A4横で schema 検証を通る（保存可能な document）", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: {
        price: "6590",
        tax: "課税",
        taxAmount: "300",
        catchCopy: "駅近角部屋",
        salesPoints: ["リノベ済", "南向き", "即入居可"],
      },
    });
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
