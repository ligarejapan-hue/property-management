/**
 * ファイル選択欄の accept 属性(".csv,.xlsx" / "image/*" / "application/pdf" など)で
 * ファイルを選り分ける。
 *
 * ブラウザは「ファイルを選択」の窓では accept で絞り込むが、ドラッグ＆ドロップで
 * 置かれたファイルは何でも通る。ドロップ枠(FileDropZone)はここで同じ基準に
 * そろえてから呼び出し側へ渡す(各画面の大きさ上限などの検証はそのまま残る)。
 */

// Windows では HEIC などの MIME が空で届くことがあるため、拡張子から補う。
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  jfif: "image/jpeg",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

type FileLike = { name: string; type: string };

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** accept が空(未指定)なら何でも受け付ける。 */
export function fileMatchesAccept(file: FileLike, accept: string | undefined): boolean {
  const tokens = (accept ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const ext = extOf(file.name);
  const mime = (file.type || EXT_MIME[ext] || "").toLowerCase();
  return tokens.some((t) => {
    if (t.startsWith(".")) return ext !== "" && t === `.${ext}`;
    if (t.endsWith("/*")) return mime.startsWith(t.slice(0, -1));
    return mime === t;
  });
}

export type PickedFiles<T> = {
  /** 呼び出し側へ渡すファイル(単一選択なら最大1件)。 */
  accepted: T[];
  /** 形式が合わず除いたファイル。 */
  rejected: T[];
  /** 単一選択の枠に複数置かれ、2件目以降を使わなかった件数。 */
  ignoredExtra: number;
};

export function pickAcceptedFiles<T extends FileLike>(
  files: readonly T[],
  accept: string | undefined,
  multiple: boolean,
): PickedFiles<T> {
  const ok: T[] = [];
  const rejected: T[] = [];
  for (const f of files) (fileMatchesAccept(f, accept) ? ok : rejected).push(f);
  if (multiple || ok.length <= 1) return { accepted: ok, rejected, ignoredExtra: 0 };
  return { accepted: ok.slice(0, 1), rejected, ignoredExtra: ok.length - 1 };
}

/**
 * 除いたファイルがあったときに枠の中へ出す一文(無ければ null)。
 * hideFileNames=true のときはファイル名を出さず件数だけ(謄本のファイル名は所有者名を含み得る)。
 */
export function pickNotice(
  picked: PickedFiles<FileLike>,
  { hideFileNames = false }: { hideFileNames?: boolean } = {},
): string | null {
  const parts: string[] = [];
  if (picked.rejected.length > 0) {
    const names = picked.rejected.slice(0, 3).map((f) => f.name).join("、");
    const more = picked.rejected.length > 3 ? ` ほか${picked.rejected.length - 3}件` : "";
    parts.push(
      `対応していない形式のため ${picked.rejected.length}件を除きました${hideFileNames ? "" : `（${names}${more}）`}`,
    );
  }
  if (picked.ignoredExtra > 0) {
    parts.push(
      hideFileNames
        ? "ここは1つずつです。最初の1件だけを使います"
        : `ここは1つずつです。最初の「${picked.accepted[0]?.name}」だけを使います`,
    );
  }
  return parts.length > 0 ? `${parts.join("。")}。` : null;
}
