/**
 * ドライブのフォルダの URL から、フォルダの番号(id)を取り出す(純関数)。
 * ドライブ連携の画面の「フォルダの URL を貼って開く」用(2026-10-26 発注者の実機で「連携させたいフォルダがない」
 * =共有ドライブ・深い階層・共有アイテムのどこにあっても、URL を貼れば開けるように)。
 * ⚠ファイル・ドキュメントの URL はフォルダではないので null(フォルダかどうかは最後にサーバーが Google に確かめる)。
 */

/** フォルダの番号として受ける形(英数字・_・-)。短すぎるものは打ち間違いとみなす。 */
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function folderIdFromUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  if (ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname !== "drive.google.com") return null;

  // /drive/folders/<id>  /drive/u/0/folders/<id>
  const m = /^\/drive(?:\/u\/\d+)?\/folders\/([^/?#]+)\/?$/.exec(url.pathname);
  if (m) return ID_RE.test(m[1]) ? m[1] : null;

  // /open?id=<id>
  if (url.pathname === "/open") {
    const id = url.searchParams.get("id") ?? "";
    return ID_RE.test(id) ? id : null;
  }
  return null;
}
