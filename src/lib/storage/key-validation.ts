/**
 * Storage key の traversal validation (Phase 2 Codex P1).
 *
 * すべての StorageAdapter (Local / Server / S3) が共通で使う key 検証。
 * `/uploads/[...path]` proxy 経由で外から来る key を、URL 組み立てや
 * fetch / S3 API 呼び出しの前に必ず通すことで、backend に依らない一貫した
 * traversal 防御を担保する。
 *
 * 拒否する代表ケース:
 *   - 絶対パス       : "/etc/passwd"
 *   - 親参照         : "..", "../etc", "a/../b"
 *   - 自己参照       : ".", "./a"
 *   - 空セグメント   : "", "a//b"
 *   - backslash 混入 : "a\\b"  (Windows path separator として解釈する backend 対策)
 *
 * 注:
 *   - URL-encoded traversal ("%2e%2e") は呼び出し側で decode 済みの raw key を
 *     受け取る前提（Next.js dynamic route params は decode 済み）。
 *   - 本 helper は **key の入力検証専用**。実体 path 解決は LocalStorageAdapter の
 *     resolveSafeUploadPath が二重防御として担当する。
 */

export function isValidStorageKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  if (key === "") return false;
  // Windows path separator として解釈する backend (またはローカル fs) 対策。
  // 正規の S3 / R2 key には backslash を含めない方針。
  if (key.includes("\\")) return false;
  // 絶対パス
  if (key.startsWith("/")) return false;
  // 各 segment を検査
  for (const seg of key.split("/")) {
    if (seg === "") return false; // 空 / 連続スラッシュ
    if (seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * 無効な key の場合に「path traversal blocked」を含むメッセージで throw。
 *
 * メッセージに含まれる "path traversal" 文字列は
 * `/uploads/[...path]` route handler の例外分類 (→ 403) と契約しているため
 * 変更しないこと。
 */
export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) {
    throw new Error(`Invalid storage key (path traversal blocked): ${key}`);
  }
}
