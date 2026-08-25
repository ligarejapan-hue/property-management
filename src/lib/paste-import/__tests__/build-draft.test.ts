import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPasteDraft } from "../build-draft";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

describe("buildPasteDraft — 実サンプルA（HOME4U 空き家相談）", () => {
  const draft = buildPasteDraft(fixture("home4u-vacant-house.txt"));

  it("送り元を見分ける", () => {
    expect(draft.sourceProfile).toBe("home4u_vacant_house");
  });

  it("★住所と地番を分けて取り出す（この機能の中心）", () => {
    expect(draft.property.address.value).toBe("世田谷区池尻4丁目26-8");
    expect(draft.property.lotNumber.value).toBe("552-2");
  });

  it("どの見出しから来たかを持つ", () => {
    expect(draft.property.address.sourceLabel).toBe("物件所在地");
  });

  it("種別を戸建にする", () => {
    expect(draft.property.propertyType.value).toBe("house");
  });

  it("和暦の築年を西暦にする", () => {
    expect(draft.property.builtYear.value).toBe("1996");
  });

  it("値が「-」の項目は拾わない（空欄のまま）", () => {
    expect(draft.property.layoutType.value).toBeNull();
    expect(draft.property.landArea.value).toBeNull();
  });

  it("所有者の情報が無いので owner は null", () => {
    expect(draft.owner).toBeNull();
  });

  it("一意の番号が無いので externalLinkKey は null", () => {
    expect(draft.externalLinkKey).toBeNull();
  });

  it("辞書に無い見出しは捨てずに備考へまとめる", () => {
    expect(draft.noteFromUnmapped).toContain("建物構造: 木造スレート葺");
    expect(draft.noteFromUnmapped).toContain("私道負担の有無: 私道（地番：552-11、210-10）持ち分あり");
    // 値が "-" のものは備考にも入れない（ノイズになるため）
    expect(draft.noteFromUnmapped).not.toContain("心理的瑕疵事項");
  });

  it("地番があるので地番の警告は出ない", () => {
    expect(draft.warnings.map((w) => w.code)).not.toContain("lot_number_missing");
  });
});

describe("buildPasteDraft — 実サンプルB（HOME4U 査定依頼）", () => {
  const draft = buildPasteDraft(fixture("home4u-assessment.txt"));

  it("送り元を見分ける", () => {
    expect(draft.sourceProfile).toBe("home4u_assessment");
  });

  it("★所在地から建物名と部屋番号を切り出す", () => {
    expect(draft.property.address.value).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(draft.property.buildingName.value).toBe("リーフィアレジデンス等々力");
    expect(draft.property.roomNo.value).toBe("303");
  });

  it("種別・面積・間取り・現況・築年を取り出す", () => {
    expect(draft.property.propertyType.value).toBe("apartment_unit");
    expect(draft.property.exclusiveArea.value).toBe("70");
    expect(draft.property.layoutType.value).toBe("2LK/2LDK");
    expect(draft.property.occupancyStatus.value).toBe("occupied");
    expect(draft.property.builtYear.value).toBe("2013");
  });

  it("★所有者の氏名・カナ・電話・メール・住所を取り出す", () => {
    expect(draft.owner).not.toBeNull();
    expect(draft.owner!.name.value).toBe("佐藤　花子");
    expect(draft.owner!.nameKana.value).toBe("サトウ　ハナコ");
    expect(draft.owner!.phone.value).toBe("09012345678");
    expect(draft.owner!.email.value).toBe("hanako@example.jp");
    expect(draft.owner!.currentAddress.value).toContain("等々力2丁目15番12号");
  });

  it("★査定ナンバーを外部キーにする（二重登録の防止に使う）", () => {
    expect(draft.externalLinkKey).toBe("SA2608-1234567");
  });

  it("★地番が無いので警告を出す", () => {
    const w = draft.warnings.find((x) => x.code === "lot_number_missing");
    expect(w).toBeDefined();
    expect(w!.message).toContain("謄本");
  });

  it("見出しの無い行（挨拶文など）に引きずられない", () => {
    expect(draft.property.address.value).not.toContain("担当者様");
  });
});

describe("buildPasteDraft — 読み取れないとき", () => {
  it("見出しが1つも無ければ警告を出し、欄は全部空", () => {
    const draft = buildPasteDraft("こんにちは\nよろしくお願いします");
    expect(draft.warnings.map((w) => w.code)).toContain("no_labeled_lines");
    expect(draft.property.address.value).toBeNull();
    expect(draft.owner).toBeNull();
  });

  it("住所が取れなければ警告を出す", () => {
    const draft = buildPasteDraft("■物件種別： 土地");
    expect(draft.warnings.map((w) => w.code)).toContain("address_missing");
  });

  it("知らない種別は unknown にして警告を出す", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■物件種別： 宇宙ステーション");
    expect(draft.property.propertyType.value).toBe("unknown");
    expect(draft.warnings.map((w) => w.code)).toContain("property_type_unknown");
  });

  it("氏名だけあって連絡先が無くても owner を作る（氏名が最低条件）", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎");
    expect(draft.owner).not.toBeNull();
    expect(draft.owner!.phone.value).toBeNull();
  });

  it("氏名が無ければ owner は作らない", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3\n■電話番号： 09000000000");
    expect(draft.owner).toBeNull();
  });
});
