/**
 * fileUrl を「同一オリジンから配信される相対パス」に正規化する。
 *
 * 過去に保存された fileUrl は混在しうる:
 *   - http://133.117.72.225:3000/uploads/...
 *   - http://127.0.0.1:3000/uploads/...
 *   - http://localhost:3000/uploads/...
 *   - /uploads/...
 *
 * 表示時には現在ブラウザが開いている origin の `/uploads/...` を叩けば
 * 200 で返る（nginx → Next.js → public/uploads）。よって絶対URLは
 * パス部分だけ残して同一オリジン相対にする。
 *
 * 外部ホスト (data: / blob: / 別ドメイン) はそのまま返す。
 */
export function normalizeFileUrl(url: string | null | undefined): string {
  if (!url) return "";
  // data:/blob: スキーマはそのまま
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  // 相対パスはそのまま
  if (url.startsWith("/")) return url;
  // 絶対URL: パス部分だけ取り出して相対化（/uploads/... を含むもののみ）
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/uploads/") || u.pathname.startsWith("/api/")) {
      return u.pathname + (u.search || "");
    }
    // /uploads/ や /api/ 以外の絶対URL（外部ストレージ等）は元のまま返す
    return url;
  } catch {
    return url;
  }
}

/**
 * 添付/写真レスポンスの fileUrl / thumbnailUrl をまとめて正規化する補助。
 */
export function normalizeFileUrlsInRecord<T extends { fileUrl?: string | null; thumbnailUrl?: string | null }>(
  record: T,
): T {
  return {
    ...record,
    fileUrl: record.fileUrl != null ? normalizeFileUrl(record.fileUrl) : record.fileUrl,
    thumbnailUrl:
      record.thumbnailUrl != null ? normalizeFileUrl(record.thumbnailUrl) : record.thumbnailUrl,
  };
}
