import { describe, it, expect } from "vitest";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { excelLeadCommitBody } from "../excel-lead-commit-body";

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
