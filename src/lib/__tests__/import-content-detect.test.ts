/**
 * B-11 (UI総点検): 取込ファイル種別の内容(列構成)ベース判定。
 *
 * - 受付帳: ヘッダ行の位置固定指紋 (H=都道府県/都道府県名, I=区/市区町村) または
 *   F列位置の区分値 (土地/建物/区分/区建/共担)
 * - 所有者: 所有者系ヘッダ名 (所有者氏名/物件住所 等)
 * - resolveImportFileType: 内容判定を最優先し、ファイル名は補助シグナルに降格。
 *   取り違え (中身がもう一方の形式) だけを明確なエラーにする。
 */
import { describe, it, expect } from "vitest";
import {
  detectImportFileTypeFromContent,
  resolveImportFileType,
} from "@/lib/import-content-detect";

// ---------- fixtures ----------

// 受付帳: ヘッダ行あり (H=都道府県, I=区)
const RECEPTION_HEADERS = [
  "No",
  "DL",
  "受付日",
  "受付番号",
  "新既",
  "区分",
  "備考",
  "都道府県",
  "区",
  "住所",
  "地番",
  "他",
];
const RECEPTION_ROWS: string[][] = [
  ["1", "〇", "2026/07/01", "123", "既", "土地", "", "東京都", "北区", "1-2", "3-4", ""],
  ["2", "", "2026/07/02", "124", "新", "建物", "", "東京都", "南区", "5-6", "7-8", ""],
];

// 受付帳: ヘッダ行なし (1行目からデータ。parseSheet は1行目をヘッダ扱いするため
// headers にデータが入るケース) → F列位置の区分値で判定
const HEADERLESS_RECEPTION_HEADERS = [
  "1",
  "〇",
  "2026/07/01",
  "123",
  "既",
  "土地",
  "",
  "東京都",
  "北区",
  "1-2",
  "3-4",
  "",
];
const HEADERLESS_RECEPTION_ROWS: string[][] = [
  ["2", "", "2026/07/02", "124", "新", "区建", "", "東京都", "南区", "5-6", "7-8", ""],
];

// 所有者: 特徴ヘッダ (物件住所 / 所有者市区郡 など)
const OWNER_HEADERS = [
  "No",
  "氏名",
  "物件住所",
  "都道府県",
  "所有者市区郡",
  "所有者住所",
  "建物名",
  "〒",
  "DM",
];
const OWNER_ROWS: string[][] = [
  ["1", "山田太郎", "東京都北区1-2 3-4", "東京都", "北区", "9-9", "", "1140000", "可"],
];

// 物件CSV (取込ウィザード用・所有者と誤認してはいけない)
const PROPERTY_CSV_HEADERS = ["住所", "郵便番号", "地番", "家屋番号", "備考"];
const PROPERTY_CSV_ROWS: string[][] = [["東京都北区1-2", "1140000", "3-4", "", ""]];

// 何の指紋もない一般CSV
const GENERIC_HEADERS = ["日付", "金額", "メモ"];
const GENERIC_ROWS: string[][] = [["2026/07/01", "1000", "テスト"]];

// ---------- detectImportFileTypeFromContent ----------

describe("detectImportFileTypeFromContent", () => {
  it("受付帳ヘッダ指紋 (H=都道府県, I=区) で reception", () => {
    const r = detectImportFileTypeFromContent(RECEPTION_HEADERS, RECEPTION_ROWS);
    expect(r.type).toBe("reception");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("ヘッダ行なし受付帳も F列位置の区分値で reception (1行目=データのフラグ付き)", () => {
    const r = detectImportFileTypeFromContent(
      HEADERLESS_RECEPTION_HEADERS,
      HEADERLESS_RECEPTION_ROWS,
    );
    expect(r.type).toBe("reception");
    // ヘッダ扱いされた 1 行目をデータへ戻す必要があることを呼び出し側へ伝える
    expect(r.receptionHeaderRowIsData).toBe(true);
  });

  it("ヘッダ行あり受付帳では 1 行目=データのフラグは立たない", () => {
    const r = detectImportFileTypeFromContent(RECEPTION_HEADERS, RECEPTION_ROWS);
    expect(r.type).toBe("reception");
    expect(r.receptionHeaderRowIsData).toBe(false);
  });

  it("所有者系ヘッダ (所有者氏名/物件住所 等) で owner", () => {
    const r = detectImportFileTypeFromContent(OWNER_HEADERS, OWNER_ROWS);
    expect(r.type).toBe("owner");
  });

  it("強い所有者ヘッダが無くても 氏名+弱ヘッダ3種以上で owner", () => {
    const r = detectImportFileTypeFromContent(
      ["氏名", "住所", "郵便番号", "DM"],
      [["山田", "東京都", "1140000", "可"]],
    );
    expect(r.type).toBe("owner");
  });

  it("物件CSV (住所/郵便番号/地番) を owner と誤認しない", () => {
    const r = detectImportFileTypeFromContent(
      PROPERTY_CSV_HEADERS,
      PROPERTY_CSV_ROWS,
    );
    expect(r.type).toBe("unknown");
  });

  it("標準物件CSV (種別列に 土地/区分) を reception と誤認しない (@codex #309 P1)", () => {
    // 物件CSVウィザードの標準テンプレは 6 列目が「種別」で、値に 土地/区分 が入る。
    // ヘッダ行がある別スキーマのデータ行を F 列値だけで受付帳と判定してはいけない。
    const headers = [
      "住所(必須)",
      "郵便番号",
      "地番",
      "家屋番号",
      "不動産番号",
      "種別",
      "登記状況",
      "DM判断",
    ];
    const rows = [
      ["東京都北区1-2", "1140000", "3-4", "", "0123456789012", "土地", "未取得", "未判断"],
      ["東京都南区5-6", "1080000", "7-8", "", "", "区分", "取得済", "送付可"],
    ];
    const r = detectImportFileTypeFromContent(headers, rows);
    expect(r.type).toBe("unknown");
  });

  it("ヘッダ行なしでも新既/DL印の裏取りが無ければ reception と断定しない (安全側)", () => {
    const headers = ["1", "", "2026/07/01", "123", "", "土地", "", "東京都", "北区", "1-2", "3-4", ""];
    const rows = [["2", "", "2026/07/02", "124", "", "建物", "", "東京都", "南区", "5-6", "7-8", ""]];
    const r = detectImportFileTypeFromContent(headers, rows);
    expect(r.type).toBe("unknown");
  });

  it("指紋のない一般CSVは unknown", () => {
    const r = detectImportFileTypeFromContent(GENERIC_HEADERS, GENERIC_ROWS);
    expect(r.type).toBe("unknown");
  });

  it("両方の指紋が立つ場合は ambiguous", () => {
    // 受付帳ヘッダ位置 + 所有者強ヘッダを併せ持つ人工ケース
    const headers = [
      "所有者氏名",
      "物件住所",
      "c",
      "d",
      "e",
      "f",
      "g",
      "都道府県",
      "区",
    ];
    const r = detectImportFileTypeFromContent(headers, []);
    expect(r.type).toBe("ambiguous");
  });
});

// ---------- resolveImportFileType ----------

describe("resolveImportFileType", () => {
  it("内容が期待通り: ファイル名に関係なく ok (内容判定を優先)", () => {
    const r = resolveImportFileType(
      "reception",
      "データ2026.xlsx", // 「受付帳」を含まない
      RECEPTION_HEADERS,
      RECEPTION_ROWS,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe("content");
    expect(r.error).toBeNull();
  });

  it("内容がもう一方の形式: 取り違えとして明確なエラー", () => {
    const r = resolveImportFileType(
      "reception",
      "受付帳.csv", // ファイル名は正しくても中身が所有者なら弾く
      OWNER_HEADERS,
      OWNER_ROWS,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("取り違え");
  });

  it("内容不明 + ファイル名が期待通り: ok (ファイル名にフォールバック)", () => {
    const r = resolveImportFileType(
      "owner",
      "所有者リスト.csv",
      GENERIC_HEADERS,
      GENERIC_ROWS,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe("filename");
  });

  it("内容不明 + ファイル名も不明: ok だが確認を促す warning 付き (従来は 422)", () => {
    const r = resolveImportFileType(
      "reception",
      "data.csv",
      GENERIC_HEADERS,
      GENERIC_ROWS,
    );
    expect(r.ok).toBe(true);
    expect(r.source).toBe("assumed");
    expect(r.warning).toContain("プレビュー");
  });

  it("内容不明 + ファイル名がもう一方: エラー (取り違えの疑い)", () => {
    const r = resolveImportFileType(
      "reception",
      "所有者リスト.csv",
      GENERIC_HEADERS,
      GENERIC_ROWS,
    );
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
  });

  it("内容が期待通り + ファイル名がもう一方: ok だが取り違え注意の warning", () => {
    const r = resolveImportFileType(
      "reception",
      "所有者データ.csv",
      RECEPTION_HEADERS,
      RECEPTION_ROWS,
    );
    expect(r.ok).toBe(true);
    expect(r.warning).not.toBeNull();
  });

  it("ヘッダ行なし受付帳は明確なエラーで拒否 (@codex #309: 黙った欠落/列ずれを防ぐ)", () => {
    // parseSheet が 1 行目をヘッダ扱いした時点で空欄キーの衝突により後続行の
    // 列が復元不能に壊れるため、受理せず見出し行の追加を案内する。
    const r = resolveImportFileType(
      "reception",
      "受付帳.csv", // ファイル名が正しくても中身がヘッダ行なしなら拒否
      HEADERLESS_RECEPTION_HEADERS,
      HEADERLESS_RECEPTION_ROWS,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("見出し行");
    // ヘッダ行あり受付帳は従来どおり受理
    const r2 = resolveImportFileType(
      "reception",
      "受付帳.csv",
      RECEPTION_HEADERS,
      RECEPTION_ROWS,
    );
    expect(r2.ok).toBe(true);
  });

  it("表示用 label は平易な日本語 (内部コードなし)", () => {
    const r = resolveImportFileType(
      "reception",
      "受付帳.csv",
      RECEPTION_HEADERS,
      RECEPTION_ROWS,
    );
    expect(r.label).toContain("受付帳");
    expect(r.label).not.toMatch(/content|filename|unknown/i);
  });
});
