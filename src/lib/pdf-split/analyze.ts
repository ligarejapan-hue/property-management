/**
 * まとめてある PDF の中身を見て、分け方の案を作る(保存はしない)。
 * 1ページずつ文字を取り出し、文字の無いページ(スキャン)だけ見出しのあたりを読み取って、
 * ページごとの種類 → 続いているページを1つにまとめた案、の順に作る。
 * ⚠読んだ文字は返さない(謄本のページには氏名が入る)。返すのは種類の code とページ番号だけ。
 */
import { runExclusive } from "@/lib/pdf-compress/run";
import { ocrPageHeads, type OcrResult, type OcrState } from "./run";
import { MAX_SPLIT_PAGES, classifyPageText, needsOcr, proposeSegments, type Segment } from "./segments";

export interface BundleAnalysis {
  pageCount: number;
  /** ページごとの種類(null=見分けられない)。ページが多すぎるときは空。 */
  pageKinds: (string | null)[];
  segments: Segment[];
  /** 見出しの読み取りの結果。読むページが無かった・読まなかったときは skipped。 */
  ocr: OcrState | "skipped";
  /** ページが多すぎて分けない(1つのまま保存する)。 */
  tooManyPages: boolean;
}

export interface AnalyzeDeps {
  /** ページごとの文字。読めなければ null。 */
  readPageTexts: (pdf: Buffer) => Promise<{ total: number; texts: string[] } | null>;
  ocr: (pdf: Buffer, pages: number[]) => Promise<OcrResult>;
}

/** 文字の取り出しに待つ上限。超えたら分けずに保存する。 */
export const READ_TIMEOUT_MS = 20_000;

async function readPageTextsWithPdfParse(pdf: Buffer): Promise<{ total: number; texts: string[] } | null> {
  // 大きい PDF の読み取りも圧縮と同じ順番待ちで1本ずつ(本体のプロセスのメモリを守る)。
  return runExclusive(async () => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdf });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      });
      const read = parser.getText().then((r) => {
        const texts = Array.from({ length: r.total }, (_, i) => r.pages.find((p) => p.num === i + 1)?.text ?? "");
        return { total: r.total, texts };
      });
      return await Promise.race([read, timeout]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        await parser.destroy();
      } catch {
        // 後始末の失敗は握りつぶす
      }
    }
  });
}

const defaultDeps: AnalyzeDeps = {
  readPageTexts: readPageTextsWithPdfParse,
  ocr: (pdf, pages) => ocrPageHeads(pdf, pages),
};

/** 分け方の案。PDF の文字を読めなければ null(=分けずにいつもどおり保存する)。 */
export async function analyzeBundlePdf(pdf: Buffer, deps: AnalyzeDeps = defaultDeps): Promise<BundleAnalysis | null> {
  const read = await deps.readPageTexts(pdf);
  if (read === null || read.total < 1) return null;
  const pageCount = read.total;
  if (pageCount > MAX_SPLIT_PAGES) {
    return { pageCount, pageKinds: [], segments: [{ from: 1, to: pageCount, kind: null }], ocr: "skipped", tooManyPages: true };
  }
  const texts = [...read.texts];
  const scanned = texts.flatMap((t, i) => (needsOcr(t) ? [i + 1] : []));
  let ocr: BundleAnalysis["ocr"] = "skipped";
  if (scanned.length > 0) {
    const r = await deps.ocr(pdf, scanned);
    if (r.ok) {
      ocr = r.ocr;
      for (const [page, text] of r.texts) texts[page - 1] = text;
    } else {
      ocr = r.reason === "unavailable" ? "unavailable" : "failed";
    }
  }
  const pageKinds = texts.map((t) => classifyPageText(t));
  return { pageCount, pageKinds, segments: proposeSegments(pageKinds), ocr, tooManyPages: false };
}
