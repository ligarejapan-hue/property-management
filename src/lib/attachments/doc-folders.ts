/**
 * 添付タブの「段階ごとのフォルダ」の分け方(純関数・画面はこれを並べるだけ)。
 * 段階 ①調査資料等 ②管理関係 ③契約関係 ④決済関係 ⑤賃貸関係 本人確認 の順に、最後に「その他」(段階なし)。
 */
import { DOC_STAGES, RENTAL_STAGE, docStageOfKind, type DocStageCode } from "@/lib/doc-classify/classify";

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
    // 種類があれば種類の表から段階を引く(段階の並びを変えたとき、保存済みの doc_stage が古くても
    // 正しいフォルダに出る)。種類が無ければ保存されている段階。
    const stage = docStageOfKind(it.docKind) ?? it.docStage;
    const folder = (stage && byCode.get(stage)) || other;
    folder.items.push(it);
  }
  return [...folders, other];
}

/**
 * 画面に出すフォルダ。⑤賃貸関係は、現況が賃貸中(occupancyStatus="rented")のときだけ空でも出す。
 * 賃貸中でなくても、中に書類があれば出す(隠れて見えなくならないように)。
 */
export function visibleFolders<T extends FolderItem>(
  folders: readonly DocFolder<T>[],
  opts: { occupancyStatus: string | null | undefined },
): DocFolder<T>[] {
  return folders.filter(
    (f) => f.code !== RENTAL_STAGE || opts.occupancyStatus === "rented" || f.items.length > 0,
  );
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
