/**
 * 住所自動入力 第2弾(番までの精細化)の純関数テスト:
 * 漢数字丁目の変換 / 住所組み立て / ISJ CSV parse / 最近傍選択。
 */
import { describe, it, expect } from "vitest";
import {
  kanjiNumberToInt,
  parseTrailingChome,
  formatBlockAddress,
} from "@/lib/address-blocks/format";
import { splitCsvLine, parseIsjCsv } from "@/lib/address-blocks/parse-isj";
import { parseImportArgs } from "@/lib/address-blocks/import-cli";
import {
  pickNearestBlock,
  haversineMeters,
  MAX_BLOCK_DISTANCE_M,
} from "@/lib/address-blocks/nearest";

describe("kanjiNumberToInt", () => {
  it.each([
    ["一", 1],
    ["三", 3],
    ["九", 9],
    ["十", 10],
    ["十三", 13],
    ["二十", 20],
    ["二十五", 25],
    ["四十九", 49],
  ])("%s → %i", (s, want) => {
    expect(kanjiNumberToInt(s as string)).toBe(want);
  });

  it("不正な並び・空は null", () => {
    expect(kanjiNumberToInt("")).toBeNull();
    expect(kanjiNumberToInt("三五")).toBeNull(); // 並記は丁目表記に無い
    expect(kanjiNumberToInt("百")).toBeNull();
    expect(kanjiNumberToInt("3")).toBeNull(); // 算用数字は対象外(ISJ は漢数字)
  });
});

describe("parseTrailingChome", () => {
  it("末尾の N丁目 を分解する", () => {
    expect(parseTrailingChome("西荻北三丁目")).toEqual({ base: "西荻北", chome: 3 });
    expect(parseTrailingChome("上荻一丁目")).toEqual({ base: "上荻", chome: 1 });
    // 町名自体に漢数字を含んでも末尾の丁目だけ変換する
    expect(parseTrailingChome("六本木七丁目")).toEqual({ base: "六本木", chome: 7 });
    expect(parseTrailingChome("銀座十三丁目")).toEqual({ base: "銀座", chome: 13 });
  });

  it("丁目を持たない町名は null(一番町・大字など)", () => {
    expect(parseTrailingChome("一番町")).toBeNull();
    expect(parseTrailingChome("大字上高井戸")).toBeNull();
    expect(parseTrailingChome("丸の内")).toBeNull();
  });
});

describe("formatBlockAddress", () => {
  const base = { prefecture: "東京都", city: "杉並区" };

  it("住居表示+丁目あり → ハイフン形(利用者は号を追記するだけ)", () => {
    expect(
      formatBlockAddress({ ...base, town: "西荻北三丁目", block: "1", isResidential: true }),
    ).toBe("東京都杉並区西荻北3-1");
  });

  it("住居表示+丁目なし → 正式形「…N番」", () => {
    expect(
      formatBlockAddress({
        prefecture: "東京都",
        city: "千代田区",
        town: "一番町",
        block: "10",
        isResidential: true,
      }),
    ).toBe("東京都千代田区一番町10番");
  });

  it("地番地域(住居表示未実施) → 「…N番地」", () => {
    expect(
      formatBlockAddress({
        prefecture: "埼玉県",
        city: "秩父市",
        town: "大字上影森",
        block: "1234",
        isResidential: false,
      }),
    ).toBe("埼玉県秩父市大字上影森1234番地");
  });
});

describe("splitCsvLine", () => {
  it("quoted CSV を分解する(フィールド内カンマ・\"\" エスケープ)", () => {
    expect(splitCsvLine('"東京都","杉並区","西荻北四丁目","","27"')).toEqual([
      "東京都",
      "杉並区",
      "西荻北四丁目",
      "",
      "27",
    ]);
    expect(splitCsvLine('"a,b","c""d"')).toEqual(["a,b", 'c"d']);
    expect(splitCsvLine("plain,1,2")).toEqual(["plain", "1", "2"]);
  });
});

describe("parseIsjCsv(実測フォーマット 24.0a)", () => {
  const HEADER =
    '"都道府県名","市区町村名","大字・丁目名","小字・通称名","街区符号・地番","座標系番号","Ｘ座標","Ｙ座標","緯度","経度","住居表示フラグ","代表フラグ","更新前履歴フラグ","更新後履歴フラグ"';
  const row = (over: Partial<Record<number, string>> = {}) => {
    const c = [
      "東京都",
      "杉並区",
      "西荻北四丁目",
      "",
      "27",
      "9",
      "-32255.1",
      "-21901.3",
      "35.709027",
      "139.591289",
      "1",
      "1",
      "0",
      "0",
    ];
    for (const [i, v] of Object.entries(over)) c[Number(i)] = v as string;
    return c.map((v) => `"${v}"`).join(",");
  };

  it("正常行を取り込む(実測サンプル)", () => {
    const r = parseIsjCsv([HEADER, row()].join("\n"));
    expect(r).toEqual({
      rows: [
        {
          prefecture: "東京都",
          city: "杉並区",
          town: "西荻北四丁目",
          block: "27",
          lat: 35.709027,
          lng: 139.591289,
          isResidential: true,
        },
      ],
      skipped: 0,
      history: 0,
    });
  });

  it("代表フラグ 0/1 とも取り込む・地番行(住居表示フラグ0)も取り込む", () => {
    const r = parseIsjCsv(
      [HEADER, row({ 11: "0" }), row({ 10: "0", 4: "1234" })].join("\n"),
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1].isResidential).toBe(false);
    expect(r.rows[1].block).toBe("1234");
  });

  it("小字・通称名(列3)は大字に連結して保持する(Codex P2: 地番地域の小字を捨てない)", () => {
    const r = parseIsjCsv(
      [HEADER, row({ 2: "大字上影森", 3: "小字前原", 4: "1234", 10: "0" })].join("\n"),
    );
    expect(r.rows[0].town).toBe("大字上影森小字前原");
    // 大字が空で小字だけの行は不正として弾く(小字だけの住所を組み立てない)。
    const bad = parseIsjCsv([HEADER, row({ 2: "", 3: "小字前原" })].join("\n"));
    expect(bad.rows).toHaveLength(0);
    expect(bad.skipped).toBe(1);
  });

  it("更新前履歴フラグ=1 の行(旧データ)は除外し件数を返す", () => {
    const r = parseIsjCsv([HEADER, row(), row({ 12: "1" })].join("\n"));
    expect(r.rows).toHaveLength(1);
    expect(r.history).toBe(1);
  });

  it("欠損・不正座標・フラグ不正の行は skipped に計上して落とす", () => {
    const r = parseIsjCsv(
      [
        HEADER,
        row({ 2: "" }), // 町丁目欠損
        row({ 8: "abc" }), // 緯度不正
        row({ 8: "51.5", 9: "-0.12" }), // 国外
        row({ 10: "2" }), // フラグ不正
      ].join("\n"),
    );
    expect(r.rows).toHaveLength(0);
    expect(r.skipped).toBe(4);
  });

  it("ヘッダの列名が想定とずれたら throw(将来の版ドリフト検知)", () => {
    const badHeader = HEADER.replace("街区符号・地番", "別の列");
    expect(() => parseIsjCsv([badHeader, row()].join("\n"))).toThrow(/ヘッダが想定と異なります/);
  });

  it("空文字列は空結果", () => {
    expect(parseIsjCsv("")).toEqual({ rows: [], skipped: 0, history: 0 });
  });
});

describe("parseImportArgs(取込CLIの引数解釈)", () => {
  it("正常系: version + パス(複数可) + --dry-run", () => {
    expect(parseImportArgs(["--version", "24.0a", "dir1"])).toEqual({
      version: "24.0a",
      dryRun: false,
      paths: ["dir1"],
    });
    expect(parseImportArgs(["--version", "24.0a", "--dry-run", "a.csv", "b"])).toEqual({
      version: "24.0a",
      dryRun: true,
      paths: ["a.csv", "b"],
    });
  });

  it("--version の値の書き忘れで次のフラグを吸い込まない(dry-runのつもりが実書込みになる事故防止)", () => {
    // 社内レビュー確定指摘: これが通ると version=\"--dry-run\"・dryRun=false で実書込みされる。
    expect(parseImportArgs(["--version", "--dry-run", "dir"])).toBeNull();
    expect(parseImportArgs(["--version"])).toBeNull();
  });

  it("未知のフラグ・version欠落・パス無しは null(usage 表示)", () => {
    expect(parseImportArgs(["--version", "24.0a", "--dryrun", "dir"])).toBeNull(); // タイポ
    expect(parseImportArgs(["dir"])).toBeNull();
    expect(parseImportArgs(["--version", "24.0a"])).toBeNull();
    expect(parseImportArgs(["--help"])).toBeNull();
  });
});

describe("pickNearestBlock / haversineMeters", () => {
  const C = (lat: number, lng: number, block: string) => ({
    prefecture: "東京都",
    city: "杉並区",
    town: "西荻北三丁目",
    block,
    lat,
    lng,
    isResidential: true,
  });

  it("haversine の目安: 緯度0.001° ≒ 111m", () => {
    const d = haversineMeters(35.7, 139.6, 35.701, 139.6);
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(117);
  });

  it("最も近い点の街区を採用し、住所を組み立てる", () => {
    const hit = pickNearestBlock(35.7042, 139.5995, [
      C(35.7041, 139.5996, "1"), // ~14m
      C(35.705, 139.601, "9"), // ~160m
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.address).toBe("東京都杉並区西荻北3-1");
    expect(hit!.distanceM).toBeLessThan(30);
  });

  it("ほぼ等距離の2点は丸めない生距離で比較する(Codex P2: 10.6m vs 10.8m で遠い方を選ばない)", () => {
    // 緯度オフセットのみ: 9.523e-5° ≒ 10.6m / 9.702e-5° ≒ 10.8m。
    // 近い方(block 1)を先に置く=丸め比較のバグだと後の 10.8m が 11m 未満で勝ってしまう並び。
    const hit = pickNearestBlock(35.7, 139.6, [
      C(35.7 + 9.523e-5, 139.6, "1"),
      C(35.7 + 9.702e-5, 139.6, "2"),
    ]);
    expect(hit!.address).toBe("東京都杉並区西荻北3-1");
  });

  it(`全候補が閾値(${MAX_BLOCK_DISTANCE_M}m)超なら null(隣町を拾わない)`, () => {
    expect(pickNearestBlock(35.7042, 139.5995, [C(35.71, 139.61, "1")])).toBeNull();
  });

  it("候補ゼロは null(GSI フォールバックに任せる)", () => {
    expect(pickNearestBlock(35.7, 139.6, [])).toBeNull();
  });
});
