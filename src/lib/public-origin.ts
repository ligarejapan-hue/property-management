/**
 * 公開(認証なし)の書き込み口 — 配信停止 /u/・電話タップ /t/<token>/phone-tap・査定申込 /t/<token>/inquiry —
 * で使う「よそのサイトから送らせた送信か」の判定。true = よそ(拒否/数えない)。
 *
 * ⚠比較相手は `req.url` ではなく **Host ヘッダ**。本番は前段 nginx(`proxy_set_header Host $host`)越しで、
 *   アプリが見る req.url のホストは公開ホスト名にならない(2026-09-16 本番実測: 自分自身の Origin で 403)。
 *   Host はブラウザが接続先として付ける値で、よそのページのフォームからは書き換えられない。
 * ⚠`Origin: null` と Origin なしは受け付ける。理由: これらの口はクッキー・ログイン状態などの「ブラウザが
 *   自動で付ける権限」を一切使わない(認証なし)ので、よそのページに踏ませても本人の権限で何かが起きることはない。
 *   本当の守りは「手紙にしか印刷されていない符号(token/署名)の所持」で、符号を持つ者は Origin を付けずに
 *   直接送れる=null/なしを拒否しても守りは増えない(なお自前の公開ページは Referrer-Policy: same-origin で、
 *   同じホストへのフォーム送信には本物の Origin が付く)。
 * ⚠この判定は「よそのサイトのフォームからの素朴な送信」を止めるだけ。CSRF 対策として頼ってはいけない
 *   (権限を伴う社内の書き込みはこの関数ではなくセッション側で守る)。
 */
export function isCrossSiteOrigin(headers: Headers, requestUrl: string): boolean {
  const raw = headers.get("origin");
  if (raw == null) return false;
  const value = raw.trim();
  if (value === "" || value === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(value).host.toLowerCase();
  } catch {
    return true;
  }
  const hostHeader = headers.get("host")?.trim().toLowerCase();
  let selfHost: string;
  if (hostHeader) {
    selfHost = hostHeader;
  } else {
    try {
      selfHost = new URL(requestUrl).host.toLowerCase();
    } catch {
      return true;
    }
  }
  return originHost !== selfHost;
}
