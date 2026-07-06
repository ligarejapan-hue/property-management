import { localizeOccupancy } from "@/lib/property-types";

/**
 * 物件の現況(occupancyStatus: vacant/occupied/unknown 等)を、売マンションの
 * 現況(occupancy)フィールドの選択肢語彙（MANSION_FIELDS/option-master.OCCUPANCY =
 * 居住中/空家/賃貸中/未完成）へ決定的に写像する単一のソース。
 *
 * 作成ダイアログ（SalesSheetCreateButton.tsx・自動反映プレビューの初期選択ヒント）と
 * 図面ビルダー（build-document.ts の buildMansionValues・override 未指定時のデフォルト）
 * の両方がこの1関数だけを参照する。以前はダイアログ側
 * （vacant→"空家"/occupied→"居住中"）とビルダー側
 * （localizeOccupancy・vacant→"空室"/occupied→"入居中"）で語彙の異なる写像が重複しており、
 * 作成ダイアログのフェッチが submit に間に合うか否かというタイミングだけで、同じ物件から
 * 異なる「現況」テキストが生成されてしまう不具合があった（@codex P2 review）。
 * 本関数へ一本化し、フェッチの成否・タイミングに関わらず常に同じ現況が決定されることを
 * 保証する。
 *
 * - vacant → "空家" / occupied → "居住中"
 *   （occupied は「居住中」と「賃貸中」を区別できないため、より一般的な自己居住側の
 *   語彙に寄せる。誤りであれば作成ダイアログで手動選択し直せる）。
 * - 上記2値以外（unknown・null・undefined・未知の値）→ 選択肢語彙でカバーしないため、
 *   既存の localizeOccupancy と同じ日本語ラベルへフォールバックする（空欄にはしない＝
 *   ビルダーは常に何らかの現況値を出す既存慣例を維持。決定的・タイミング非依存で
 *   あることは変わらない）。
 */
export function mapOccupancyStatusToMansionOccupancy(
  status: string | null | undefined,
): string | undefined {
  if (status === "vacant") return "空家";
  if (status === "occupied") return "居住中";
  return localizeOccupancy(status) ?? undefined;
}

/**
 * 物件の現況(occupancyStatus)を、売土地の現況(occupancy)フィールドの選択肢語彙
 * （field-model.LAND_FIELDS / option-master.OCCUPANCY_LAND = 更地/上物有）へ決定的に
 * 写像する単一のソース（[F2-A Task3]）。理由は mapOccupancyStatusToMansionOccupancy と同じ:
 * 作成ダイアログの自動反映プレビューと図面ビルダー（build-document.ts の
 * buildLandValues・override 未指定時のデフォルト）が同じ関数を参照することで、
 * フェッチの成否・タイミングに関わらず常に同じ現況が決定されることを保証する。
 *
 * - vacant → "更地" / occupied → "上物有"
 * - 上記2値以外（unknown・null・undefined・未知の値）→ undefined（手動選択に委ねる）。
 *   マンション版と異なり localizeOccupancy へはフォールバックしない: 土地の現況語彙
 *   (更地/上物有)は一般の入居状況語彙（空室/入居中 等）と意味がずれるため、無理に
 *   丸めず空欄のままにする方が安全（プランの確定仕様どおり）。
 */
export function mapOccupancyStatusToLandOccupancy(
  status: string | null | undefined,
): string | undefined {
  if (status === "vacant") return "更地";
  if (status === "occupied") return "上物有";
  return undefined;
}
