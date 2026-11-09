/**
 * 物件の基本情報の「謄本 ○件」で、種別の列が空の謄本(手で取り込んだもの)を本文で見分ける(2026-11-09 発注者依頼)。
 * 見分け方は取引の画面(登記の現況・数値照合)と同じ: 権利部の甲区がある=全部事項、所有者の表が読める=所有者事項。
 *
 * ⚠種別の列は書き換えない(列を見るほかの画面=基本情報への反映・所有者の自動登録・名義の確認・照合の動きを変えない)。
 * ⚠見分けた結果は添付ごとにこのサーバーの中に覚える(ファイルが変わらない限り読み直さない)。再起動で忘れる。
 *   時間切れ・読み取りの失敗は「その他」で覚えるが、10分で忘れる(一時的な失敗で長く「その他」にしない)。
 * ⚠画像だけの謄本・時間切れ・読めない=「その他」。画面を遅らせないよう、1回の表示で読む時間に上限がある。
 * ⚠監査ログは書かない(謄本を開いた記録を増やさない)。覚えるのは種別だけ(氏名・本文は残さない)。
 */
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import { PDF_READ_TIMEOUT } from "@/lib/pdf-read-timeout";
import { isFullCertificateText } from "@/lib/registry-strike";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";

export type RegistryCountKind = "owner" | "all" | "other";
export type RegistryCounts = Record<RegistryCountKind, number>;

export type UntypedRegistryAttachment = {
  id: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
};

/** 1件を読む時間の上限(保存場所から読む時間を含む)。 */
export const REGISTRY_COUNT_READ_TIMEOUT_MS = 3_000;
/** 1回の表示で読む時間の合計の上限。残りは「その他」で出し、次に開いたときに続きを読む。 */
export const REGISTRY_COUNT_READ_BUDGET_MS = 4_000;
/** 残りがこれより短ければ読みに行かない(確実に時間切れになるため・覚えない)。 */
export const REGISTRY_COUNT_MIN_READ_MS = 1_000;
/** 時間切れ・読み取りの失敗を覚えておく時間。 */
export const REGISTRY_COUNT_FAILURE_TTL_MS = 10 * 60_000;
/** 覚えておく件数の上限(古いものから忘れる)。 */
const CACHE_MAX = 5_000;

const cache = new Map<string, { kind: RegistryCountKind; expiresAt: number | null }>();

/** ファイルが変われば別の鍵になる(保存先・大きさ)。 */
function cacheKey(a: UntypedRegistryAttachment): string {
  return `${a.id}|${a.fileUrl}|${a.fileSize}`;
}

function remember(key: string, kind: RegistryCountKind, expiresAt: number | null): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { kind, expiresAt });
}

/** 本文から種別を決める(純関数)。 */
export function classifyRegistryText(text: string): RegistryCountKind {
  if (isFullCertificateText(text)) return "all";
  if (parseRegistryOwnerTable(text)?.length) return "owner";
  return "other";
}

export type ReadPdfText = (fileUrl: string, timeoutMs: number) => Promise<string | null>;

/** 保存場所から読んで文字を抜き出す。PDF でない・ファイルが無い=null。時間切れ・失敗は投げる。 */
const readPdfText: ReadPdfText = async (fileUrl, timeoutMs) => {
  const started = Date.now();
  const storage = getStorage();
  const key = storage.keyFromUrl(fileUrl);
  const file = key ? await storage.read(key) : null;
  if (!file || !isPdfBuffer(file.body)) return null;
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) throw Object.assign(new Error("timeout"), { code: PDF_READ_TIMEOUT });
  return extractTextFromPdf(file.body, { timeoutMs: remaining });
};

/**
 * 種別の列が空の謄本を見分けて数える。覚えている分は読まない。例外は投げない(読めなければ「その他」)。
 * @param deps テスト用(読み取り・時計の差し替え)
 */
export async function countUntypedRegistryAttachments(
  rows: UntypedRegistryAttachment[],
  deps: { read?: ReadPdfText; now?: () => number } = {},
): Promise<RegistryCounts> {
  const read = deps.read ?? readPdfText;
  const now = deps.now ?? Date.now;
  const counts = { owner: 0, all: 0, other: 0 };
  const deadline = now() + REGISTRY_COUNT_READ_BUDGET_MS;
  for (const a of rows) {
    const key = cacheKey(a);
    const hit = cache.get(key);
    if (hit && (hit.expiresAt === null || hit.expiresAt > now())) {
      counts[hit.kind]++;
      continue;
    }
    let kind: RegistryCountKind;
    let expiresAt: number | null = null;
    if (!/pdf/i.test(a.mimeType)) {
      // 画像だけの謄本など=読まずに「その他」
      kind = "other";
    } else {
      const remaining = deadline - now();
      if (remaining < REGISTRY_COUNT_MIN_READ_MS) {
        // 今回は読む時間が無い=覚えずに「その他」(次に開いたときに読む)
        counts.other++;
        continue;
      }
      try {
        const text = await read(a.fileUrl, Math.min(REGISTRY_COUNT_READ_TIMEOUT_MS, remaining));
        kind = text && text.trim() ? classifyRegistryText(text) : "other";
      } catch {
        // 時間切れ・読み取りの失敗=「その他」。しばらく覚えて、開くたびに同じ待ちを繰り返さない
        kind = "other";
        expiresAt = now() + REGISTRY_COUNT_FAILURE_TTL_MS;
      }
    }
    remember(key, kind, expiresAt);
    counts[kind]++;
  }
  return counts;
}

/**
 * 種別ごとの件数(groupBy の結果)を数える。種別の列が空の分だけ、読み出して本文で見分ける。
 * 読み出し・見分けが失敗しても投げず、列が空の分は「その他」にする(物件の画面は必ず出す)。
 */
export async function countRegistryAttachmentGroups(
  grouped: { registryCertificateType: string | null; _count: { _all: number } }[],
  loadUntyped: () => Promise<UntypedRegistryAttachment[]>,
  deps: { read?: ReadPdfText; now?: () => number } = {},
): Promise<RegistryCounts> {
  const counts = { owner: 0, all: 0, other: 0 };
  let untyped = 0;
  for (const g of grouped) {
    const n = g._count._all;
    if (g.registryCertificateType === "owner") counts.owner += n;
    else if (g.registryCertificateType === "all") counts.all += n;
    else if (g.registryCertificateType === null) untyped += n;
    else counts.other += n;
  }
  if (untyped === 0) return counts;
  try {
    const c = await countUntypedRegistryAttachments(await loadUntyped(), deps);
    return { owner: counts.owner + c.owner, all: counts.all + c.all, other: counts.other + c.other };
  } catch {
    return { ...counts, other: counts.other + untyped };
  }
}

/** テスト用: 覚えた結果を消す。 */
export function resetRegistryCountCacheForTest(): void {
  cache.clear();
}
