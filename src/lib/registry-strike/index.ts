/**
 * 謄本の「今も効力のある登記」の要約を作る入口。
 *
 * - PDF があれば、図形の下線（抹消の印）まで読んで判定する。
 * - テキスト貼り付けなど PDF が無いときは、「N番…抹消」の登記だけから判定する。
 * - どちらも**失敗したら null**（取込・プレビューは従来どおり続ける）。
 *
 * ⚠ 結果には氏名・住所が入る。ログ・AuditLog・エラー文に出さないこと。
 */
import { analyzeRegistryRights, type RegistryRightsSummary } from "./analyze";
import { extractStrikeLinesFromPdf } from "./extract";
import { linesFromPlainText } from "./lines";

export type { RegistryRightsSummary } from "./analyze";

export async function summarizeRegistryRights(input: {
  pdf?: Buffer | null;
  text: string;
}): Promise<RegistryRightsSummary | null> {
  try {
    const lines = input.pdf
      ? await extractStrikeLinesFromPdf(input.pdf)
      : linesFromPlainText(input.text);
    return analyzeRegistryRights(lines);
  } catch {
    // 本文や氏名を含みうるため、例外の中身は出さない
    return null;
  }
}
