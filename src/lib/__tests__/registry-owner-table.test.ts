import { describe, expect, it } from "vitest";

import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import { parseRegistryText } from "@/lib/pdf-registry-parser";

/**
 * 登記情報提供サービスの「所有者事項」PDF は、罫線で囲まれた表で所有者を並べる。
 * ここの見本は実物の *並び* だけを写したもので、氏名・住所は架空。
 * (実物は個人情報なのでテストには入れない)
 *
 *   ┏━━━┓
 *   ┃ 所 有 者 ┃            ← 表題(1セル)
 *   ┠───┬───┨
 *   ┃ 住 所 │ 氏 名 ┃        ← 見出し
 *   ┠───┼───┨
 *   ┃東京都… │山田太郎 ┃    ← 中身
 *   ┗━━━┛
 */
const TWO_COLUMN = [
  "2026/09/15 10:00 登記情報提供サービス。",
  "東京都渋谷区神宮前三丁目123-4 所有者事項 （土地）",
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠────────────────────┬─────────────┨",
  "┃ 住 所 │ 氏 名 ┃",
  "┠────────────────────┼─────────────┨",
  "┃東京都渋谷区神宮前三丁目12番3号 │山田太郎 ┃",
  "┗━━━━━━━━━━━━━━━━━━┷━━━━━━━━━┛",
  "",
  "-- 1 of 1 --",
].join("\n");

const THREE_COLUMN = [
  "2026/09/15 10:00 登記情報提供サービス。",
  "東京都世田谷区三宿一丁目292-3 所有者事項 （土地）",
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠──────────────┬────────┬──────────┨",
  "┃ 住 所 │ 持 分 │ 氏 名 ┃",
  "┠──────────────┼────────┼──────────┨",
  "┃東京都世田谷区三宿一丁目12番3号 │ 3分の1│山田太郎 ┃",
  "┠──────────────┼────────┼──────────┨",
  "┃東京都世田谷区三宿一丁目12番3号 │ 3分の1│山田花子 ┃",
  "┠──────────────┼────────┼──────────┨",
  "┃神奈川県川崎市中原区上平間1番地2ハイツ │ 3分の1│田中一郎 ┃",
  "┃サンプル101 │ │ ┃",
  "┗━━━━━━━━━┷━━━━━━┷━━━━━━━━┛",
  "",
  "-- 1 of 1 --",
].join("\n");

const NO_TABLE = [
  "登記事項の写し",
  "所有者 東京都渋谷区神宮前三丁目12番3号",
  "山田太郎",
].join("\n");

describe("parseRegistryOwnerTable", () => {
  it("2列（住所・氏名）の表から所有者を読み取る", () => {
    const owners = parseRegistryOwnerTable(TWO_COLUMN);
    expect(owners).toEqual([
      {
        name: "山田太郎",
        address: "東京都渋谷区神宮前三丁目12番3号",
        share: null,
      },
    ]);
  });

  it("3列（住所・持分・氏名）の表から全員を読み取る", () => {
    const owners = parseRegistryOwnerTable(THREE_COLUMN);
    expect(owners).not.toBeNull();
    expect(owners).toHaveLength(3);
    expect(owners?.[0]).toEqual({
      name: "山田太郎",
      address: "東京都世田谷区三宿一丁目12番3号",
      share: "3分の1",
    });
    expect(owners?.[1]?.name).toBe("山田花子");
  });

  it("住所が次の行へ折り返していても1人ぶんとしてつなげる", () => {
    const owners = parseRegistryOwnerTable(THREE_COLUMN);
    expect(owners?.[2]).toEqual({
      name: "田中一郎",
      address: "神奈川県川崎市中原区上平間1番地2ハイツサンプル101",
      share: "3分の1",
    });
  });

  it("表の見出し（住所・氏名）を所有者として拾わない", () => {
    const owners = parseRegistryOwnerTable(TWO_COLUMN);
    expect(owners?.some((o) => o.name.includes("住所"))).toBe(false);
    expect(owners?.some((o) => o.name.includes("氏名"))).toBe(false);
  });

  it("表が無いテキストでは null を返す（従来の読み取りに任せる）", () => {
    expect(parseRegistryOwnerTable(NO_TABLE)).toBeNull();
  });

  it("見出しだけで中身が無い表では空の配列を返す", () => {
    const headerOnly = [
      "┏━━━━━━━━━┓",
      "┃ 所 有 者 ┃",
      "┠─────┬────┨",
      "┃ 住 所 │ 氏 名 ┃",
      "┗━━━━━┷━━━━┛",
    ].join("\n");
    expect(parseRegistryOwnerTable(headerOnly)).toEqual([]);
  });
});

/**
 * 実物のPDFで起きたケース。氏名の列の下に、登記情報提供サービス側の
 * 「整理番号」などが刷り込まれる。これを所有者として拾ってはいけない。
 */
const WITH_SERVICE_FOOTER = [
  "2026/09/15 10:00 登記情報提供サービス。",
  "東京都大田区東雪谷一丁目12-3 所有者事項 （建物）",
  "┏━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠──────────────┬────────┨",
  "┃ 住 所 │ 氏 名 ┃",
  "┠──────────────┼────────┨",
  "┃東京都大田区東雪谷一丁目1番2号 │株式会社サンプルホールディングス ┃",
  "┃ │ 検索用資料番号 0801-01-0┃",
  "┃ │ 14425 ┃",
  "┗━━━━━━━━━┷━━━━━━━━┛",
].join("\n");

/** 住所が折り返し、その行の氏名の列にサービスの定型文が入る3列の例。 */
const WRAPPED_WITH_FOOTER = [
  "東京都港区赤坂一丁目1-1 所有者事項 （土地）",
  "┏━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠────────────┬──────┬────────┨",
  "┃ 住 所 │ 持 分 │ 氏 名 ┃",
  "┠────────────┼──────┼────────┨",
  "┃東京都港区赤坂一丁目1番1号KAND │ 10分の9│山田太郎 ┃",
  "┃ASQUAREGATE3階 │ │ 検索用資料番号 0801-01-0┃",
  "┃ │ │ 14425 ┃",
  "┗━━━━━━━━┷━━━━━┷━━━━━━┛",
].join("\n");

describe("parseRegistryOwnerTable（サービスの定型文が混ざる実物のケース）", () => {
  it("氏名の列に入り込んだ整理番号を所有者にしない", () => {
    const owners = parseRegistryOwnerTable(WITH_SERVICE_FOOTER);
    expect(owners).toHaveLength(1);
    expect(owners?.[0]).toEqual({
      name: "株式会社サンプルホールディングス",
      address: "東京都大田区東雪谷一丁目1番2号",
      share: null,
    });
  });

  it("住所が折り返した行に定型文が入っていても、住所だけつなげる", () => {
    const owners = parseRegistryOwnerTable(WRAPPED_WITH_FOOTER);
    expect(owners).toHaveLength(1);
    expect(owners?.[0]).toEqual({
      name: "山田太郎",
      address: "東京都港区赤坂一丁目1番1号KANDASQUAREGATE3階",
      share: "10分の9",
    });
  });

  it("氏名が折り返した場合はつなげる（数字を含まない続き）", () => {
    const wrappedName = [
      "┏━━━━━━━━━┓",
      "┃ 所 有 者 ┃",
      "┠─────┬────┨",
      "┃ 住 所 │ 氏 名 ┃",
      "┠─────┼────┨",
      "┃東京都中央区銀座一丁目1番1号 │株式会社サンプル（ＡＤ ┃",
      "┃ │ＭＩＮ） ┃",
      "┗━━━━━┷━━━━┛",
    ].join("\n");
    const owners = parseRegistryOwnerTable(wrappedName);
    expect(owners).toHaveLength(1);
    expect(owners?.[0]?.name).toBe("株式会社サンプル（ＡＤＭＩＮ）");
  });
});

describe("parseRegistryOwnerTable（見出しが繰り返される表）", () => {
  it("⚠2ページ目以降の見出しを所有者として拾わない", () => {
    // 共有者が多い謄本は改ページで表が続き、見出しがもう一度出る。
    // 見出しの行を中身として読むと「氏名」という名前の所有者ができる。
    const twoPages = [
      "┏━━━━━━━━━┓",
      "┃ 所 有 者 ┃",
      "┠─────┬────┨",
      "┃ 住 所 │ 氏 名 ┃",
      "┠─────┼────┨",
      "┃東京都渋谷区神宮前三丁目1番1号 │山田太郎 ┃",
      "┗━━━━━┷━━━━┛",
      "-- 1 of 2 --",
      "┏━━━━━━━━━┓",
      "┃ 所 有 者 ┃",
      "┠─────┬────┨",
      "┃ 住 所 │ 氏 名 ┃",
      "┠─────┼────┨",
      "┃東京都渋谷区神宮前三丁目1番1号 │山田花子 ┃",
      "┗━━━━━┷━━━━┛",
      "-- 2 of 2 --",
    ].join("\n");

    const owners = parseRegistryOwnerTable(twoPages);
    expect(owners?.map((o) => o.name)).toEqual(["山田太郎", "山田花子"]);
    expect(owners?.some((o) => o.name === "氏名")).toBe(false);
    expect(owners?.some((o) => o.address === "住所")).toBe(false);
  });
});

describe("parseRegistryText（表がある謄本）", () => {
  it("表の見出しを氏名として登録しない", () => {
    const parsed = parseRegistryText(TWO_COLUMN);
    expect(parsed.owners.map((o) => o.name)).not.toContain("住所 氏名");
    expect(parsed.owners).toHaveLength(1);
  });

  it("氏名と住所の両方が取れる", () => {
    const parsed = parseRegistryText(TWO_COLUMN);
    expect(parsed.owners[0]).toMatchObject({
      name: "山田太郎",
      address: "東京都渋谷区神宮前三丁目12番3号",
    });
  });

  it("共有の謄本では全員ぶんの氏名と持分が取れる", () => {
    const parsed = parseRegistryText(THREE_COLUMN);
    expect(parsed.owners).toHaveLength(3);
    expect(parsed.owners.map((o) => o.share)).toEqual([
      "3分の1",
      "3分の1",
      "3分の1",
    ]);
  });
});
