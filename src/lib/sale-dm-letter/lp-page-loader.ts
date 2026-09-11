/**
 * /t/[token] のページ描画用の読み出し(設計 §2.4)。計数(recordTrackingHit)とは分け、読むだけ。
 * select に氏名・宛先住所・所有者を**含めない**(テストで固定)。ページの材料は LP型の文章/枠/写真の publicId と
 * 物件の所在(町名まで)・種別・会社案内・配信停止URL だけ。
 */
import { buildLpRenderInput } from "./lp-render-input";
import { renderLpPage } from "./lp-page";
import { loadSaleDmPublicPageConfig } from "./config-store";
import { buildUnsubscribeToken, buildUnsubscribeUrl, deriveUnsubscribeKey } from "./unsubscribe-token";

const SELECT = {
  status: true,
  trackingToken: true,
  lpVariant: {
    select: {
      headline: true, lead: true, bodyText: true, faqJson: true,
      media: { select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } }, orderBy: { sortOrder: "asc" as const } },
    },
  },
  property: { select: { address: true, propertyType: true } },
} as const;

type Row = {
  status: "draft" | "confirmed" | "sent";
  trackingToken: string;
  lpVariant: { headline: string | null; lead: string | null; bodyText: string | null; faqJson: unknown; media: Array<{ slot: string; heading: string | null; figureKind: string | null; asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null }> } | null;
  property: { address: string | null; propertyType: string | null };
};
export interface LpPageClientLike { dmRecipientDraft: { findUnique: (args: { where: { trackingToken: string }; select: typeof SELECT }) => Promise<Row | null> } }
export type LpPageData = { kind: "none" } | { kind: "page"; html: string; status: Row["status"] };

// 配信停止URL: 印刷 route(お手紙の停止QR)と同じ導出をそのまま写す
// (deriveUnsubscribeKey → buildUnsubscribeToken → buildUnsubscribeUrl)。鍵が未導出(NEXTAUTH_SECRET
// 未設定)の環境では null を返し、ページは配信停止の案内なしで描画する(入口を壊さない)。
// baseUrl は loadSaleDmPublicPageConfig が印刷 route と同じ解決(resolveTrackingBaseUrl=絶対http(s)検証込み)を
// 適用済みの値を渡す。
function unsubscribeUrlFor(trackingToken: string, trackingBaseUrl: string | null): string | null {
  try {
    const key = deriveUnsubscribeKey();
    const token = buildUnsubscribeToken(trackingToken, key);
    return buildUnsubscribeUrl(token, trackingBaseUrl ?? undefined);
  } catch {
    return null;
  }
}

export async function loadLpPageData(client: LpPageClientLike, token: string): Promise<LpPageData> {
  // ロールアウトゲート(社内プレビュー route は対象外・このローダーを呼ぶのは公開 /t/[token] のみ):
  // SALE_DM_LP_PUBLIC_ENABLED が立つまでは常に none。draft の内容を見るより前に判定し、無効時は
  // DB 読み取り(dmRecipientDraft.findUnique)自体を行わない(送付済みの以前の印刷分が HTTPS 移行前に
  // 本番へデプロイした瞬間アプリ内ページとして出てしまう事故を止める)。
  // 公開・未認証・高頻度の /t 経路ゆえ秘匿APIキー列を読まない専用リーダーを使う
  // (loadSaleDmConfig は使わない=このページ描画パスで課金キーを materialize しない不変条件)。
  const cfg = await loadSaleDmPublicPageConfig();
  if (!cfg.lpPublicEnabled) return { kind: "none" };

  const row = await client.dmRecipientDraft.findUnique({ where: { trackingToken: token }, select: SELECT });
  const v = row?.lpVariant;
  // headline/bodyText は空白のみも未保存扱い(見た目上は空文と同じ=ページを出さない)。
  if (!row || !v || !v.headline?.trim() || !v.bodyText || v.bodyText.trim().length === 0) return { kind: "none" };
  const trackingBaseUrl = cfg.trackingBaseUrl ?? null;
  const mode = row.status === "sent" ? "live" : "preview";
  const input = buildLpRenderInput(
    {
      variant: { headline: v.headline, lead: v.lead, bodyText: v.bodyText, faqJson: v.faqJson },
      media: v.media,
      property: row.property,
      company: { senderName: cfg.senderName, senderContact: cfg.senderContact },
    },
    {
      mode,
      unsubscribeUrl: mode === "live" ? unsubscribeUrlFor(row.trackingToken, trackingBaseUrl) : null,
      phoneTapToken: mode === "live" ? row.trackingToken : null,
    },
  );
  return { kind: "page", html: renderLpPage(input), status: row.status };
}
