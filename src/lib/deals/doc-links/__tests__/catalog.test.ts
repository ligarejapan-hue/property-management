import { describe, expect, it } from "vitest";
import { DOC_LINK_CATALOG, docLinkHintOf, docLinkOptionsFor } from "../catalog";
import { DEFAULT_CHECKLIST_ITEMS } from "../../checklist";

const ids = (role: "seller" | "buyer", deal: { base: "unit" | "house" | "land" | "building" | null; hasOc: boolean }) =>
  docLinkOptionsFor(role, deal).map((o) => o.id);

describe("提出書類の一覧(売主・買主ごと・2026-11-20 発注者)", () => {
  it("売主・買主とも: 実印・印鑑証明書/写真付き身分証明書/住民票(書類確認書の id のまま)", () => {
    for (const role of ["seller", "buyer"] as const) {
      expect(ids(role, { base: "unit", hasOc: false }).slice(0, 3)).toEqual(["s_bring_seal", "s_bring_id", "s_bring_resident"]);
    }
    const labels = docLinkOptionsFor("buyer", { base: "unit", hasOc: false }).map((o) => o.label);
    expect(labels.slice(0, 3)).toEqual(["実印・印鑑証明書", "写真付き身分証明書", "住民票"]);
  });
  it("買主だけ: 納税証明書", () => {
    expect(ids("buyer", { base: "house", hasOc: true })).toEqual(["s_bring_seal", "s_bring_id", "s_bring_resident", "doc_tax_certificate"]);
    expect(ids("seller", { base: "house", hasOc: true })).not.toContain("doc_tax_certificate");
  });
  it("売主だけ: マンションなら管理組合議事録、土地・戸建なら境界確認書・測量図、OC なら賃貸借契約書", () => {
    expect(ids("seller", { base: "unit", hasOc: false })).toEqual([
      "s_bring_seal", "s_bring_id", "s_bring_resident", "doc_hoa_minutes", "doc_purchase_brochure", "doc_property_tax_notice",
    ]);
    expect(ids("seller", { base: "house", hasOc: true })).toEqual([
      "s_bring_seal", "s_bring_id", "s_bring_resident", "doc_purchase_brochure", "doc_property_tax_notice", "s_recv_survey", "s_recv_leases",
    ]);
    for (const base of ["land", "building"] as const) expect(ids("seller", { base, hasOc: false })).toContain("s_recv_survey");
    expect(ids("seller", { base: null, hasOc: false })).not.toContain("doc_hoa_minutes");
  });
  it("外した書類(鍵・登記識別情報・領収書・管理規約)はどの組み合わせでも出ない", () => {
    const removed = ["s_recv_keys", "s_recv_title", "s_recv_receipt", "s_recv_bylaws"];
    for (const role of ["seller", "buyer"] as const) {
      for (const base of ["unit", "house", "land", "building", null] as const) {
        for (const hasOc of [true, false]) {
          for (const id of removed) expect(ids(role, { base, hasOc })).not.toContain(id);
        }
      }
    }
  });
  it("残した id は書類確認書の項目と同じ(受領の ✓ が付く)。新しい id は書類確認書の項目とぶつからない", () => {
    const checklistIds = new Set(DEFAULT_CHECKLIST_ITEMS.map((i) => i.id));
    for (const id of ["s_bring_seal", "s_bring_id", "s_bring_resident", "s_recv_survey", "s_recv_leases"]) expect(checklistIds.has(id)).toBe(true);
    for (const id of ["doc_tax_certificate", "doc_hoa_minutes", "doc_purchase_brochure", "doc_property_tax_notice"]) expect(checklistIds.has(id)).toBe(false);
    expect(new Set(DOC_LINK_CATALOG.map((c) => c.id)).size).toBe(DOC_LINK_CATALOG.length);
  });
  it("写真付き身分証明書には、お客様向けの一言と撮り方の注意がある(ほかの書類には無い)", () => {
    const hint = docLinkHintOf("s_bring_id");
    expect(hint?.text).toBe("運転免許証・マイナンバーカード・パスポートなど（法務局や住宅ローンの手続きに使えるもの）");
    expect(hint?.howto.join("")).toContain("運転免許証は表と裏の両方");
    expect(hint?.howto.join("")).toContain("パスポートは顔写真が載っているページ");
    expect(hint?.howto.join("")).toMatch(/マイナンバーカードは表面だけ。裏面の番号.*写さないか、隠してください/);
    expect(docLinkHintOf("s_bring_seal")).toBeNull();
    expect(docLinkHintOf("unknown")).toBeNull();
  });
});
