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

export const UPLOADS_PREFIX = "/uploads/";
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

/**
 * /uploads/{key} 形式の URL からキーを取り出す、backend 非依存の lenient parser。
 *
 * extractStorageKeyFromUrl との違い:
 *   - 絶対 URL（任意 host）でも pathname に /uploads/{key} があれば抽出する。
 *   - data: / blob: / file: のみ対象外。
 *
 * 使用目的: cleanup が /uploads/ 形式で保存された fileUrl を持つ backend
 *   （local / s3）の keyFromUrl 実装に使う。
 *
 * null になる代表ケース:
 *   - null / undefined / 空 / whitespace のみ
 *   - data: / blob: / file:
 *   - pathname に /uploads/ が無い
 *   - traversal などで isValidStorageKey が拒否する key
 */
export function extractStorageKeyFromAnyUploadsUrl(
  fileUrl: string | null | undefined,
): string | null {
  if (typeof fileUrl !== "string") return null;
  const s = fileUrl.trim();
  if (s === "") return null;
  if (/^(data|blob|file):/i.test(s)) return null;
  let pathPart: string;
  if (s.startsWith("/")) {
    pathPart = s.split(/[?#]/)[0];
  } else {
    try {
      pathPart = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  if (!pathPart.startsWith(UPLOADS_PREFIX)) return null;
  const key = pathPart.slice(UPLOADS_PREFIX.length);
  if (key === "" || !isValidStorageKey(key)) return null;
  return key;
}
