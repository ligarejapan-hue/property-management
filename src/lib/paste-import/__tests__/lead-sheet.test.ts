import { describe, it, expect } from "vitest";
import {
  readLeadSheet,
  composeLeadOwnerNote,
  leadRowStatus,
  withFallbackLinkKey,
} from "../lead-sheet";
import { buildPasteDraft } from "../build-draft";

// ⚠値はすべて架空。実物の顧客管理表と**同じ見出し・同じ並び**だけを写す
//   (fake-must-mirror-real-markup)。

/** 顧客管理(HOME4U・タカウル).xlsx の書式: 1行目=表題、2行目=見出し、URL列に反響メール本文。 */
const FORM_HEADER = [
  "依頼日付", "姓名", "住所　物件名", "物件種別", "コンタクト", "見込度", "架電",
  "メール", "査定書", "DM", "アポ", "担当者", "メモ", "URL",
];

const HOME4U_MAIL = [
  "査定ナンバー：H-0001",
  "物件種別：マンション",
  "物件名称：テストハイツ",
  "物件所在地：東京都世田谷区桜丘9丁目9-9 テストハイツ101",
  "建物（専有）面積：55.5㎡",
  "お名前：山田　太郎",
  "フリガナ：ヤマダ　タロウ",
  "ご住所：東京都世田谷区桜丘9丁目9-9",
  "電話番号：090-0000-0000",
  "E-mail：taro@example.com",
  "年齢：60代",
].join("\n");

const formSheet = (rows: string[][]) => [["  顧客管理表"], FORM_HEADER, ...rows];

/** 顧客管理(リビンマッチ).xlsx の書式: 1行目=見出し、項目ごとに列が分かれる。 */
const LIVIN_HEADER = [
  "SN", "媒体", "案件ID", "登録日時", "見込度", "推定ステータス", "姓名", "ふりがな",
  "連絡先住所", "年齢", "電話番号", "メールアドレス", "物件の名義", "物件所在地",
  "所在地(町名以下)", "物件種別/経営プラン", "建物面積 ", "土地面積 土地面積単位",
  "間取り（部屋数・タイプ） 間取り(その他)", "築年", "物件の現況", "ご依頼の理由", "担当者氏名",
];

describe("readLeadSheet — 査定サイト反響の顧客管理表", () => {
  it("URL列の反響メール本文をそのまま下書きの文章にし、管理の列は所有者の備考へ回す", () => {
    const r = readLeadSheet("HOME4U", formSheet([
      ["2025/05/28", "山田　太郎", "世田谷区桜丘9-9-9 テストハイツ", "マンション", "済", "C", "済",
        "済", "", "", "", "勝地", "6/1 電話 留守\n6/2 折返しあり", HOME4U_MAIL],
    ]));
    expect(r.format).toBe("form_text");
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.rowNumber).toBe(3); // Excel上の行番号(表題・見出しの下)
    expect(row.text).toContain("査定ナンバー：H-0001");
    const draft = buildPasteDraft(row.text);
    expect(draft.owner?.name.value).toBe("山田　太郎");
    expect(draft.externalLinkKey).toBe("H-0001");
    // 管理の列は文章に入れない(物件の備考=誰でも見える欄へ流さない)
    expect(row.text).not.toContain("勝地");
    expect(row.ownerNoteLines).toContain("見込度: C");
    expect(row.ownerNoteLines).toContain("担当者: 勝地");
    // 複数行のメモも失わない
    expect(row.ownerNoteLines.join("\n")).toContain("6/2 折返しあり");
  });

  it("URL列が空でも、姓名・住所・種別の列から下書きを作る", () => {
    const r = readLeadSheet("HOME4U", formSheet([
      ["2025/06/01", "佐藤　花子", "世田谷区赤堤9-9-9", "戸建", "", "", "", "", "", "", "", "", "", ""],
    ]));
    const draft = buildPasteDraft(r.rows[0].text);
    expect(draft.owner?.name.value).toBe("佐藤　花子");
    expect(draft.property.address.value).toBe("世田谷区赤堤9-9-9");
    expect(draft.property.propertyType.value).toBe("house");
  });

  it("メール本文に氏名があれば、そちらが優先される(列の値は足りないときだけ使う)", () => {
    const r = readLeadSheet("HOME4U", formSheet([
      ["2025/05/28", "山田太郎(列)", "別の住所", "戸建", "", "", "", "", "", "", "", "", "", HOME4U_MAIL],
    ]));
    const draft = buildPasteDraft(r.rows[0].text);
    expect(draft.owner?.name.value).toBe("山田　太郎");
    expect(draft.property.propertyType.value).toBe("apartment_unit");
  });

  it("タカウルの「査定物件の所在地」を物件の住所として読む", () => {
    const mail = ["物件種別：マンション", "査定物件の所在地：東京都世田谷区玉川9丁目9番9号", "お名前：鈴木　一郎"].join("\n");
    const r = readLeadSheet("タカウル", formSheet([
      ["2025/07/22", "鈴木　一郎", "世田谷区玉川9-9-9", "マンション", "", "", "", "", "", "", "", "", "", mail],
    ]));
    const draft = buildPasteDraft(r.rows[0].text);
    expect(draft.property.address.value).toBe("東京都世田谷区玉川9丁目9番9号");
  });

  it("項目ごとに列が分かれた表(リビンマッチ)を見出し付きの文章に組み直す", () => {
    const r = readLeadSheet("顧客管理（リビンマッチ）", [
      LIVIN_HEADER,
      ["1", "不動産売却", "lj-0001", "2024/6/22 7:50", "0.1", "本人確認済", "田中　次郎", "たなか　じろう",
        "神奈川県横浜市港北区9-9", "62歳", "09000000000", "jiro@example.com", "物件の名義人",
        "神奈川県横浜市港北区", "9丁目9-9", "一戸建て", "70 m2", "90 m2", "3LK／3LDK ", "2018年",
        "自身・親族が居住中", "相続", "村山"],
    ]);
    expect(r.format).toBe("columns");
    const row = r.rows[0];
    expect(row.rowNumber).toBe(2);
    const draft = buildPasteDraft(row.text);
    expect(draft.externalLinkKey).toBe("lj-0001");
    expect(draft.owner?.name.value).toBe("田中　次郎");
    expect(draft.owner?.nameKana.value).toBe("たなか　じろう");
    expect(draft.owner?.phone.value).toBe("09000000000");
    expect(draft.owner?.email.value).toBe("jiro@example.com");
    expect(draft.owner?.currentAddress.value).toBe("神奈川県横浜市港北区9-9");
    expect(draft.property.address.value).toBe("神奈川県横浜市港北区9丁目9-9");
    expect(draft.property.propertyType.value).toBe("house");
    expect(draft.property.landArea.value).toBe("90");
    expect(draft.property.builtYear.value).toBe("2018");
    expect(row.ownerNoteLines).toEqual(expect.arrayContaining([
      "媒体: 不動産売却", "見込度: 0.1", "推定ステータス: 本人確認済", "年齢: 62歳",
      "物件の名義: 物件の名義人", "ご依頼の理由: 相続", "担当者氏名: 村山",
    ]));
    // 個人に関わる列は文章(=物件の備考へ流れうる側)に入れない
    expect(row.text).not.toContain("62歳");
  });

  it("値の中の改行は1行にまとめる(行単位の読み取りで項目が割れないように)", () => {
    const header = [...LIVIN_HEADER];
    const cells = header.map(() => "");
    cells[header.indexOf("姓名")] = "田中\n次郎";
    cells[header.indexOf("物件所在地")] = "東京都港区";
    const r = readLeadSheet("x", [header, cells]);
    expect(buildPasteDraft(r.rows[0].text).owner?.name.value).toBe("田中 次郎");
  });

  it("見出しが見つからないシート・空のシートは行を返さない", () => {
    expect(readLeadSheet("空", []).rows).toEqual([]);
    const r = readLeadSheet("無関係", [["品名", "数量"], ["りんご", "3"]]);
    expect(r.format).toBeNull();
    expect(r.rows).toEqual([]);
  });

  it("見出しの上に空行がいくつあっても見つける(空行は探す範囲に数えない)", () => {
    const blanks = Array.from({ length: 8 }, () => [] as string[]);
    const r = readLeadSheet("HOME4U", [...blanks, ...formSheet([
      ["2025/06/01", "佐藤　花子", "世田谷区赤堤9-9-9", "戸建", "", "", "", "", "", "", "", "", "", ""],
    ])]);
    expect(r.format).toBe("form_text");
    expect(r.rows[0].rowNumber).toBe(11);
  });

  it("見出しだけで中身のない行は飛ばす", () => {
    const r = readLeadSheet("HOME4U", formSheet([
      FORM_HEADER.map(() => ""),
      ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ]));
    expect(r.rows).toEqual([]);
  });

  it("反響番号の無い行の鍵の材料は、メモや進み具合が変わっても同じ(取り込み直しで二重登録しない)", () => {
    const a = readLeadSheet("タカウル", formSheet([
      ["2025/07/22", "鈴木　一郎", "世田谷区玉川9-9-9", "マンション", "", "C", "", "", "", "", "", "", "メモ1", ""],
    ])).rows[0];
    const b = readLeadSheet("タカウル", formSheet([
      ["2025/07/22", "鈴木　一郎", "世田谷区玉川9-9-9", "マンション", "済", "A", "済", "", "", "", "〇", "村山", "メモ2", ""],
    ])).rows[0];
    expect(a.keySeed).toBe(b.keySeed);
    const c = readLeadSheet("タカウル", formSheet([
      ["2025/07/22", "鈴木　一郎", "世田谷区玉川1-1-1", "マンション", "", "", "", "", "", "", "", "", "", ""],
    ])).rows[0];
    expect(c.keySeed).not.toBe(a.keySeed);
  });
});

describe("withFallbackLinkKey", () => {
  it("反響番号が読めない文章にだけ、鍵の行を足す", () => {
    const text = "お名前：鈴木　一郎\n物件所在地：東京都港区1-1";
    const withKey = withFallbackLinkKey(text, buildPasteDraft(text), "xlsx-abc");
    expect(buildPasteDraft(withKey).externalLinkKey).toBe("xlsx-abc");
    const has = "査定ナンバー：H-1\nお名前：鈴木";
    expect(withFallbackLinkKey(has, buildPasteDraft(has), "xlsx-abc")).toBe(has);
  });
});

describe("composeLeadOwnerNote", () => {
  it("取込元・管理の列・備考へ入れなかった項目・読み取れなかった行を所有者の備考にまとめる", () => {
    const text = "お名前：山田\n物件所在地：東京都港区1-1\n年齢：60代\n自由に書かれた一文";
    const note = composeLeadOwnerNote(
      { sheetName: "HOME4U", rowNumber: 5, ownerNoteLines: ["見込度: C", "メモ: 留守"] },
      buildPasteDraft(text),
    );
    expect(note.split("\n")[0]).toBe("Excel取込: HOME4U 5行目");
    expect(note).toContain("見込度: C");
    expect(note).toContain("メモ: 留守");
    expect(note).toContain("年齢: 60代");
    expect(note).toContain("自由に書かれた一文");
  });
});

describe("leadRowStatus", () => {
  const ok = buildPasteDraft("お名前：山田\n物件所在地：東京都港区1-1\n物件種別：戸建");
  const none = { blocked: false, similarCount: 0, ownerCandidateCount: 0, ownerCandidatesTruncated: false };

  it("氏名・住所・種別が読めて、似た物件も同名の所有者も無ければ登録できる", () => {
    expect(leadRowStatus(ok, none)).toEqual({ status: "ready", reasons: [] });
  });

  it("同じ反響番号の物件があれば登録済み", () => {
    expect(leadRowStatus(ok, { ...none, blocked: true }).status).toBe("registered");
  });

  it("似た物件・同名の所有者・確認しきれない候補は要確認(自動でつながない)", () => {
    expect(leadRowStatus(ok, { ...none, similarCount: 1 }).reasons).toEqual(["同じ住所の物件がすでにあります"]);
    expect(leadRowStatus(ok, { ...none, ownerCandidateCount: 2 }).reasons).toEqual(["同じ名前の所有者がすでにいます"]);
    expect(leadRowStatus(ok, { ...none, ownerCandidatesTruncated: true }).status).toBe("review");
  });

  it("氏名・住所・種別が読めない行は要確認", () => {
    const d = buildPasteDraft("物件種別：一棟\n電話番号：090-0000-0000");
    const r = leadRowStatus(d, none);
    expect(r.status).toBe("review");
    expect(r.reasons).toEqual([
      "物件の住所が読み取れません",
      "氏名が読み取れません",
      "物件種別が分かりません",
    ]);
  });
});
