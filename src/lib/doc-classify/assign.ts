/**
 * 判別の結果を Attachment の4列(docStage/docKind/docTitle/docConfidence)に落とす(純関数)。
 * route(POST/PATCH)はここを呼ぶだけにして、名前の組み立てと日付の決め方を1か所に置く。
 */
import { parseDateOnly, todayDateOnly } from "@/lib/case-dates";
import { classifyDocument, docKindByCode, docStageOfKind, type DocConfidence } from "./classify";
import {
  buildDocTitle,
  dateFromStamp,
  dateStampFromDocTitle,
  extractDocumentDate,
  fileExtension,
  propertyLabelForTitle,
  uniqueDocTitle,
} from "./title";

export interface DocColumns {
  docStage: string | null;
  docKind: string | null;
  docTitle: string | null;
  docConfidence: DocConfidence | null;
}

export interface TitleContext {
  property: { buildingName: string | null | undefined; roomNo: string | null | undefined; address: string };
  /** 同じ物件に既にある名前(docTitle)。重複に連番を付けるため。 */
  takenTitles: ReadonlySet<string>;
}

const EMPTY: DocColumns = { docStage: null, docKind: null, docTitle: null, docConfidence: null };

/** 種類 code から4列を組み立てる。種類が無ければ(その他)4列とも null。 */
function columnsForKind(
  kindCode: string | null,
  confidence: DocConfidence,
  fileName: string,
  date: Date,
  ctx: TitleContext,
): DocColumns {
  const kind = docKindByCode(kindCode);
  if (!kind) return { ...EMPTY };
  const title = uniqueDocTitle(
    buildDocTitle({
      kindLabel: kind.label,
      propertyLabel: propertyLabelForTitle(ctx.property),
      date,
      ext: fileExtension(fileName),
    }),
    ctx.takenTitles,
  );
  return { docStage: docStageOfKind(kind.code), docKind: kind.code, docTitle: title, docConfidence: confidence };
}

/**
 * 新しく登録する添付の4列。名前と本文から判別し、日付は本文の日付→今日(端末=サーバーの日付)。
 * 当たらなければ4列とも null(=その他・元の名前のまま)。
 */
export function docColumnsForNewAttachment(
  input: { fileName: string; text?: string | null; now?: Date },
  ctx: TitleContext,
): DocColumns {
  const hit = classifyDocument({ fileName: input.fileName, text: input.text });
  if (!hit) return { ...EMPTY };
  const fromText = extractDocumentDate(input.text);
  const date = (fromText ? dateFromStamp(fromText) : null) ?? parseDateOnly(todayDateOnly(input.now)) ?? new Date();
  return columnsForKind(hit.kind, hit.confidence, input.fileName, date, ctx);
}

/**
 * 受け取り箱から添付するときの4列(種類・確からしさ・本文の日付は受け取ったときに決めてある)。
 * 人が受け取り箱で種類を選び直していれば `confidence` は "manual"。種類が無ければ4列とも null。
 */
export function docColumnsForKnownKind(
  input: {
    kindCode: string | null;
    confidence: DocConfidence;
    fileName: string;
    /** 本文から読んだ日付 YYYYMMDD。無ければ `now` の日付。 */
    dateStamp: string | null;
    now?: Date;
  },
  ctx: TitleContext,
): DocColumns {
  if (input.kindCode === null) return { ...EMPTY };
  const date =
    (input.dateStamp ? dateFromStamp(input.dateStamp) : null) ?? parseDateOnly(todayDateOnly(input.now)) ?? new Date();
  return columnsForKind(input.kindCode, input.confidence, input.fileName, date, ctx);
}

/**
 * 人が種類を決め直したときの4列。日付は今の名前の日付を引き継ぎ、無ければ登録日。
 * `kindCode` が null なら「その他」(4列とも null)。
 */
export function docColumnsForManualKind(
  input: { kindCode: string | null; fileName: string; currentTitle: string | null; createdAt: Date },
  ctx: TitleContext,
): DocColumns {
  if (input.kindCode === null) return { ...EMPTY };
  const stamp = dateStampFromDocTitle(input.currentTitle);
  const date = (stamp ? dateFromStamp(stamp) : null) ?? parseDateOnly(todayDateOnly(input.createdAt)) ?? input.createdAt;
  return columnsForKind(input.kindCode, "manual", input.fileName, date, ctx);
}
