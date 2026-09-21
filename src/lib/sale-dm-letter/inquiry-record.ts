import { lockPropertyRow } from "@/lib/property-record-guard";
import { syncSaleDmReaction, type ReactionSyncTx } from "@/lib/dm-reaction/sync";
import { hasRenderableLpVariant } from "./lp-render-input";
import type { InquiryInput } from "./inquiry-input";

// ⚠この説明は関数の外に置く。dm-writer-lock-order の走査は関数本文(export async function recordInquiry 以降)の呼び出し順を見るため、本文内のコメントに呼び出し名を書くと順序判定を狂わせる
/**
 * 公開LPの査定申込の記録(設計 §2.5)。
 *
 * 順序(R50=物件配下の書込は親行ロックから・recordTrackingHit と同じ):
 *   親の物件行ロック → ロック下で宛先の状態を読み直す(送付済みでなければ書かない。送付済みでも
 *   LP型が描画可能(hasRenderableLpVariant=見出し・本文とも空白以外)でなければ書かない=公開ページが
 *   一度も表示されない draft への直接 POST で申込・初回時刻を作らせない)
 *   → 申込 INSERT → 初回時刻(条件付き updateMany の count で確定=同時の二重初回を防ぐ)
 *   → QR読み取り・アプリ内ページ表示の2つの初回時刻の補い(下記) → 申込回数 +1・outcome=inquiry
 *   → 送付記録への反響同期。
 *
 * 2つの初回時刻の補い: 申込は必ずアプリ内LPページ(GET /t/<token>=QR読み取りの記録が先に走り、
 * ページが実際に返れば lp-page-view-record.ts の計測も走る)から送られるので lpFirstAccessAt と
 * lpPageFirstAt は通常すでに立っている。どちらも best-effort な計測で失敗し得るため、立っていない
 * ときだけここで立てる。フォーム送信そのものが「QRを読んだ」ことと「アプリ内ページが実際に描画された」
 * ことの両方の証拠になるため、どちらを取りこぼしていても申込の成立で補える。これで outcome の正準定義
 * (deriveOutcome=LP∪電話)を変えずに「申込があれば必ず反響あり」が成り立つ(outcome route が電話反響
 * を外しても申込の反響は消えない)し、LP型の閲覧集計(lpPageFirstAt を分母にする)も「1件申込・0件
 * 閲覧」に陥らない。
 * lpAccessCount・lpPageViewCount は増やさない(閲覧回数の水増しをしない。あくまで初回時刻の補い)。
 *
 * 同期は allowTerminal:false=「連絡あり」だけを書く(宛先不明は書かない=Owner ロック不要の公開経路)。
 * 拒否(配信停止)済みの送付記録は同期の優先規則(dm-reaction/core)で上書きされない。申込自体は保存する。
 *
 * 例外は投げる(呼び出し側が「混み合っています」を返す)。申込を黙って捨てない。
 */

export interface InquiryDraftRow {
  id: string;
  propertyId: string;
  status: string;
}

export interface InquiryLockedRow {
  status: string;
  lpVariant: { headline: string | null; bodyText: string | null } | null;
}

export interface InquiryTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmRecipientDraft: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; lpVariant: { select: { headline: true; bodyText: true } } };
    }) => Promise<InquiryLockedRow | null>;
    updateMany: (args: {
      where: { id: string; formInquiryFirstAt?: null; lpFirstAccessAt?: null; lpPageFirstAt?: null };
      data: { formInquiryFirstAt?: Date; lpFirstAccessAt?: Date; lpPageFirstAt?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: { formInquiryCount: { increment: number }; outcome: "inquiry" };
    }) => Promise<unknown>;
  };
  dmInquiry: {
    create: (args: {
      data: InquiryInput & { draftId: string; submittedAt: Date };
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
}

export interface InquiryClientLike {
  dmRecipientDraft: {
    findUnique: (args: {
      where: { trackingToken: string };
      select: { id: true; propertyId: true; status: true };
    }) => Promise<InquiryDraftRow | null>;
  };
  $transaction: <T>(fn: (tx: InquiryTx) => Promise<T>) => Promise<T>;
}

export type RecordInquiryResult =
  | { kind: "unknown" }
  | { kind: "not_sent" }
  | { kind: "no_form" }
  | { kind: "recorded"; inquiryId: string; draftId: string; first: boolean };

export async function recordInquiry(
  client: InquiryClientLike,
  token: string,
  input: InquiryInput,
  now: Date = new Date(),
): Promise<RecordInquiryResult> {
  const draft = await client.dmRecipientDraft.findUnique({
    where: { trackingToken: token },
    select: { id: true, propertyId: true, status: true },
  });
  if (!draft) return { kind: "unknown" };
  if (draft.status !== "sent") return { kind: "not_sent" };

  return client.$transaction(async (tx): Promise<RecordInquiryResult> => {
    await lockPropertyRow(tx, draft.propertyId);
    const locked = await tx.dmRecipientDraft.findUnique({
      where: { id: draft.id },
      select: { status: true, lpVariant: { select: { headline: true, bodyText: true } } },
    });
    if (!locked || locked.status !== "sent") return { kind: "not_sent" };
    if (!hasRenderableLpVariant(locked.lpVariant)) return { kind: "no_form" };

    const created = await tx.dmInquiry.create({
      data: {
        draftId: draft.id,
        submittedAt: now,
        name: input.name,
        phone: input.phone,
        email: input.email,
        contactPref: input.contactPref,
        contactTime: input.contactTime,
        message: input.message,
      },
      select: { id: true },
    });
    const claimed = await tx.dmRecipientDraft.updateMany({
      where: { id: draft.id, formInquiryFirstAt: null },
      data: { formInquiryFirstAt: now },
    });
    await tx.dmRecipientDraft.updateMany({
      where: { id: draft.id, lpFirstAccessAt: null },
      data: { lpFirstAccessAt: now },
    });
    await tx.dmRecipientDraft.updateMany({
      where: { id: draft.id, lpPageFirstAt: null },
      data: { lpPageFirstAt: now },
    });
    await tx.dmRecipientDraft.update({
      where: { id: draft.id },
      data: { formInquiryCount: { increment: 1 }, outcome: "inquiry" },
    });
    await syncSaleDmReaction(tx as unknown as ReactionSyncTx, draft.id, { allowTerminal: false });
    return { kind: "recorded", inquiryId: created.id, draftId: draft.id, first: claimed.count === 1 };
  });
}
