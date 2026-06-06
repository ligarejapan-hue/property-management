/**
 * /uploads 配信の条件付き GET（ETag / If-None-Match → 304）用ヘルパー。
 *
 * ETag は storage key のみから決定的に生成する。これが安全に成立する根拠
 * （核は「key は再利用・上書きされない」）:
 *  - storage key は採番時に一意（photos/attachments はタイムスタンプ、
 *    field-survey pin photos は `randomUUID()`）で、アプリは既存 key への
 *    上書き upload を行わず、key を別内容へ再利用することもない。
 *  - 削除の扱いはカテゴリで異なる（attachment は DB soft-delete・バイト残置／
 *    photo 系は DB 行削除 + storage.delete の hard delete）が、どちらも
 *    「同一 key が別のバイト列を指すようになる」ことはない。削除後のアクセスは
 *    authorizeUploadAccess（DB 逆引き）が not_found を返し、304 判定より
 *    先に 404 になるため、削除済み key に 304 が返ることもない。
 *  → 配信され得る限り同一 key は常に同一バイト列を指すため、key 由来の ETag は
 *    strong validator として機能する（実体読み込み・adapter 変更が不要）。
 *
 * 運用上の注意: storage 上のファイルを「同一 key のまま手動で差し替える」
 * 運用を行うと、この前提が崩れ古いキャッシュが 304 で残り続ける。
 * その場合は新しい key で再アップロードすること（アプリの通常操作では発生しない）。
 *
 * 適用範囲（route 側で制御）:
 *  - 非 registry のみ。registry PDF（登記簿謄本）は S1b-4 の
 *    `Cache-Control: no-store` + 毎配信監査を維持するため対象外。
 *  - 304 判定は session / permissions / authorizeUploadAccess の通過後にのみ
 *    行う（認可前 304 は禁止）。
 */
import { createHash } from "crypto";

/**
 * storage key から決定的な strong ETag を生成する（quoted 形式で返す）。
 * key は PII（所有者名等）を含まない採番値だが、ETag からの key 推測を
 * 避けるため一方向ハッシュ（sha256 先頭 32 hex）にする。
 */
export function buildUploadsEtag(key: string): string {
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
  return `"${hash}"`;
}

/**
 * If-None-Match ヘッダが指定 ETag に一致するか（RFC 9110 weak comparison）。
 *  - 未指定（null/空）→ false
 *  - `*` → true
 *  - カンマ区切りの複数候補に対応し、`W/` プレフィクスは比較時に無視する
 *    （If-None-Match の評価は weak comparison が正・GET のキャッシュ再検証用途）。
 */
export function ifNoneMatchMatches(
  headerValue: string | null,
  etag: string,
): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}
