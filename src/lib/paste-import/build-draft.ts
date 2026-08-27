/**
 * 段2〜4を通して下書きを組み立てる。純関数。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { parseLabeledLines, isBlankValue, type LabeledLine } from "./parse-labeled-lines";
import {
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
  normalizeExternalLinkKey,
  type YearBoundOptions,
} from "./normalize";
import { fieldKeyForLabel, type DraftFieldKey } from "./label-dictionary";
import { propertyTypeForRaw } from "./property-type-dictionary";
import {
  detectSourceProfile,
  splitBuildingAndRoom,
  SOURCE_PROFILE_LABELS,
} from "./source-profiles";
import { judgeOwnerPersonalInfo } from "./owner-personal-info";
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
 * ⚠**時計を読むのは API 層（境界）だけ**。ここは上限を引数で受け取るだけで、
 *   同じ入力には同じ結果を返す（テストは固定値を渡す）。
 */
export function buildPasteDraft(text: string, options?: YearBoundOptions): PasteDraft {
  const { labeled, unlabeled } = parseLabeledLines(text);
  const warnings: DraftWarning[] = [];

  // 見出しごとの最初の値だけを採る（同じ見出しが2回出たら先勝ち）。
  const picked = new Map<DraftFieldKey, LabeledLine>();
  const unmapped: { label: string; value: string }[] = [];
  const withheldFromNote: PasteDraft["withheldFromNote"] = [];
  const unreadable: PasteDraft["unreadable"] = [];

  for (const line of labeled) {
    if (isBlankValue(line.value)) continue; // 値なしは拾わない
    const key = fieldKeyForLabel(line.label);
    if (key === null) {
      // ⚠所有者の個人情報にあたる見出しは**備考へ入れない**(@codex PR#414 11巡目 ①)。
      //   Property.note は所有者の項目別マスクを通らずに表示されるため、
      //   ここへ流すと項目別権限チェックの迂回路になる。捨てはせず、
      //   確認画面に出して人が適切な欄へ移せるようにする。
      const verdict = judgeOwnerPersonalInfo(line.label, line.value);
      if (verdict.isOwnerPersonalInfo && verdict.reason !== null) {
        withheldFromNote.push({
          label: line.label,
          value: line.value,
          reason: verdict.reason,
        });
        continue;
      }
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
      field: "propertyType",
      message: `物件種別「${typeRaw}」を判別できませんでした。選び直してください。`,
    });
  }

  // ---- 所有者 ----
  // ⚠**氏名が無いだけで丸ごと捨てない**(@codex PR#414 21巡目 ①)。
  //   連絡先(電話・メール・現住所)やカナが読み取れているのに owner を null に
  //   すると、それらの行は unmapped からも除かれているため
  //   **確認画面のどこにも出ないまま、登録時に黙って消える**。
  //   「黙って捨てるのが一番悪い」。読み取れた値を入れた owner を返し、
  //   氏名が空であることを警告で伝える。画面側は R9 のガード
  //   (新規所有者モードで氏名が空なら登録を止める)がそのまま効くので、
  //   値は事前入力され、氏名の入力を促され、そのまま登録はできない。
  //   「所有者なしで登録する」を選べば従来どおり(人が見たうえで選んだ結果)。
  const ownerName = raw("ownerName");
  const ownerFieldKeys: DraftFieldKey[] = [
    "ownerName",
    "ownerNameKana",
    "ownerPhone",
    "ownerEmail",
    "ownerAddress",
  ];
  const hasAnyOwnerField = ownerFieldKeys.some((k) => raw(k) !== null);
  const owner = !hasAnyOwnerField
    ? null
    : {
        name: field(ownerName, label("ownerName")),
        nameKana: field(raw("ownerNameKana"), label("ownerNameKana")),
        phone: field(raw("ownerPhone"), label("ownerPhone")),
        email: field(raw("ownerEmail"), label("ownerEmail")),
        currentAddress: field(raw("ownerAddress"), label("ownerAddress")),
      };
  if (hasAnyOwnerField && ownerName === null) {
    warnings.push({
      code: "owner_name_missing",
      message:
        "所有者の連絡先を読み取りましたが、氏名が読み取れませんでした。氏名を入力するか、「所有者なしで登録する」を選んでください。",
    });
  }

  // ---- 値を解釈できなかった欄の共通処理 ----
  // ⚠**捨てて黙らない**(@codex PR#414 9巡目 ②)。5巡目で「単位が確かでなければ
  //   null」にした結果、`20坪（66.1㎡）` のような値は確認画面で
  //   「元の資料に記載がありません」と出ていた＝**元資料には書いてあるのに
  //   無いと言う**＝利用者への嘘で、設計の「誤解させない」に正面から反する。
  //   ①警告を出す ②生の値を備考へ残す(辞書に無い見出しと同じ扱い＝情報を失わない)
  //   ③欄は空のまま(推測で埋めない) の3つを同時に行う。
  // ⚠面積に限らず、**見出しは辞書にあるのに値を解釈できなかった場合すべて**に
  //   同じ扱いをする(築年の元号エラー・現況の言い換え不明も同型)。
  function readOrKeepRaw<T>(
    key: DraftFieldKey,
    fieldKey: string,
    fieldLabel: string,
    parse: (raw: string) => T | null,
  ): T | null {
    const rawValue = raw(key);
    if (rawValue === null) return null;
    const parsed = parse(rawValue);
    if (parsed !== null) return parsed;
    warnings.push({
      code: "value_unreadable",
      field: fieldKey,
      message: `${fieldLabel}「${rawValue}」を読み取れませんでした。ご確認のうえ入力してください。`,
    });
    // 備考へ回す(見出しは元の表記のまま＝原文と突き合わせられる)。
    const noteLabel = label(key) || fieldLabel;
    unmapped.push({ label: noteLabel, value: rawValue });
    // どの欄の生値かを覚えておく(人がその欄に値を入れたら備考から消すため)。
    unreadable.push({ field: fieldKey, label: noteLabel, value: rawValue });
    return null;
  }

  const builtYear = readOrKeepRaw("builtYearRaw", "builtYear", "築年", (v) =>
    warekiToSeireki(v, options),
  );
  const area = readOrKeepRaw("exclusiveArea", "exclusiveArea", "専有面積", parseAreaSqm);
  const landArea = readOrKeepRaw("landArea", "landArea", "土地面積", parseAreaSqm);
  const occupancy = readOrKeepRaw("occupancyRaw", "occupancyStatus", "現況", occupancyFor);

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
      occupancyStatus: field(occupancy, label("occupancyRaw")),
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
    withheldFromNote,
    unreadable,
    // ⚠割れなかった行も捨てずに持つ（設計書 §4.2）。全体レビュー I-5:
    //   parseLabeledLines は unlabeled を返していたのに、ここで labeled しか
    //   受け取っておらず、下書きに乗る前に消えていた。
    unlabeled,
    noteFromUnmapped: unmapped.map((u) => `${u.label}: ${u.value}`).join("\n"),
  };
}
