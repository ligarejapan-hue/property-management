/**
 * 広告用の公開ページの Google広告のコンバージョン(lp-public.ts と lp-page.ts の両方で使う=循環 import を避けて別ファイル)。
 */

/** Google のタグの設定(タグ ID は許可リストを通った値・ラベルはラベルだけか send_to まるごと)。 */
export interface GoogleTagConfig { tagId: string; convLabel: string | null }

export const GOOGLE_CONV_LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/;
export const GOOGLE_ADS_SEND_TO_RE = /^AW-[A-Z0-9]{4,20}\/[A-Za-z0-9_-]{4,64}$/;

/**
 * 申込完了で Google広告へ送る先(send_to)と、gtag.js に追加で config する Google広告の ID(タグ ID と同じなら null)。
 * 送らないとき(ラベルなし・G-/GT- にラベルだけ)は null。値は許可リストを通ったものだけ(合わなければ送らない)。
 */
export function googleConversionTarget(google: GoogleTagConfig): { sendTo: string; extraConfigId: string | null } | null {
  const label = google.convLabel;
  if (!label) return null;
  if (GOOGLE_ADS_SEND_TO_RE.test(label)) {
    const adsId = label.slice(0, label.indexOf("/"));
    return { sendTo: label, extraConfigId: adsId === google.tagId ? null : adsId };
  }
  if (GOOGLE_CONV_LABEL_RE.test(label) && google.tagId.startsWith("AW-")) return { sendTo: `${google.tagId}/${label}`, extraConfigId: null };
  return null;
}
