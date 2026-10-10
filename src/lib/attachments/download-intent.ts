/**
 * 添付の「ダウンロード」で `?download=1` を付ける書類(保存として受け取らせる・定型の保存名)。
 * ⚠査定報告書・反響資料も、付けないとサーバーは inline で返し、押してもブラウザで開くだけになる
 *   (@codex PR#500 16巡目)。謄本は download 権限の確認にも使う。
 * プレビュー(iframe)には付けない。
 */
export function sendsDownloadIntent(type: string | null | undefined): boolean {
  return type === "registry" || type === "referral" || type === "report";
}
