/**
 * 請求(課金)の確認ゲート(純関数)。
 *
 * ⚠**ここが本当の課金の瞬間**(2026-08-19 第7回テスト+JS実測で確定):
 * 請求リストの【請求】(#btn_seikyu)は押しただけでは submit されない。
 * `btnForward` → `submitFormNo` → `GConfirmSeikyuInclComfirmSeikyuDelay` →
 * `CSimpleConfirm`(jQuery UI の modal・金額入り・既定ラベル「ＯＫ/キャンセル」)を出し、
 * **ＯＫ押下ではじめて** `$("#seikyu").val("true")` + `CLockSubmit(#fudosanIchiranForm)`
 * が走る。第7回はこのＯＫを押していなかったため、課金ゼロのまま画面待ちで timeout した。
 *
 * サイトは請求前の画面に**請求金額合計**(`#GSeikyuKingakuGokei`)を出しており、
 * 確認ダイアログの本文にも同じ額が入る(`GConfirmSeikyu` が CGetMessage に埋める)。
 * ⇒ **選択した行の料金と合計が一致すること**を課金前に実測すれば、
 * 「選択が増えていて余計に買う」事故をサイト自身の数字で塞げる。
 */

/** 金額表記(全角・カンマ・「円」混じり)から数値を取り出す。取れなければ null。 */
export function parseYenAmount(raw: string): number | null {
  const halfWidth = raw
    .normalize("NFKC")
    .replace(/[,\s]/g, "");
  const m = halfWidth.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

export type SeikyuConfirmDecision =
  | { proceed: true; amountYen: number }
  | {
      proceed: false;
      reason: "total-unreadable" | "row-fee-unreadable" | "amount-mismatch";
      /** 実況・journal 用(金額は非PII)。 */
      detail: string;
    };

/**
 * 課金してよいかの判定。
 * - 行の料金(hidden `ryokin_N`)と画面の請求金額合計が**一致**したときだけ進む。
 *   一致 = 「いま選ばれているのは対象の1件だけ」をサイトの計算で裏取りしたことになる。
 * - どちらかが読めなければ進まない(fail-closed・課金前中止)。
 */
export function resolveSeikyuConfirm(input: {
  /** 選択した行の料金セル/hidden の生値(例「140」)。 */
  rowFeeText: string;
  /** 画面の請求金額合計の生値(例「140」「1,400」)。 */
  totalText: string;
}): SeikyuConfirmDecision {
  const rowFee = parseYenAmount(input.rowFeeText);
  const total = parseYenAmount(input.totalText);
  if (total === null) {
    return {
      proceed: false,
      reason: "total-unreadable",
      detail: "請求金額合計を読み取れませんでした",
    };
  }
  if (rowFee === null) {
    return {
      proceed: false,
      reason: "row-fee-unreadable",
      detail: "対象行の料金を読み取れませんでした",
    };
  }
  if (rowFee !== total) {
    return {
      proceed: false,
      reason: "amount-mismatch",
      detail: `請求金額合計(${total}円)が対象行の料金(${rowFee}円)と一致しません`,
    };
  }
  return { proceed: true, amountYen: total };
}

/**
 * 確認ダイアログ本文の金額が、課金前に確認した額と一致するかの最終照合。
 * 本文から金額を取れない場合は**照合をスキップして進む**(サイト文言の変化で
 * 永久に取得できなくなるのを避ける。過剰課金の本丸は上の合計一致で塞いである)。
 */
export function dialogAmountMatches(
  dialogText: string,
  expectedYen: number,
): { ok: boolean; found: number | null } {
  const normalized = dialogText.normalize("NFKC").replace(/[,\s]/g, "");
  const hits = [...normalized.matchAll(/(\d+)円/g)].map((m) =>
    Number.parseInt(m[1], 10),
  );
  if (hits.length === 0) return { ok: true, found: null };
  return { ok: hits.includes(expectedYen), found: hits[0] ?? null };
}

/** 確認ダイアログの「進む」ボタンのラベル(サイト既定=全角ＯＫ・経路により「はい」)。 */
export const SEIKYU_CONFIRM_OK_LABELS = ["ＯＫ", "OK", "はい"] as const;
/** ⚠絶対に押してはいけないラベル(取り消し側)。 */
export const SEIKYU_CONFIRM_CANCEL_LABELS = ["キャンセル", "いいえ"] as const;

/** ダイアログのボタン群から押すべきものを選ぶ(取り消し側は決して選ばない)。 */
export function pickConfirmButtonIndex(labels: string[]): number {
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i].normalize("NFKC").trim();
    if (SEIKYU_CONFIRM_CANCEL_LABELS.some((c) => label === c.normalize("NFKC")))
      continue;
    if (SEIKYU_CONFIRM_OK_LABELS.some((o) => label === o.normalize("NFKC")))
      return i;
  }
  return -1;
}
