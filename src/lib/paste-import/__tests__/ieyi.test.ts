import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPasteDraft } from "../build-draft";
import { parseLabeledLines } from "../parse-labeled-lines";
import { detectSourceProfile, parseOptionsFor } from "../source-profiles";
import { introductionRouteForLeadSource } from "../lead-source-route";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

/**
 * イエイの査定依頼メール。実物(2026-11-06 着)の書式を写した見本。
 * ⚠見本の書式(「［見出し］」の行・次の行に値・空行・「▼」の節・連絡先だけ「見出し：値」・
 *   罫線つきの署名欄)は変えない。個人情報は架空の値。
 */
describe("buildPasteDraft — イエイ 査定依頼", () => {
  const text = fixture("ieyi-assessment.txt");
  const draft = buildPasteDraft(text, { maxYear: 2026 });
  const withheldLabels = draft.withheldFromNote.map((w) => w.label);

  it("送り元を見分ける・導入ルートは一括査定", () => {
    expect(draft.sourceProfile).toBe("ieyi_assessment");
    expect(draft.sourceProfileLabel).toBe("イエイ 査定依頼");
    expect(introductionRouteForLeadSource(draft.sourceProfile)).toBe("bulk_assessment");
  });

  it("★物件の所在地・種別・面積・間取り・築年・現況が読める", () => {
    expect(draft.property.address.value).toBe("東京都世田谷区見本町1-2-3");
    expect(draft.property.address.sourceLabel).toBe("物件所在地");
    expect(draft.property.propertyType.value).toBe("house");
    expect(draft.property.layoutType.value).toBe("4LDK");
    expect(draft.property.builtYear.value).toBe("2010");
    expect(draft.property.occupancyStatus.value).toBe("occupied");
    expect(draft.warnings.map((w) => w.code)).not.toContain("address_missing");
    expect(draft.warnings.map((w) => w.code)).not.toContain("no_labeled_lines");
  });

  it("★お客様の氏名・フリガナ・現住所・電話・メール", () => {
    expect(draft.owner?.name.value).toBe("見本 太郎");
    expect(draft.owner?.name.sourceLabel).toBe("姓名");
    expect(draft.owner?.nameKana.value).toBe("ミホン タロウ");
    expect(draft.owner?.currentAddress.value).toBe("東京都目黒区見本台4-5-6");
    expect(draft.owner?.phone.value).toBe("09000000000");
    expect(draft.owner?.email.value).toBe("sample@example.com");
  });

  it("選択式の項目は物件の備考へ(査定方法・ご名義・ご依頼理由・売却時期など)", () => {
    for (const piece of ["簡易査定", "仲介", "私は名義人の家族・親族です", "資産整理のため", "1年以内", "連絡希望日: 特になし", "12時〜15時"]) {
      expect(draft.noteFromUnmapped).toContain(piece);
    }
  });

  it("年齢・氏名・フリガナ・現住所・連絡先は備考に入れない(所有者の個人情報)", () => {
    expect(withheldLabels).toContain("年齢");
    for (const piece of ["35", "見本 太郎", "ミホン", "見本台", "09000000000", "sample@"]) {
      expect(draft.noteFromUnmapped).not.toContain(piece);
    }
  });

  it("⚠イエイの見出しは送り元を問わず安全扱いにしない(知らない値は備考に入れない)", () => {
    const other = buildPasteDraft(
      "物件所在地：東京都A区1\nご名義：Jonathan Smith\nご依頼理由：山田花子様の相続のため\n希望連絡時間：山田の携帯へ夜に\n連絡希望日：佐藤様が戻る日\n査定種別：鈴木様経由",
      { maxYear: 2026 },
    );
    expect(other.withheldFromNote.map((w) => w.label)).toEqual(
      expect.arrayContaining(["ご名義", "ご依頼理由", "希望連絡時間", "連絡希望日", "査定種別"]),
    );
    for (const piece of ["Jonathan", "山田", "佐藤", "鈴木"]) expect(other.noteFromUnmapped).not.toContain(piece);
  });

  it("★冒頭の受信日時・イエイの署名欄は見出しで割らない(読み取れなかった行に残す)", () => {
    expect(withheldLabels.some((l) => l.startsWith("（"))).toBe(false);
    expect(withheldLabels).not.toContain("運営会社");
    expect(withheldLabels).not.toContain("サポート窓口");
    expect(draft.owner?.email.value).not.toContain("example.jp");
    expect(draft.unlabeled.some((l) => l.includes("イエイ経由"))).toBe(true);
    expect(draft.unlabeled.some((l) => l.includes("サポート窓口"))).toBe(true);
  });
});

describe("［見出し］の行の読み方(イエイだけ)", () => {
  const opts = parseOptionsFor("ieyi_assessment");

  it("見出しの次の行が値・空行で終わる・値の無い見出しは拾わない", () => {
    const r = parseLabeledLines("［物件種別］\n一戸建\n\n［賃料］\n\n\n［現況］\n居住中", opts);
    expect(r.labeled.map((l) => [l.label, l.value])).toEqual([
      ["物件種別", "一戸建"],
      ["現況", "居住中"],
    ]);
  });

  it("値の2行目が括弧で囲まれていればフリガナ・ほかの2行目は空白でつなぐ", () => {
    const r = parseLabeledLines("［姓名］\n山田 花子\n（ヤマダ ハナコ）\n\n［ご要望など］\n早めに\n連絡ください", opts);
    expect(r.labeled.map((l) => [l.label, l.value])).toEqual([
      ["姓名", "山田 花子"],
      ["フリガナ", "ヤマダ ハナコ"],
      ["ご要望など", "早めに 連絡ください"],
    ]);
  });

  it("「▼」の節の行と「見出し：値」の行で値は終わる・お客様の「住所」は現住所の見出しに", () => {
    const r = parseLabeledLines("［ご要望など］\n▼お客様情報\n［住所］\n東京都A区1\n［連絡先］\n電話番号1：0312345678", opts);
    expect(r.labeled.map((l) => [l.label, l.value])).toEqual([
      ["ご住所", "東京都A区1"],
      ["電話番号1", "0312345678"],
    ]);
    expect(r.unlabeled).toContain("▼お客様情報");
  });

  it("⚠括弧の行をフリガナにするのは氏名の見出しの下だけ(ご要望などの括弧は値の続き)", () => {
    const r = parseLabeledLines("［ご要望など］\n早めに売却したい\n（午前中に電話希望）\n\n［姓名］\n山田 花子\n（ヤマダ ハナコ）", opts);
    expect(r.labeled.map((l) => [l.label, l.value])).toEqual([
      ["ご要望など", "早めに売却したい （午前中に電話希望）"],
      ["姓名", "山田 花子"],
      ["フリガナ", "ヤマダ ハナコ"],
    ]);
  });

  it("⚠値の中のコロンで割らない・「見出し：値」で割るのは［連絡先］の下だけ", () => {
    const r = parseLabeledLines(
      "（2026-11-06 10:45:10）にイエイ経由で\n［希望連絡時間］\n12:00〜15:00\n\n［物件所在地］\n東京都A区1-2（地番：45）\n\n［ご要望など］\nよろしく\n\nTEL：0311112222\n\n［連絡先］\n電話番号1：0312345678",
      opts,
    );
    expect(r.labeled.map((l) => [l.label, l.value])).toEqual([
      ["希望連絡時間", "12:00〜15:00"],
      ["物件所在地", "東京都A区1-2（地番：45）"],
      ["ご要望など", "よろしく"],
      ["電話番号1", "0312345678"],
    ]);
    expect(r.unlabeled).toContain("TEL：0311112222");
  });

  it("⚠ほかの送り元の書式は今までどおりの送り元と読み取り(HOME4U・タカウルの見本)", () => {
    expect(buildPasteDraft(readFileSync(join(__dirname, "fixtures", "home4u-assessment.txt"), "utf8")).sourceProfile).toBe("home4u_assessment");
    expect(buildPasteDraft(readFileSync(join(__dirname, "fixtures", "takauru-assessment.txt"), "utf8")).sourceProfile).toBe("takauru_assessment");
  });

  it("⚠ほかの送り元の読み方は変えない(共通の読み方では［見出し］の行は読み取れなかった行のまま)", () => {
    const r = parseLabeledLines("［物件種別］\n一戸建");
    expect(r.labeled).toEqual([]);
    expect(r.unlabeled).toEqual(["［物件種別］", "一戸建"]);
  });
});

describe("イエイの見分け方", () => {
  it("「［物件所在地］」の行と、イエイに固有の見出しの行があるときだけ", () => {
    expect(detectSourceProfile([], ["［物件所在地］", "［査定種別］"])).toBe("ieyi_assessment");
    expect(detectSourceProfile([], ["［物件所在地］"])).toBe("generic");
    expect(detectSourceProfile([], ["［査定種別］"])).toBe("generic");
    expect(detectSourceProfile(["物件所在地"])).toBe("generic");
  });
});
