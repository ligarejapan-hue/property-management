/**
 * 既存 field-survey 写真の遡及 EXIF/GPS strip — inventory / dry-run / apply CLI core。
 *
 * 位置づけ:
 *   docs/field-survey-retro-exif-strip-runbook.md の実行ロジック部分。
 *   本モジュールは純関数群で、prisma / storage 実体 / process / next を一切 import しない（DI）。
 *   実際の DB read/repoint・storage read/upload/delete・出力は薄い wrapper
 *   （scripts/retro-exif-strip-field-survey.ts）が実体を注入して担当する。
 *
 * モードと安全境界:
 *   - inventory / dry-run は READ のみ（書き込み導線なし）。dry-run の no-write は
 *     makeDryRunPorts の throw スタブ + processRetroStripRow(mode:"dry-run") の早期 return
 *     で多層に保証する。
 *   - apply（PR-R2b）は processRetroStripRow を mode:"apply" で呼ぶ「配線のみ」。
 *     新 key 再アップロード + 楽観ガード付き repoint・新 key 補償削除は core（PR #148）が
 *     完結しており、本モジュールはそれを呼ぶ ports（makeApplyPorts）と repoint closure
 *     （makeUpdateManyRepointPhoto）を組むだけ。**旧 key / 旧 thumbnail key は削除しない**
 *     （rollback 窓として保持。cleanup は別承認の PR-R2c）。
 *   - 出力は非 PII。fileName / 座標 / EXIF 値 / 所有者情報は出さない
 *     （RetroStripRowResult は fileName を含まない。JSONL も whitelist 整形）。
 */

import {
  processRetroStripRow,
  extractStorageKeyFromStoredFileUrl,
  RETRO_STRIP_SUPPORTED_MIMES,
  RETRO_STRIP_OUTCOMES,
  type RetroStripMode,
  type RetroStripPorts,
  type RetroStripRowInput,
  type RetroStripRowResult,
  type RetroStripOutcome,
} from "./retro-exif-strip";

// ---------------------------------------------------------------
// CLI 引数 / 安全ガード
// ---------------------------------------------------------------

export type RetroStripCliMode = "inventory" | "dry-run" | "apply";

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
 * 受理: --inventory | --dry-run | --apply（いずれか必須・排他）/ --jsonl <path> /
 *       --batch-size <n> / --limit <n> / --help。
 * 拒否: 未知フラグ / mode 未指定 / mode 重複 / 数値オプションの不正値。
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
      return `モードは1つだけ指定してください（--inventory / --dry-run / --apply は排他）`;
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
      case "--apply": {
        // PR-R2b: 実 strip（新 key 再アップロード + 楽観ガード付き repoint・新 key 補償削除）。
        // 旧 key は削除しない（rollback 窓）。本番実行は runbook の手順・別承認に従う。
        const e = setMode("apply");
        if (e) return { ok: false, error: e };
        break;
      }
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
      error: "--inventory / --dry-run / --apply のいずれかを指定してください",
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
// apply の storage backend 明示ガード（Codex P1）
// ---------------------------------------------------------------

/**
 * --apply で許可する STORAGE_BACKEND の値。
 * **src/lib/storage/index.ts の storage 取得関数の switch case と必ず一致させること**
 * （同期は cli テストの source-assertion でロック）。
 */
export const APPLY_STORAGE_BACKENDS = ["local", "server", "s3"] as const;
export type ApplyStorageBackend = (typeof APPLY_STORAGE_BACKENDS)[number];

export type ApplyStorageBackendResult =
  | { ok: true; backend: ApplyStorageBackend }
  | { ok: false; reason: string };

/**
 * --apply 実行時に STORAGE_BACKEND を明示必須にする（暗黙の local fallback を禁止）。
 *
 * storage 取得関数は `process.env.STORAGE_BACKEND ?? "local"` で未設定時に local adapter へ
 * fallback する。apply でこれを許すと「strip 画像を local disk へ upload しつつ production DB を
 * new key へ repoint」し、稼働 app（server backend 等）が new key を読めず写真が 404 化する
 * 事故が起き得る（Codex P1）。よって apply では未設定 / 空 / 未対応値を即エラーにし、
 * **storage 取得・DB repoint 前**にこの検証を完了させる（wrapper が main で呼ぶ）。
 *
 * trim しない（storage 取得関数が trim しないため。" server " 等は switch の default で throw
 * する＝reject が正）。server / s3 backend が要求する関連 env（STORAGE_SERVER_URL / STORAGE_S3_*
 * 等）は各 adapter の constructor が fail-closed で throw する（storage 取得時点＝repoint 前）。
 */
export function resolveApplyStorageBackend(
  env: Record<string, string | undefined>,
): ApplyStorageBackendResult {
  const backend = env.STORAGE_BACKEND;
  if (backend === undefined || backend === "") {
    return {
      ok: false,
      reason:
        "STORAGE_BACKEND が未設定（または空）です。--apply では暗黙の local fallback を禁止します" +
        `（稼働 app と同じ backend を明示してください。許可値: ${APPLY_STORAGE_BACKENDS.join(" / ")}）。`,
    };
  }
  if (!(APPLY_STORAGE_BACKENDS as readonly string[]).includes(backend)) {
    return {
      ok: false,
      reason: `STORAGE_BACKEND="${backend}" は --apply では未対応です（許可値: ${APPLY_STORAGE_BACKENDS.join(" / ")}）。`,
    };
  }
  return { ok: true, backend: backend as ApplyStorageBackend };
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

/** dry-run / apply 1 件分の非 PII run-log 行（JSONL の 1 オブジェクト）。 */
export interface RetroStripRunLogLine {
  photoId: string;
  outcome: RetroStripOutcome;
  /** 復元できた旧 key（path のみ。氏名/座標を含まない）。無い分岐では省略。 */
  oldKey?: string;
  /** strip 前後のバイト数（would_strip / repointed）。 */
  bytesBefore?: number;
  bytesAfter?: number;
  /** 非対応 MIME 件のための mimeType（HEIC/HEIF 等）。 */
  mimeType?: string;
  /** failed の段階とエラー名（メッセージ本文は含めない）。 */
  stage?: string;
  errorName?: string;
  /** apply で新規 upload した key（repointed / skipped_row_changed / 一部 failed）。非 PII（path のみ）。 */
  newKey?: string;
  /** repointed 時の旧 thumbnail key（cleanup フェーズ用の記録。本モジュールは削除しない）。null なら省略。 */
  oldThumbnailKey?: string;
  /** 新 key のみの補償削除が成功したか（skipped_row_changed / 非 canonical failed）。false = 新 key 孤児。 */
  compensationDeleted?: boolean;
}

/**
 * RetroStripRowResult を非 PII の JSONL 行へ整形する（whitelist 方式・防御的）。
 * fileName / newFileUrl / newThumbnailUrl / 座標などは run-log に出さない
 * （key と outcome で確認・cleanup に十分。旧 key は repointed/skip 系で記録するが、
 *  apply の失敗系でも旧 key には触れない＝新 key のみ追跡する）。
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
    case "repointed":
      // 新 key / 旧 key / バイト数（全て非 PII の path / 数値）。
      // newFileUrl / newThumbnailUrl は run-log に出さない（key で十分・冗長回避）。
      line.oldKey = result.oldKey;
      if (result.oldThumbnailKey !== null) line.oldThumbnailKey = result.oldThumbnailKey;
      line.newKey = result.newKey;
      line.bytesBefore = result.bytesBefore;
      line.bytesAfter = result.bytesAfter;
      break;
    case "skipped_row_changed":
      // 楽観ガード負け。新 key の補償削除可否も記録（false = 新 key 孤児・要 cleanup）。
      line.oldKey = result.oldKey;
      line.newKey = result.newKey;
      line.compensationDeleted = result.compensationDeleted;
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
      // apply の upload 後 / repoint 失敗時のみ存在（孤児候補の追跡用）。旧 key は決して含めない。
      if (result.newKey !== undefined) line.newKey = result.newKey;
      if (result.compensationDeleted !== undefined) {
        line.compensationDeleted = result.compensationDeleted;
      }
      break;
    // skipped_unmappable_url は photoId + outcome のみ（key 復元できていない）。
    default:
      break;
  }
  return line;
}

/** dry-run / apply 共通の集計結果。 */
export interface RetroStripRunResult {
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
      `dry-run では ${op} は実行されません（dry-run モードに書き込み導線はありません）`,
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

// ---------------------------------------------------------------
// apply ports / repoint closure（PR-R2b）。実体は wrapper が注入する（DI）。
// ---------------------------------------------------------------

/**
 * 楽観ガード付き repoint の updateMany 引数形。
 * - where に {id, fileUrl} を使い、読み取り時の fileUrl 値自体を楽観ロックにする
 *   （FieldSurveyPinPhoto に version / updatedAt 列が無いため）。
 * - data に mimeType を含めない（apply は format を保持するため mime は不変）。
 *   この型が mimeType を構造的に拒否する（混入はコンパイルエラー）。
 */
export interface RetroStripUpdateManyArgs {
  where: { id: string; fileUrl: string };
  data: { fileUrl: string; thumbnailUrl: string | null; fileSize: number };
}

/**
 * prisma の updateMany を遡及 strip の repointPhoto 契約に適合させる closure を組む。
 *
 * - 注入された updateMany（wrapper が `prisma.fieldSurveyPinPhoto.updateMany` を渡す）を、
 *   {@link RetroStripUpdateManyArgs} の固定 shape で呼ぶ。
 * - 返り値 = 更新行数（0 = 並行変更/削除＝楽観ガード負け。core が新 key を補償削除する）。
 * - 本 lib は prisma を import しない。updateMany 関数だけを受け取る（DI）。
 */
export function makeUpdateManyRepointPhoto(
  updateMany: (args: RetroStripUpdateManyArgs) => Promise<{ count: number }>,
): RetroStripPorts["repointPhoto"] {
  return async (update) => {
    const { count } = await updateMany({
      where: { id: update.id, fileUrl: update.expectedFileUrl },
      data: {
        fileUrl: update.newFileUrl,
        thumbnailUrl: update.newThumbnailUrl,
        fileSize: update.newFileSize,
      },
    });
    return count;
  };
}

/**
 * apply 用 ports を組み立てる（実 storage / repoint callback を注入するだけ）。
 *
 * 本 lib は storage adapter 取得関数 / prisma を import しない（DI）。storage 実体
 * （read/upload/delete）と repointPhoto closure（{@link makeUpdateManyRepointPhoto} 推奨）は
 * wrapper が注入する。dry-run の makeDryRunPorts と対になる関数で、apply では throw スタブを
 * 置かない（upload/delete/repoint は core が実際に呼ぶ）。
 */
export function makeApplyPorts(deps: {
  storage: RetroStripPorts["storage"];
  repointPhoto: RetroStripPorts["repointPhoto"];
  generateUuid?: RetroStripPorts["generateUuid"];
}): RetroStripPorts {
  return {
    storage: deps.storage,
    repointPhoto: deps.repointPhoto,
    generateUuid: deps.generateUuid,
  };
}

// ---------------------------------------------------------------
// runner（dry-run / apply 共有・per-row streaming 集計）
// ---------------------------------------------------------------

/**
 * 行を 1 件ずつ処理し、非 PII run-log 行を sink へ流しつつ outcome を集計する。
 * 結果配列を保持しない（per-row 逐次集計＝行ページング / JSONL 逐次書き出しと同じ streaming
 * 規律。全件処理でもヒープが行数に比例して増えない）。並行度は sequential。
 */
async function runRetroStrip(
  rows: AsyncIterable<RetroStripRowInput>,
  ports: RetroStripPorts,
  mode: RetroStripMode,
  onLine?: (line: RetroStripRunLogLine) => void | Promise<void>,
): Promise<RetroStripRunResult> {
  const summary = emptyOutcomeSummary();
  let processed = 0;
  for await (const row of rows) {
    const result = await processRetroStripRow(row, ports, { mode });
    summary[result.outcome] += 1;
    processed += 1;
    if (onLine) await onLine(toRunLogLine(result));
  }
  return { processed, summary };
}

/**
 * dry-run（storage read + strip in-memory のみ・書き込みなし）。makeDryRunPorts 推奨。
 *
 * @param rows    非同期反復可能な行ソース（wrapper が prisma ページングで供給）。
 * @param ports   dry-run ports（makeDryRunPorts 推奨＝upload/delete/repoint は throw）。
 * @param onLine  各 run-log 行の sink（JSONL ファイル追記等。省略可）。
 */
export async function runRetroStripDryRun(
  rows: AsyncIterable<RetroStripRowInput>,
  ports: RetroStripPorts,
  onLine?: (line: RetroStripRunLogLine) => void | Promise<void>,
): Promise<RetroStripRunResult> {
  return runRetroStrip(rows, ports, "dry-run", onLine);
}

/**
 * apply（新 key 再アップロード + 楽観ガード付き repoint・新 key 補償削除）。makeApplyPorts 必須。
 *
 * - 実 strip の判断・新 key 生成・canonical 検証・補償削除は core（processRetroStripRow）が完結。
 *   本 runner は dry-run と同じ streaming で回すだけ。
 * - 旧 key / 旧 thumbnail key は core が削除しない（rollback 窓・cleanup は PR-R2c）。
 * - sequential（行ごとに read→strip→upload→repoint を完結。楽観ガード〔fileUrl 値〕で並行安全）。
 */
export async function runRetroStripApply(
  rows: AsyncIterable<RetroStripRowInput>,
  ports: RetroStripPorts,
  onLine?: (line: RetroStripRunLogLine) => void | Promise<void>,
): Promise<RetroStripRunResult> {
  return runRetroStrip(rows, ports, "apply", onLine);
}

// ---------------------------------------------------------------
// apply の終了コード（純関数・テスト可能）
// ---------------------------------------------------------------

export const APPLY_EXIT_OK = 0;
export const APPLY_EXIT_FAILED = 1;
export const APPLY_EXIT_ROW_CHANGED = 2;

/**
 * apply の終了コードを決める純関数。
 *   0 = clean（failed も skipped_row_changed も無い。期待された skip〔unsupported/malformed/
 *       unmappable/missing〕は許容＝inventory/dry-run で事前レビュー済みの想定）
 *   1 = failed > 0（read/upload/repoint 例外・非 canonical key 等。要調査）
 *   2 = failed は無いが skipped_row_changed > 0（並行変更＝再実行で収束を推奨）
 * failed と skipped_row_changed が同時のときは 1（致命を優先）。
 */
export function applyExitCode(summary: Record<RetroStripOutcome, number>): number {
  if (summary.failed > 0) return APPLY_EXIT_FAILED;
  if (summary.skipped_row_changed > 0) return APPLY_EXIT_ROW_CHANGED;
  return APPLY_EXIT_OK;
}

/** help / banner 用に、空サマリ（全 outcome 0）を返す。 */
export function emptyOutcomeSummary(): Record<RetroStripOutcome, number> {
  return Object.fromEntries(
    RETRO_STRIP_OUTCOMES.map((o) => [o, 0]),
  ) as Record<RetroStripOutcome, number>;
}
