/**
 * 消費者向けひな型の実寸PNGを4種別ぶん描く(目視確認用・本番では使わない)。
 * 使い方: npx tsx scripts/sales-sheet-consumer-preview.ts <出力フォルダ>
 * 写真は色付きの仮画像を chromium で作って data: で埋め込む。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  buildSaleHouseDocument,
  buildSaleMansionDocument,
  buildSaleBuildingDocument,
  buildSaleLandDocument,
} from "../src/lib/sales-sheet/build-document";
import { renderDocumentToImage } from "../src/lib/sales-sheet/render-to-output";
import { findTableOverflows } from "../src/lib/sales-sheet/editor-document";
import type { SalesSheetDocument } from "../src/lib/sales-sheet/document-schema";

async function placeholders(specs: [label: string, w: number, h: number, color: string][]): Promise<{ fileUrl: string }[]> {
  const browser = await chromium.launch();
  try {
    const out: { fileUrl: string }[] = [];
    for (const [label, w, h, color] of specs) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.setContent(
        `<body style="margin:0;width:${w}px;height:${h}px;background:${color};display:flex;align-items:center;justify-content:center;font:bold 32px sans-serif;color:#fff">${label}</body>`,
      );
      out.push({ fileUrl: `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}` });
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("出力フォルダを指定してください");
  mkdirSync(outDir, { recursive: true });
  const photos = await placeholders([
    ["外観", 900, 600, "#5f7fa0"], ["リビング", 800, 600, "#a98865"], ["キッチン", 600, 800, "#6f9474"],
  ]);
  const [plan] = await placeholders([["間取り図", 700, 700, "#8f877b"]]);
  const footer = { transactionType: "専任媒介", compensation: "分かれ", adType: "広告可", staff: "山田" };
  const common = { photos, floorPlanImage: plan };

  const docs: [string, SalesSheetDocument][] = [
    ["house", buildSaleHouseDocument({
      ...common,
      property: { address: "東京都練馬区富士見台二丁目1-1", layoutType: "4LDK", zoningDistrict: "第一種中高層住居専用地域", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "5.0", occupancyStatus: "occupied" },
      overrides: {
        propertyType: "中古戸建", price: "6980", tax: "課税", taxAmount: "180", access: "西武池袋線「富士見台」駅 徒歩6分(約450m)",
        landArea: "100.12", areaMethod: "公簿", landRight: "所有権", privateRoad: "なし", landCategory: ["宅地"],
        buildingArea: "98.54", floor1Area: "50.20", floor2Area: "48.34", structure: "木造", aboveFloors: "2", parking: "有",
        builtYearMonth: "2008年3月", roadDirections: ["東"], cityPlanning: ["市街化区域"], areaZone: ["準防火地域"],
        buildingConfirm: "確認済", rebuild: "再建築可", equipment: "都市ガス・本下水・追焚", delivery: "相談", remarks: "2019年 外壁塗装",
        catchCopy: "駅徒歩6分・南向き4LDK・駐車場付", salesPoints: ["東側公道で陽当たり良好", "2019年に外壁塗装済み", "小学校まで徒歩5分"], ...footer,
      },
    })],
    ["mansion", buildSaleMansionDocument({
      ...common,
      property: { address: "東京都練馬区平和台一丁目2-3", roomNo: "503", exclusiveArea: "67.21", balconyArea: "9.80", layoutType: "3LDK", floorNo: 5, orientation: "南", managementFee: 12800, repairReserveFee: 15600, zoningDistrict: "近隣商業地域", occupancyStatus: "vacant" },
      building: { name: "平和台パークハウス", totalFloors: 11, builtYear: 2003, structureType: "RC", managementCompany: "〇〇管理", totalUnits: 48 },
      overrides: { propertyType: "中古マンション", price: "3980", access: "東京メトロ有楽町線「平和台」駅 徒歩5分", builtYearMonth: "2003年4月", parking: "空無", delivery: "即時", catchCopy: "駅徒歩5分・南向き3LDK", salesPoints: ["南向きバルコニー", "2022年に水回りリフォーム", "ペット飼育可"], ...footer },
    })],
    ["building", buildSaleBuildingDocument({
      ...common,
      property: { address: "東京都板橋区成増四丁目5-6", zoningDistrict: "第一種住居地域", buildingCoverageRatio: "60", floorAreaRatio: "200", roadType: "公道", roadWidth: "6.0", occupancyStatus: "occupied" },
      overrides: { propertyType: "一棟マンション", price: "18800", access: "東武東上線「成増」駅 徒歩9分", landArea: "165.28", areaMethod: "実測", totalFloorArea: "312.40", structure: "軽量鉄骨造", aboveFloors: "3", builtYearMonth: "1998年11月", totalUnits: "12", grossYield: "7.85", expectedIncome: "1476", catchCopy: "満室稼働中・想定利回り7.85%", salesPoints: ["全12戸 満室", "駅徒歩9分", "2021年 屋上防水"], ...footer },
    })],
    ["land", buildSaleLandDocument({
      ...common,
      property: { address: "東京都世田谷区上馬四丁目7-8", zoningDistrict: "第一種低層住居専用地域", buildingCoverageRatio: "50", floorAreaRatio: "100", roadType: "公道", roadWidth: "4.0", occupancyStatus: "vacant" },
      overrides: { propertyType: "売地", price: "8200", unitPrice: "210", access: "東急田園都市線「駒沢大学」駅 徒歩8分", landArea: "130.50", areaMethod: "実測", landCategory: ["宅地"], roadDirections: ["南"], buildCondition: "なし", delivery: "相談", catchCopy: "南道路・整形地", salesPoints: ["南道路で陽当たり良好", "建築条件なし", "整形地"], ...footer },
    })],
  ];

  for (const [name, doc] of docs) {
    writeFileSync(join(outDir, `${name}.png`), await renderDocumentToImage(doc, "png"));
    console.log(`${name}: overflow=${JSON.stringify(findTableOverflows(doc))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
