import { describe, it, expect } from "vitest";
import { buildInquiryNotifyMail, formatJst } from "@/lib/sale-dm-letter/inquiry-notify-mail";
import { HIDDEN_NAME_PLACEHOLDER } from "@/lib/sale-dm-letter/inquiry-list";

const F = {
  inquiryId: "11111111-1111-4111-8111-111111111111",
  submittedAt: new Date("2026-09-18T05:05:00Z"),
  campaignName: "9月 空き家",
  dmVariantLabel: "A",
  lpVariantLabel: "安心",
  location: "世田谷区代沢",
  propertyTypeLabel: "戸建",
  name: "山田 太郎",
  phone: "090-1234-5678",
  email: "taro@example.jp",
  contactPref: "phone",
  contactTime: "平日夜",
  message: "相談したい",
};

describe("buildInquiryNotifyMail", () => {
  it("件名=【査定申込】町名の種別(キャンペーン名)", () => {
    expect(buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null }).subject).toBe(
      "【査定申込】世田谷区代沢の戸建(9月 空き家)",
    );
  });
  it("件名の改行は除き、120字で切る・町名/種別が無ければ一般語", () => {
    const s = buildInquiryNotifyMail(
      { ...F, campaignName: "x\r\ny".repeat(100), location: null, propertyTypeLabel: null },
      { detail: "minimal", appBaseUrl: null },
    ).subject;
    expect(s).not.toMatch(/[\r\n]/);
    expect([...s].length).toBeLessThanOrEqual(120);
    expect(s.startsWith("【査定申込】所在地不明の物件(")).toBe(true);
  });
  it("minimal は電話・メール・時間帯・要望を含まない", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: "https://pm.example.ts.net/" });
    for (const v of ["090-1234-5678", "taro@example.jp", "平日夜", "相談したい"]) expect(text).not.toContain(v);
    expect(text).toContain("受付日時: 2026年9月18日 14:05");
    expect(text).toContain("お名前: 山田 太郎");
    expect(text).toContain("DM型: A / LP型: 安心");
    expect(text).toContain(
      "https://pm.example.ts.net/properties/sale-dm/inquiries?focus=11111111-1111-4111-8111-111111111111",
    );
  });
  it("full は電話・メール・希望連絡方法・時間帯・要望を含む", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "full", appBaseUrl: null });
    for (const v of [
      "電話: 090-1234-5678",
      "メール: taro@example.jp",
      "希望の連絡方法: 電話",
      "連絡のつきやすい時間帯: 平日夜",
      "相談したい",
    ])
      expect(text).toContain(v);
  });
  it("minimal では数字や @ を含むお名前を伏せる・full ではそのまま", () => {
    const f = { ...F, name: "山田 090" };
    expect(buildInquiryNotifyMail(f, { detail: "minimal", appBaseUrl: null }).text).toContain(
      `お名前: ${HIDDEN_NAME_PLACEHOLDER}`,
    );
    expect(buildInquiryNotifyMail(f, { detail: "full", appBaseUrl: null }).text).toContain("お名前: 山田 090");
  });
  it("アプリのURLが無ければリンクの代わりに案内文", () => {
    const { text } = buildInquiryNotifyMail(F, { detail: "minimal", appBaseUrl: null });
    expect(text).toContain("アプリの「査定の申込」からご確認ください。");
    expect(text).not.toContain("focus=");
  });
  it("formatJst", () => {
    expect(formatJst(new Date("2026-12-31T15:00:00Z"))).toBe("2027年1月1日 00:00");
  });
});
