/**
 * 編集中の鍵のヘッダ名だけを置く**素のモジュール**。
 *
 * ⚠ここに依存を足さない。`screen-token.ts`(server)は `@/lib/api-helpers` を
 *   経由して auth と prisma を引くため、client 部品から import できない。
 *   ヘッダ名は両側で必要なので、名前だけをこのファイルに分ける。
 */
/** ブラウザのタブごとの合言葉を送るヘッダ名。 */
export const EDIT_SCREEN_HEADER = "X-Edit-Screen";
/** 鍵の世代(取得の応答の lockId)を送るヘッダ名。鍵を持つ画面の保存だけが付ける。 */
export const EDIT_LOCK_HEADER = "X-Edit-Lock";
