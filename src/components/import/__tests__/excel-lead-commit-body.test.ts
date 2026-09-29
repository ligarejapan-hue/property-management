import { describe, it, expect } from "vitest";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { excelLeadCommitBody, commitOutcome } from "../excel-lead-commit-body";

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

  it("★土地面積・築年は物件の欄に入れる(備考に重ねて書かない・@codex PR#456 3巡目)", () => {
    expect(body.property).toMatchObject({ landArea: "90", builtYear: 2018 });
    expect(body.property.note ?? "").not.toContain("土地面積");
    expect(body.property.note ?? "").not.toContain("築年");
  });

  it("★管理のメモは物件の備考に入れない(所有者の備考だけ)", () => {
    expect(body.property.note ?? "").not.toContain("見込度");
  });

  it("氏名が無ければ所有者は送らない", () => {
    const d = buildPasteDraft("物件所在地：東京都港区1-1\n物件種別：土地");
    expect(excelLeadCommitBody({ draft: d, ownerNote: "x" }).owner).toBeNull();
  });
});

describe("登録APIの応答の読み分け(@codex PR#456 1巡目 ①・4巡目 ①)", () => {
  it("まとめ取込は、確定の時点での重複確認を登録APIに頼む", () => {
    const d = buildPasteDraft("お名前：渡辺\n物件所在地：東京都港区2-2\n物件種別：戸建");
    expect(excelLeadCommitBody({ draft: d, ownerNote: "" }).requireNoDuplicates).toBe(true);
  });

  it("成功は作った物件へ", () => {
    expect(commitOutcome(200, { propertyId: "p-1" })).toEqual({ kind: "created", propertyId: "p-1" });
  });

  it("★確定の時点で候補が見つかった(NEEDS_REVIEW)ら要確認・理由は1つずつ", () => {
    expect(commitOutcome(409, { error: { code: "NEEDS_REVIEW", message: "同じ住所の物件がすでにあります／同じ名前の所有者がすでにいます" } }))
      .toEqual({ kind: "review", reasons: ["同じ住所の物件がすでにあります", "同じ名前の所有者がすでにいます"] });
  });

  it("同じ反響番号(DUPLICATE)は登録済み・それ以外の失敗は理由つき", () => {
    expect(commitOutcome(409, { error: { code: "DUPLICATE", message: "この案件は登録済みです" } })).toEqual({ kind: "duplicate" });
    expect(commitOutcome(400, { error: { code: "BAD_REQUEST", message: "メールアドレスの形式が正しくありません" } }))
      .toEqual({ kind: "failed", message: "メールアドレスの形式が正しくありません" });
    expect(commitOutcome(500, null)).toEqual({ kind: "failed", message: "処理に失敗しました（500）" });
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

  it("★戸建の建物面積は延床面積の欄へ。間取り・現況は登録で消える欄なので物件の備考に行として残す", () => {
    const body = excelLeadCommitBody({ draft: buildPasteDraft(houseText), ownerNote: "" });
    expect(body.property.totalFloorArea).toBe("70");
    expect(body.property.exclusiveArea).toBeNull();
    expect(body.property.note ?? "").not.toContain("建物面積");
    expect(body.property.note).toContain("間取り: 3LDK");
    expect(body.property.note).toContain("現況: 入居中");
  });

  it("区分マンションは専用の欄にそのまま入る(備考に重ねて書かない)", () => {
    const text = houseText.replace("一戸建て", "分譲マンション");
    const body = excelLeadCommitBody({ draft: buildPasteDraft(text), ownerNote: "" });
    expect(body.property).toMatchObject({ exclusiveArea: "70", layoutType: "3LDK", occupancyStatus: "occupied" });
    expect(body.property.totalFloorArea).toBeNull();
    expect(body.property.note ?? "").not.toContain("建物面積");
  });

  it("★棟なしの区分マンションの築年は物件の欄へ(編集画面に出る)。土地面積は区分の欄に無いので備考へ", () => {
    const text = [houseText.replace("一戸建て", "分譲マンション"), "築年：2001年", "土地面積：30 m2"].join("\n");
    const body = excelLeadCommitBody({ draft: buildPasteDraft(text), ownerNote: "" });
    expect(body.property.builtYear).toBe(2001);
    expect(body.property.landArea).toBeNull();
    expect(body.property.note).toContain("土地面積: 30");
    expect(body.property.note ?? "").not.toContain("築年");
  });

  it("★土地に建物面積・築年があっても延床面積・築年の欄には入れず、備考に残す(@codex PR#456 4巡目)", () => {
    const text = [houseText.replace("一戸建て", "土地"), "築年：1980年", "土地面積：120 m2"].join("\n");
    const body = excelLeadCommitBody({ draft: buildPasteDraft(text), ownerNote: "" });
    expect(body.property).toMatchObject({ landArea: "120", totalFloorArea: null, builtYear: null });
    expect(body.property.note).toContain("建物面積: 70㎡");
    expect(body.property.note).toContain("築年: 1980");
  });
});
