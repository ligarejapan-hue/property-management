/**
 * 取り込み(CSV)画面の控え(設計書 §2 S4)。1つの画面に3つの流れがある:
 *   main = CSV/Excel → 物件(段階 2・3 だけ控える。取り込み後の段階 4 は控えない)
 *   ro   = 受付帳 × 所有者(結果が出たら控えない)
 *   rp   = 受付帳 → 物件(結果が出たら控えない)
 * ファイルの中身は文字(csvText)か base64 で持っているので、選び直しは要らない。
 * 大きいときは土台が "too_large" で止める(§5.4)。
 */
import { z } from "zod/v4";
import type { StoredDraft } from "../draft-store";

type FileEntry = { name: string; csvText?: string; xlsxBase64?: string };
type DlFilter = "marked" | "unmarked" | "all";
type ShinkiFilter = "existing" | "new" | "all";

export interface CsvMainDraft {
  step: 2 | 3;
  fileName: string;
  csvText: string;
  xlsxBase64: string | null;
  template: string;
  headers: string[];
  rows: string[][];
  columnMapping: Record<string, string>;
  /** 重複の下見(サーバーの応答)。形は画面の state と同じ。 */
  duplicatePreview: Record<string, unknown> | null;
}
export interface CsvRoDraft {
  receptionFile: FileEntry | null;
  ownerFile: FileEntry | null;
  dlFilter: DlFilter;
  shinkiFilter: ShinkiFilter;
  roPreview: Record<string, unknown> | null;
}
export interface CsvRpDraft {
  rpFile: FileEntry | null;
  rpDlFilter: DlFilter;
  rpShinkiFilter: ShinkiFilter;
  rpPreview: Record<string, unknown> | null;
}
export interface CsvImportDraft {
  rev: 1;
  main: CsvMainDraft | null;
  ro: CsvRoDraft | null;
  rp: CsvRpDraft | null;
}

const fileSchema = z.object({ name: z.string(), csvText: z.string().optional(), xlsxBase64: z.string().optional() });
const dl = z.enum(["marked", "unmarked", "all"]);
const shinki = z.enum(["existing", "new", "all"]);

const schema = z.object({
  rev: z.literal(1),
  main: z
    .object({
      step: z.union([z.literal(2), z.literal(3)]),
      fileName: z.string(),
      csvText: z.string(),
      xlsxBase64: z.string().nullable(),
      template: z.string(),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      columnMapping: z.record(z.string(), z.string()),
      duplicatePreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  ro: z
    .object({
      receptionFile: fileSchema.nullable(),
      ownerFile: fileSchema.nullable(),
      dlFilter: dl,
      shinkiFilter: shinki,
      roPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  rp: z
    .object({
      rpFile: fileSchema.nullable(),
      rpDlFilter: dl,
      rpShinkiFilter: shinki,
      rpPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
});

export function parseCsvImportDraft(d: unknown): CsvImportDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as CsvImportDraft) : null;
}

export function isCsvImportDraftEmpty(d: CsvImportDraft): boolean {
  return d.main === null && d.ro === null && d.rp === null;
}

/** 大きすぎて控えを止めた後に、送信中の印だけを残す中身(空)。 */
export function compactCsvImportDraftForPending(): CsvImportDraft {
  return { rev: 1, main: null, ro: null, rp: null };
}

/**
 * 戻し方を決める。送信中の印が残っていたら、取り込みはサーバーで続いているかもしれない
 * =中身は戻さず「取り込み履歴で確かめて」だけ出す(§5.1 S4)。
 */
export function decideCsvImportRestore(
  restored: StoredDraft<CsvImportDraft> | null,
): { start: CsvImportDraft | null; showPending: boolean } {
  if (!restored) return { start: null, showPending: false };
  if (restored.pendingSubmit) return { start: null, showPending: true };
  return { start: restored.data, showPending: false };
}

/**
 * 取り込みが済んだ流れを外した控え(印を外す前に書く)。
 * ⚠画面を離れた後に返事が来ても書き手は生きているので、印を外すだけだと取り込む前の形
 *   (段階3の中身など)が「送信中でない控え」として残り、戻ったときもう一度送れてしまう(§5.1 S4)。
 */
export function csvDraftAfterImport(d: CsvImportDraft, flow: "main" | "ro" | "rp"): CsvImportDraft {
  return { ...d, [flow]: null };
}

/**
 * 送信中の印の数え方。3つの流れは1つの控え(印も1つ)を分け合うので、
 * ⚠1つの流れが済んでも、他の流れが送っている途中なら印を外さない(@codex P1)。
 * ⚠結果が分からない(5xx・通信切れ)ときは、画面に残っていても人が履歴で確かめるまで外さない。
 */
export type CsvPendingEvent = "start" | "ok" | "definite" | "unknown" | "confirm";
export interface CsvPendingState {
  /** いま送っている取り込みの数。 */
  inflight: number;
  /** 結果が分からないまま、まだ人が確かめていない。 */
  unknown: boolean;
}
export const INITIAL_CSV_PENDING: CsvPendingState = { inflight: 0, unknown: false };

export function nextCsvPending(s: CsvPendingState, e: CsvPendingEvent): { state: CsvPendingState; unmark: boolean } {
  switch (e) {
    case "start":
      return { state: { ...s, inflight: s.inflight + 1 }, unmark: false };
    case "ok":
    case "definite": {
      const inflight = Math.max(0, s.inflight - 1);
      return { state: { ...s, inflight }, unmark: inflight === 0 && !s.unknown };
    }
    case "unknown":
      return { state: { inflight: Math.max(0, s.inflight - 1), unknown: true }, unmark: false };
    case "confirm":
      return { state: { ...s, unknown: false }, unmark: s.inflight === 0 };
  }
}

/**
 * 結果が分からなくなってから、取り込み履歴を「確かめた」根拠にできるまでの待ち時間。
 * ⚠サーバーは取り込みを受け取った直後に記録(処理中)を作る(src/lib/import-job-start.ts)。ただし通信が切れた
 *   直後は、送った中身がまだサーバーへ届き切っていない・順番待ちのことがある=少し待ってから読み直したものだけを
 *   使う(@codex P1)。表を読み終えるのを待つ必要はない(記録は前処理より前にできる)。
 */
export const HISTORY_SETTLE_MS = 60_000;

/** 前回離れて印が残っていたときは、印を付けた時刻から待つ。 */
export function initialHistoryReadyAt(restored: StoredDraft<CsvImportDraft> | null): number {
  return restored?.pendingSubmit ? restored.pendingSubmit.at + HISTORY_SETTLE_MS : 0;
}

/** その履歴の読み込みを、結果が分からない取り込みを「確かめた」根拠にしてよいか。 */
export function canTrustJobHistory(p: {
  /** 結果が分からなくなった後(最新の世代)に始めた読み込みか。 */
  sameGen: boolean;
  /** 絞り込みなしの1ページ目か(今回の取り込みが必ず見える)。 */
  defaultView: boolean;
  startedAt: number;
  readyAt: number;
}): boolean {
  return p.sameGen && p.defaultView && p.startedAt >= p.readyAt;
}

/**
 * 画面すっきり化 第4回 D(2026-10-16): 受付帳は1回だけ入れ、①(rp)と②(ro)で同じファイル・同じ
 * 取込条件を使う。画面の state は流れごとに2つのまま(控えの形・送信中の印の数え方を変えない)なので、
 * 戻すときに2つを1つにそろえる。
 * - ファイル = ①の控え(rp.rpFile)を優先。①が済んで控えから外れていれば②の控え(ro.receptionFile)。
 * - 取込条件 = ①の控えがあれば①、無ければ②。
 * - ⚠第4回より前の控えで①と②が別のファイル・別の条件だったら、②の下見は今の入力と合わないので捨てる
 *   (下見と違う中身で取り込ませない)。
 */
export function unifyReceptionDraft(d: CsvImportDraft | null): CsvImportDraft | null {
  if (!d || (!d.rp && !d.ro)) return d;
  const file = d.rp?.rpFile ?? d.ro?.receptionFile ?? null;
  const dlFilter = d.rp ? d.rp.rpDlFilter : d.ro!.dlFilter;
  const shinkiFilter = d.rp ? d.rp.rpShinkiFilter : d.ro!.shinkiFilter;
  const sameFile = (a: FileEntry | null, b: FileEntry | null) =>
    a === b || (!!a && !!b && a.name === b.name && a.csvText === b.csvText && a.xlsxBase64 === b.xlsxBase64);
  const ro = d.ro
    ? {
        ...d.ro,
        receptionFile: file,
        dlFilter,
        shinkiFilter,
        roPreview:
          sameFile(d.ro.receptionFile, file) && d.ro.dlFilter === dlFilter && d.ro.shinkiFilter === shinkiFilter
            ? d.ro.roPreview
            : null,
      }
    : null;
  return { ...d, ro };
}
