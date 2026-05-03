/**
 * ローカルストレージのパス解決ヘルパー。
 *
 * - `LocalStorageAdapter` (書き込み側) と `/uploads/[...path]` route handler (読み出し側)
 *   が同一のルートを参照するために共有する。
 * - 既定値は `process.cwd()/public/uploads`（既存互換）。
 *   `LOCAL_UPLOAD_ROOT` 環境変数があれば、それを絶対パスとして優先する。
 *   本番運用でリポジトリ外（例: /var/lib/property-management/uploads）に保存先を
 *   逃がしたい場合に使う。
 */

import path from "path";

/**
 * ローカルアップロード保存先のルート絶対パスを返す。
 *
 * - `LOCAL_UPLOAD_ROOT` が設定されていれば優先（trim 済みかつ非空）。
 * - 未設定または空文字なら `process.cwd()/public/uploads`。
 *
 * 本関数は呼び出しごとに env を見るので、テストや本番起動後の変更にも追従する。
 */
export function getLocalUploadRoot(): string {
  const fromEnv = process.env.LOCAL_UPLOAD_ROOT;
  if (fromEnv && fromEnv.trim() !== "") {
    return path.resolve(fromEnv.trim());
  }
  return path.join(process.cwd(), "public", "uploads");
}

/**
 * 与えられた storage key を絶対パスに解決し、
 * UPLOAD ROOT 配下に厳密に収まることを検証する。
 *
 * - 絶対パスや `..` を含む key は path traversal として明示的に reject する。
 * - 解決後パスが root と等しい（= ルート自体を指す）場合も reject。
 *
 * 安全に解決できない場合は throw する（呼び出し側で catch して 4xx 等に変換）。
 */
export function resolveSafeUploadPath(key: string): string {
  const root = getLocalUploadRoot();
  // バックスラッシュを正規化してから path.normalize に渡す
  const normalized = path.normalize(key.replace(/\\/g, "/"));

  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid storage key (path traversal blocked): ${key}`);
  }

  const resolved = path.resolve(root, normalized);
  // resolve 後も root 配下であることを再確認（belt-and-suspenders）
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid storage key (escapes upload root): ${key}`);
  }
  return resolved;
}
