import { describe, it, expect } from "vitest";
import { buildPasteDraft } from "../build-draft";
import { leadRowStatus } from "../lead-sheet";
import { stripRoomFromBlockNumber } from "../split-fields";

/**
 * HOME4U 査定依頼の**表の形**(見出しと値がタブ区切り・2026-10-26 発注者の貼り付け)。
 * 住所が4行・氏名が姓/名・フリガナがカナ姓/カナ名に分かれている。
 * 「査定依頼者建物名号室」の行は見出しと値の間のタブが抜けていた(実物どおり)。
 * ⚠値はすべて架空。
 */
const lines = (overrides: Record<string, string> = {}): string => {
  const rows: [string, string][] = [
    ["査定ナンバー", "SA2610-0000001"],
    ["査定依頼日付", "2026/10/20"],
    ["査定依頼時刻", "13:41:22"],
    ["物件種別", "分譲マンション（区分所有）"],
    ["物件都道府県", "東京都"],
    ["物件市区町村", "世田谷区"],
    ["物件町字", "三軒茶屋"],
    ["物件丁目番地号", "1-2-3-405"],
    ["物件建物名", "テスト三軒茶屋マンション"],
    ["物件号室", "405"],
    ["専有延べ床面積", "55.5平米"],
    ["土地面積", ""],
    ["間取り", "1LK/1LDK"],
    ["階数", ""],
    ["築年", "2001 年"],
    ["現況", "居住中"],
    ["名義", "物件の名義人本人"],
    ["姓", "試験"],
    ["名", "太郎"],
    ["カナ姓", "シケン"],
    ["カナ名", "タロウ"],
    ["年齢", "50"],
    ["電話番号", "090-0000-0000"],
    ["電話番号2", ""],
    ["メールアドレス", "taro@example.com"],
    ["査定依頼者郵便番号", ""],
    ["査定依頼者住所", "東京都世田谷区三軒茶屋1-2-3"],
  ];
  const out = rows.map(([k, v]) => `${k}\t${k in overrides ? overrides[k] : v}`);
  // タブが抜けた行(実物どおり)
  out.push(`査定依頼者建物名号室${overrides["査定依頼者建物名号室"] ?? "テスト三軒茶屋マンション405号室"}`);
  out.push("査定の理由\t住み替え");
  out.push("売却の希望時期\t６ヶ月以内に売りたい");
  out.push("査定方法\t机上査定（簡易査定）");
  out.push("▼ 簡易査定の作成支援サービスです。是非ご活用ください。 ▼");
  return out.join("\n");
};

describe("buildPasteDraft — HOME4U 査定依頼(表の形)", () => {
  const draft = buildPasteDraft(lines());

  it("送り元は HOME4U 査定依頼", () => {
    expect(draft.sourceProfile).toBe("home4u_assessment");
  });

  it("★4行に分かれた住所をつなぐ(部屋番号と同じ末尾は外す)", () => {
    expect(draft.property.address.value).toBe("東京都世田谷区三軒茶屋1-2-3");
    expect(draft.warnings.map((w) => w.code)).not.toContain("address_missing");
  });

  it("建物名・部屋番号を読む", () => {
    expect(draft.property.buildingName.value).toBe("テスト三軒茶屋マンション");
    expect(draft.property.roomNo.value).toBe("405");
    expect(draft.property.roomNo.sourceLabel).toBe("物件号室");
  });

  it("専有延べ床面積は面積の欄へ読む(登録のときに備考へ回る)", () => {
    expect(draft.property.exclusiveArea.value).toBe("55.5");
  });

  it("★姓と名をつないで氏名に・カナもつなぐ", () => {
    expect(draft.owner?.name.value).toBe("試験　太郎");
    expect(draft.owner?.nameKana.value).toBe("シケン　タロウ");
    expect(draft.applicantName).toBe("試験　太郎");
    expect(draft.warnings.map((w) => w.code)).not.toContain("owner_name_missing");
  });

  it("★申込者の住所に、タブの抜けた建物名号室の行もつなぐ", () => {
    expect(draft.owner?.currentAddress.value).toBe("東京都世田谷区三軒茶屋1-2-3 テスト三軒茶屋マンション405号室");
    expect(draft.unlabeled.join("\n")).not.toContain("査定依頼者建物名号室");
  });

  it("つないだ元の行は、備考に入れない項目にも二重に出さない", () => {
    const withheld = draft.withheldFromNote.map((w) => w.label);
    for (const l of ["物件都道府県", "物件市区町村", "物件町字", "物件丁目番地号", "物件建物名", "姓", "名", "カナ姓", "カナ名", "査定依頼者住所"]) {
      expect(withheld).not.toContain(l);
    }
  });

  it("★申込者の氏名・住所・電話・年齢は物件の備考に入らない(備考は物件を見られる人全員に出る)", () => {
    for (const v of ["試験", "太郎", "シケン", "三軒茶屋1-2-3", "090-0000-0000", "50", "taro@example.com"]) {
      expect(draft.noteFromUnmapped).not.toContain(v);
    }
  });

  it("今まで読めていた欄はそのまま", () => {
    expect(draft.property.propertyType.value).toBe("apartment_unit");
    expect(draft.property.layoutType.value).toBe("1LK/1LDK");
    expect(draft.property.occupancyStatus.value).toBe("occupied");
    expect(draft.property.builtYear.value).toBe("2001");
    expect(draft.owner?.phone.value).toBe("090-0000-0000");
    expect(draft.owner?.email.value).toBe("taro@example.com");
    expect(draft.externalLinkKey).toBe("SA2610-0000001");
  });

  it("名義が本人なら名義の警告は出ない", () => {
    expect(draft.warnings.map((w) => w.code)).not.toContain("applicant_may_not_be_holder");
  });

  it("Excel のまとめて登録でも、氏名・住所が読めないことでは止めない", () => {
    const st = leadRowStatus(draft, { blocked: false, similarCount: 0, ownerCandidateCount: 0, ownerCandidatesTruncated: false });
    expect(st.reasons).not.toContain("物件の住所が読み取れません");
    expect(st.reasons).not.toContain("氏名が読み取れません");
  });
});

describe("HOME4U 表の形 — 細かい場合", () => {
  it("丁目番地号の末尾が部屋番号と違えば外さない(推測しない)", () => {
    const d = buildPasteDraft(lines({ "物件丁目番地号": "1-2-3" }));
    expect(d.property.address.value).toBe("東京都世田谷区三軒茶屋1-2-3");
    const d2 = buildPasteDraft(lines({ "物件丁目番地号": "1-2-3-406" }));
    expect(d2.property.address.value).toBe("東京都世田谷区三軒茶屋1-2-3-406");
  });

  it("3つだけの番地(1-2-405)は、号室と同じでも外さない", () => {
    const d = buildPasteDraft(lines({ "物件丁目番地号": "1-2-405" }));
    expect(d.property.address.value).toBe("東京都世田谷区三軒茶屋1-2-405");
  });

  it("全角の番地・「号室」付きの号室でも外せる。号室が空なら外さない", () => {
    expect(stripRoomFromBlockNumber("１－２－３－４０５", "４０５")).toBe("１－２－３");
    expect(stripRoomFromBlockNumber("1-2-3-405", "405号室")).toBe("1-2-3");
    expect(stripRoomFromBlockNumber("1-2-3-405", undefined)).toBe("1-2-3-405");
  });

  it("名義が「本人以外」「本人ではない」でも警告を出す", () => {
    for (const v of ["本人以外", "本人ではない"]) {
      const d = buildPasteDraft(lines({ "名義": v }));
      expect(d.warnings.map((w) => w.code)).toContain("applicant_may_not_be_holder");
    }
  });

  it("郵便番号があれば申込者の住所の頭に付ける", () => {
    const d = buildPasteDraft(lines({ "査定依頼者郵便番号": "154-0024" }));
    expect(d.owner?.currentAddress.value).toBe("154-0024 東京都世田谷区三軒茶屋1-2-3 テスト三軒茶屋マンション405号室");
  });

  it("名だけ空なら姓だけを氏名にする", () => {
    const d = buildPasteDraft(lines({ "名": "" }));
    expect(d.owner?.name.value).toBe("試験");
  });

  it("★名義が本人でなければ警告を出し、まとめて登録しない", () => {
    const d = buildPasteDraft(lines({ "名義": "家族の名義" }));
    const w = d.warnings.find((x) => x.code === "applicant_may_not_be_holder");
    expect(w?.message).toContain("家族の名義");
    const st = leadRowStatus(d, { blocked: false, similarCount: 0, ownerCandidateCount: 0, ownerCandidatesTruncated: false });
    expect(st.status).toBe("review");
  });

  it("タブの抜けた行の扱いは、その見出しで始まる行だけ(ほかの区切り無しの行は従来どおり)", () => {
    const d = buildPasteDraft(lines());
    expect(d.unlabeled).toContain("▼ 簡易査定の作成支援サービスです。是非ご活用ください。 ▼");
  });

  it("「名」の見出しだけ(姓が無い)では氏名にしない", () => {
    const d = buildPasteDraft("物件所在地：東京都世田谷区三軒茶屋1-2-3\n名\t太郎");
    expect(d.owner).toBeNull();
  });
});
