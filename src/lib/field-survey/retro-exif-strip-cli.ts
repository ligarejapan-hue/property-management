/**
 * 既存 field-survey 写真の遡及 EXIF/GPS strip — inventory / dry-run CLI core（PR-R2a）。
 *
 * 位置づけ:
 *   docs/field-survey-retro-exif-strip-runbook.md の実行ロジック部分。
 *   本モジュールは **dry-run / inventory 専用** の純関数群で、prisma / storage 実体 /
 *   process / next を一切 import しない（DI）。実際の DB read・storage read・出力は
 *   薄い wrapper（scripts/retro-exif-strip-field-survey.ts）が担当する。
 *
 * 安全境界（PR-R2a の絶対条件）:
 *   - `--apply` は受理しない（parse 時点で error）。DB 更新 / storage upload・delete /
 *     repoint / cleanup は本 PR に存在しない（PR-R2b 以降・別承認）。
 *   - dry-run は processRetroStripRow を mode:"dry-run" で呼ぶだけ。同関数は
 *     upload / repoint / delete を呼ばない（PR #148 でロック済み）。本 CLI は
 *     さらに「呼ばれたら throw する ports」を wrapper 側で渡し、多層防御する。
 *   - 出力は非 PII。fileName / 座標 / EXIF 値 / 所有者情報は出さない
 *     （RetroStripRowResult は元々 fileName を含まない。JSONL も whitelist 整形）。
 */

import {
  processRetroStripRow,
  extractStorageKeyFromStoredFileUrl,
  RETRO_STRIP_SUPPORTED_MIMES,
  RETRO_STRIP_OUTCOMES,
  type RetroStripPorts,
  type RetroStripRowInput,
  type RetroStripRowResult,
  type RetroStripOutcome,
} from "./retro-exif-strip";

// ---------------------------------------------------------------
// CLI 引数 / 安全ガード
// ---------------------------------------------------------------

export type RetroStripCliMode = "inventory" | "dry-run";

export interface RetroStripCliOptions {
  mode: RetroStripCliMode;
  /** dry-run の JSONL run-log 出力先パス（未指定なら stdout 前提・wrapper が解釈）。 */
  jsonlPath: string | null;
  /** 1 バッチあたりの取得件数（ページング）。既定 500。 */
  batchSize: number;
  /** 処理対象の上限（テスト/部分確認用。未指定 = 無制限）。 */
  limit: number | null;
  /** --help。 */
  help: boolean;
}

export interface RetroStripCliParseError {
  error: string;
}

export type RetroStripCliParseResult =
  | { ok: true; options: RetroStripCliOptions }
  | { ok: false; error: string };

const DEFAULT_BATCH_SIZE = 500;

/**
 * argv（実行ファイル名等を除いた純粋な引数配列）を parse する。
 *
 * 受理: --inventory | --dry-run（いずれか必須・排他）/ --jsonl <path> /
 *       --batch-size <n> / --limit <n> / --help。
 * 拒否: --apply（PR-R2a では実装しない＝明示エラー）/ 未知フラグ / mode 未指定 /
 *       mode 重複 / 数値オプションの不正値。
 */
export function parseRetroStripCliArgs(
  argv: readonly string[],
): RetroStripCliParseResult {
  let mode: RetroStripCliMode | null = null;
  let jsonlPath: string | null = null;
  let batchSize = DEFAULT_BATCH_SIZE;
  let limit: number | null = null;
  let help = false;

  const setMode = (m: RetroStripCliMode): string | null => {
    if (mode !== null && mode !== m) {
      return `モードは1つだけ指定してください（--inventory と --dry-run は排他）`;
    }
    mode = m;
    return null;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--inventory": {
        const e = setMode("inventory");
        if (e) return { ok: false, error: e };
        break;
      }
      case "--dry-run": {
        const e = setMode("dry-run");
        if (e) return { ok: false, error: e };
        break;
      }
      case "--apply":
        // PR-R2a は dry-run / inventory 専用。apply は未実装（別承認の PR-R2b 以降）。
        return {
          ok: false,
          error:
            "--apply はこの CLI では実装されていません（dry-run / inventory 専用）。実 strip は別 PR・別承認です。",
        };
      case "--jsonl": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return { ok: false, error: "--jsonl には出力先パスを指定してください" };
        }
        jsonlPath = value;
        i += 1;
        break;
      }
      case "--batch-size": {
        const value = argv[i + 1];
        const n = Number(value);
        if (value === undefined || !Number.isInteger(n) || n <= 0) {
          return { ok: false, error: "--batch-size には正の整数を指定してください" };
        }
        batchSize = n;
        i += 1;
        break;
      }
      case "--limit": {
        const value = argv[i + 1];
        const n = Number(value);
        if (value === undefined || !Number.isInteger(n) || n <= 0) {
          return { ok: false, error: "--limit には正の整数を指定してください" };
        }
        limit = n;
        i += 1;
        break;
      }
      default:
        return { ok: false, error: `未知のオプション: ${arg}` };
    }
  }

  if (help) {
    // help は mode 不要（wrapper が usage を出して終了する）。
    return {
      ok: true,
      options: { mode: mode ?? "inventory", jsonlPath, batchSize, limit, help: true },
    };
  }

  if (mode === null) {
    return {
      ok: false,
      error: "--inventory または --dry-run のいずれかを指定してください",
    };
  }

  return { ok: true, options: { mode, jsonlPath, batchSize, limit, help: false } };
}

export interface EnvironmentGuardResult {
  ok: boolean;
  /** 停止理由（ok=false のとき）。 */
  reason?: string;
}

/**
 * 危険/不適切な実行環境を検出して停止する。
 *
 * - NEXT_PUBLIC_USE_MOCK==="true": mock モードでは実 DB/ストレージを指さず、
 *   audit も無効化される（このフラグ下の inventory/dry-run は無意味かつ誤解を招く）。
 *   実データに対する確認意図と矛盾するため停止する。
 *
 * 注意: 本 CLI は read 専用だが、運用上「mock を本番だと誤認」する事故を防ぐためのガード。
 */
export function assertSafeEnvironment(
  env: Record<string, string | undefined>,
): EnvironmentGuardResult {
  if (env.NEXT_PUBLIC_USE_MOCK === "true") {
    return {
      ok: false,
      reason:
        "NEXT_PUBLIC_USE_MOCK=true のため停止しました（mock 環境では inventory/dry-run の結果が実データを反映しません）。",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// inventory（storage を読まない DB-only 分類・集計）
// ---------------------------------------------------------------

/** inventory が必要とする行の最小形（storage は読まない）。 */
export interface InventoryRowInput {
  id: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  mimeType: string;
}

export interface InventorySummary {
  total: number;
  /** mimeType（小文字化）ごとの件数。 */
  byMimeType: Record<string, number>;
  /** fileUrl から canonical key を復元できた件数（処理候補）。 */
  mappable: number;
  /** fileUrl から key を復元できない件数（skip 予定）。 */
  unmappable: number;
  /** mappable のうち、fileUrl が absolute（scheme 付き）だった件数（legacy 由来）。 */
  absoluteLegacy: number;
  /** strip 対象 MIME（jpeg/png/webp）かつ mappable な件数（実処理候補の上限）。 */
  supportedAndMappable: number;
  /** HEIC/HEIF 等の非対応 MIME 件数（skip 予定・GPS 残存が残る候補）。 */
  unsupportedMime: number;
  /** thumbnailUrl が非 null の件数。 */
  withThumbnail: number;
  /** thumbnailUrl から canonical key を復元できた件数。 */
  thumbnailMappable: number;
}

const ABSOLUTE_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;

/** 1 行の inventory 分類（純関数・storage を読まない）。 */
export function classifyInventoryRow(row: InventoryRowInput): {
  mappable: boolean;
  absoluteLegacy: boolean;
  supportedMime: boolean;
  unsupportedMime: boolean;
  hasThumbnail: boolean;
  thumbnailMappable: boolean;
} {
  const key = extractStorageKeyFromStoredFileUrl(row.fileUrl);
  const mappable = key !== null;
  const mime = row.mimeType.toLowerCase();
  const supportedMime = RETRO_STRIP_SUPPORTED_MIMES.has(mime);
  const hasThumbnail = typeof row.thumbnailUrl === "string" && row.thumbnailUrl.trim() !== "";
  return {
    mappable,
    // absolute（scheme 付き）かつ mappable = legacy absolute /uploads URL（P1 で対象化）。
    absoluteLegacy: mappable && ABSOLUTE_SCHEME_RE.test(row.fileUrl.trim()),
    supportedMime,
    unsupportedMime: !supportedMime,
    hasThumbnail,
    thumbnailMappable:
      extractStorageKeyFromStoredFileUrl(row.thumbnailUrl) !== null,
  };
}

/** 全カウント 0 の inventory サマリ（streaming fold の初期値）。 */
export function emptyInventorySummary(): InventorySummary {
  return {
    total: 0,
    byMimeType: {},
    mappable: 0,
    unmappable: 0,
    absoluteLegacy: 0,
    supportedAndMappable: 0,
    unsupportedMime: 0,
    withThumbnail: 0,
    thumbnailMappable: 0,
  };
}

/**
 * inventory サマリへ 1 行を畳み込む（in-place 更新）。
 * wrapper はページングしながら本関数で逐次集計でき、全行をメモリに保持しなくてよい
 * （dry-run の streaming と同じ規律）。
 */
export function accumulateInventoryRow(
  summary: InventorySummary,
  row: InventoryRowInput,
): void {
  summary.total += 1;
  const mime = row.mimeType.toLowerCase();
  summary.byMimeType[mime] = (summary.byMimeType[mime] ?? 0) + 1;
  const c = classifyInventoryRow(row);
  if (c.mappable) summary.mappable += 1;
  else summary.unmappable += 1;
  if (c.absoluteLegacy) summary.absoluteLegacy += 1;
  if (c.mappable && c.supportedMime) summary.supportedAndMappable += 1;
  if (c.unsupportedMime) summary.unsupportedMime += 1;
  if (c.hasThumbnail) summary.withThumbnail += 1;
  if (c.thumbnailMappable) summary.thumbnailMappable += 1;
}

/** 行配列から inventory サマリを集計する（純関数・上記 fold の薄いラッパ）。 */
export function aggregateInventory(
  rows: readonly InventoryRowInput[],
): InventorySummary {
  const summary = emptyInventorySummary();
  for (const row of rows) accumulateInventoryRow(summary, row);
  return summary;
}

// ---------------------------------------------------------------
// dry-run（storage read + strip in-memory のみ・書き込み一切なし）
// ---------------------------------------------------------------

/** dry-run 1 件分の非 PII run-log 行（JSONL の 1 オブジェクト）。 */
export interface RetroStripRunLogLine {
  photoId: string;
  outcome: RetroStripOutcome;
  /** 復元できた旧 key（path のみ。氏名/座標を含まない）。無い分岐では省略。 */
  oldKey?: string;
  /** strip 前後のバイト数（would_strip のみ）。 */
  bytesBefore?: number;
  bytesAfter?: number;
  /** 非対応 MIME 件のための mimeType（HEIC/HEIF 等）。 */
  mimeType?: string;
  /** failed の段階とエラー名（メッセージ本文は含めない）。 */
  stage?: string;
  errorName?: string;
}

/**
 * RetroStripRowResult を非 PII の JSONL 行へ整形する（whitelist 方式・防御的）。
 * fileName / newFileUrl / thumbnail などは run-log に出さない（dry-run の確認に不要）。
 */
export function toRunLogLine(result: RetroStripRowResult): RetroStripRunLogLine {
  const line: RetroStripRunLogLine = {
    photoId: result.photoId,
    outcome: result.outcome,
  };
  switch (result.outcome) {
    case "would_strip":
      line.oldKey = result.oldKey;
      line.bytesBefore = result.bytesBefore;
      line.bytesAfter = result.bytesAfter;
      break;
    case "unchanged":
    case "skipped_malformed":
    case "skipped_missing_bytes":
      line.oldKey = result.oldKey;
      break;
    case "skipped_unsupported_mime":
      line.mimeType = result.mimeType;
      break;
    case "failed":
      line.stage = result.stage;
      line.errorName = result.errorName;
      break;
    // skipped_unmappable_url は photoId + outcome のみ（key 復元できていない）。
    // repointed / would_strip 以外の apply 系 outcome は dry-run では発生しない。
    default:
      break;
  }
  return line;
}

/** dry-run の集計結果。 */
export interface RetroStripDryRunResult {
  processed: number;
  summary: Record<RetroStripOutcome, number>;
}

/**
 * dry-run 専用 ports を組み立てる。
 *
 * - storage.read のみ実体（呼び出し側が注入）。
 * - upload / delete / repointPhoto は **呼ばれたら throw**（多層防御）。
 *   dry-run モードの processRetroStripRow はこれらに到達しないため、throw は
 *   「将来 mode 取り違え等のバグが混入したら即座に失敗させる」安全網。
 */
export function makeDryRunPorts(
  read: RetroStripPorts["storage"]["read"],
): RetroStripPorts {
  // async stub: 呼ばれたら reject する（callers は await する契約のため throw でなく
  // rejected promise を返す。dry-run では到達しないが、到達したら即失敗させる安全網）。
  const forbidden = (op: string) => async (): Promise<never> => {
    throw new Error(
      `dry-run では ${op} は実行されません（書き込み導線は PR-R2a に存在しません）`,
    );
  };
  return {
    storage: {
      read,
      upload: forbidden("storage.upload") as RetroStripPorts["storage"]["upload"],
      delete: forbidden("storage.delete") as RetroStripPorts["storage"]["delete"],
    },
    repointPhoto: forbidden("repointPhoto") as RetroStripPorts["repointPhoto"],
  };
}

/**
 * 行を 1 件ずつ dry-run 処理し、非 PII run-log 行を sink へ流しつつ集計する。
 *
 * @param rows    非同期反復可能な行ソース（wrapper が prisma ページングで供給）。
 * @param ports   dry-run ports（makeDryRunPorts 推奨）。
 * @param onLine  各 run-log 行の sink（JSONL ファイル追記等。省略可）。
 */
export async function runRetroStripDryRun(
  rows: AsyncIterable<RetroStripRowInput>,
  ports: RetroStripPorts,
  onLine?: (line: RetroStripRunLogLine) => void | Promise<void>,
): Promise<RetroStripDryRunResult> {
  // Codex P2: 結果配列を保持せず outcome counter を per-row 更新する（全件 dry-run でも
  // ヒープが行数に比例して増えない＝行ページング / JSONL 逐次書き出しと同じ streaming 規律）。
  const summary = emptyOutcomeSummary();
  let processed = 0;
  for await (const row of rows) {
    const result = await processRetroStripRow(row, ports, { mode: "dry-run" });
    summary[result.outcome] += 1;
    processed += 1;
    if (onLine) await onLine(toRunLogLine(result));
  }
  return { processed, summary };
}

/** help / banner 用に、空サマリ（全 outcome 0）を返す。 */
export function emptyOutcomeSummary(): Record<RetroStripOutcome, number> {
  return Object.fromEntries(
    RETRO_STRIP_OUTCOMES.map((o) => [o, 0]),
  ) as Record<RetroStripOutcome, number>;
}
