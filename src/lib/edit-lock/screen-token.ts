/**
 * 編集中の鍵の「合言葉」(ブラウザのタブごとのランダム値)まわりのヘッダ読み取り。
 * ⚠生の合言葉はどこにも残さない: 読んだ瞬間に sha256 へ変換し、ハッシュだけを返す。
 */
import { createHash } from "node:crypto";

/** ブラウザのタブごとの合言葉を送るヘッダ名。 */
export const EDIT_SCREEN_HEADER = "X-Edit-Screen";
/** 鍵の世代(取得の応答の lockId)を送るヘッダ名。鍵を持つ画面の保存だけが付ける。 */
export const EDIT_LOCK_HEADER = "X-Edit-Lock";

export function hashScreenToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** ヘッダから合言葉を読み、**ハッシュだけ**を返す(生値はどこにも残さない)。 */
export function readScreenTokenHash(request: Request): string | null {
  const raw = request.headers.get(EDIT_SCREEN_HEADER);
  if (!raw || raw.trim() === "") return null;
  return hashScreenToken(raw.trim());
}

/**
 * 鍵の世代(lockId)をそのまま返す。⚠これは秘密ではなく世代の識別子なのでハッシュ化しない。
 */
export function readLockId(request: Request): string | null {
  const raw = request.headers.get(EDIT_LOCK_HEADER);
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}
