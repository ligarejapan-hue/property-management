import { IDENTITY_DOC_KIND } from "./identity-display-name";

/**
 * 添付の「ダウンロード」で `?download=1` を付ける書類(保存として受け取らせる・定型の保存名)。
 * ⚠査定報告書・反響資料も、付けないとサーバーは inline で返し、押してもブラウザで開くだけになる
 *   (@codex PR#500 16巡目)。謄本は download 権限の確認にも使う。
 * ⚠本人確認書類(type は general・docKind=identity_document)も同じ(サーバーが定型名
 *   `本人確認書類_YYYY-MM-DD.<ext>` で返す・@codex PR#571)。
 * ⚠画面(client)から読むので、サーバー専用の uploads-authorization は読まない。守りの判定
 *   (OWNER_PII_DOC_KINDS)と食い違わないことはテストで確かめる(download-intent.test.ts)。
 * プレビュー(iframe)には付けない。
 */
export function sendsDownloadIntent(att: { type?: string | null; docKind?: string | null }): boolean {
  return att.type === "registry" || att.type === "referral" || att.type === "report" || att.docKind === IDENTITY_DOC_KIND;
}
