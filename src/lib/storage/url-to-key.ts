/**
 * fileUrl → storage key 抽出 helper。
 *
 * delete 経路で実体ファイル消去するために、DB 保存された fileUrl から
 * 自前 storage の key を安全に取り出す。誤って外部 host の URL を delete
 * 対象にしないため、絶対 URL は全て対象外とする（旧データの絶対 URL は
 * orphan として残し、将来 cleanup バッチで回収する方針）。
 *
 * 返り値:
 *   - 自前 storage の key（例 "properties/{id}/photos/123.jpg"）
 *   - 削除対象外 → null
 *
 * null になる代表ケース:
 *   - null / undefined / 空 / whitespace のみ
 *   - 絶対 URL（http: / https: / file: 等 任意の scheme 付き）
 *   - data: / blob:
 *   - /uploads/ で始まらない
 *   - traversal などで isValidStorageKey が拒否する key
 */

import { isValidStorageKey } from "./key-validation";

const UPLOADS_PREFIX = "/uploads/";
// RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

export function extractStorageKeyFromUrl(
  url: string | null | undefined,
): string | null {
  if (url == null) return null;
  if (typeof url !== "string") return null;

  const trimmed = url.trim();
  if (trimmed === "") return null;

  // scheme 付き (http: / https: / data: / blob: / file: 等) は全て対象外。
  // 外部 host の /uploads/... を自前 storage と誤認しないための安全側ガード。
  if (SCHEME_RE.test(trimmed)) return null;

  if (!trimmed.startsWith(UPLOADS_PREFIX)) return null;

  let key = trimmed.slice(UPLOADS_PREFIX.length);
  const queryIdx = key.search(/[?#]/);
  if (queryIdx >= 0) key = key.slice(0, queryIdx);

  if (key === "") return null;
  if (!isValidStorageKey(key)) return null;
  return key;
}
