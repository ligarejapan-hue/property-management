import { describe, it, expect, vi } from "vitest";
import { recordPublicInquiry } from "@/lib/sale-dm-letter/lp-public-record";

const INPUT = { name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい", propertyAddress: "世田谷区経堂1-2-3" };
const AD = { utmSource: "google", utmMedium: "cpc", utmCampaign: "aki", utmTerm: null, utmContent: null, gclid: "G1" };
const NOW = new Date("2026-10-20T01:00:00.000Z");

describe("recordPublicInquiry(広告用の公開ページの申込を記録)", () => {
  it("宛先なし・source=public・DMの種類と公開名・所在地・広告の印を1行に保存し、id を返す", async () => {
    const create = vi.fn(async () => ({ id: "inq1" }));
    const r = await recordPublicInquiry({ dmInquiry: { create } }, { id: "s1", slug: "souzoku" }, INPUT, AD, NOW);
    expect(r).toEqual({ inquiryId: "inq1" });
    expect(create).toHaveBeenCalledTimes(1);
    const { data, select } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown>; select: unknown }])[0];
    expect(select).toEqual({ id: true });
    expect(data).toEqual({
      source: "public",
      scenarioId: "s1",
      publicSlug: "souzoku",
      submittedAt: NOW,
      name: "山田",
      phone: "090-1234-5678",
      email: null,
      contactPref: null,
      contactTime: null,
      message: "相談したい",
      propertyAddress: "世田谷区経堂1-2-3",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "aki",
      utmTerm: null,
      utmContent: null,
      gclid: "G1",
    });
    expect("draftId" in data).toBe(false);
  });
});
