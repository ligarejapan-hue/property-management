import { renderPublicCardPage } from "@/lib/sale-dm-letter/unsubscribe-page";

// 追客メールの配信停止の公開ページ(認証なし)。純関数・固定文だけ(外から来た文字を埋め込まない)。
// ⚠アドレス・お名前・物件の情報は出さない(リンクを第三者が開いても何も見えない)。
// 紙の DM のページ(郵送のご案内)とは文言だけが違う。回数制限・混み合いの画面は共用する。

/** GET: 確認の画面。停止はボタン(POST)を押したときだけ起きる(メールソフトがリンクを先に開いても止まらない)。 */
export function renderFollowupUnsubscribeConfirmPage(): string {
  return renderPublicCardPage(
    "メール配信停止のお手続き",
    [
      "<h1>メール配信停止のお手続き</h1>",
      "<p>このページは、査定のお申し込みのあとにお送りしているご案内メールの配信停止を受け付けるページです。</p>",
      "<p>下のボタンを押すと、このメールアドレスへの今後のご案内メールを停止いたします。</p>",
      // action 無し = 同じURLへ POST(トークンを HTML 本文へ書き出さない)。
      '<form method="post"><button type="submit">配信を停止する</button></form>',
      '<p class="note">メールアドレスやお名前がこの画面に表示されることはありません。ボタンを押すまで停止は行われません。</p>',
    ].join(""),
  );
}

/** POST 完了: 記録した/すでに停止済み/対象が見つからない を問わず同じ画面(在否を答えない)。 */
export function renderFollowupUnsubscribeDonePage(): string {
  return renderPublicCardPage(
    "配信停止を受け付けました",
    [
      "<h1>配信停止を受け付けました</h1>",
      "<p>このメールアドレスへの今後のご案内メールを停止いたします。ご対応ありがとうございました。</p>",
      '<p class="note">行き違いで、すでにお送りしている途中のメールが1通届く場合がございます。ご容赦ください。</p>',
    ].join(""),
  );
}

/** 署名が合わない(リンクの書き換え・鍵の差し替え後の古いリンク)。メールの連絡先へ案内する。 */
export function renderFollowupUnsubscribeInvalidPage(): string {
  return renderPublicCardPage(
    "確認できませんでした",
    [
      "<h1>このリンクを確認できませんでした</h1>",
      "<p>お手数ですが、メールの末尾に記載のお問い合わせ先までご連絡ください。お電話・メールでも配信停止を承ります。</p>",
    ].join(""),
  );
}
