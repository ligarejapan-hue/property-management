/**
 * 「ファイルを入れる」から取り込みの画面へ、入れたファイルを持って進むための入れ物(画面側だけ)。
 *
 * ⚠作業中の控え(keep-draft・sessionStorage)には File が入らないので、画面の切り替え
 *   (router.push)では消えない**この画面の中の入れ物**に置く。再読み込みやタブを閉じると消える
 *   (そのときは「ファイルを入れる」から入れ直す)。
 * ⚠置けるのは1つだけ。進んだ先の画面が最初の描画で読み(peek)、描き終えたら消す(clear)。
 *   読むだけで消さないのは、開発時の二重の初期化(React の StrictMode)で2回目が空にならないため。
 * 受付帳・所有者は、見分けるときに読んだ中身(文字・Excel の base64)をそのまま渡す(画面の控えと同じ形)。
 */
import type { HandoffTarget } from "./detect";

export interface SheetEntry {
  name: string;
  csvText?: string;
  xlsxBase64?: string;
}

export type HandoffPayload =
  | { target: "reception" | "owner"; entry: SheetEntry }
  | { target: "lead_excel" | "registry_pdf" | "paste_pdf"; file: File };

let slot: HandoffPayload | null = null;

/** 渡すものを置く(前に置いたものは捨てる)。 */
export function putHandoff(payload: HandoffPayload): void {
  slot = payload;
}

/** その画面あての渡しものを読む(消さない)。 */
export function peekHandoff<T extends HandoffTarget>(target: T): Extract<HandoffPayload, { target: T }> | null {
  return slot !== null && slot.target === target ? (slot as Extract<HandoffPayload, { target: T }>) : null;
}

/** その画面あての渡しものを消す(受け取り終えたあと)。 */
export function clearHandoff(target: HandoffTarget): void {
  if (slot !== null && slot.target === target) slot = null;
}

/** PDF・Excel の画面: 渡された File(無ければ null)。 */
export function peekHandoffFile(target: "lead_excel" | "registry_pdf" | "paste_pdf"): File | null {
  const p = peekHandoff(target);
  return p ? p.file : null;
}

/** 受付帳・所有者の画面: 渡された中身(無ければ null)。 */
export function peekHandoffEntry(target: "reception" | "owner"): SheetEntry | null {
  const p = peekHandoff(target);
  return p ? p.entry : null;
}
