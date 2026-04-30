/**
 * 取込エラー / レビュー理由の分類ヘルパ。
 *
 * 既存の errorMessage は実装ごとにフォーマットが微妙に違うフリーテキスト
 * （「住所が空です」「氏名が空です」「重複の可能性[住所一致]:...」など）。
 * これらを一旦 `ImportErrorType` enum と「対象列名」「修正ヒント」に
 * 落とし込んで、UI 側で「分類アイコン / 列ハイライト / 修正手順」を
 * 一貫して出せるようにする。
 *
 * ★ 段階A: スキーマ・API・既存 errorMessage は触らない。
 *   このファイルは表示専用ユーティリティ。
 */

import {
  isUpdateMessage,
  isDuplicateMessage,
  extractDuplicateReason,
  extractUpdateReason,
} from "./import-row-display";

export type ImportErrorType =
  // 必須項目が空（住所空、氏名空 など）
  | "empty"
  // 重複検知（needs_review 行）
  | "duplicate"
  // 業務的なレビュー保留（受付帳×所有者の owner_unmatched / property_not_found 等）
  | "review"
  // 既存レコード更新（success 行・通常 UI では表示対象外だが分類は持つ）
  | "update"
  // 棟が未登録 / 候補複数（CSVの buildingName 解決失敗）
  | "building_not_found"
  // 上記いずれにも当てはまらない・catch ブロック由来 (Prisma 例外等)
  | "unknown";

export interface ClassifiedImportError {
  /** 大見出し用ラベル。例: "住所が未入力" "重複の可能性あり" */
  label: string;
  /**
   * rawData の該当キー（原因列）。
   * - rawData が渡されていれば「シノニム検索」で実際に存在するキー名を返す
   *   （例: rawData が "所在地" でも、住所空エラーなら "所在地" を返す）。
   * - 該当キーが特定できないときは null。UI 側はこの値が rawData の key と
   *   一致するセルだけハイライトすればよい。
   */
  field: string | null;
  type: ImportErrorType;
  /** 修正方法のヒント。現場が次にやることを 1 文で。 */
  hint: string;
}

/**
 * canonical な「項目名」→ rawData 上で使われ得るキー候補。
 * AUTO_MAP / OWNER_HEADER_TO_FIELD 等を踏まえた最低限のシノニム集合。
 * 厳密一致はしない（CSV ヘッダの揺れに対応するため）。
 */
const FIELD_SYNONYMS: Record<string, readonly string[]> = {
  住所: ["住所", "所在地", "物件住所", "address"],
  氏名: ["氏名", "名前", "所有者名", "name", "owner_name"],
  棟名: ["棟名", "建物名", "マンション名", "building_name", "building"],
};

/**
 * canonical 項目名から rawData の実際のキー名を解決する。
 * 該当キーが rawData に無い場合は canonical 名そのものを返す（表示用ラベル代わり）。
 * rawData が null の場合は canonical 名を返す。
 */
function resolveRawDataKey(
  canonical: string,
  rawData: Record<string, unknown> | null | undefined,
): string {
  if (!rawData) return canonical;
  const synonyms = FIELD_SYNONYMS[canonical] ?? [canonical];
  for (const key of synonyms) {
    if (Object.prototype.hasOwnProperty.call(rawData, key)) return key;
  }
  return canonical;
}

/**
 * errorMessage と rawData から分類済みエラーを返す。
 *
 * @param errorMessage ImportJobRow.errorMessage（null OK）
 * @param rawData ImportJobRow.rawData（null OK）。シノニム解決と
 *                列ハイライトのキー特定に使う。
 */
export function classifyImportError(
  errorMessage: string | null | undefined,
  rawData: Record<string, unknown> | null | undefined,
): ClassifiedImportError {
  const msg = errorMessage ?? "";

  // ---- 空必須項目 ----
  if (msg === "住所が空です") {
    return {
      label: "住所が未入力",
      field: resolveRawDataKey("住所", rawData),
      type: "empty",
      hint: "対象列に住所を入力してリトライしてください。",
    };
  }
  if (msg === "氏名が空です") {
    return {
      label: "氏名が未入力",
      field: resolveRawDataKey("氏名", rawData),
      type: "empty",
      hint: "対象列に氏名を入力してリトライしてください。",
    };
  }

  // ---- 棟未解決（CSV 物件取込で buildingName が見つからない／候補が複数）----
  // resolution.error フォールバック文言を含む
  if (
    msg.startsWith("棟名が見つかりません") ||
    msg.includes("棟が複数見つかりました") ||
    msg.includes("棟候補")
  ) {
    return {
      label: "棟が特定できません",
      field: resolveRawDataKey("棟名", rawData),
      type: "building_not_found",
      hint:
        "下の棟候補から正しい棟を選ぶか、先に棟マスタを登録してください。",
    };
  }

  // ---- 更新確定（success 行の表示用に分類は持つ。UI は別経路）----
  if (isUpdateMessage(msg)) {
    return {
      label: "既存レコードを更新しました",
      field: null,
      type: "update",
      hint:
        "更新項目を確認してください。誤りがある場合は物件詳細から個別に修正できます。",
    };
  }

  // ---- 重複検知（property_csv / owner_csv 共通）----
  if (isDuplicateMessage(msg)) {
    const reason = extractDuplicateReason(msg);
    return {
      label: reason ? `重複の可能性（${reason}）` : "重複の可能性",
      field: null,
      type: "duplicate",
      hint:
        "既存レコードと紐付ける場合は「既存に紐付け」、別物として扱う場合は「新規作成」、判断保留は「スキップ」を選んでください。",
    };
  }

  // ---- 受付帳×所有者のレビュー理由（reception-owner ルート）----
  if (msg === "要レビュー（所有者未突合）") {
    return {
      label: "所有者が未突合",
      field: null,
      type: "review",
      hint:
        "所有者CSV（C列のキー）に同じキーの行があるかを確認してください。物件側は特定できています。",
    };
  }
  if (msg === "要レビュー（物件未特定）") {
    return {
      label: "物件が未特定",
      field: null,
      type: "review",
      hint:
        "該当する物件が DB に存在しません。物件一覧で先に登録するか、地番／家屋番号を見直してください。",
    };
  }
  if (msg === "要レビュー（複数候補）") {
    return {
      label: "物件候補が複数",
      field: null,
      type: "review",
      hint: "正しい物件を選択して個別に紐付けてください。",
    };
  }
  if (msg === "要レビュー（キー不足）") {
    return {
      label: "突合キーが不足",
      field: null,
      type: "review",
      hint:
        "受付帳CSVのF列（区分）とK列を確認してください。地番／家屋番号が空のため特定できません。",
    };
  }

  // ---- 旧フォールバック ----
  if (msg === "想定外の状態") {
    return {
      label: "想定外の状態",
      field: null,
      type: "unknown",
      hint:
        "プレビューで条件を再確認してください。再現する場合は管理者に連絡してください。",
    };
  }

  // ---- catch ブロック由来（Prisma 例外など）----
  if (!msg || msg === "不明なエラー") {
    return {
      label: "不明なエラー",
      field: null,
      type: "unknown",
      hint:
        "原データを修正してリトライしてください。解消しない場合は元のメッセージを管理者に共有してください。",
    };
  }

  // ---- それ以外（フリーテキストの err.message 等）----
  return {
    label: "取込エラー",
    field: null,
    type: "unknown",
    hint:
      "下の原データを編集してリトライするか、スキップしてください。詳細は元のメッセージを参照。",
  };
}
