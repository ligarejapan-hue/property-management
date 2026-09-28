import { describe, it, expect } from "vitest";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { excelLeadCommitBody, excelLeadRecheckBody, recheckOutcome } from "../excel-lead-commit-body";

describe("excelLeadCommitBody — 1行を登録APIの形にする", () => {
  const text = [
    "反響番号：lj-1",
    "お名前：田中　次郎",
    "フリガナ：たなか　じろう",
    "ご住所：神奈川県横浜市港北区9-9",
    "電話番号：09000000000",
    "メールアドレス：jiro@example.com",
    "物件所在地：神奈川県横浜市港北区9丁目9-9",
    "物件種別：一戸建て",
    "土地面積：90 m2",
    "築年：2018年",
    "間取り：3LDK",
  ].join("\n");
  const draft = buildPasteDraft(text, { maxYear: 2026 });
  const body = excelLeadCommitBody({ draft, ownerNote: "Excel取込: x 2行目\n見込度: C" });

  it("物件と所有者を下書きの値のまま送る(既存の所有者には紐付けない)", () => {
    expect(body.property).toMatchObject({
      address: "神奈川県横浜市港北区9丁目9-9",
      propertyType: "house",
      lotNumber: null,
    });
    expect(body.owner).toMatchObject({
      name: "田中　次郎",
      nameKana: "たなか　じろう",
      phone: "09000000000",
      email: "jiro@example.com",
      currentAddress: "神奈川県横浜市港北区9-9",
      note: "Excel取込: x 2行目\n見込度: C",
    });
    expect(body.externalLinkKey).toBe("lj-1");
    expect(body.linkExistingOwnerId).toBeNull();
  });

  it("専用の列が無い土地面積・築年は、貼り付けと同じく物件の備考へ残す", () => {
    expect(body.property.note).toContain("土地面積: 90");
    expect(body.property.note).toContain("築年: 2018");
  });

  it("★管理のメモは物件の備考に入れない(所有者の備考だけ)", () => {
    expect(body.property.note ?? "").not.toContain("見込度");
  });

  it("氏名が無ければ所有者は送らない", () => {
    const d = buildPasteDraft("物件所在地：東京都港区1-1\n物件種別：土地");
    expect(excelLeadCommitBody({ draft: d, ownerNote: "x" }).owner).toBeNull();
  });
});

describe("登録直前の見直し(@codex PR#456 1巡目 ①)", () => {
  const draft = buildPasteDraft(
    "反響番号：lj-2\nお名前：渡辺　一\nご住所：東京都港区1-1\n物件所在地：東京都港区2-2\n物件種別：戸建",
  );
  const clean = {
    duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
    similar: [],
    ownerCandidates: [],
    ownerCandidatesTruncated: false,
  };

  it("見直しには下書きの値(鍵・住所・氏名・現住所)をそのまま送る", () => {
    expect(excelLeadRecheckBody({ draft })).toEqual({
      address: "東京都港区2-2",
      lotNumber: "",
      externalLinkKey: "lj-2",
      ownerName: "渡辺　一",
      ownerCurrentAddress: "東京都港区1-1",
    });
  });

  it("何も見つからなければ登録へ進む", () => {
    expect(recheckOutcome(draft, clean)).toEqual({ kind: "go" });
  });

  it("★同じ人の2行目: 1行目で作った所有者が候補に出たら、登録せず要確認へ回す", () => {
    expect(recheckOutcome(draft, { ...clean, ownerCandidates: [{ id: "o-1" }] })).toEqual({
      kind: "review",
      reasons: ["同じ名前の所有者がすでにいます"],
    });
  });

  it("★同じ物件の行: 似た物件が出たら要確認・同じ鍵なら登録済み", () => {
    expect(recheckOutcome(draft, { ...clean, similar: [{ id: "p-1" }] }).kind).toBe("review");
    expect(
      recheckOutcome(draft, {
        ...clean,
        duplicates: { blocked: true, blockedByPropertyId: "p-2", similarPropertyIds: [] },
      }),
    ).toEqual({ kind: "duplicate" });
  });

  it("候補が多すぎて確認しきれないときも要確認", () => {
    expect(recheckOutcome(draft, { ...clean, ownerCandidatesTruncated: true }).kind).toBe("review");
  });
});

describe("区分以外の種別で消える欄は備考に残す(@codex PR#456 2巡目 ①)", () => {
  const houseText = [
    "お名前：田中　次郎",
    "物件所在地：東京都港区1-1",
    "物件種別：一戸建て",
    "建物面積：70 m2",
    "間取り：3LDK",
    "現況：自身・親族が居住中",
  ].join("\n");

  it("★戸建の建物面積・間取り・現況は、登録で消える欄なので物件の備考に行として残す", () => {
    const body = excelLeadCommitBody({ draft: buildPasteDraft(houseText), ownerNote: "" });
    expect(body.property.note).toContain("建物面積: 70㎡");
    expect(body.property.note).toContain("間取り: 3LDK");
    expect(body.property.note).toContain("現況: 入居中");
  });

  it("区分マンションは専用の欄にそのまま入る(備考に重ねて書かない)", () => {
    const text = houseText.replace("一戸建て", "分譲マンション");
    const body = excelLeadCommitBody({ draft: buildPasteDraft(text), ownerNote: "" });
    expect(body.property).toMatchObject({ exclusiveArea: "70", layoutType: "3LDK", occupancyStatus: "occupied" });
    expect(body.property.note ?? "").not.toContain("建物面積");
  });
});
