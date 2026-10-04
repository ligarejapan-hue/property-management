/**
 * Web プッシュの送り先(endpoint)の確認(設計書 §7.2)。**純関数だけ**。
 *
 * 画面から送られた endpoint をそのまま信じない。細工した URL を登録されると、送信のたびに
 * サーバーから任意の宛先へ接続させられる(SSRF)うえ、発注者が承認した接続先の範囲も超えるため。
 * 登録のときと送信のときの両方で同じ確認をする。
 *
 * 承認済みの中継サービス(D14 + 2026-10-03 に Edge を追加承認):
 *   - Google(Chrome・Android): fcm.googleapis.com
 *   - Mozilla(Firefox): updates.push.services.mozilla.com
 *   - Apple(Safari・iPhone のホーム画面アプリ): *.push.apple.com(Apple の案内=サブドメインを許可)
 *   - Microsoft(Windows の Edge): *.notify.windows.com
 * ⚠拒否したときの応答・ログに URL 本体を出さない(定型のコードだけ)。
 */

export type EndpointCheck =
  | { ok: true; host: string; provider: "google" | "mozilla" | "apple" | "microsoft" }
  | { ok: false; code: "endpoint_invalid" | "endpoint_not_allowed" };

const EXACT: Record<string, "google" | "mozilla"> = {
  "fcm.googleapis.com": "google",
  "updates.push.services.mozilla.com": "mozilla",
};
const SUFFIX: Array<[string, "apple" | "microsoft"]> = [
  [".push.apple.com", "apple"],
  [".notify.windows.com", "microsoft"],
];
/** ホスト名の1区切り(英小文字・数字・ハイフン)。 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ENDPOINT_MAX_LENGTH = 1024;

export function checkPushEndpoint(raw: unknown): EndpointCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > ENDPOINT_MAX_LENGTH) {
    return { ok: false, code: "endpoint_invalid" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "endpoint_invalid" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return { ok: false, code: "endpoint_not_allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (!host.split(".").every((l) => LABEL_RE.test(l))) {
    // IP の直書き(数字だけの区切りは通るが、下の許可リストに当たらない)・空の区切りなど
    return { ok: false, code: "endpoint_not_allowed" };
  }
  const exact = EXACT[host];
  if (exact) return { ok: true, host, provider: exact };
  for (const [suffix, provider] of SUFFIX) {
    // サブドメインだけを許す(push.apple.com そのものや、evilpush.apple.com のような前方一致は不可)
    if (host.endsWith(suffix) && host.length > suffix.length) return { ok: true, host, provider };
  }
  return { ok: false, code: "endpoint_not_allowed" };
}
