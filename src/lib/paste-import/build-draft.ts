/**
 * 段2〜4を通して下書きを組み立てる。純関数。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { parseLabeledLines, isBlankValue, type LabeledLine } from "./parse-labeled-lines";
import {
  toHalfWidth,
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
  type YearBoundOptions,
} from "./normalize";
import { fieldKeyForLabel, type DraftFieldKey } from "./label-dictionary";
import { propertyTypeForRaw } from "./property-type-dictionary";
import {
  detectSourceProfile,
  splitBuildingAndRoom,
  SOURCE_PROFILE_LABELS,
} from "./source-profiles";
import type { DraftField, DraftWarning, PasteDraft } from "./types";

const EMPTY: DraftField = { value: null, sourceLabel: null };
const field = (value: string | null, sourceLabel: string): DraftField =>
  value === null ? EMPTY : { value, sourceLabel };

/** 現況の言い換え → OccupancyStatus。分からなければ null（unknown を推測で入れない）。 */
function occupancyFor(raw: string): string | null {
  const s = raw.replace(/[\s　]/g, "");
  if (s.includes("居住中") || s.includes("入居中") || s.includes("賃貸中")) return "occupied";
  if (s.includes("空室") || s.includes("空家") || s.includes("空き家")) return "vacant";
  return null;
}

/**
 * 外部キーの表記ゆれを畳む。**新しい正規化規則は作らない**:
 * 既存の toHalfWidth（全角英数→半角・全角ハイフン類→"-"）と前後の空白除去だけ。
 * 空になったら null（「無い」と同じに畳む）。
 */
function normalizeExternalLinkKey(raw: string | null): string | null {
  if (raw === null) return null;
  const v = toHalfWidth(raw).trim();
  return v === "" ? null : v;
}

/**
 * ⚠**時計を読むのは API 層（境界）だけ**。ここは上限を引数で受け取るだけで、
 *   同じ入力には同じ結果を返す（テストは固定値を渡す）。
 */
export function buildPasteDraft(text: string, options?: YearBoundOptions): PasteDraft {
  const { labeled, unlabeled } = parseLabeledLines(text);
  const warnings: DraftWarning[] = [];

  // 見出しごとの最初の値だけを採る（同じ見出しが2回出たら先勝ち）。
  const picked = new Map<DraftFieldKey, LabeledLine>();
  const unmapped: { label: string; value: string }[] = [];

  for (const line of labeled) {
    if (isBlankValue(line.value)) continue; // 値なしは拾わない
    const key = fieldKeyForLabel(line.label);
    if (key === null) {
      unmapped.push({ label: line.label, value: line.value });
      continue;
    }
    if (!picked.has(key)) picked.set(key, line);
  }

  // 見出しが1つも読み取れなかったときは、その1件だけを警告する。
  // 「そもそも何も読み取れていない」のに「住所が無い」「地番が無い」まで
  // 並ぶと利用者が誤解するため（address_missing / lot_number_missing を抑制）。
  const noLabeledLines = labeled.length === 0;
  if (noLabeledLines) {
    warnings.push({
      code: "no_labeled_lines",
      message:
        "読み取れる項目がありませんでした。「項目名：値」の形で書かれた文章を貼り付けてください。",
    });
  }

  const sourceProfile = detectSourceProfile(labeled.map((l) => l.label));

  const raw = (key: DraftFieldKey): string | null => picked.get(key)?.value ?? null;
  const label = (key: DraftFieldKey): string => picked.get(key)?.label ?? "";

  // ---- 住所・地番・建物名・部屋番号 ----
  const addressRaw = raw("address");
  const buildingName = raw("buildingName");
  let address: string | null = null;
  let lotNumber: string | null = raw("lotNumber");
  let roomNo: string | null = null;

  if (addressRaw !== null) {
    const split = splitLotNumberFromAddress(addressRaw);
    address = split.address;
    if (lotNumber === null) lotNumber = split.lotNumber;
    const room = splitBuildingAndRoom(address, buildingName);
    address = room.address;
    roomNo = room.roomNo;
  }

  if (address === null && !noLabeledLines) {
    warnings.push({
      code: "address_missing",
      message: "住所を読み取れませんでした。手で入力してください。",
    });
  }
  if (lotNumber === null && !noLabeledLines) {
    warnings.push({
      code: "lot_number_missing",
      message:
        "地番がありません。このままでは謄本を取得できません。地番検索サービスで調べて入力してください。",
    });
  }

  // ---- 物件種別 ----
  const typeRaw = raw("propertyTypeRaw");
  const mappedType = typeRaw === null ? null : propertyTypeForRaw(typeRaw);
  if (mappedType !== null && !mappedType.confident) {
    warnings.push({
      code: "property_type_unknown",
      message: `物件種別「${typeRaw}」を判別できませんでした。選び直してください。`,
    });
  }

  // ---- 所有者（氏名があるときだけ作る） ----
  const ownerName = raw("ownerName");
  const owner = ownerName === null
    ? null
    : {
        name: field(ownerName, label("ownerName")),
        nameKana: field(raw("ownerNameKana"), label("ownerNameKana")),
        phone: field(raw("ownerPhone"), label("ownerPhone")),
        email: field(raw("ownerEmail"), label("ownerEmail")),
        currentAddress: field(raw("ownerAddress"), label("ownerAddress")),
      };

  const builtYearRaw = raw("builtYearRaw");
  const builtYear = builtYearRaw === null ? null : warekiToSeireki(builtYearRaw, options);
  const areaRaw = raw("exclusiveArea");
  const area = areaRaw === null ? null : parseAreaSqm(areaRaw);
  const landAreaRaw = raw("landArea");
  const landArea = landAreaRaw === null ? null : parseAreaSqm(landAreaRaw);
  const occRaw = raw("occupancyRaw");

  return {
    sourceProfile,
    sourceProfileLabel: SOURCE_PROFILE_LABELS[sourceProfile],
    property: {
      address: field(address, label("address")),
      lotNumber: field(lotNumber, label("lotNumber") || label("address")),
      buildingName: field(buildingName, label("buildingName")),
      roomNo: field(roomNo, label("address")),
      propertyType: field(mappedType?.value ?? null, label("propertyTypeRaw")),
      exclusiveArea: field(area === null ? null : String(area), label("exclusiveArea")),
      landArea: field(landArea === null ? null : String(landArea), label("landArea")),
      layoutType: field(raw("layoutType"), label("layoutType")),
      occupancyStatus: field(
        occRaw === null ? null : occupancyFor(occRaw),
        label("occupancyRaw"),
      ),
      builtYear: field(builtYear === null ? null : String(builtYear), label("builtYearRaw")),
    },
    owner,
    // ⚠外部キー(査定ナンバー)は**この入口で1回だけ**正規化し、以降は
    //   「保存する値 == 検索する値 == 助言ロックの鍵」を常に同じ文字列で通す
    //   (@codex PR#414 の指摘 → 発注者判断 2026-08-26)。
    //   ⚠いちばん重要な理由は**ロック**: 助言ロックの鍵が比較に使う鍵と
    //   一致していなければ、鍵がずれた瞬間に直列化が外れ、二重登録のガードが
    //   静かに無効になる。ロックと比較は同じ値でなければ意味がない。
    //   正規化は既存の toHalfWidth + 前後の空白除去だけ(新しい正規化は増やさない)。
    //   査定ナンバーは元々半角ASCIIなので、実際に保存される文字列は変わらない。
    externalLinkKey: normalizeExternalLinkKey(raw("externalLinkKey")),
    warnings,
    unmapped,
    // ⚠割れなかった行も捨てずに持つ（設計書 §4.2）。全体レビュー I-5:
    //   parseLabeledLines は unlabeled を返していたのに、ここで labeled しか
    //   受け取っておらず、下書きに乗る前に消えていた。
    unlabeled,
    noteFromUnmapped: unmapped.map((u) => `${u.label}: ${u.value}`).join("\n"),
  };
}
