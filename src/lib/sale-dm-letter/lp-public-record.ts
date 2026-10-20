/**
 * 広告用の公開ページ(/lp/<公開名>)の申込を記録する(設計 2026-10-20 §2)。
 * 宛先(draft)が無いので、DM 用(inquiry-record.ts)のような物件のロック・反響の同期は無い。
 * 1行を dm_inquiries に source=public で入れるだけ。
 */
import type { InquiryInput } from "./inquiry-input";
import type { AdParams } from "./lp-public";

export interface PublicInquiryCreateData extends InquiryInput, AdParams {
  source: "public";
  scenarioId: string;
  publicSlug: string;
  submittedAt: Date;
}

export interface PublicInquiryClientLike {
  dmInquiry: {
    create: (args: { data: PublicInquiryCreateData; select: { id: true } }) => Promise<{ id: string }>;
  };
}

export async function recordPublicInquiry(
  client: PublicInquiryClientLike,
  scenario: { id: string; slug: string },
  input: InquiryInput,
  ad: AdParams,
  now: Date = new Date(),
): Promise<{ inquiryId: string }> {
  const created = await client.dmInquiry.create({
    data: {
      source: "public",
      scenarioId: scenario.id,
      publicSlug: scenario.slug,
      submittedAt: now,
      name: input.name,
      phone: input.phone,
      email: input.email,
      contactPref: input.contactPref,
      contactTime: input.contactTime,
      message: input.message,
      propertyAddress: input.propertyAddress,
      utmSource: ad.utmSource,
      utmMedium: ad.utmMedium,
      utmCampaign: ad.utmCampaign,
      utmTerm: ad.utmTerm,
      utmContent: ad.utmContent,
      gclid: ad.gclid,
    },
    select: { id: true },
  });
  return { inquiryId: created.id };
}
