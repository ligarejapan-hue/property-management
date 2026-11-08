/**
 * PDF の文字の抜き出しが時間の上限を超えたときのエラーの code(extractTextFromPdf の timeoutMs)。
 * ⚠pdf-extract とは別のファイルに置く(多くのテストが pdf-extract を作り物に差し替えるので、
 *   そこに置くと差し替えた側で「その名前が無い」になる)。
 */
export const PDF_READ_TIMEOUT = "PDF_READ_TIMEOUT";
