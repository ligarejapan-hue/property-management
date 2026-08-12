/**
 * 地番を人が確認して入れるポップアップ（設計 §3.2 / §3.3 / §4.1 / §4.3）。
 *
 * jsdom が無いので、純関数は直接呼び、画面はソース走査で固定する
 * （このリポの UI テストの主流。registry-location-search-button.test.ts と同型）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chibanMapUrl } from "@/components/properties/registry-chiban-popup";

const src = readFileSync(
  join(process.cwd(), "src/components/properties/registry-chiban-popup.tsx"),
  "utf8",
);

const LOC = readFileSync(
  join(
    process.cwd(),
    "src/components/properties/registry-location-search-button.tsx",
  ),
  "utf8",
);

describe("地図サービスのURL（設計 §3.2）", () => {
  it("座標があればその位置をズーム18で開く", () => {
    // ⚠18 は筆界と地番が見える倍率（#15 では筆界が出ない・実機で確認済み）。
    expect(chibanMapUrl(35.430368, 139.601094)).toBe(
      "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/#18/35.430368/139.601094",
    );
  });

  it("座標が無ければサービスのトップを開くだけ（住所は渡さない）", () => {
    const top = "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/";
    expect(chibanMapUrl(null, null)).toBe(top);
    expect(chibanMapUrl(35.4, null)).toBe(top);
    expect(chibanMapUrl(null, 139.6)).toBe(top);
    expect(chibanMapUrl(undefined, undefined)).toBe(top);
  });

  it("⚠本番の大半は座標が無い（668件中667件）ので、開けなくならないこと", () => {
    expect(chibanMapUrl(null, null)).toContain("chiban_search/map/");
  });
});

describe("外部へ渡すことの扱い（設計 §3.2）", () => {
  it("⚠rel=noopener noreferrer（物件詳細のURLを外部へ渡さない）", () => {
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).toContain('target="_blank"');
  });

  it("⚠位置を渡すことを画面に書く", () => {
    expect(src).toContain("地図サービスへ渡して開きます");
  });

  it("⚠「送信されない」とは書かない（フラグメントでも相手のJSが読む）", () => {
    expect(src).not.toContain("送信されません");
    expect(src).not.toContain("送信されない");
  });

  it("⚠中心の地番を写さないよう「該当の筆をクリック」と書く", () => {
    // 座標は建物の位置であって筆の代表点ではない。
    expect(src).toContain("該当の筆をクリック");
  });
});

describe("費用の書き分け（設計 §3.2）", () => {
  it("この画面では課金されないこと・課金は次の取得であることを書く", () => {
    expect(src).toContain("この画面の操作では課金されません");
    expect(src).toContain("課金は次の取得のとき");
  });
});

describe("保存（設計 §4.1）", () => {
  it("保存するのは lotNumber だけ", () => {
    expect(src).toContain("lotNumber: value.trim()");
  });

  it("⚠家屋番号を保存する口を作らない（地図が返すのは地番）", () => {
    expect(src).not.toMatch(/buildingNumber:\s*value/);
    expect(src).not.toMatch(/body:[\s\S]{0,200}buildingNumber/);
  });

  it("version を必ず同梱する（更新スキーマの必須項目）", () => {
    expect(src).toContain("version: propertyVersion");
  });

  it("⚠保存しただけでは検索APIを呼ばない（料金の確認を必ず経由する）", () => {
    expect(src).not.toContain("/registry/search");
    expect(src).toContain("onSaved()");
  });

  it("409 は「開き直してください」と案内する（最新versionは返らない）", () => {
    expect(src).toContain("VERSION_CONFLICT");
    expect(src).toContain("開き直して");
  });
});

describe("入力の検査（設計 §4.3）", () => {
  it("⚠同じ判定関数を使う（画面独自の正規表現を書かない）", () => {
    expect(src).toContain("isReadableChiban");
    expect(src).not.toMatch(/new RegExp\(/);
  });

  it("読めない形のあいだは保存ボタンを押せない", () => {
    expect(src).toContain("const canSave = canWriteProperty && readable && !saving");
  });
});

describe("権限（設計 §4.1）", () => {
  it("地番を保存できない利用者には入力欄を出さず案内する", () => {
    expect(src).toContain("canWriteProperty");
    expect(src).toContain("地番の編集権限");
  });
});

describe("建物のとき（設計 §3.3）", () => {
  it("2つの道を出す", () => {
    expect(src).toContain("建物の登記を取る");
    expect(src).toContain("土地の登記を取る");
  });

  it("⚠建物の側は案内だけ（家屋番号は地図では分からない）", () => {
    expect(src).toContain("地番検索サービスの地図では分かりません");
  });
});

describe("秘匿（設計 §5）", () => {
  it("入力した地番を console へ出さない", () => {
    expect(src).not.toMatch(/console\.\w+\(/);
  });
});

describe("導線への差し込み（設計 §3.1 / §4.1）", () => {
  it("番号が無いとき（kind === none）だけポップアップを出す", () => {
    expect(LOC).toContain('target?.kind === "none"');
    expect(LOC).toContain("RegistryChibanPopup");
  });

  it("⚠保存したら物件を取り直すだけ（検索を直接投げない）", () => {
    expect(LOC).toMatch(/onSaved=\{\(\) => \{[\s\S]{0,300}?onPropertyRefresh\(\)/);
    expect(LOC).not.toMatch(/onSaved=\{\(\) => \{[\s\S]{0,300}?runSearch\(\)/);
  });

  it("番号があるときは従来どおり確認パネルを出す", () => {
    expect(LOC).toContain('target?.kind !== "none"');
    expect(LOC).toContain("所在で謄本候補を検索しますか？");
  });
});
