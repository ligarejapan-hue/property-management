/**
 * 既存 field-survey 写真の遡及 EXIF strip — cleanup dry-run 列挙 core（PR-R2c-i）。
 *
 * 位置づけ:
 *   docs/field-survey-retro-exif-strip-runbook.md の cleanup（旧 key / 旧 thumbnail key 削除）
 *   の **dry-run 列挙のみ**。実削除（storage 実体の delete 配線・実削除フラグ）は PR-R2c-ii。
 *   本モジュールは純関数群で、prisma / storage 実体 / process / next / node:fs を一切 import しない（DI）。
 *   実際の DB read（lookupRow）・run-log 読み込み・出力は薄い wrapper
 *   （scripts/retro-exif-strip-cleanup-field-survey.ts）が実体を注入して担当する。
 *
 * 設計（確定方針）:
 *   - 削除対象の権威ソース = apply の JSONL run-log。DB 単独では apply 後の旧 key を逆算できない
 *     （fileUrl は new key を指す）ため、apply 時に保存した run-log の repointed 行が唯一の根拠。
 *   - outcome === "repointed" 行の oldKey（常在）と 非 null oldThumbnailKey のみを候補化する。
 *     それ以外（skipped_row_changed / failed の newKey 等）は **新 key 孤児**で別スコープ。
 *     outcome を厳格 filter して取り違え（現役 new key の誤削除）を構造的に防ぐ。
 *   - 削除前の安全確認 = 現 DB 行（lookupRow）の fileUrl / thumbnailUrl がまだ候補 key を
 *     参照していないかを再確認する（手動 rollback / 未 repoint の検出）。
 *       · 現 key === 候補 key            → skipped_still_referenced（誤削除しない・fail-closed）
 *       · 現 URL から key 復元不能       → skipped_unmappable（非参照を証明できない・fail-closed）
 *       · 行が存在しない（cascade 削除） → skipped_row_missing
 *       · 候補 key が非 canonical        → skipped_invalid_key（DB を見るまでもなく skip）
 *       · 上記以外（現 key ≠ 候補 key）   → deletable（R2c-ii で削除対象）
 *   - run-log 行は逐次 parse し、壊れ行（JSON 不正 / photoId・outcome 欠落 / repointed なのに
 *     oldKey 欠落）は握りつぶさず malformed_line として fail-closed skip（誤 parse で newKey を
 *     oldKey 扱いする誤削除を防ぐ）。
 *   - per-line streaming fold（結果配列を保持しない）。出力は非 PII（key の path / 数値 / enum のみ。
 *     fileName / 座標 / 所有者情報 / newFileUrl は出さない）。
 *   - legacy absolute URL（https://host/uploads/{key}・server adapter 由来）の現 DB 再確認は
 *     extractStorageKeyFromStoredFileUrl（legacy 対応版）で行う。run-log の oldKey はそのまま
 *     信頼する（既に apply 時に canonical 化済みの key）。
 */

import { extractStorageKeyFromStoredFileUrl } from "./retro-exif-strip";
import { isValidStorageKey } from "../storage/key-validation";

// ---------------------------------------------------------------
// outcome / 型定義
// ---------------------------------------------------------------

/** cleanup dry-run の per-candidate outcome 一覧（summary 集計キーと完全一致）。 */
export const CLEANUP_DRY_RUN_OUTCOMES = [
  "deletable",
  "skipped_still_referenced",
  "skipped_unmappable",
  "skipped_row_missing",
  "skipped_invalid_key",
  "skipped_not_repointed",
  "malformed_line",
] as const;

export type CleanupDryRunOutcome = (typeof CLEANUP_DRY_RUN_OUTCOMES)[number];

export type CleanupCandidateKind = "file" | "thumbnail";

/** lookupRow が返す現 DB 行の最小形（repoint 済かの再確認用）。 */
export interface CleanupCurrentRow {
  fileUrl: string;
  thumbnailUrl: string | null;
}

/** 依存注入 ports（R2c-i は DB read のみ。storage 操作は無い＝delete は PR-R2c-ii）。 */
export interface CleanupDryRunPorts {
  /** 現在の FieldSurveyPinPhoto 行を読む。存在しなければ null。 */
  lookupRow(photoId: string): Promise<CleanupCurrentRow | null>;
}

/** cleanup dry-run の非 PII 出力行（JSONL の 1 オブジェクト）。 */
export interface CleanupDryRunLogLine {
  outcome: CleanupDryRunOutcome;
  /** 候補が属する写真（malformed_line では無い）。 */
  photoId?: string;
  /** file（本体）か thumbnail か。 */
  kind?: CleanupCandidateKind;
  /** 評価対象の旧 key（path のみ。氏名 / 座標を含まない）。 */
  candidateKey?: string;
  /** still_referenced のとき、現 DB が指す key（path のみ・デバッグ補助）。 */
  currentKey?: string;
  /** not_repointed のとき、run-log 行の元 outcome（enum 文字列・非 PII）。 */
  sourceOutcome?: string;
  /** malformed_line のとき、入力 run-log の行番号（locate 用）。 */
  lineNumber?: number;
}

/** cleanup dry-run の集計結果。 */
export interface CleanupDryRunResult {
  /** 処理した非空行数（blank 行は数えない）。 */
  lines: number;
  summary: Record<CleanupDryRunOutcome, number>;
}

/** 全 outcome を 0 で初期化した summary を返す。 */
export function emptyCleanupSummary(): Record<CleanupDryRunOutcome, number> {
  return Object.fromEntries(
    CLEANUP_DRY_RUN_OUTCOMES.map((o) => [o, 0]),
  ) as Record<CleanupDryRunOutcome, number>;
}

// ---------------------------------------------------------------
// run-log 行の parse（純関数・DB なし）
// ---------------------------------------------------------------

export interface CleanupCandidate {
  kind: CleanupCandidateKind;
  key: string;
}

/** 1 行 parse の判別 union。 */
export type ParsedCleanupLine =
  | { kind: "blank" }
  | { kind: "malformed"; lineNumber: number }
  | { kind: "not_repointed"; photoId: string; sourceOutcome: string }
  | { kind: "candidates"; photoId: string; candidates: CleanupCandidate[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/**
 * cleanup 候補 key の妥当性。isValidStorageKey に加え、`?` / `#` を含む key を弾く。
 *
 * 現 DB 側の key 抽出（extractStorageKeyFromStoredFileUrl → extractStorageKeyFromUrl）は
 * query / fragment を切り落とす。一方 isValidStorageKey は `?` / `#` を弾かないため、`?` / `#` を
 * 含む候補 key は現 key と決して一致せず、本来 skipped_still_referenced であるべき行を deletable と
 * 誤判定し得る（fail-open）。apply の canonical 検証で repointed の oldKey は `?` / `#` を含まないことが
 * 保証されるが、cleanup 側でも防御的に弾く（fail-closed・R2c-ii の実削除へ渡す候補を堅くする）。
 */
function isValidCleanupCandidateKey(key: string): boolean {
  return isValidStorageKey(key) && !key.includes("?") && !key.includes("#");
}

/**
 * apply run-log の 1 行（生 JSONL 文字列）を cleanup 候補へ parse する。
 *
 * - 空行 / 空白のみ → blank（集計対象外）。
 * - JSON 不正 / 非オブジェクト / photoId・outcome 欠落 → malformed（fail-closed）。
 * - outcome !== "repointed" → not_repointed（候補化しない・新 key 孤児等の取り違え防止）。
 * - repointed → oldKey（必須）と 非 null oldThumbnailKey を候補化。
 *   repointed なのに oldKey 欠落 / oldThumbnailKey が空・非文字列 → malformed（壊れ行を握りつぶさない）。
 */
export function parseCleanupRunLogLine(
  raw: string,
  lineNumber: number,
): ParsedCleanupLine {
  if (raw.trim() === "") return { kind: "blank" };

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: "malformed", lineNumber };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { kind: "malformed", lineNumber };
  }

  const rec = obj as Record<string, unknown>;
  const photoId = rec.photoId;
  const outcome = rec.outcome;
  if (!isNonEmptyString(photoId) || !isNonEmptyString(outcome)) {
    return { kind: "malformed", lineNumber };
  }

  if (outcome !== "repointed") {
    return { kind: "not_repointed", photoId, sourceOutcome: outcome };
  }

  const oldKey = rec.oldKey;
  if (!isNonEmptyString(oldKey)) {
    // repointed 行は必ず oldKey を持つ（apply の toRunLogLine 契約）。欠落 = 壊れ行。
    return { kind: "malformed", lineNumber };
  }
  const candidates: CleanupCandidate[] = [{ kind: "file", key: oldKey }];

  const oldThumbnailKey = rec.oldThumbnailKey;
  // null は apply の null-omit 相当（旧 thumbnail なし）として undefined と同様に扱い、file 候補は失わない。
  // それ以外で非空文字列でなければ malformed（壊れ行を握りつぶさない）。
  if (oldThumbnailKey !== undefined && oldThumbnailKey !== null) {
    if (!isNonEmptyString(oldThumbnailKey)) {
      return { kind: "malformed", lineNumber };
    }
    candidates.push({ kind: "thumbnail", key: oldThumbnailKey });
  }

  return { kind: "candidates", photoId, candidates };
}

// ---------------------------------------------------------------
// 候補 1 件の DB 再確認（純関数・row を注入）
// ---------------------------------------------------------------

/**
 * 候補 key 1 件を現 DB 行に照らして評価する（削除しない・分類のみ）。
 *
 * 順序（fail-closed）:
 *   1. 非 canonical key            → skipped_invalid_key（DB を見るまでもなく除外）
 *   2. 行が存在しない              → skipped_row_missing
 *   3. 現 URL から key 復元不能     → skipped_unmappable（非参照を証明できない）
 *   4. 現 key === 候補 key         → skipped_still_referenced（誤削除しない）
 *   5. それ以外                    → deletable（R2c-ii で削除対象）
 */
export function evaluateCleanupCandidate(
  photoId: string,
  candidate: CleanupCandidate,
  row: CleanupCurrentRow | null,
): CleanupDryRunLogLine {
  const kind = candidate.kind;
  const candidateKey = candidate.key;

  if (!isValidCleanupCandidateKey(candidateKey)) {
    return { outcome: "skipped_invalid_key", photoId, kind, candidateKey };
  }
  if (row === null) {
    return { outcome: "skipped_row_missing", photoId, kind, candidateKey };
  }

  const currentUrl = kind === "file" ? row.fileUrl : row.thumbnailUrl;
  const currentKey = extractStorageKeyFromStoredFileUrl(currentUrl);
  if (currentKey === null) {
    // thumbnailUrl が null / 現 URL が unmappable → 非参照を証明できないため fail-closed skip。
    return { outcome: "skipped_unmappable", photoId, kind, candidateKey };
  }
  if (currentKey === candidateKey) {
    // 手動 rollback / 未 repoint。現役の旧 key を削除しない。
    return { outcome: "skipped_still_referenced", photoId, kind, candidateKey, currentKey };
  }
  return { outcome: "deletable", photoId, kind, candidateKey };
}

// ---------------------------------------------------------------
// runner（per-line streaming・結果配列を保持しない）
// ---------------------------------------------------------------

/**
 * apply run-log の生 JSONL 行を 1 件ずつ評価し、非 PII 出力行を sink へ流しつつ outcome を集計する。
 * 結果配列を保持しない（per-row 逐次集計＝行ストリーム / JSONL 逐次書き出しと同じ streaming 規律）。
 * DB 再確認（lookupRow）は repointed 行ごとに 1 回（候補数に依らない）。
 */
export async function runCleanupDryRun(
  rawLines: AsyncIterable<string>,
  ports: CleanupDryRunPorts,
  onLine?: (line: CleanupDryRunLogLine) => void | Promise<void>,
): Promise<CleanupDryRunResult> {
  const summary = emptyCleanupSummary();
  let lines = 0;
  let lineNumber = 0;

  const emit = async (evaluation: CleanupDryRunLogLine): Promise<void> => {
    summary[evaluation.outcome] += 1;
    if (onLine) await onLine(evaluation);
  };

  for await (const raw of rawLines) {
    lineNumber += 1;
    const parsed = parseCleanupRunLogLine(raw, lineNumber);
    if (parsed.kind === "blank") continue;
    lines += 1;

    if (parsed.kind === "malformed") {
      await emit({ outcome: "malformed_line", lineNumber: parsed.lineNumber });
      continue;
    }
    if (parsed.kind === "not_repointed") {
      await emit({
        outcome: "skipped_not_repointed",
        photoId: parsed.photoId,
        sourceOutcome: parsed.sourceOutcome,
      });
      continue;
    }

    // candidates: DB 再確認は 1 行（写真）につき 1 回。
    const row = await ports.lookupRow(parsed.photoId);
    for (const candidate of parsed.candidates) {
      await emit(evaluateCleanupCandidate(parsed.photoId, candidate, row));
    }
  }

  return { lines, summary };
}

// ---------------------------------------------------------------
// 終了コード（純関数・テスト可能）
// ---------------------------------------------------------------

export const CLEANUP_DRY_RUN_EXIT_OK = 0;
export const CLEANUP_DRY_RUN_EXIT_MALFORMED = 1;
export const CLEANUP_DRY_RUN_EXIT_STILL_REFERENCED = 2;

/**
 * cleanup dry-run の終了コードを決める純関数。
 *   0 = clean（deletable / 期待 skip のみ）
 *   1 = malformed_line > 0（run-log 破損・最優先で要調査）
 *   2 = malformed は無いが skipped_still_referenced > 0（手動 rollback / 未 repoint の疑い・
 *       R2c-ii の実削除前に要調査）
 * malformed と still_referenced が同時のときは 1（致命を優先）。
 */
export function cleanupDryRunExitCode(
  summary: Record<CleanupDryRunOutcome, number>,
): number {
  if (summary.malformed_line > 0) return CLEANUP_DRY_RUN_EXIT_MALFORMED;
  if (summary.skipped_still_referenced > 0) return CLEANUP_DRY_RUN_EXIT_STILL_REFERENCED;
  return CLEANUP_DRY_RUN_EXIT_OK;
}

// ---------------------------------------------------------------
// CLI 引数 parse（R2c-i は dry-run 列挙のみ。--delete / --confirm は拒否）
// ---------------------------------------------------------------

export interface CleanupCliOptions {
  /** 入力 = apply の JSONL run-log パス（必須）。 */
  applyRunLogPath: string;
  /** cleanup dry-run の JSONL 出力先（任意）。 */
  outPath: string | null;
  help: boolean;
}

export type CleanupCliParseResult =
  | { ok: true; options: CleanupCliOptions }
  | { ok: false; error: string };

/**
 * argv（実行ファイル名等を除いた純粋な引数配列）を parse する。
 *
 * 受理: --apply-run-log <path>（必須）/ --out <path> / --help。
 * 拒否: 未知フラグ / --apply-run-log 未指定 / 値欠落 /
 *       --delete・--confirm（R2c-i は列挙のみ・実削除は PR-R2c-ii）。
 */
export function parseCleanupCliArgs(
  argv: readonly string[],
): CleanupCliParseResult {
  let applyRunLogPath: string | null = null;
  let outPath: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--apply-run-log": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return {
            ok: false,
            error: "--apply-run-log には入力 run-log（apply の JSONL）パスを指定してください",
          };
        }
        applyRunLogPath = value;
        i += 1;
        break;
      }
      case "--out": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return {
            ok: false,
            error: "--out には cleanup dry-run の JSONL 出力先パスを指定してください",
          };
        }
        outPath = value;
        i += 1;
        break;
      }
      case "--delete":
      case "--confirm":
        // R2c-i は cleanup dry-run 列挙のみ。実削除フラグは構造的に拒否する。
        return {
          ok: false,
          error: `${arg} は cleanup dry-run（PR-R2c-i）では使用できません（実削除の配線は PR-R2c-ii）。`,
        };
      default:
        return { ok: false, error: `未知のオプション: ${arg}` };
    }
  }

  if (help) {
    return {
      ok: true,
      options: { applyRunLogPath: applyRunLogPath ?? "", outPath, help: true },
    };
  }
  if (applyRunLogPath === null) {
    return {
      ok: false,
      error: "--apply-run-log（apply の JSONL run-log）を指定してください",
    };
  }
  return { ok: true, options: { applyRunLogPath, outPath, help: false } };
}
