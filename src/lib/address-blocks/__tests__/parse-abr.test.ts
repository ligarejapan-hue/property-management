/**
 * 第3弾(号までの精細化)の純関数テスト: ABR 町字マスター/住居点の解釈・
 * 住所組み立て・最近傍選択。フォーマットは 2026-08-02 実測(東京都)に基づく。
 */
import { describe, it, expect } from "vitest";
import {
  parseAbrTownCsv,
  parseAbrRsdtHeader,
  parseAbrRsdtLine,
  formatResidenceAddress,
} from "@/lib/address-blocks/parse-abr";
import {
  pickNearestResidence,
  RSDT_MAX_DISTANCE_M,
} from "@/lib/address-blocks/nearest";
import { strictUtf8LinesFromChunks } from "@/lib/address-blocks/import-files";

async function collect(chunks: Uint8Array[]): Promise<string[]> {
  const out: string[] = [];
  for await (const line of strictUtf8LinesFromChunks(chunks)) out.push(line);
  return out;
}

// 実測ヘッダ(mt_town_pref13.csv)。
const TOWN_HEADER =
  "lg_code,machiaza_id,machiaza_type,pref,pref_kana,pref_roma,county,county_kana,county_roma,city,city_kana,city_roma,ward,ward_kana,ward_roma,oaza_cho,oaza_cho_kana,oaza_cho_roma,chome,chome_kana,chome_number,koaza,koaza_kana,koaza_roma,machiaza_dist,rsdt_addr_flg,rsdt_addr_mtd_code,oaza_cho_aka_flg,koaza_aka_code,oaza_cho_gsi_uncmn,koaza_gsi_uncmn,status_flg,wake_num_flg,efct_date,ablt_date,src_code,post_code,remarks";

function townRow(over: Partial<Record<number, string>> = {}) {
  const c = TOWN_HEADER.split(",").map(() => "");
  c[0] = "131156"; // lg_code(杉並区)
  c[1] = "0029003"; // machiaza_id
  c[3] = "東京都";
  c[9] = "杉並区";
  c[15] = "西荻北";
  c[18] = "３丁目";
  c[20] = "3"; // chome_number
  for (const [i, v] of Object.entries(over)) c[Number(i)] = v as string;
  return c.join(",");
}

describe("parseAbrTownCsv(町字マスター)", () => {
  it("実測サンプルを (lg_code:machiaza_id) → 表示名へ解決する", () => {
    const r = parseAbrTownCsv([TOWN_HEADER, townRow()].join("\n"));
    expect(r.towns.get("131156:0029003")).toEqual({
      prefecture: "東京都",
      city: "杉並区",
      town: "西荻北",
      chome: "3",
      koaza: "",
    });
    expect(r.skipped).toBe(0);
  });

  it("政令市は city+ward・郡部は county+city を連結・小字は独立保持・丁目なしは chome 空", () => {
    const r = parseAbrTownCsv(
      [
        TOWN_HEADER,
        townRow({ 0: "141305", 9: "横浜市", 12: "中区", 15: "本町", 18: "", 20: "" }),
        townRow({ 1: "0001001", 15: "大字上高井戸", 21: "小字前原", 18: "", 20: "" }),
        // 郡部(Codex P2: 郡を落とすと「東京都檜原村…」の不完全住所になる)
        townRow({ 0: "133078", 6: "西多摩郡", 9: "檜原村", 15: "本宿", 18: "", 20: "" }),
      ].join("\n"),
    );
    expect(r.towns.get("141305:0029003")).toEqual({
      prefecture: "東京都",
      city: "横浜市中区",
      town: "本町",
      chome: "",
      koaza: "",
    });
    expect(r.towns.get("131156:0001001")).toEqual({
      prefecture: "東京都",
      city: "杉並区",
      town: "大字上高井戸",
      chome: "",
      koaza: "小字前原",
    });
    expect(r.towns.get("133078:0029003")).toEqual({
      prefecture: "東京都",
      city: "西多摩郡檜原村",
      town: "本宿",
      chome: "",
      koaza: "",
    });
  });

  it("廃止行(ablt_date あり)は除外・欠損行は skipped", () => {
    const r = parseAbrTownCsv(
      [
        TOWN_HEADER,
        townRow({ 34: "2020-01-01" }), // 廃止
        townRow({ 15: "" }), // 大字欠損
        townRow({ 20: "abc" }), // chome_number 不正
      ].join("\n"),
    );
    expect(r.towns.size).toBe(0);
    expect(r.skipped).toBe(2); // 廃止は skipped に数えない(正常な除外)
  });

  it("BOM 付き・ヘッダ列名ドリフトの検知", () => {
    const bom = "﻿" + [TOWN_HEADER, townRow()].join("\n");
    expect(parseAbrTownCsv(bom).towns.size).toBe(1);
    expect(() =>
      parseAbrTownCsv([TOWN_HEADER.replace("machiaza_id", "renamed"), townRow()].join("\n")),
    ).toThrow(/列「machiaza_id」がありません/);
  });
});

// 実測ヘッダ(mt_rsdtdsp_rsdt_pos_pref13.csv)。
const POS_HEADER =
  "lg_code,machiaza_id,blk_id,rsdt_id,rsdt2_id,rsdt_addr_flg,rsdt_addr_mtd_code,rep_lon,rep_lat,rep_srid,rep_scale,rep_src_code,rsdt_addr_code_rdbl,rsdt_addr_data_mnt_date,basic_rsdt_div";

function posLine(over: Partial<Record<number, string>> = {}) {
  const c = [
    "131156",
    "0029003",
    "019", // blk_id(番=19・ゼロ埋め)
    "004", // rsdt_id(号=4)
    "",
    "1",
    "1",
    "139.599500000",
    "35.704200000",
    "EPSG:6668",
    "2500",
    "1",
    "",
    "2017-08-04",
    "0",
  ];
  for (const [i, v] of Object.entries(over)) c[Number(i)] = v as string;
  return c.join(",");
}

describe("parseAbrRsdtLine(住居点・実測フォーマット)", () => {
  const towns = parseAbrTownCsv([TOWN_HEADER, townRow()].join("\n")).towns;
  const col = parseAbrRsdtHeader(POS_HEADER);

  it("ゼロ埋め ID を番・号へ(019→19, 004→4)、町字を名前解決する", () => {
    expect(parseAbrRsdtLine(posLine(), col, towns)).toEqual({
      prefecture: "東京都",
      city: "杉並区",
      town: "西荻北",
      chome: "3",
      koaza: "",
      block: "19",
      rsdt: "4",
      lat: 35.7042,
      lng: 139.5995,
    });
  });

  it("枝番(rsdt2_id)は号へ連結(東京都で0.4%実在)", () => {
    expect(parseAbrRsdtLine(posLine({ 4: "002" }), col, towns)!.rsdt).toBe("4-2");
  });

  it("町字に紐づかない・数値でないID・国外座標は null(=skip)", () => {
    expect(parseAbrRsdtLine(posLine({ 1: "9999999" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 2: "01A" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 8: "51.5", 7: "-0.12" }), col, towns)).toBeNull();
  });

  it("ABR の予約IDレンジは実番号でない=skip(社内レビュー・大阪/北海道の実データで裏取り)", () => {
    // 街区ID 000 = 道路方式(北海道浦河町で実在)。901+ = 特殊街区符号の連番
    // (大阪市西区千代崎=京セラドームで実在。「903」を番にすると実在しない住所になる)。
    expect(parseAbrRsdtLine(posLine({ 2: "000" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 2: "901" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 3: "000" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 3: "999" }), col, towns)).toBeNull();
    expect(parseAbrRsdtLine(posLine({ 4: "10001" }), col, towns)).toBeNull();
    // 予約レンジ直前は通常値として通る。
    expect(parseAbrRsdtLine(posLine({ 2: "900" }), col, towns)!.block).toBe("900");
    expect(parseAbrRsdtLine(posLine({ 4: "10000" }), col, towns)!.rsdt).toBe("4-10000");
  });

  it("ヘッダの列名ドリフトは throw", () => {
    expect(() => parseAbrRsdtHeader(POS_HEADER.replace("rep_lat", "renamed"))).toThrow(
      /列「rep_lat」がありません/,
    );
  });
});

describe("formatResidenceAddress / pickNearestResidence", () => {
  const ROW = {
    prefecture: "東京都",
    city: "杉並区",
    town: "西荻北",
    chome: "3",
    koaza: "",
    block: "19",
    rsdt: "4",
  };

  it("小字あり → 大字→丁目→小字の正順(Codex R5 P2: 「大字小字3-…」の並び崩れ防止)", () => {
    expect(
      formatResidenceAddress({
        prefecture: "青森県",
        city: "八戸市",
        town: "大字市川町",
        chome: "3",
        koaza: "小字桔梗野",
        block: "1",
        rsdt: "2",
      }),
    ).toBe("青森県八戸市大字市川町3丁目小字桔梗野1-2");
    expect(
      formatResidenceAddress({
        prefecture: "青森県",
        city: "八戸市",
        town: "大字市川町",
        chome: "",
        koaza: "小字桔梗野",
        block: "1",
        rsdt: "2",
      }),
    ).toBe("青森県八戸市大字市川町小字桔梗野1-2");
  });

  it("丁目あり → 3-19-4 / 丁目なし → 10-3 のハイフン形", () => {
    expect(formatResidenceAddress(ROW)).toBe("東京都杉並区西荻北3-19-4");
    expect(
      formatResidenceAddress({
        prefecture: "東京都",
        city: "千代田区",
        town: "一番町",
        chome: "",
        koaza: "",
        block: "10",
        rsdt: "3",
      }),
    ).toBe("東京都千代田区一番町10-3");
  });

  it("最近傍を生距離で選び、town は丁目付きで返す", () => {
    const C = (lat: number, lng: number, rsdt: string) => ({ ...ROW, rsdt, lat, lng });
    const hit = pickNearestResidence(35.7042, 139.5995, [
      C(35.70421, 139.59952, "4"), // ~2m
      C(35.7044, 139.5998, "6"), // ~35m
    ]);
    expect(hit!.address).toBe("東京都杉並区西荻北3-19-4");
    expect(hit!.town).toBe("西荻北3丁目");
    expect(hit!.distanceM).toBeLessThan(5);
  });

  it(`閾値(${RSDT_MAX_DISTANCE_M}m)超・候補ゼロは null(街区→GSI へフォールバック)`, () => {
    expect(
      pickNearestResidence(35.7042, 139.5995, [{ ...ROW, lat: 35.705, lng: 139.6 }]),
    ).toBeNull();
    expect(pickNearestResidence(35.7042, 139.5995, [])).toBeNull();
  });
});

describe("strictUtf8LinesFromChunks(streaming 厳格デコード・社内レビュー指摘のテスト固定)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("チャンク境界でマルチバイト文字が分断されても正しく復元する", async () => {
    const bytes = enc("東京都\n杉並区\n");
    // 「京」の3バイトの途中で分割
    const lines = await collect([bytes.subarray(0, 4), bytes.subarray(4)]);
    expect(lines).toEqual(["東京都", "杉並区"]);
  });

  it("CRLF の \r と \n が別チャンクに割れても行を分断しない", async () => {
    const a = enc("line1\r");
    const b = enc("\nline2\r\n");
    expect(await collect([a, b])).toEqual(["line1", "line2"]);
  });

  it("改行なしの最終行を落とさない(末尾の住居点が黙って消えない)", async () => {
    expect(await collect([enc("a\nb\nlast-no-newline")])).toEqual([
      "a",
      "b",
      "last-no-newline",
    ]);
  });

  it("不正な UTF-8 バイトは TypeError(取込側が文字コード破損として停止する契約)", async () => {
    const bad = new Uint8Array([0x61, 0x0a, 0xff, 0xfe, 0x62]);
    await expect(collect([bad])).rejects.toBeInstanceOf(TypeError);
  });

  it("空チャンク・空入力・LF のみ", async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect([enc("")])).toEqual([]);
    expect(await collect([enc("a\n\nb\n")])).toEqual(["a", "", "b"]);
  });
});
