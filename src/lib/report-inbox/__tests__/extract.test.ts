import { describe, it, expect } from "vitest";
import { extractReportClues } from "../extract";

/**
 * 実物(SRE AI査定「不動産価格査定報告書」2026-10-08)の pdf-parse 出力の並びを写した見本。
 * ⚠個人情報(依頼者の氏名・物件の番地)は架空。部首の文字(⽥ ⾕ ⽉ ⽇ ⼭)・タブ区切り・
 *   制御文字(\u0001)・目次の「物件詳細」も実物どおり入れてある。
 */
const SRE_TEXT = [
  "佐藤 花子 様",
  "不動産価格査定報告書",
  "(東急サンプルハイツ弐番館 305号室)",
  "2026年10⽉8⽇",
  "株式会社リガーレジャパン",
  "担当：⼭⽥太郎",
  "電話：03-0000-0000",
  "〒154-0000",
  "東京都世⽥⾕区上⾺1-2-3",
  "-- 1 of 46 --",
  "1.物件詳細",
  "2.本書の査定⽅法",
  "物件詳細",
  "名称 \t東急サンプルハイツ弐番館 305号室",
  "所有地 \t東京都世⽥⾕区太⼦堂4丁目12ー3",
  "交通 \t東急世⽥⾕線「三軒茶屋駅」\u0001徒歩4分",
  "-",
  "所在階",
].join("\n");

describe("extractReportClues(査定報告書から物件の手がかり)", () => {
  it("★SRE の報告書: 名称からマンション名と部屋番号、所有地から所在地(部首の文字は普通の漢字に)", () => {
    expect(extractReportClues(SRE_TEXT)).toEqual({
      source: "sre",
      buildingName: "東急サンプルハイツ弐番館",
      roomNo: "305",
      address: "東京都世田谷区太子堂4丁目12ー3",
    });
  });

  it("★1ページ目の御社の住所(〒…上馬)を物件の所在地として拾わない", () => {
    const r = extractReportClues(SRE_TEXT);
    expect(r.address).not.toContain("上馬");
  });

  it("依頼者の氏名は返さない", () => {
    expect(JSON.stringify(extractReportClues(SRE_TEXT))).not.toContain("佐藤");
  });

  it("「名称」の表が無くても、1ページ目の括弧書きから名称を読む", () => {
    const t = SRE_TEXT.split("\n").filter((l) => !l.startsWith("名称")).join("\n");
    const r = extractReportClues(t);
    expect(r.buildingName).toBe("東急サンプルハイツ弐番館");
    expect(r.roomNo).toBe("305");
  });

  it("見出しと値が別の行でも読む", () => {
    const r = extractReportClues("物件詳細\n名称\nグリーンコート 1203号室\n所有地\n東京都A区B1丁目2-3");
    expect(r).toMatchObject({ buildingName: "グリーンコート", roomNo: "1203", address: "東京都A区B1丁目2-3" });
  });

  it("号室が無い名称(戸建など)は部屋番号を作らない", () => {
    const r = extractReportClues("名称 \t山田邸\n所有地 \t東京都A区B1-2-3");
    expect(r).toMatchObject({ buildingName: "山田邸", roomNo: null });
  });

  it("手がかりが無ければ全部 null・書式は unknown", () => {
    expect(extractReportClues("ただの文章です")).toEqual({
      source: "unknown",
      buildingName: null,
      roomNo: null,
      address: null,
    });
  });

  it("値が「-」のときは null", () => {
    const r = extractReportClues("名称 \t-\n所有地 \t-");
    expect(r).toMatchObject({ buildingName: null, address: null });
  });
});
