import { describe, it, expect } from "vitest";
import {
  DOC_KINDS,
  DOC_STAGES,
  classifyDocument,
  docKindByCode,
  docStageOfKind,
  normalizeForMatch,
} from "../classify";

describe("種類の表", () => {
  it("段階は ①契約前 ②契約関係 ③決済関係 ④本人確認 の順", () => {
    expect(DOC_STAGES.map((s) => s.code)).toEqual([
      "pre_contract",
      "contract",
      "settlement",
      "identity",
    ]);
  });

  it("種類の code は重複せず、必ず表にある段階を指す", () => {
    const codes = DOC_KINDS.map((k) => k.code);
    expect(new Set(codes).size).toBe(codes.length);
    const stageCodes = new Set(DOC_STAGES.map((s) => s.code));
    for (const k of DOC_KINDS) expect(stageCodes.has(k.stage)).toBe(true);
  });

  it("docKindByCode / docStageOfKind", () => {
    expect(docKindByCode("sales_contract")?.label).toBe("売買契約書");
    expect(docKindByCode("nope")).toBeNull();
    expect(docStageOfKind("settlement_notice")).toBe("settlement");
    expect(docStageOfKind(null)).toBeNull();
  });
});

describe("normalizeForMatch", () => {
  it("全角英数・空白・大文字を吸収する", () => {
    expect(normalizeForMatch("【完成版】　売買 契約書 ＰＤＦ")).toBe("【完成版】売買契約書pdf");
  });
});

describe("classifyDocument: ファイル名", () => {
  const byName = (fileName: string) => classifyDocument({ fileName });

  it.each([
    ["【完成版】売買契約書.pdf", "sales_contract", "contract"],
    ["重要事項説明書（西荻リリエン）.pdf", "disclosure", "contract"],
    ["付帯設備表　ハマイハイライズ305号室.xlsx", "fixtures_list", "contract"],
    ["物件状況告知書.pdf", "condition_report", "contract"],
    ["ハマイハイライズ　媒介契約書.pdf", "brokerage_agreement", "pre_contract"],
    ["管理に係る重要事項調査報告書.pdf", "mgmt_report", "pre_contract"],
    ["管理規約.pdf", "bylaws", "pre_contract"],
    ["査定報告書_2026.pdf", "appraisal_report", "pre_contract"],
    ["決済ご案内（ハマイハイライズ305）.pdf", "settlement_notice", "settlement"],
    ["精算金（ハマイハイライズ３０５）.pdf", "settlement_statement", "settlement"],
    ["取引完了確認書.docx", "completion_confirmation", "settlement"],
    ["区分所有者変更届.pdf", "owner_change_forms", "settlement"],
    ["預金口座振替依頼書.pdf", "owner_change_forms", "settlement"],
    ["鍵引渡確認書.pdf", "key_handover", "settlement"],
    ["運転免許証.jpg", "identity_document", "identity"],
  ])("%s → %s(%s)・high", (fileName, kind, stage) => {
    const r = byName(fileName);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe(kind);
    expect(r?.stage).toBe(stage);
    expect(r?.confidence).toBe("high");
  });

  it("重要事項説明書 と 重要事項調査報告書 を取り違えない", () => {
    expect(byName("重要事項調査報告書_11308.pdf")?.kind).toBe("mgmt_report");
    expect(byName("重要事項説明書案（最終版）.pdf")?.kind).toBe("disclosure");
    // 「重要事項説明書依頼」も説明書の仲間として扱う(依頼の書類はその他に落とさない)
    expect(byName("重要事項説明書依頼3.pdf")?.kind).toBe("disclosure");
  });

  it("名前の「領収書」は手付なら契約・残代金/仲介手数料なら決済", () => {
    expect(byName("手付金領収書.pdf")?.kind).toBe("deposit_receipt");
    expect(byName("残代金領収書.pdf")?.kind).toBe("settlement_receipt");
    expect(byName("株式会社A御中_媒介契約に基づく仲介手数料として_領収書_REC-18.pdf")?.kind).toBe("settlement_receipt");
  });

  it("名前だけの「領収書」は決済の領収書・low", () => {
    const r = byName("領収書.pdf");
    expect(r?.kind).toBe("settlement_receipt");
    expect(r?.confidence).toBe("low");
  });

  it("当たらなければ null", () => {
    expect(byName("IMG_0042.jpg")).toBeNull();
    expect(byName("資料.pdf")).toBeNull();
  });
});

describe("classifyDocument: 本文", () => {
  it("名前で当たらず、見出し域(先頭)に語があれば high", () => {
    const r = classifyDocument({
      fileName: "scan001.pdf",
      text: "\n\n不動産売買契約書\n\n売主 甲 と 買主 乙 は…",
    });
    expect(r?.kind).toBe("sales_contract");
    expect(r?.confidence).toBe("high");
  });

  it("見出し域より後ろにしか無ければ low", () => {
    const filler = "あ".repeat(800);
    const r = classifyDocument({ fileName: "scan002.pdf", text: `${filler}付帯設備表` });
    expect(r?.kind).toBe("fixtures_list");
    expect(r?.confidence).toBe("low");
  });

  it("名前の判定が本文より優先", () => {
    const r = classifyDocument({ fileName: "付帯設備表.pdf", text: "売買契約書" });
    expect(r?.kind).toBe("fixtures_list");
  });

  it("本文に複数の種類があれば最も前のもの", () => {
    const r = classifyDocument({
      fileName: "x.pdf",
      text: "決済のご案内 … 添付: 精算書 …",
    });
    expect(r?.kind).toBe("settlement_notice");
  });

  it("本文は先頭 3,000 文字だけ見る", () => {
    const r = classifyDocument({ fileName: "x.pdf", text: `${"い".repeat(3000)}売買契約書` });
    expect(r).toBeNull();
  });

  it("本文の「領収書」は手付/残代金の語で振り分ける", () => {
    expect(classifyDocument({ fileName: "a.pdf", text: "領収書 … 手付金として" })?.kind).toBe("deposit_receipt");
    expect(classifyDocument({ fileName: "b.pdf", text: "領収書 … 残代金として" })?.kind).toBe("settlement_receipt");
  });

  it("本文では領収書を優先しない(持ち物欄に「領収書」とある決済のご案内は、ご案内のまま)", () => {
    const r = classifyDocument({
      fileName: "x.pdf",
      text: "決済のご案内\n\n当日お持ちいただくもの: 仲介手数料の領収書 …",
    });
    expect(r?.kind).toBe("settlement_notice");
    // 売買契約書の本文に「手付金の領収書」が1回出ても契約書のまま
    expect(classifyDocument({ fileName: "y.pdf", text: "不動産売買契約書 … 手付金の領収書を交付する" })?.kind).toBe("sales_contract");
  });

  it("text が undefined / 空でも落ちない", () => {
    expect(classifyDocument({ fileName: "x.pdf", text: undefined })).toBeNull();
    expect(classifyDocument({ fileName: "x.pdf", text: "" })).toBeNull();
  });
});
