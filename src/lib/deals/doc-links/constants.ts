/**
 * お客様の書類提出 — 画面とサーバーの両方で使う定数(発注者依頼 2026-11-01)。
 * ⚠サーバー専用の部品を import しない(取引の画面からも読む)。
 */

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;
export const DOC_LINK_DEFAULT_DAYS = 14;
export const DOC_LINK_MAX_DAYS = 60;
export const DOC_LINK_REJECT_REASON_MAX = 200;
export const DOC_LINK_ROLES = ["seller", "buyer"] as const;
export type DocLinkRole = (typeof DOC_LINK_ROLES)[number];
export const DOC_LINK_ROLE_LABELS: Record<DocLinkRole, string> = { seller: "売主", buyer: "買主" };

/** 写真の上限で、PDF を縮めるときの目標(写真はスマホの中で縮めてから送る)。 */
export const DOC_FILE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * PDF として受け取ってよい大きさ(縮める前)。8MB を超えた PDF はサーバーで縮める(2026-11-06 発注者)。
 * ⚠受け口は proxy を通さない(src/proxy.ts の SUBMIT_UPLOAD_PATTERN)。nginx の見本は 32m。
 */
export const DOC_PDF_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
/** 縮めても 8MB に届かないとき、保存してよい大きさ(社内の添付と同じ 20MB・2026-10-19 発注者決定)。 */
export const DOC_FILE_ACCEPT_BYTES = 20 * 1024 * 1024;
/** 差し戻したものを除いて、1書類あたりのファイル数。 */
export const DOC_FILES_PER_REQUEST = 5;
/** 差し戻したものも含めて、1リンクあたりのファイル数(ディスクを使い切られない上限)。 */
export const DOC_FILES_PER_LINK = 50;
/**
 * 差し戻したものも含めて、1リンクあたりの合計の大きさ。1ファイル 20MB まで保存できるようにした(2026-11-06)ので、
 * ディスクの使い方の最悪が前(50 ファイル × 8MB)より増えないよう合計でも見る。
 */
export const DOC_BYTES_PER_LINK = DOC_FILES_PER_LINK * DOC_FILE_MAX_BYTES;

export const DOC_REQUEST_STATUSES = ["pending", "submitted", "received", "rejected"] as const;
export type DocRequestStatus = (typeof DOC_REQUEST_STATUSES)[number];
export const DOC_REQUEST_STATUS_LABELS: Record<DocRequestStatus, string> = {
  pending: "未提出", submitted: "確認待ち", received: "受領", rejected: "差し戻し",
};

/** お客様のページの提出状況。差し戻しの理由は出さない(担当者が再案内の文面で伝える)。 */
export const DOC_REQUEST_PUBLIC_LABELS: Record<DocRequestStatus, string> = {
  pending: "未提出", submitted: "届きました(確認中)", received: "確認しました", rejected: "もう一度提出してください",
};

/** 後で消す仕組みが使う状態。⚠received は自動で消さない。 */
export const DOC_FILE_REVIEW_STATES = ["unreviewed", "received", "rejected", "deal_cancelled_unreviewed"] as const;
export type DocFileReviewState = (typeof DOC_FILE_REVIEW_STATES)[number];

export type DocLinkState = "active" | "expired" | "revoked" | "party_changed";
export const DOC_LINK_STATE_LABELS: Record<DocLinkState, string> = {
  active: "有効", expired: "期限切れ", revoked: "無効", party_changed: "当事者が変わったため無効",
};

/** お客様が提出できる取引の状態(中止・決済済では止める)。 */
const OPEN_DEAL_STATUSES: ReadonlySet<string> = new Set(["considering", "contracted"]);
export const isDealOpenForDocs = (status: string): boolean => OPEN_DEAL_STATUSES.has(status);

/** 発行した日(日本時間)から days 日後の日の終わりまで有効=その翌日 0:00 に切れる(案内の文面の日付どおりに使える)。 */
export function docLinkExpiresAt(now: Date, days: number): Date {
  const jstDay = Math.floor((now.getTime() + JST_OFFSET_MS) / DAY_MS);
  return new Date((jstDay + days + 1) * DAY_MS - JST_OFFSET_MS);
}

/** 画面と文面に出す期限の日(日本時間の YYYY-MM-DD)。切れる瞬間の前の日。 */
export const docLinkExpiresOn = (expiresAt: Date): string =>
  new Date(expiresAt.getTime() - 1 + JST_OFFSET_MS).toISOString().slice(0, 10);

export interface DocLinkGate { partyRole: string; party: { role: string; isSelf: boolean } | null; revokedAt: Date | null; expiresAt: Date }

/** リンクの今の状態。期限ちょうどは切れた扱い。 */
export function docLinkStateOf(link: DocLinkGate, now: Date): DocLinkState {
  // 当事者を消した・自社にした・売主と買主を入れ替えた=発行した相手ではなくなった(動かさない)。
  if (!link.party || link.party.isSelf || link.party.role !== link.partyRole) return "party_changed";
  if (link.revokedAt) return "revoked";
  return link.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

/** お客様がこのリンクで見て・提出してよいか。 */
export function isDocLinkOpen(link: DocLinkGate & { deal: { status: string } }, now: Date): boolean {
  return docLinkStateOf(link, now) === "active" && isDealOpenForDocs(link.deal.status);
}

/** すべての依頼が受領になった項目(同じ項目を売主と買主の両方に頼んだら、両方そろって初めて)。書類確認書の ✓ に使う。 */
export function receivedChecklistItemIds(requests: readonly { checklistItemId: string; status: string }[]): Set<string> {
  const all = new Map<string, boolean>();
  for (const r of requests) all.set(r.checklistItemId, (all.get(r.checklistItemId) ?? true) && r.status === "received");
  return new Set([...all].filter(([, ok]) => ok).map(([id]) => id));
}
