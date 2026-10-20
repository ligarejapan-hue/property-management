/**
 * 広告用の公開ページ(/lp/<公開名>)の申込を記録する(設計 2026-10-20 §2)。
 * 宛先(draft)が無いので、DM 用(inquiry-record.ts)のような物件のロック・反響の同期は無い。
 * ⚠DMの種類の行を FOR UPDATE でロックしてから「使う・削除されていない・公開名が同じ」を読み直して入れる
 *  (@codex #535 R4 P2: 受け口の存在確認と INSERT の間に管理者の削除(論理削除)が挟まると、削除済みの種類に
 *   申込が付いてしまう。削除側も同じ行をロックして申込の数を数えるので、どちらかが先に決まる)。
 */
import type { InquiryInput } from "./inquiry-input";
import type { AdParams } from "./lp-public";

export interface PublicInquiryCreateData extends InquiryInput, AdParams {
  source: "public";
  scenarioId: string;
  publicSlug: string;
  submittedAt: Date;
}

export interface PublicInquiryTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmInquiry: {
    create: (args: { data: PublicInquiryCreateData; select: { id: true } }) => Promise<{ id: string }>;
  };
}

export interface PublicInquiryClientLike {
  $transaction: <T>(fn: (tx: PublicInquiryTx) => Promise<T>) => Promise<T>;
}

export type RecordPublicInquiryResult = { kind: "unavailable" } | { kind: "recorded"; inquiryId: string };

export async function recordPublicInquiry(
  client: PublicInquiryClientLike,
  scenario: { id: string; slug: string },
  input: InquiryInput,
  ad: AdParams,
  now: Date = new Date(),
): Promise<RecordPublicInquiryResult> {
  return client.$transaction(async (tx): Promise<RecordPublicInquiryResult> => {
    const rows = await tx.$queryRaw<Array<{ id: string; active: boolean; deleted_at: Date | null; public_slug: string | null }>>`
      SELECT id, active, deleted_at, public_slug FROM dm_scenarios WHERE id = ${scenario.id}::uuid FOR UPDATE`;
    const locked = rows[0];
    if (!locked || !locked.active || locked.deleted_at !== null || locked.public_slug !== scenario.slug) {
      return { kind: "unavailable" };
    }
    const created = await tx.dmInquiry.create({
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
    return { kind: "recorded", inquiryId: created.id };
  });
}
