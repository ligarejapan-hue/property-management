/**
 * ドライブの見回り(第2段b)の決めごと(純関数)。どのファイルを取り込むか・どこへ入れるか・
 * どの添付をドライブへ複製するか。route と見回りの本体はここを呼ぶだけにする。
 * ⚠人がドライブに置いたフォルダ・ファイルの名前は変えない(発注者決定 2026-10-24)。
 */
import { DOC_STAGES, type DocStageCode } from "@/lib/doc-classify/classify";
import { ALLOWED_ATTACHMENT_MIMES } from "@/lib/storage/types";
import { MAX_ATTACHMENT_BYTES } from "@/lib/pdf-compress/policy";
import { isOwnerPiiDocument } from "@/lib/uploads-authorization";

export type DriveStage = DocStageCode | "photo";

/**
 * 名前の語 → 段階。上から順に見る(「賃貸管理」は賃貸・「契約書類関係」は契約)。
 * 「写真」は段階の語がほかに無いときだけ(「契約書類(写真)」は契約=書類を写真タブへ入れない)。
 */
const STAGE_WORDS: readonly [string, DriveStage][] = [
  ["本人確認", "identity"],
  ["賃貸", "rental"],
  ["決済", "settlement"],
  ["契約", "contract"],
  ["管理", "management"],
  ["調査", "pre_contract"],
];

/** フォルダ名が段階を示していればその段階(写真は "photo")。示さなければ null。 */
export function stageOfDriveFolderName(name: string): DriveStage | null {
  const n = name.normalize("NFKC");
  for (const [word, stage] of STAGE_WORDS) if (n.includes(word)) return stage;
  if (n.includes("写真")) return "photo";
  return null;
}

/** アプリが段階のフォルダを新しく作るときの名前(「③契約関係」)。段階なしは「その他」。 */
export function stageFolderNameForCreate(stage: DocStageCode | null): string {
  const s = DOC_STAGES.find((x) => x.code === stage);
  return s ? `${s.short}${s.label}` : "その他";
}

/** 紐づけたフォルダの直下から、その段階に使える既存のフォルダを選ぶ(無ければ null=作る)。 */
export function pickStageFolder<T extends { id: string; name: string }>(
  subfolders: readonly T[],
  stage: DocStageCode | null,
): T | null {
  if (stage === null) return subfolders.find((f) => f.name.normalize("NFKC").trim() === "その他") ?? null;
  return subfolders.find((f) => stageOfDriveFolderName(f.name) === stage) ?? null;
}

export type Placement =
  | { kind: "inbox" }
  | { kind: "attach"; stageHint: DocStageCode | null }
  | { kind: "photo" };

/** 写真タブへ入れる画像(位置情報を消せる形式だけ)。 */
export const DRIVE_PHOTO_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 紐づけたフォルダからの道(フォルダ名の並び)で、入れ先を決める。
 * 直下=受け取り箱 / 段階のフォルダの中(下の階層も最初の段で決める)=添付 / 「写真」の画像=写真タブ。
 */
export function placementForRelPath(relPath: readonly string[], mimeType: string): Placement {
  if (relPath.length === 0) return { kind: "inbox" };
  // ★道のどこかに「本人確認」があれば本人確認書類として守る(「契約関係/本人確認/免許.pdf」も)
  if (relPath.some((p) => stageOfDriveFolderName(p) === "identity")) return { kind: "attach", stageHint: "identity" };
  const stage = stageOfDriveFolderName(relPath[0]);
  if (stage === "photo") {
    return DRIVE_PHOTO_MIMES.has(mimeType) ? { kind: "photo" } : { kind: "attach", stageHint: null };
  }
  return { kind: "attach", stageHint: stage };
}

export type SkipReason = "app_copy" | "duplicate" | "unsupported";

/** 取り込まない理由(取り込むなら null)。app_copy=アプリが置いた写し(台帳にも書かない)。 */
export function skipReasonForDriveFile(
  f: { mimeType: string; size: number | null; md5: string | null; appSource: string | null },
  ctx: { knownMd5: ReadonlySet<string>; maxBytes?: number },
): SkipReason | null {
  if (f.appSource === "app") return "app_copy";
  if (!ALLOWED_ATTACHMENT_MIMES.has(f.mimeType)) return "unsupported"; // Google ドキュメント形式もここ
  if (f.size === null || f.size > (ctx.maxBytes ?? MAX_ATTACHMENT_BYTES)) return "unsupported";
  if (f.md5 && ctx.knownMd5.has(f.md5)) return "duplicate";
  return null;
}

/**
 * アプリの添付をドライブへ複製するか。謄本(課金した原本)・反響資料・査定報告書・本人確認書類
 * (発注者決定 2026-10-24「複製しない」)は複製しない。
 */
export function shouldCopyOut(a: {
  type: string;
  docKind: string | null;
  isDeleted: boolean;
  driveFileId: string | null;
  fileSize: number;
}): boolean {
  if (a.type !== "general") return false;
  if (isOwnerPiiDocument(a)) return false;
  if (a.isDeleted || a.driveFileId !== null) return false;
  return a.fileSize <= MAX_ATTACHMENT_BYTES;
}

/** ドライブに置く写しの名前: そろえた名前・無ければ元の名前(使えない文字は _)。 */
export function outFileName(a: { docTitle: string | null; fileName: string }): string {
  const name = a.docTitle && a.docTitle !== "" ? a.docTitle : a.fileName;
  return name.replace(/[\\/\x00-\x1f]/g, "_");
}
