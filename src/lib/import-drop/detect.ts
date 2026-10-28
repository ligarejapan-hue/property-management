/**
 * 「ファイルを入れる」(2026-10-28 発注者決定・第2段)— 入れたファイルの行き先を決める(純関数)。
 *
 * どれも**今ある判定をそのまま使う**(取り込みのやり方は変えない):
 *   受付帳/所有者 … detectImportFileTypeFromContent(列の名前)
 *   査定サイトの顧客管理表 … readLeadSheet(「姓名」+「URL・住所物件名」または「物件所在地」)
 *   謄本 … classifyPageText(見出しの「全部事項証明書」「表題部」・権利部の甲区)
 *   反響の PDF … detectSourceProfile(HOME4U・タカウルの見出し)
 *   それ以外 … 書類の受け取り箱
 * ⚠推測で取り込みへ回さない: CSV で決まらなければ人が選ぶ(unknown)。
 */
import type { ImportFileType } from "@/lib/import-file-type";
import { detectSourceProfile } from "@/lib/paste-import/source-profiles";
import { REGISTRY_KIND, classifyPageText } from "@/lib/pdf-split/segments";

/** 取り込みの画面へ進む行き先(ファイルを持って進む)。 */
export type HandoffTarget = "reception" | "owner" | "lead_excel" | "registry_pdf" | "paste_pdf";
/** 行き先。document=書類の受け取り箱・unknown=人が選ぶ。 */
export type DropTarget = HandoffTarget | "document" | "unknown";

export const DROP_TARGETS: readonly DropTarget[] = [
  "reception", "owner", "lead_excel", "registry_pdf", "paste_pdf", "document", "unknown",
];

/** 進む先の画面。 */
export const HANDOFF_PATHS: Record<HandoffTarget, string> = {
  reception: "/import",
  owner: "/import#owner-match",
  lead_excel: "/import/paste/excel",
  registry_pdf: "/import/registry-pdf",
  paste_pdf: "/import/paste",
};

/** 見分けた中身の名前(画面の表に出す)。 */
export const DROP_TARGET_LABELS: Record<DropTarget, string> = {
  reception: "受付帳",
  owner: "所有者の一覧",
  lead_excel: "査定サイトの顧客管理表",
  registry_pdf: "謄本",
  paste_pdf: "反響のPDF",
  document: "書類",
  unknown: "分かりません",
};

/** 進むボタンの文字。 */
export const HANDOFF_BUTTON_LABELS: Record<HandoffTarget, string> = {
  reception: "受付帳の取り込みへ",
  owner: "所有者の突合へ",
  lead_excel: "Excelから物件化へ",
  registry_pdf: "謄本の取り込みへ",
  paste_pdf: "貼り付けて物件化へ",
};

export function isHandoffTarget(t: DropTarget): t is HandoffTarget {
  return t in HANDOFF_PATHS;
}

/** ファイルの形(どの見分け方を使うか)。.xls(古い Excel)は取り込みに対応していないので書類。 */
export function dropFileKind(file: { name: string; type: string }): "sheet" | "pdf" | "other" {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (/\.(csv|tsv|txt|xlsx)$/.test(name)) return "sheet";
  return "other";
}

/**
 * 表(CSV・Excel)の行き先。顧客管理表を先に見る(「姓名」の列は受付帳・所有者には無い)。
 * 決まらないとき: Excel は書類(レントロールなどの表も来る)・CSV は人が選ぶ。
 */
export function sheetTarget(input: {
  contentType: ImportFileType | null;
  leadRows: number;
  isXlsx: boolean;
}): DropTarget {
  if (input.leadRows > 0) return "lead_excel";
  if (input.contentType === "reception") return "reception";
  if (input.contentType === "owner") return "owner";
  return input.isXlsx ? "document" : "unknown";
}

/** PDF の行き先(先頭のページの文字から)。文字が読めない(スキャン)PDF は書類。 */
export function pdfTarget(text: string | null): DropTarget {
  if (!text || text.trim() === "") return "document";
  if (classifyPageText(text) === REGISTRY_KIND) return "registry_pdf";
  const compact = text.normalize("NFKC").replace(/[\s　]/g, "");
  // 登記情報提供サービスの所有者事項は「…証明書」と書かれないことがある(見出しのあたりだけで見る)。
  if (compact.slice(0, 400).includes("所有者事項")) return "registry_pdf";
  // 反響は送り元に固有の見出しがあるときだけ(どの文章でも読める「共通」の読み方では決めない)。
  if (detectSourceProfile([compact]) !== "generic") return "paste_pdf";
  return "document";
}
