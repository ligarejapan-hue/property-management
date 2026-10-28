/**
 * まとめてある PDF の口(split-analyze・split)の「席」。
 * ⚠この2つの口は小さい PDF でも、読み取り・分ける・縮めるの**同じ1本の列**(runExclusive)に並ぶ。
 *   大きさで席を取る添付の口(reserveLargePdfSlot は 8MB 超だけ)と違い、**大きさによらず**席を取る。
 *   取れなければ、本文を読む前にすぐ 503(列に何本も抱えて何分も待たせない・@提出前レビュー P2)。
 *   画面は 503 のとき「謄本ですか？」と聞いてから送る(推測で通常の添付にしない)。
 */
import { ApiError } from "@/lib/api-helpers";
import { compressBusyMessage } from "@/lib/pdf-compress/policy";
import { tryReserveCompressionSlot } from "@/lib/pdf-compress/run";

/** 席を取る。返した関数は finally で必ず呼ぶ。取れなければ 503。 */
export function reserveSplitSlot(reserve: () => (() => void) | null = tryReserveCompressionSlot): () => void {
  const release = reserve();
  if (release === null) throw new ApiError(503, compressBusyMessage(), "BUSY");
  return release;
}
