import { z } from "zod";

/**
 * 資料送付の上限と、画面でもサーバーでも使う確かめ(画面で読んでよい=サーバー専用のものを読まない)。
 * ⚠ここに認可・DB・保存先の import を足さない(画面に入って本番の build が落ちる・@codex 7巡目 P1)。
 */

/**
 * 資料送付の上限(spec §2.2・§6)。相手のメールの受け取りが多くは 20〜25MB で止まる。
 * ⚠添付はメールの中で base64 になり約 4/3 倍(+改行)に増える=ファイルの合計 15MB で、メールは約 20.5MB
 *   (@codex 5巡目 P2・20MB のままだと約 27MB になり受け取りで止まる)。
 */
export const MATERIAL_SEND_LIMITS = { maxTotalBytes: 15 * 1024 * 1024, maxFiles: 20, subject: 200, body: 10_000 } as const;
/** 画面・案内に出す上限(例「15MB」)。数字はここだけで決める。 */
export const MATERIAL_SEND_LIMIT_LABEL = `${MATERIAL_SEND_LIMITS.maxTotalBytes / 1024 / 1024}MB`;

/** 宛先は正しい形式のアドレス1件だけ(カンマ・セミコロン・改行・表示名つきは受けない=ヘッダ注入の多層防御)。 */
export function isSingleAddress(to: string): boolean {
  if (/[\r\n,;<>\s]/.test(to)) return false;
  return z.string().email().max(254).safeParse(to).success;
}
