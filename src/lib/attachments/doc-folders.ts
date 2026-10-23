/**
 * 添付タブの「段階ごとのフォルダ」の分け方(純関数・画面はこれを並べるだけ)。
 * 段階 ①契約前 ②契約関係 ③決済関係 ④本人確認 の順に、最後に「その他」(段階なし)。
 */
import { DOC_STAGES, type DocStageCode } from "@/lib/doc-classify/classify";

export interface FolderItem {
  id: string;
  fileName: string;
  mimeType: string;
  docStage?: string | null;
  docKind?: string | null;
  docTitle?: string | null;
  docConfidence?: string | null;
}

export interface DocFolder<T extends FolderItem> {
  /** 段階 code。その他は "other"。 */
  code: DocStageCode | "other";
  label: string;
  /** 「①」「②」…。その他は ""。 */
  short: string;
  items: T[];
}

export function groupAttachmentsByStage<T extends FolderItem>(items: readonly T[]): DocFolder<T>[] {
  const folders: DocFolder<T>[] = DOC_STAGES.map((s) => ({ code: s.code, label: s.label, short: s.short, items: [] }));
  const other: DocFolder<T> = { code: "other", label: "その他", short: "", items: [] };
  const byCode = new Map<string, DocFolder<T>>(folders.map((f) => [f.code, f]));
  for (const it of items) {
    const folder = (it.docStage && byCode.get(it.docStage)) || other;
    folder.items.push(it);
  }
  return [...folders, other];
}

/** 画面に出す名前: そろえた名前があればそれ、無ければ元の名前。 */
export function displayTitle(it: Pick<FolderItem, "fileName" | "docTitle">): string {
  return it.docTitle && it.docTitle !== "" ? it.docTitle : it.fileName;
}

/**
 * 「種類を確認」を出すか: 本文の語だけで仮に決めたもの(low)か、
 * 文書(PDF・Word・Excel)なのに種類が付かなかったもの。画像は出さない(第3段の撮影で扱う)。
 */
export function needsKindCheck(it: Pick<FolderItem, "mimeType" | "docKind" | "docConfidence">): boolean {
  if (it.docConfidence === "low") return true;
  if (it.docKind) return false;
  return !it.mimeType.startsWith("image/");
}
