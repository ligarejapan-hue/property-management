/**
 * 受付帳×所有者 2ファイル突合の通し検証スクリプト。
 * - 実CSVが手元に無いため、実務パターンを反映した合成CSVで通し検証する
 * - 純粋ヘルパ (reception-owner-match) を直接呼ぶ → DB依存なし
 *
 * 使い方: npx tsx scripts/validate-reception-owner.ts
 */

import {
  parseReceptionRows,
  parseOwnerRows,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  type PropertyCandidate,
} from "../src/lib/reception-owner-match";
import { parseCsv } from "../src/lib/csv-parser";

const RECEPTION_HEADERS = [
  "受付番号", "受付日", "依頼者", "電話", "区分コード",
  "F_種別", "G_受付担当", "H_都道府県", "I_市区町村", "J_町丁目", "K_番地",
];

function buildReceptionCsv(): string {
  const rows: string[][] = [RECEPTION_HEADERS];
  // 50 土地
  for (let i = 0; i < 50; i++) {
    rows.push([
      `R${1000 + i}`, "2026-04-20", `依頼者${i}`, "090-0000-0000", "L",
      "土地", "担当A",
      "東京都", "港区",
      `芝${(i % 5) + 1}-${(i % 3) + 1}-${(i % 7) + 1}`,
      `${100 + i}`,
    ]);
  }
  // 30 建物
  for (let i = 0; i < 30; i++) {
    rows.push([
      `R${2000 + i}`, "2026-04-20", `依頼者B${i}`, "", "B",
      "建物", "担当B",
      "大阪府", "北区",
      `梅田${(i % 4) + 1}-${(i % 5) + 1}`,
      `${300 + i}`,
    ]);
  }
  // 15 区分
  for (let i = 0; i < 15; i++) {
    rows.push([
      `R${3000 + i}`, "2026-04-20", `依頼者C${i}`, "", "C",
      "区分", "担当C",
      "東京都", "渋谷区",
      `道玄坂${(i % 3) + 1}`,
      `A-${100 + i}`,
    ]);
  }
  // 10 未定
  for (let i = 0; i < 10; i++) {
    rows.push([
      `R${4000 + i}`, "2026-04-20", `依頼者D${i}`, "", "X",
      "未定", "担当D",
      "北海道", "札幌市",
      `北区北${i}`,
      `${500 + i}`,
    ]);
  }
  // 5 表記ゆれ
  for (let i = 0; i < 5; i++) {
    rows.push([
      `R${5000 + i}`, "2026-04-20", `依頼者E${i}`, "", "L",
      "土地", "担当E",
      "東京都", "港区",
      `芝１－２－${i + 1}`,
      `１００${i}`,
    ]);
  }
  return rows.map((r) => r.join(",")).join("\n");
}

const OWNER_HEADERS = ["所有者ID", "登録日", "所在地", "氏名", "住所", "建物名", "部屋番号"];

function buildOwnerCsv(): string {
  const rows: string[][] = [OWNER_HEADERS];
  // 40 所有者あり（土地）+ 8 共有名義
  for (let i = 0; i < 40; i++) {
    const cColumn = `東京都港区芝${(i % 5) + 1}-${(i % 3) + 1}-${(i % 7) + 1}${100 + i}`;
    rows.push([`O${i}`, "2026-04-20", cColumn, `山田太郎${i}`, "東京都港区", "", ""]);
    if (i % 5 === 0) {
      rows.push([`O${i}b`, "2026-04-20", cColumn, `山田花子${i}`, "東京都港区", "", ""]);
    }
  }
  // 25 建物
  for (let i = 0; i < 25; i++) {
    const cColumn = `大阪府北区梅田${(i % 4) + 1}-${(i % 5) + 1}${300 + i}`;
    rows.push([`O${i + 100}`, "2026-04-20", cColumn, `田中一郎${i}`, "大阪府北区", "XXビル", ""]);
  }
  // 10 区分
  for (let i = 0; i < 10; i++) {
    const cColumn = `東京都渋谷区道玄坂${(i % 3) + 1}A-${100 + i}`;
    rows.push([`O${i + 200}`, "2026-04-20", cColumn, `鈴木二郎${i}`, "東京都渋谷区", "YYマンション", `${101 + i}`]);
  }
  // 5 未定（所有者は拾えるがF不明で物件未特定）
  for (let i = 0; i < 5; i++) {
    const cColumn = `北海道札幌市北区北${i}${500 + i}`;
    rows.push([`O${i + 300}`, "2026-04-20", cColumn, `佐藤三郎${i}`, "北海道札幌市", "", ""]);
  }
  // 5 表記ゆれ（半角＋空白）
  for (let i = 0; i < 5; i++) {
    const cColumn = `東京都港区芝1-2-${i + 1} 100${i}`;
    rows.push([`O${i + 400}`, "2026-04-20", cColumn, `高橋${i}`, "東京都港区", "", ""]);
  }
  // 10 ノイズ（受付帳に無い）
  for (let i = 0; i < 10; i++) {
    rows.push([
      `O${i + 500}`, "2026-04-20",
      `沖縄県那覇市${i}`,
      `未紐付${i}`, "沖縄県那覇市", "", "",
    ]);
  }
  return rows.map((r) => r.join(",")).join("\n");
}

function buildExistingProperties(): PropertyCandidate[] {
  const ps: PropertyCandidate[] = [];
  // 土地 35 件（一意）
  for (let i = 0; i < 35; i++) {
    ps.push({
      id: `p-land-${i}`,
      address: `東京都港区芝${(i % 5) + 1}-${(i % 3) + 1}-${(i % 7) + 1}`,
      lotNumber: `${100 + i}`,
      buildingNumber: null,
      buildingName: null,
      roomNo: null,
    });
  }
  // 土地重複 3 組 → matched → multiple（最初の 3 件と同じ lotNumber）
  for (let i = 0; i < 3; i++) {
    ps.push({
      id: `p-land-dup-${i}`,
      address: `東京都港区芝（重複）`,
      lotNumber: `${100 + i}`,
      buildingNumber: null,
      buildingName: null,
      roomNo: null,
    });
  }
  // 建物 20 件
  for (let i = 0; i < 20; i++) {
    ps.push({
      id: `p-bldg-${i}`,
      address: `大阪府北区梅田`,
      lotNumber: null,
      buildingNumber: `${300 + i}`,
      buildingName: "XXビル",
      roomNo: null,
    });
  }
  // 区分 8 件
  for (let i = 0; i < 8; i++) {
    ps.push({
      id: `p-unit-${i}`,
      address: `東京都渋谷区道玄坂`,
      lotNumber: null,
      buildingNumber: `A-${100 + i}`,
      buildingName: "YYマンション",
      roomNo: null,
    });
  }
  // 表記ゆれ 3 件（保存は半角）
  for (let i = 0; i < 3; i++) {
    ps.push({
      id: `p-full-${i}`,
      address: "東京都港区芝",
      lotNumber: `100${i}`,
      buildingNumber: null,
      buildingName: null,
      roomNo: null,
    });
  }
  return ps;
}

// ---------- 実行 ----------

function toPositional(headers: string[], rows: readonly Record<string, string>[]): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

const recParsed = parseCsv(buildReceptionCsv());
const ownParsed = parseCsv(buildOwnerCsv());

const receptionRows = parseReceptionRows(
  toPositional(recParsed.headers, recParsed.rows),
);
const ownerRows = parseOwnerRows(
  ownParsed.headers,
  toPositional(ownParsed.headers, ownParsed.rows),
);
const properties = buildExistingProperties();
const combined = buildCombinedMatches(receptionRows, ownerRows, properties);
const summary = summarizeMatches(receptionRows, ownerRows.length, combined);

const reasonCounts: Record<string, number> = {
  ok: 0,
  owner_unmatched: 0,
  property_not_found: 0,
  property_multiple: 0,
  property_no_key: 0,
};
const byFColumn: Record<string, Record<string, number>> = {};
const sampleByReason: Record<string, string[]> = {};
for (const c of combined) {
  const r = getReviewReason(c);
  const key = r ?? "ok";
  reasonCounts[key]++;
  if (r) {
    const f = c.reception.fColumn || "(空)";
    byFColumn[f] = byFColumn[f] ?? {};
    byFColumn[f][r] = (byFColumn[f][r] ?? 0) + 1;
    sampleByReason[r] = sampleByReason[r] ?? [];
    if (sampleByReason[r].length < 3) {
      sampleByReason[r].push(
        `row=${c.reception.rowNumber} F=${c.reception.fColumn} K=${c.reception.kColumn} key=${c.reception.matchKey}`,
      );
    }
  }
}

const ownerShared = combined.filter((c) => c.owners.length > 1).length;
const ownerMatched = combined.filter((c) => c.owners.length > 0).length;

const out = {
  受付帳件数: summary.receptionCount,
  所有者件数: summary.ownerCount,
  所有者一致_1人以上: ownerMatched,
  共有名義_2人以上: ownerShared,
  所有者未突合: summary.ownerUnmatchedCount,
  物件一意特定: summary.propertyMatchedCount,
  物件未特定: summary.propertyNotFoundCount,
  物件複数候補: summary.propertyMultipleCount,
  物件キー不足: summary.propertyNoKeyCount,
};

console.log("=== 集計 ===");
for (const [k, v] of Object.entries(out)) console.log(`${k}: ${v}`);

console.log("\n=== 要レビュー理由内訳 ===");
for (const [k, v] of Object.entries(reasonCounts)) console.log(`  ${k}: ${v}`);

console.log("\n=== F列 × 要レビュー理由 ===");
for (const [f, obj] of Object.entries(byFColumn)) {
  console.log(`  F=${f}: ${JSON.stringify(obj)}`);
}

console.log("\n=== サンプル ===");
for (const [r, list] of Object.entries(sampleByReason)) {
  console.log(`[${r}]`);
  for (const s of list) console.log(`  ${s}`);
}
