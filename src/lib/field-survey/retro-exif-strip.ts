/**
 * 既存 field-survey 写真の遡及 EXIF/GPS strip — batch core（per-row 純関数）。
 *
 * 位置づけ（PR-R1）:
 *   docs/field-survey-photo-privacy-checklist.md §6「既存アップロード済み画像の
 *   遡及 strip（別タスク・別承認）」の処理ロジック部分。CLI / 実行手順 / cleanup は
 *   本モジュールに含めない（PR-R2 以降・別承認）。本モジュールは production の
 *   どの route からも import されない（実行導線はまだ存在しない）。
 *
 * 方式 = 「新 key 再アップロード + DB repoint」（同一 key の in-place 上書きは不採用）:
 *   - /uploads の ETag は key 由来（uploads-etag.ts）のため、同一 key のバイト差し替えは
 *     キャッシュ済みクライアントに旧バイト（GPS 入り）を 304 で返し続ける。
 *     uploads-etag.ts の注意書きどおり「新しい key で再アップロード」する。
 *   - server backend の同一 key 上書きセマンティクスはリポジトリから検証できない。
 *     新 key + repoint なら DB ポインタ切替で完了が検証可能。
 *   - 旧 key / 旧 thumbnail key は本モジュールでは**絶対に削除しない**
 *     （rollback 窓として保持。cleanup は別承認の別フェーズ）。
 *     storage.delete を呼ぶのは「repoint 楽観ガード負け時の新 key 補償削除」のみ。
 *
 * skip ポリシー（確定方針）:
 *   - HEIC/HEIF ほか未対応 MIME → skipped_unsupported_mime（変換しない・触らない）
 *   - 構造不正（malformed） → skipped_malformed（削除・上書きを絶対にしない）
 *   - fileUrl から key を復元できない行（絶対 URL 等） → skipped_unmappable_url
 *   - storage 実体なし → skipped_missing_bytes
 *
 * 依存注入（DI）:
 *   prisma / storage 実体（adapter 取得関数）/ next を import しない。
 *   storage 操作と DB repoint は ports 経由で受け取る。これにより本番 DB /
 *   本番 storage に触れずに合成 fixture だけで全分岐を単体テストできる。
 *
 * 非 PII 規律:
 *   返却 record には fileName・座標・エラーメッセージ本文を含めない
 *   （photoId / pinId 由来 key / バイト数 / outcome / エラー名のみ）。
 *   fileName は storage.upload のメタデータとして透過するだけで結果には出さない。
 */

import { randomUUID } from "node:crypto";
import { stripFieldSurveyPhotoMetadata } from "./exif-strip";
import { extractStorageKeyFromUrl } from "../storage/url-to-key";
import { isValidStorageKey } from "../storage/key-validation";
import { normalizeFileUrl } from "../url-normalize";
import type { StorageAdapter } from "../storage/types";

// ---------------------------------------------------------------
// outcome / 型定義
// ---------------------------------------------------------------

/** per-row 処理の outcome 一覧（summarize の集計キーと完全一致）。 */
export const RETRO_STRIP_OUTCOMES = [
  "repointed",
  "unchanged",
  "would_strip",
  "skipped_unsupported_mime",
  "skipped_malformed",
  "skipped_unmappable_url",
  "skipped_missing_bytes",
  "skipped_row_changed",
  "failed",
] as const;

export type RetroStripOutcome = (typeof RETRO_STRIP_OUTCOMES)[number];

export type RetroStripMode = "dry-run" | "apply";

export type RetroStripFailStage = "read" | "upload" | "repoint";

// 新 key の拡張子は MIME から決める（route の MIME_TO_EXT と同方針）。
// exif-strip が strip 可能な形式と一致。HEIC/HEIF は対象外（skip+flag 方針）。
const RETRO_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * 遡及 strip が処理できる MIME。RETRO_MIME_TO_EXT のキーから導出する
 * （2 定数の手動同期をなくし、supported なのに拡張子未定義という状態を構造的に排除）。
 */
export const RETRO_STRIP_SUPPORTED_MIMES: ReadonlySet<string> = new Set(
  Object.keys(RETRO_MIME_TO_EXT),
);

/** 処理対象 1 行分の入力（FieldSurveyPinPhoto の必要列のみ）。 */
export interface RetroStripRowInput {
  /** FieldSurveyPinPhoto.id */
  id: string;
  pinId: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  /** storage.upload メタデータへの透過用。結果 record には一切含めない。 */
  fileName: string;
  mimeType: string;
}

/** repoint（楽観ガード付き DB 更新）への入力。 */
export interface RetroStripRepointUpdate {
  id: string;
  /**
   * 楽観ガード: 読み取り時点の fileUrl。実装側（PR-R2）は
   * updateMany({ where: { id, fileUrl: expectedFileUrl }, data: ... }) の
   * count を返す想定。0 = 並行変更/削除済み（その場合 caller が新 key を補償削除）。
   */
  expectedFileUrl: string;
  newFileUrl: string;
  newThumbnailUrl: string | null;
  /** strip 後バイト長（route の fileSize = strip 後 buffer 長と同じ規約）。 */
  newFileSize: number;
}

/** 依存注入 ports。本モジュールは実 adapter / 実 DB を一切 import しない。 */
export interface RetroStripPorts {
  storage: Pick<StorageAdapter, "read" | "upload" | "delete">;
  /** 楽観ガード付き repoint。更新行数を返す（0 = ガード負け）。 */
  repointPhoto(update: RetroStripRepointUpdate): Promise<number>;
  /** 新 key 用 UUID 生成。テスト決定性のため注入可。省略時 randomUUID。 */
  generateUuid?: () => string;
}

/** per-row 処理結果（判別 union）。fileName / 座標 / エラー本文は含めない。 */
export type RetroStripRowResult =
  | { outcome: "unchanged"; photoId: string; oldKey: string }
  | {
      outcome: "would_strip";
      photoId: string;
      oldKey: string;
      bytesBefore: number;
      bytesAfter: number;
    }
  | {
      outcome: "repointed";
      photoId: string;
      oldKey: string;
      /** 旧 thumbnail の key（cleanup フェーズ用の記録。本モジュールでは削除しない）。 */
      oldThumbnailKey: string | null;
      newKey: string;
      newFileUrl: string;
      newThumbnailUrl: string | null;
      bytesBefore: number;
      bytesAfter: number;
    }
  | { outcome: "skipped_unsupported_mime"; photoId: string; mimeType: string }
  | { outcome: "skipped_malformed"; photoId: string; oldKey: string }
  | { outcome: "skipped_unmappable_url"; photoId: string }
  | { outcome: "skipped_missing_bytes"; photoId: string; oldKey: string }
  | {
      outcome: "skipped_row_changed";
      photoId: string;
      oldKey: string;
      newKey: string;
      /** 補償削除（新 key）が成功したか。false = 新 key が孤児として残存（要 cleanup）。 */
      compensationDeleted: boolean;
    }
  | {
      outcome: "failed";
      photoId: string;
      stage: RetroStripFailStage;
      /** Error.name のみ（メッセージ本文は PII 混入リスクがあるため記録しない）。 */
      errorName: string;
      /** upload 後に失敗した場合の新 key（孤児候補の記録）。旧 key は決して含めない。 */
      newKey?: string;
      /**
       * 非 canonical な新 key を補償削除できたか（upload 段の non-canonical 失敗時のみ設定）。
       * false = 新 key 孤児が残存し得る（cleanup 対象）。旧 key は常に不可侵。
       */
      compensationDeleted?: boolean;
    };

// ---------------------------------------------------------------
// 内部 helper（route の URL 正規化セマンティクスと同一）
// ---------------------------------------------------------------

// storage key を app proxy 経由の相対 URL にする（field-survey photos route と同方針）。
function toUploadProxyUrl(key: string): string {
  const clean = String(key)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  return `/uploads/${clean}`;
}

// thumbnail は proxy 相対 (/uploads/...) に正規化できる場合のみ保持（route と同方針）。
function toProxyThumbnailUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const normalized = normalizeFileUrl(raw);
  return normalized.startsWith("/uploads/") ? normalized : null;
}

// エラーは name のみ記録する（message は path / fileName 等を含み得るため）。
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------
// per-row 処理本体
// ---------------------------------------------------------------

/**
 * FieldSurveyPinPhoto 1 行分の遡及 strip 処理。
 *
 * フロー:
 *   1. fileUrl → 旧 key 復元（不能 = skipped_unmappable_url・storage に触れない）
 *   2. 未対応 MIME は read 前に skip（HEIC/HEIF の無駄読みをしない）
 *   3. storage.read（null = skipped_missing_bytes）
 *   4. stripFieldSurveyPhotoMetadata（malformed = skipped_malformed）
 *   5. changed=false → unchanged（書き込みなし。再実行時の冪等 skip）
 *   6. dry-run → would_strip（upload / repoint / delete を一切呼ばない）
 *   7. apply → 新 key（route と同形式）で upload → 楽観ガード付き repoint
 *      - ガード負け（count=0）→ 新 key を補償削除して skipped_row_changed
 *      - 旧 key / 旧 thumbnail key はどの分岐でも削除しない（rollback 窓）
 */
export async function processRetroStripRow(
  row: RetroStripRowInput,
  ports: RetroStripPorts,
  options: { mode: RetroStripMode },
): Promise<RetroStripRowResult> {
  const photoId = row.id;

  // 1. 旧 key 復元。絶対 URL / 非 /uploads/ / traversal は null（= 触らず skip）。
  const oldKey = extractStorageKeyFromUrl(row.fileUrl);
  if (oldKey === null) {
    return { outcome: "skipped_unmappable_url", photoId };
  }

  // 2. 未対応 MIME は read 前に確定 skip（strip 側でも同判定だが IO を節約する）。
  const mime = row.mimeType.toLowerCase();
  if (!RETRO_STRIP_SUPPORTED_MIMES.has(mime)) {
    return {
      outcome: "skipped_unsupported_mime",
      photoId,
      mimeType: row.mimeType,
    };
  }

  // 3. 実体読み取り。
  let read;
  try {
    read = await ports.storage.read(oldKey);
  } catch (error) {
    return { outcome: "failed", photoId, stage: "read", errorName: errorNameOf(error) };
  }
  if (read === null) {
    return { outcome: "skipped_missing_bytes", photoId, oldKey };
  }

  // 4. strip（pure utility 再利用）。DB mimeType と実バイトの不一致は
  //    parser が malformed に倒す（誤 MIME のバイトを書き換えない）。
  const stripResult = stripFieldSurveyPhotoMetadata(read.body, mime);
  if (!stripResult.ok) {
    if (stripResult.reason === "unsupported_mime") {
      // 2 で除外済みのため通常到達しないが、防御的に同じ skip に倒す。
      return {
        outcome: "skipped_unsupported_mime",
        photoId,
        mimeType: row.mimeType,
      };
    }
    return { outcome: "skipped_malformed", photoId, oldKey };
  }

  // 5. 既に clean（= 再実行時の冪等 skip）。書き込みを発生させない。
  if (!stripResult.changed) {
    return { outcome: "unchanged", photoId, oldKey };
  }

  const bytesBefore = read.body.length;
  const bytesAfter = stripResult.buffer.length;

  // 6. dry-run はここで終了（upload / repoint / delete を呼ばない）。
  if (options.mode === "dry-run") {
    return { outcome: "would_strip", photoId, oldKey, bytesBefore, bytesAfter };
  }

  // 7. apply: 新 key で upload → 楽観ガード付き repoint。
  //    key 形式は field-survey photos route と同一
  //    （`field-survey/pins/{pinId}/photos/{uuid}.{ext}`・拡張子は MIME 由来）。
  const uuid = (ports.generateUuid ?? randomUUID)();
  const ext = RETRO_MIME_TO_EXT[mime];
  const requestedKey = `field-survey/pins/${row.pinId}/photos/${uuid}.${ext}`;

  let uploaded;
  try {
    uploaded = await ports.storage.upload(stripResult.buffer, {
      key: requestedKey,
      mimeType: row.mimeType,
      fileName: row.fileName,
    });
  } catch (error) {
    return { outcome: "failed", photoId, stage: "upload", errorName: errorNameOf(error) };
  }

  // backend が返した key（uploaded.key）をそのまま採用する前に検証する。
  // newFileUrl は DB に保存する値、roundTripKey は「その URL から復元される key」。
  // 注意: toUploadProxyUrl は backslash / 連続スラッシュ / 先頭スラッシュを正規化するため、
  // 非正規 key でも newFileUrl だけ見ると正常に見えてしまう（= Codex P2 指摘）。
  // よって uploaded.key 自体が canonical（= round-trip で同一）であることを要求する。
  const newKey = uploaded.key;
  const newFileUrl = toUploadProxyUrl(newKey);
  const roundTripKey = extractStorageKeyFromUrl(newFileUrl);

  // 防御 1（最優先）: 返却 key が（非正規スペルでも）旧 key を指す = key 未回転。
  // in-place 上書きの疑いがあり、補償削除が唯一の実体（旧 key）に到達し得るため
  // fail-closed。旧 key には絶対に触れない（delete しない）。
  if (roundTripKey !== null && roundTripKey === oldKey) {
    return {
      outcome: "failed",
      photoId,
      stage: "upload",
      errorName: "UploadKeyNotRotated",
      newKey,
    };
  }

  // 防御 2: canonical key 要求。uploaded.key === extractStorageKeyFromUrl(その proxy URL)
  // でなければ「DB 保存 URL（正規化後）」と「storage 実体 key（非正規のまま）」が食い違い、
  // 写真参照や将来の cleanup 対象がズレる。該当ケース:
  //   - roundTripKey === null : traversal / 空（そもそも proxy URL にできない）
  //   - roundTripKey !== newKey: backslash / 連続スラッシュ / 先頭スラッシュ / '?' '#' 混入
  // いずれも repoint しない。新 key は「安全に delete できる形（isValidStorageKey）」の
  // ときのみ補償削除を試みる（旧 key には決して触れない・失敗は swallow し孤児として記録）。
  if (roundTripKey === null || roundTripKey !== newKey) {
    let compensationDeleted = false;
    // isValidStorageKey が false の key（backslash / 連続スラッシュ / 先頭スラッシュ /
    // traversal / 空）は delete に渡しても adapter が弾くだけなので試みない
    // （旧データ破壊を最優先で避ける）。'?' '#' 混入のような「構造的には有効だが
    // 非 canonical」な key のみ、その実体（新規 upload 分）を補償削除する。
    if (isValidStorageKey(newKey)) {
      try {
        await ports.storage.delete(newKey);
        compensationDeleted = true;
      } catch {
        // 補償削除失敗は致命にしない（新 key 孤児は非配信・cleanup 対象として記録）。
      }
    }
    return {
      outcome: "failed",
      photoId,
      stage: "upload",
      errorName:
        roundTripKey === null
          ? "InvalidUploadResultKey"
          : "NonCanonicalUploadResultKey",
      newKey,
      compensationDeleted,
    };
  }

  // ここに到達 = roundTripKey === newKey（canonical）かつ ≠ oldKey。
  // newFileUrl === `/uploads/${newKey}` で DB 保存値と storage 実体が一致する。
  const newThumbnailUrl = toProxyThumbnailUrl(uploaded.thumbnailUrl);

  let repointedCount: number;
  try {
    repointedCount = await ports.repointPhoto({
      id: photoId,
      expectedFileUrl: row.fileUrl,
      newFileUrl,
      newThumbnailUrl,
      newFileSize: bytesAfter,
    });
  } catch (error) {
    // DB 状態が不明（更新済みか否か判別不能）のため補償削除はしない。
    // 新 key を記録して cleanup フェーズ（別承認）の判断材料にする。
    return {
      outcome: "failed",
      photoId,
      stage: "repoint",
      errorName: errorNameOf(error),
      newKey,
    };
  }

  if (repointedCount === 0) {
    // 楽観ガード負け = 行が並行で削除/変更された。新 key のみ補償削除する
    // （旧 key には触れない）。削除失敗は swallow し、孤児として記録する。
    let compensationDeleted = false;
    try {
      await ports.storage.delete(newKey);
      compensationDeleted = true;
    } catch {
      // 補償削除失敗は致命にしない（新 key 孤児は非配信・cleanup 対象として記録）。
    }
    return {
      outcome: "skipped_row_changed",
      photoId,
      oldKey,
      newKey,
      compensationDeleted,
    };
  }

  // 旧 thumbnail key は cleanup フェーズ用に記録だけする（削除しない）。
  const oldThumbnailKey = extractStorageKeyFromUrl(row.thumbnailUrl);

  return {
    outcome: "repointed",
    photoId,
    oldKey,
    oldThumbnailKey,
    newKey,
    newFileUrl,
    newThumbnailUrl,
    bytesBefore,
    bytesAfter,
  };
}

// ---------------------------------------------------------------
// 集計 helper
// ---------------------------------------------------------------

/** outcome ごとの件数集計（PR-R2 の dry-run レポート / サマリ AuditLog detail 用の形）。 */
export function summarizeRetroStripResults(
  results: readonly RetroStripRowResult[],
): Record<RetroStripOutcome, number> {
  const summary = Object.fromEntries(
    RETRO_STRIP_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<RetroStripOutcome, number>;
  for (const result of results) {
    summary[result.outcome] += 1;
  }
  return summary;
}
