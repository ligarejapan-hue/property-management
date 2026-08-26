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
    // 「間取り」の行は値が実際に "-" ＝ 空値フィルタを通ってはじめて null になる。
    expect(draft.property.layoutType.value).toBeNull();
  });

  it("文書に項目そのものが無ければ null（土地面積の行が無い）", () => {
    // ⚠ home4u-vacant-house.txt に「土地面積」の行は実物どおり存在しない。
    //   ここは「行が無い→null」を確かめるテストで、
    //   「値が-→null」を確かめる空値フィルタのテストとは意図が別。
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

  it("見出しが1つも無いときは no_labeled_lines のみ（住所/地番の警告は重ねない）", () => {
    const draft = buildPasteDraft("こんにちは\nよろしくお願いします");
    expect(draft.warnings.map((w) => w.code)).toEqual(["no_labeled_lines"]);
    expect(draft.warnings.map((w) => w.code)).not.toContain("address_missing");
    expect(draft.warnings.map((w) => w.code)).not.toContain("lot_number_missing");
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

  it("同じ見出しが2回出たら先に出た方を採る", () => {
    const draft = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■お名前： 田中\n■お名前： 佐藤",
    );
    expect(draft.owner!.name.value).toBe("田中");
  });

  it("空値の行はスロットを消費しない（1回目が「-」、2回目が実値なら実値を採る）", () => {
    const draft = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■間取り： -\n■間取り： 2LDK",
    );
    expect(draft.property.layoutType.value).toBe("2LDK");
  });
});

const NL = "\n";

describe("区切りが無い行(unlabeled)を捨てない（設計書 §4.2・全体レビュー I-5）", () => {
  it("★下書きに unlabeled が残る", () => {
    const draft = buildPasteDraft(
      "この物件についてのご相談です" + NL +
      "■物件所在地： 東京都A区B1-2-3" + NL +
      "よろしくお願いいたします",
    );
    expect(draft.unlabeled).toEqual([
      "この物件についてのご相談です",
      "よろしくお願いいたします",
    ]);
    // 拾えた項目は従来どおり(unlabeled を持たせたことで壊れていない)。
    expect(draft.property.address.value).toBe("東京都A区B1-2-3");
  });

  it("区切りのある行だけなら unlabeled は空", () => {
    const draft = buildPasteDraft("■物件所在地： 東京都A区B1-2-3");
    expect(draft.unlabeled).toEqual([]);
  });
});

describe("buildPasteDraft も年の上限を引数で受け取る（6巡目 ④）", () => {
  it("★上限を渡すと、それを超える築年は拾わない", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL + "■築年（西暦）： 2099 年",
      { maxYear: 2026 },
    );
    expect(d.property.builtYear.value).toBeNull();
  });

  it("★上限の内側なら従来どおり拾う", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL + "■築年（西暦）： 2013 年",
      { maxYear: 2026 },
    );
    expect(d.property.builtYear.value).toBe("2013");
  });

  it("上限を渡さなければ従来どおり（既存の呼び出しを壊さない）", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL + "■築年（西暦）： 2099 年",
    );
    expect(d.property.builtYear.value).toBe("2099");
  });
});

describe("値を解釈できなかった欄は、捨てても黙りもしない（9巡目 ②）", () => {
  const NLL = "\n";

  it("★面積『20坪（66.1㎡）』: 警告が出る / 生の値が備考に残る / 欄は空", () => {
    // 捨てて黙ると、確認画面に「元の資料に記載がありません」と出る＝
    // 元資料には書いてあるのに無いと言う＝利用者への嘘。
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NLL + "■建物（専有）面積： 20坪（66.1㎡）",
    );
    expect(d.property.exclusiveArea.value).toBeNull();
    const w = d.warnings.find((x) => x.code === "value_unreadable" && x.field === "exclusiveArea");
    expect(w).toBeTruthy();
    expect(w!.message).toContain("20坪（66.1㎡）");
    expect(d.noteFromUnmapped).toContain("20坪（66.1㎡）");
    expect(d.noteFromUnmapped).toContain("建物（専有）面積");
  });

  it("★土地面積でも同じ扱い", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NLL + "■土地面積： 30坪",
    );
    expect(d.property.landArea.value).toBeNull();
    expect(d.warnings.some((x) => x.code === "value_unreadable" && x.field === "landArea")).toBe(true);
    expect(d.noteFromUnmapped).toContain("30坪");
  });

  it("★築年の元号エラー（平成32年）でも同じ扱い（面積だけ直していない）", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NLL + "■築年数： 平成32年建築",
    );
    expect(d.property.builtYear.value).toBeNull();
    const w = d.warnings.find((x) => x.code === "value_unreadable" && x.field === "builtYear");
    expect(w).toBeTruthy();
    expect(w!.message).toContain("平成32年建築");
    expect(d.noteFromUnmapped).toContain("平成32年建築");
  });

  it("★現況の言い換えが分からないときも同じ扱い", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NLL + "■現況： 未定",
    );
    expect(d.property.occupancyStatus.value).toBeNull();
    expect(d.warnings.some((x) => x.code === "value_unreadable" && x.field === "occupancyStatus")).toBe(true);
    expect(d.noteFromUnmapped).toContain("未定");
  });

  it("★読み取れた値では警告も備考行も作らない（過剰に出していない）", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NLL + "■建物（専有）面積： 70 平米" + NLL + "■築年（西暦）： 2013 年",
    );
    expect(d.property.exclusiveArea.value).toBe("70");
    expect(d.property.builtYear.value).toBe("2013");
    expect(d.warnings.some((x) => x.code === "value_unreadable")).toBe(false);
    expect(d.noteFromUnmapped).not.toContain("70 平米");
  });

  it("★見出しそのものが無ければ警告は出さない（本当に記載が無い場合）", () => {
    const d = buildPasteDraft("■物件所在地： 東京都A区B1-2-3");
    expect(d.warnings.some((x) => x.code === "value_unreadable")).toBe(false);
  });
});

describe("所有者の個人情報は備考へ入れない（11巡目 ①）", () => {
  const NL2 = "\n";

  it("★『携帯電話』は備考に入らず、withheldFromNote に残る（捨てない）", () => {
    // Property.note は所有者の項目別マスクを通らずに表示される＝
    // owner_phone の権限が無い人でも電話番号を保存でき、全員に見えてしまう。
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL2 + "■携帯電話： 090-1234-5678",
    );
    expect(d.noteFromUnmapped).not.toContain("090-1234-5678");
    expect(d.noteFromUnmapped).not.toContain("携帯電話");
    expect(d.withheldFromNote).toEqual([
      { label: "携帯電話", value: "090-1234-5678", reason: "label" },
    ]);
  });

  it("★『連絡先住所』も同じ扱い", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL2 + "■連絡先住所： 東京都渋谷区X1-1-1",
    );
    expect(d.noteFromUnmapped).not.toContain("東京都渋谷区X1-1-1");
    expect(d.withheldFromNote.map((w) => w.label)).toEqual(["連絡先住所"]);
  });

  it("★見出しが分からなくても、値が電話番号なら備考に入れない", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL2 + "■ご連絡いただける窓口： 090-1234-5678",
    );
    expect(d.noteFromUnmapped).not.toContain("090-1234-5678");
    expect(d.withheldFromNote[0].reason).toBe("value");
  });

  it("★『建物構造: 木造』のような所有者と無関係な項目は従来どおり備考に入る", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL2 + "■建物構造： 木造スレート葺",
    );
    expect(d.noteFromUnmapped).toContain("建物構造: 木造スレート葺");
    expect(d.withheldFromNote).toEqual([]);
  });

  it("★実サンプル(査定依頼)の『年齢』は備考へ行かない", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL2 + "■年齢： 71 歳",
    );
    expect(d.noteFromUnmapped).not.toContain("71 歳");
    expect(d.withheldFromNote.map((w) => w.label)).toEqual(["年齢"]);
  });
});

describe("読み取れなかった生値は、どの欄のものかを持つ（11巡目 ②の土台）", () => {
  const NL3 = "\n";

  it("★unreadable に field / label / 生値が入る", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL3 + "■土地面積： 20坪（66.1㎡）",
    );
    expect(d.unreadable).toEqual([
      { field: "landArea", label: "土地面積", value: "20坪（66.1㎡）" },
    ]);
    // 備考にも同じ行が入っている(まだ人が値を入れていないので残す)。
    expect(d.noteFromUnmapped).toContain("土地面積: 20坪（66.1㎡）");
  });

  it("読み取れた値では unreadable は空", () => {
    const d = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3" + NL3 + "■土地面積： 66.1㎡",
    );
    expect(d.unreadable).toEqual([]);
  });
});
