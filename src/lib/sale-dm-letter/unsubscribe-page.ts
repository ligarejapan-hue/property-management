// 配信停止の公開ページ(認証なし)の HTML。純関数(env/DB 非依存)。
//
// ⚠この画面は**お客様(所有者)**が見る。氏名・住所・物件情報は一切出さない
//   (QR を第三者が拾って開いても個人情報が見えない)。文言は固定文のみで、
//   外部由来の文字列を埋め込まない(エスケープ漏れの余地を作らない)。

const PAGE_STYLE = [
  "body{margin:0;background:#f5f6f8;color:#1f2530;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Kaku Gothic ProN','Yu Gothic UI','Noto Sans JP',sans-serif;line-height:1.9}",
  "main{max-width:34rem;margin:0 auto;padding:40px 20px 80px}",
  ".card{background:#fff;border:1px solid #dfe3e9;border-radius:12px;padding:28px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04)}",
  "h1{font-size:19px;margin:0 0 14px}",
  "p{margin:0 0 12px;font-size:15px}",
  ".note{font-size:12.5px;color:#68707d}",
  "button{display:block;width:100%;margin:20px 0 8px;padding:14px;font-size:16px;font-weight:700;color:#fff;background:#b3402f;border:none;border-radius:8px;cursor:pointer}",
  "button:active{opacity:.85}",
].join("");

function page(title: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<meta name="robots" content="noindex,nofollow" />',
    `<title>${title}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head><body><main><div class=\"card\">",
    bodyHtml,
    "</div></main></body></html>",
  ].join("");
}

/** GET: 確認画面。停止は下のボタン(POST)を押したときだけ起きる。 */
export function renderUnsubscribeConfirmPage(): string {
  return page(
    "配信停止のお手続き",
    [
      "<h1>配信停止のお手続き</h1>",
      "<p>このページは、郵便でお送りしたご案内(お手紙)の配信停止を受け付けるページです。</p>",
      "<p>下のボタンを押すと、今後の郵送によるご案内を停止いたします。</p>",
      // action 無し = 同じURLへ POST(トークンを HTML 本文へ書き出さない)。
      '<form method="post"><button type="submit">配信を停止する</button></form>',
      '<p class="note">お名前や住所がこの画面に表示されることはありません。ボタンを押すまで停止は行われません。</p>',
    ].join(""),
  );
}

/** POST 完了: 記録済み/対象なしを問わず同じ画面(在否を答えない)。 */
export function renderUnsubscribeDonePage(): string {
  return page(
    "配信停止を受け付けました",
    [
      "<h1>配信停止を受け付けました</h1>",
      "<p>今後の郵送によるご案内を停止いたします。ご対応ありがとうございました。</p>",
      '<p class="note">行き違いで、すでに発送済みのご案内が届く場合がございます。ご容赦ください。</p>',
    ].join(""),
  );
}

/** 署名不一致(改ざん・鍵ローテーション後の旧QR)。連絡先はお手紙面へ誘導する。 */
export function renderUnsubscribeInvalidPage(): string {
  return page(
    "確認できませんでした",
    [
      "<h1>このQRコードを確認できませんでした</h1>",
      "<p>お手数ですが、お手元のお手紙に記載の連絡先までご連絡ください。お電話でも配信停止を承ります。</p>",
    ].join(""),
  );
}

/** 並行更新と衝突(まれ)。もう一度押していただく。 */
export function renderUnsubscribeBusyPage(): string {
  return page(
    "混み合っています",
    [
      "<h1>ただいま混み合っています</h1>",
      "<p>お手数ですが、少し時間をおいて、もう一度下のボタンを押してください。</p>",
      '<form method="post"><button type="submit">配信を停止する</button></form>',
    ].join(""),
  );
}

/** 回数制限にかかった(攻撃・連打)。 */
export function renderUnsubscribeThrottledPage(): string {
  return page(
    "アクセスが集中しています",
    [
      "<h1>アクセスが集中しています</h1>",
      "<p>お手数ですが、しばらく時間をおいてから、もう一度お試しください。</p>",
    ].join(""),
  );
}

/** 公開ページ共通の応答ヘッダ(キャッシュ禁止・索引拒否・token を referrer に漏らさない)。 */
export const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
