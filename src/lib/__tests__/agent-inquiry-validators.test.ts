import { describe, it, expect } from "vitest";
import {
  agentCreateSchema, inquiryCreateSchema, inquiryUpdateSchema, adPermissionsPutSchema,
  normalizeAgentInput, normalizeInquiryContact,
} from "@/lib/agent-inquiry/validators";

const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";

describe("業者の入力", () => {
  it("商号と代表電話は必須", () => {
    expect(agentCreateSchema.safeParse({ companyName: "", phone: "0312345678" }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ companyName: "○○不動産", phone: "" }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ companyName: "○○不動産", phone: "0312345678" }).success).toBe(true);
  });
  it("電話はハイフン入りへ・桁不正はそのまま・空の任意欄は null", () => {
    const a = normalizeAgentInput(agentCreateSchema.parse({ companyName: " ○○不動産 ", phone: "0312345678", fax: "", email: "" }));
    expect(a).toMatchObject({ companyName: "○○不動産", phone: "03-1234-5678", fax: null, email: null });
    expect(normalizeAgentInput(agentCreateSchema.parse({ companyName: "x", phone: "0312" })).phone).toBe("0312");
  });
  it("メール形式が不正なら弾く", () => {
    expect(agentCreateSchema.safeParse({ companyName: "x", phone: "0312345678", email: "abc" }).success).toBe(false);
  });
});

describe("反響の入力", () => {
  const base = { propertyId: PID, agentId: AID, kind: "viewing", viewing: { viewingType: "guided" } };
  it("物件と業者と用件は必須・入口の既定は電話", () => {
    expect(inquiryCreateSchema.safeParse({ agentId: AID, kind: "viewing" }).success).toBe(false);
    expect(inquiryCreateSchema.parse(base).channel).toBe("phone");
  });
  it("用件は3つだけ(空室確認は無い)", () => {
    expect(inquiryCreateSchema.safeParse({ ...base, kind: "vacancy" }).success).toBe(false);
    expect(inquiryCreateSchema.safeParse(base).success).toBe(true);
    for (const k of ["ad_permission", "material_request"]) {
      expect(inquiryCreateSchema.safeParse({ propertyId: PID, agentId: AID, kind: k }).success).toBe(true);
    }
  });
  it("用件=内見なら案内/下見の指定が必須(日時は空でよい・@codex #454 R2 P2)", () => {
    expect(inquiryCreateSchema.safeParse({ propertyId: PID, agentId: AID, kind: "viewing" }).success).toBe(false);
    expect(inquiryCreateSchema.safeParse({ ...base, viewing: { viewingType: "preview", scheduledAt: null } }).success).toBe(true);
  });
  it("内見の予定は用件=内見のときだけ受け付ける", () => {
    const v = { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z" };
    expect(inquiryCreateSchema.safeParse({ ...base, viewing: v }).success).toBe(true);
    expect(inquiryCreateSchema.safeParse({ ...base, kind: "ad_permission", viewing: v }).success).toBe(false);
  });
  it("日時の無い内見(日程調整中)も可", () => {
    expect(inquiryCreateSchema.safeParse({ ...base, viewing: { viewingType: "preview" } }).success).toBe(true);
  });
  it("携帯は整形・メールの空は null", () => {
    expect(normalizeInquiryContact({ contactName: " 田中 ", contactMobile: "09012345678", contactEmail: "" }))
      .toEqual({ contactName: "田中", contactMobile: "090-1234-5678", contactEmail: null });
  });
  it("触らない項目はキーごと出さない", () => {
    expect(normalizeInquiryContact({})).toEqual({});
  });
  it("変更は version 必須", () => {
    expect(inquiryUpdateSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(inquiryUpdateSchema.safeParse({ status: "done", version: 1 }).success).toBe(true);
  });
});

describe("広告の可否", () => {
  it("6媒体×ok/ng/ask/null(null=未設定に戻す)", () => {
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "ok" }, { medium: "flyer", value: null }] }).success).toBe(true);
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "twitter", value: "ok" }] }).success).toBe(false);
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "maybe" }] }).success).toBe(false);
  });
  it("同じ媒体を2回送れない", () => {
    expect(adPermissionsPutSchema.safeParse({ items: [{ medium: "athome", value: "ok" }, { medium: "athome", value: "ng" }] }).success).toBe(false);
  });
});
