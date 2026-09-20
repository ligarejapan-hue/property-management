/**
 * 編集中の鍵の「合言葉」(ブラウザのタブごとのランダム値)まわりのヘッダ読み取り。
 * ⚠生の合言葉はどこにも残さない: 読んだ瞬間に sha256 へ変換し、ハッシュだけを返す。
 */
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api-helpers";

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

/** 鍵の世代(lockId)の形式チェック。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 鍵の世代(lockId)をそのまま返す。⚠これは秘密ではなく世代の識別子なのでハッシュ化しない。
 *
 * ヘッダが無い(または空白のみ)なら `null`(=「鍵なし」として通常どおり続ける。
 * 古い画面からの保存を弾かないため)。
 *
 * 値があるのに uuid の形をしていなければ、ここで `ApiError(400)` を投げて入口で断る。
 * ⚠今のところ `assertNotEditLockedByOther`(service.ts)は lockId を JS の文字列比較
 * (`row.id === input.lockId`)にしか使っておらず、SQL には bind していない――つまり
 * 「不正な値のまま渡すと今すぐ 22P02 で 500 になる」わけではない。この検査の意味は
 * **入口の約束**: 将来 lockId を SQL 側の判定に使う実装に変えても、不正な形式の値は
 * ここで止まっているので 22P02 の 500 にはならない。値を捨てて「鍵なし」として
 * 通すのはこの検査が塞ぐはずの穴を開けるので禁止(コントローラ決定①)。
 */
export function readLockId(request: Request): string | null {
  const raw = request.headers.get(EDIT_LOCK_HEADER);
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new ApiError(400, "編集の鍵の形式が不正です", "EDIT_LOCK_ID_INVALID");
  }
  return trimmed;
}
