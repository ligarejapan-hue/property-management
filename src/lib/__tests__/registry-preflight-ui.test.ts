/**
 * 謄本取得の事前警告UIの配線(発注者要望 2026-08-08)。
 * 3つの入口(単発ボタン・所在検索・一括モーダル)が共通の preflight(サーバ判定)を
 * 使うことをソース表明で固定する([同種の穴は全箇所]: 1入口だけの警告にしない)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SHARED = read("src/components/properties/registry-preflight-warnings.tsx");
const AUTO = read("src/components/properties/registry-auto-fetch-button.tsx");
const LOC = read("src/components/properties/registry-location-search-button.tsx");
const BULK = read("src/components/properties/registry-bulk-fetch-button.tsx");
const CLIENT = read("src/lib/api-client.ts");

describe("共通部品(registry-preflight-warnings)", () => {
  it("サーバ判定(fetchRegistryPreflight)を使い、失敗時は黙って消さず注意書きを出す", () => {
    expect(SHARED).toMatch(/fetchRegistryPreflight\(/);
    const failNotices =
      SHARED.split("事前確認に失敗しました").length - 1;
    expect(failNotices).toBe(2); // 単発用+一括用
  });

  it("3種の警告文言(取得済み/謄本PDF添付あり/所有者入力あり)を持つ", () => {
    expect(SHARED).toContain("登記状況が「取得済」です");
    expect(SHARED).toContain("既に謄本PDFが添付されています");
    expect(SHARED).toContain("既に所有者情報が入力されています");
    // 一括の件数表示
    expect(SHARED).toContain("謄本PDFの添付あり: {attached}件");
    expect(SHARED).toContain("所有者の入力あり: {withOwners}件");
  });
});

describe("3入口の配線", () => {
  it("単発ボタン: confirming で preflight を取得し警告行を出す(既存の取得済み文言とは重複させない)", () => {
    expect(AUTO).toMatch(/useRegistryPreflight\(\[propertyId\], state === "confirming"\)/);
    expect(AUTO).toMatch(/<RegistryPreflightWarningLines[\s\S]{0,140}?showObtained=\{!alreadyObtained\}/);
  });

  it("所在検索: 課金直前(confirmObtain)で preflight を取得し警告行を出す", () => {
    // ⚠所在検索は confirmSearch でも取る（何を取りに行くかが分からないうちは検索も始めさせない）。
    expect(LOC).toMatch(/state === "confirmSearch" || state === "confirmObtain"/);
    expect(LOC).toMatch(/<RegistryPreflightWarningLines state=\{preflight\} propertyId=\{propertyId\} \/>/);
  });

  it("一括モーダル: open で preflight を取得し件数警告を出す", () => {
    expect(BULK).toMatch(/useRegistryPreflight\(propertyIds, open\)/);
    expect(BULK).toMatch(/<RegistryPreflightCountLines state=\{preflight\} \/>/);
  });
});

describe("api-client", () => {
  it("fetchRegistryPreflight は USE_MOCK 分岐を持ち POST /api/registry-fetch/preflight を呼ぶ", () => {
    const start = CLIENT.indexOf("export async function fetchRegistryPreflight(");
    expect(start).toBeGreaterThan(0);
    const next = CLIENT.indexOf("export async function", start + 1);
    const body = CLIENT.slice(start, next === -1 ? undefined : next);
    expect(body).toMatch(/if \(USE_MOCK\)/);
    expect(body).toContain("/api/registry-fetch/preflight");
  });
});

describe("実行ボタンは事前確認が済むまで無効(#365 R1)", () => {
  it("再オープン時は前回の確定を無効化してから再確認する(#365 R3)", () => {
    expect(SHARED).toMatch(/Promise\.resolve\(\)\.then\(\(\) => \{[\s\S]{0,200}?setSettledKey\(null\)/);
  });

  it("hook は pending を導出し、失敗も『確定』として注意書き表示後に実行可能へ戻す", () => {
    expect(SHARED).toMatch(
      /pending: active && propertyIds.length > 0 && settledKey !== cacheKey/,
    );
    expect(SHARED).toContain('setSettledKey(cacheKey); // 失敗も「確定」');
  });
  it("3入口の課金ボタンすべてが preflight\.pending で disabled になる", () => {
    expect(AUTO).toMatch(/disabled=\{preflight\.pending\}/);
    expect(LOC).toMatch(
      /disabled={preflight.pending || preflight.targetsUnavailable}/,
    );
    expect(BULK).toMatch(/preflight.targetsUnavailable/);
  });

  it("⚠内訳が長くても操作できる（画面内に収めて中でスクロール・@codex #373 R10 P2）", () => {
    // 食い違いの内訳は1物件1行で最大50行まで伸びる。上下にはみ出すと
    // 種類の選択も実行ボタンも押せなくなる（特にスマホ）。
    expect(BULK).toMatch(/max-h-\[\d+vh\]/);
    expect(BULK).toContain("overflow-y-auto");
  });
});

describe("⚠APIへ送るIDに取り直しの合図を混ぜない（@codex #373 P1）", () => {
  it("送るのは idsKey（合図を含む cacheKey ではない）", () => {
    // 混ぜると `0|<uuid>` が送られて 400 になり、分類が読めず
    // 実行ボタンが永久に無効＝謄本の取得が全部できなくなる。
    expect(SHARED).toContain("fetchRegistryPreflight(idsKey.split(\",\"))");
    expect(SHARED).not.toMatch(/fetchRegistryPreflight\(cacheKey/);
  });

  it("キーの作り分けは純関数に切り出してある（ソース走査では捕まらない壊れ方のため）", () => {
    expect(SHARED).toContain("export function buildPreflightKeys");
  });
});
