/**
 * 編集中の鍵の「合言葉」(ブラウザのタブごとのランダム値)まわりのヘッダ読み取り。
 * ⚠生の合言葉はどこにも残さない: 読んだ瞬間に sha256 へ変換し、ハッシュだけを返す。
 */
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api-helpers";
// ⚠ヘッダ名は client からも使うため素のモジュールに分けた(Task 1)。ここは再輸出だけ。
// ⚠この import を「重複」と見て消さないこと: `export { X } from "./y"` という
//   バレルの書き方はこのファイルの中に X という束縛を作らない(re-export専用の
//   構文で、モジュール内では未定義のまま)。下の readScreenTokenHash/readLockId は
//   EDIT_SCREEN_HEADER/EDIT_LOCK_HEADER を直接参照するので、import で束縛してから
//   export する2行が必要(import を外すと ReferenceError で全テストが落ちる)。
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "./header-names";

export { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER };

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
 *
 * ⚠review Minor 1(M1): **小文字化して返す**。`row.id === input.lockId` は素の
 *   文字列比較で、行の `id`(PostgreSQL の uuid 列から返る値)は常に小文字。
 *   SQL 側は同じ大小文字の問題を uuid 型キャストで解決済み(service.ts の
 *   `readEditLocks`/`deleteEditLocksFor` のコメント参照)なので、JS側の比較も
 *   同じ扱いに揃える。正規化しないと、大文字混じりの `X-Edit-Lock` を送った
 *   画面の保存が常に `423 EDIT_LOCK_STALE` になる。
 */
export function readLockId(request: Request): string | null {
  const raw = request.headers.get(EDIT_LOCK_HEADER);
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new ApiError(400, "編集の鍵の形式が不正です", "EDIT_LOCK_ID_INVALID");
  }
  return trimmed.toLowerCase();
}
