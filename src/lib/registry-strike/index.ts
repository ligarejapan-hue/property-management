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

/**
 * 全部事項（権利部の甲区がある謄本）の文章か。
 * 所有者事項には権利部が無い。pdf-parse の文字は「権 利 部 （ 甲 区 ）」のように空白が入るので詰めて見る。
 */
export function isFullCertificateText(text: string): boolean {
  const c = text.replace(/[\s　]/g, "");
  return c.includes("権利部") && c.includes("甲区");
}

/** 全部事項で今の所有者を判定できなかったときの警告（氏名・住所は含めない）。 */
export const FULL_CERTIFICATE_OWNERS_UNDETERMINED_WARNING =
  "全部事項の謄本から今の所有者を判定できなかったため、所有者は反映していません。謄本を見て所有者を確認・入力してください。";

/** 判定結果の「今の所有者」を、取込の所有者の形にする。 */
export function ownersFromRights(
  rights: RegistryRightsSummary,
): { name: string; address: string | null; share: string | null }[] {
  return rights.currentOwners.map((o) => ({ name: o.name, address: o.address, share: o.share }));
}

/** 判定結果から今の所有者を使えるか（甲区を読めて、1人以上判定できた）。 */
export function hasDeterminedOwners(rights: RegistryRightsSummary | null | undefined): rights is RegistryRightsSummary {
  return !!rights && rights.hasKouku && rights.currentOwners.length > 0;
}

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
