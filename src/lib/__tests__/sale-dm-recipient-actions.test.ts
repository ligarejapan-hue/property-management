import { describe, it, expect } from "vitest";
import { variantLabel, isInquiry, buildOutcomePayload } from "../sale-dm-letter/recipient-actions";
import type { SaleDmDraft, SaleDmVariant } from "@/lib/api-client";

const variants: SaleDmVariant[] = [
  { id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  { id: "v2", label: "B", designTemplate: "impact", tone: "soft", length: "short", appeal: "buyer", strength: "high", extraInstruction: null },
];

const baseDraft: SaleDmDraft = {
  id: "r1", variantId: "v1", propertyId: "p1", recipientName: "田中 一郎", recipientZip: null,
  recipientAddress: null, honorific: "様", body: "本文", status: "draft", outcome: "none",
  deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
};

describe("variantLabel", () => {
  it("variantId に対応する label を返す", () => {
    expect(variantLabel(variants, "v2")).toBe("B");
  });
  it("見つからなければ '-' を返す", () => {
    expect(variantLabel(variants, "zzz")).toBe("-");
  });
});

describe("isInquiry", () => {
  it("lpFirstAccessAt があれば true", () => {
    expect(isInquiry({ ...baseDraft, lpFirstAccessAt: "2026-06-20T00:00:00Z" })).toBe(true);
  });
  it("phoneInquiryAt があれば true", () => {
    expect(isInquiry({ ...baseDraft, phoneInquiryAt: "2026-06-20T00:00:00Z" })).toBe(true);
  });
  it("どちらも無ければ false", () => {
    expect(isInquiry(baseDraft)).toBe(false);
  });
});

describe("buildOutcomePayload", () => {
  it("配達結果のみ", () => {
    expect(buildOutcomePayload({ deliveryStatus: "delivered" })).toEqual({ deliveryStatus: "delivered" });
  });
  it("電話問い合わせトグル true", () => {
    expect(buildOutcomePayload({ phoneInquiry: true })).toEqual({ phoneInquiry: true });
  });
  it("両方指定", () => {
    expect(buildOutcomePayload({ deliveryStatus: "returned_undeliverable", phoneInquiry: false }))
      .toEqual({ deliveryStatus: "returned_undeliverable", phoneInquiry: false });
  });
  it("未指定キーは payload に入れない", () => {
    expect(buildOutcomePayload({})).toEqual({});
  });
});
