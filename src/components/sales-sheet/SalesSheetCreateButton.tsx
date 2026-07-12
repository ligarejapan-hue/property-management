"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SalesSheetTemplateKind } from "@/lib/sales-sheet/template-kind";
import { fetchPropertyDetail } from "@/lib/api-client";
import { MANSION_FIELDS, LAND_FIELDS, HOUSE_FIELDS, BUILDING_FIELDS, type SheetField } from "@/lib/sales-sheet/field-model";
import {
  mapOccupancyStatusToMansionOccupancy,
  mapOccupancyStatusToLandOccupancy,
} from "@/lib/sales-sheet/occupancy";
import { computeTsuboUnitPrice } from "@/lib/sales-sheet/tsubo";
import {
  OTHER_OPTION,
  hasOtherOption,
  selectOtherState,
  multiOtherState,
  setMultiFreeText,
} from "@/lib/sales-sheet/other-input";

export type { SalesSheetTemplateKind };

interface FieldConfig {
  /** 表題・ボタン・モーダルに使うテンプレ名（例: 売マンション）。 */
  label: string;
  /** 作成時に入力する上書き項目。key は route の overridesSchema と一致させる。 */
  fields: { key: string; label: string }[];
}

// 種別ごとの作成フォーム項目。key は new route の per-type overridesSchema と揃える。
// （テンプレの実データはサーバ側で物件レコードから補完し、ここでは「システムに無い値」だけ集める）
// 全種別が FIELDS_BY_KIND(field-model) 駆動のダイアログへ差し替え済みのため fields は未使用
// （label はボタン/見出し表示に引き続き使う・land は [F2-A Task4]、house は [F2-B Task3]、
// building は [F2-C Task3] で追加）。
const FIELD_SETS: Record<SalesSheetTemplateKind, FieldConfig> = {
  land: {
    label: "売土地",
    fields: [],
  },
  mansion: {
    label: "売マンション",
    fields: [],
  },
  house: {
    label: "売戸建",
    fields: [],
  },
  building: {
    label: "一棟",
    fields: [],
  },
};

/**
 * 新規デザイン作成 API へのリクエスト内容を組み立てる純関数。
 * テンプレ種別はサーバ側で物件種別から判定するため body には含めない（上書き項目のみ）。
 * mansion/land は multiselect（用途地域/地目 等）があるため string[] も許容する。
 */
export function buildCreateRequest(
  propertyId: string,
  values: Record<string, string | string[]>,
): { url: string; init: RequestInit } {
  return {
    url: `/api/properties/${propertyId}/sales-sheets/new`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    },
  };
}

// ============================================================================
// field-model(FIELDS_BY_KIND) 駆動の作成ダイアログ（売マンション/売土地/売戸建 共通の汎用 widget 描画）
// [F2-A Task4] F1 で確立した売マンション専用の描画（MansionFieldModelForm 等）を、
// LAND_FIELDS を持つ売土地でも再利用できるよう一般化した。[F2-B Task3] 売戸建、[F2-C Task3]
// 一棟も同じ汎用レンダラへ配線した（全種別 field-model 駆動）。
// ============================================================================

export type FieldModelValue = string | string[];
export type FieldModelValues = Record<string, FieldModelValue>;

/** 全種別が field-model 駆動（[F2-C Task3] で building も配線）。型は既存互換のため null 許容を残す。 */
const FIELDS_BY_KIND: Record<SalesSheetTemplateKind, readonly SheetField[] | null> = {
  land: LAND_FIELDS,
  mansion: MANSION_FIELDS,
  house: HOUSE_FIELDS,
  building: BUILDING_FIELDS,
};

/**
 * MANSION_FIELDS のうち、物件/建物レコードが正のため上書き機構を持たない自動反映専用キー。
 * ダイアログでは参照表示のみ（disabled・編集不可）にする＝編集しても送信されない。
 * route.ts の mansionOverridesSchema / build-document.ts の SaleMansionOverrides に
 * 対応するキーが無いことに合わせている（[T4→T5] carry-forward: structure は意図的に
 * 対象外。buildingName/address 等の他の自動反映専用フィールドも同じ理由＝
 * 単一ソースの事実値であり、シート単位で個別に上書きする設計にはしない）。
 * propertyType・occupancy は本タスクで新規に上書き可能へ昇格したためここには含めない。
 * （[F2-A Task4]: 同じ考え方の LAND_AUTO_ONLY_KEYS を追加。両者は AUTO_ONLY_KEYS_BY_KIND
 * 経由で種別ごとに参照する。）
 */
const MANSION_AUTO_ONLY_KEYS = new Set<string>([
  "buildingName",
  "managementFee",
  "repairFee",
  "address",
  "exclusiveArea",
  "balconyArea",
  "balconyDir",
  "layout",
  "structure",
  "floorNo",
  "totalFloors",
  "totalUnits",
  "managementCompany",
]);

/**
 * LAND_FIELDS のうち、物件レコードが正のため上書き機構を持たない自動反映専用キー
 * （MANSION_AUTO_ONLY_KEYS と同じ考え方・[F2-A Task4]）。土地は建物 relation を持たないため
 * 自動反映元は物件スカラ（address/roadType/buildingCoverageRatio/floorAreaRatio）のみ。
 * useDistrict（zoningDistrict 自動反映＋追加選択）・roadWidth（自動反映＋より精度の高い値を
 * 上書き可能＝builtYearMonth と同じ「override優先＋auto fallback」）・occupancy（現況、
 * mansion の occupancy と同じく seed のみ・明示編集時のみ送信）は SaleLandOverrides に
 * 対応するキーがあるため対象外＝通常の編集可能フィールドとして扱う（hints/occupancySeed 経由）。
 */
const LAND_AUTO_ONLY_KEYS = new Set<string>(["address", "roadKind", "coverageRatio", "floorRatio"]);

/**
 * HOUSE_FIELDS のうち、物件レコードが正のため上書き機構を持たない自動反映専用キー
 * （LAND_AUTO_ONLY_KEYS と同じ考え方・[F2-B Task3]）。house も building relation を
 * 配線しないため、自動反映元は物件スカラ（address/layoutType/roadType/
 * buildingCoverageRatio/floorAreaRatio）のみ。layout は SaleHouseOverrides に対応する
 * キーが無い（MANSION_AUTO_ONLY_KEYS の layout と同じ理由）ため、LAND_AUTO_ONLY_KEYS と
 * 同じ4キーに加えて layout も自動反映専用に含める。useDistrict（zoningDistrict 自動反映＋
 * 追加選択）・roadWidth（override優先＋auto fallback）・occupancy（seedのみ・明示編集時のみ
 * 送信）は SaleHouseOverrides に対応するキーがあるため対象外＝通常の編集可能フィールドとして
 * 扱う（land と同じ基準・hints/occupancySeed 経由）。
 */
const HOUSE_AUTO_ONLY_KEYS = new Set<string>([
  "address",
  "layout",
  "roadKind",
  "coverageRatio",
  "floorRatio",
]);

/**
 * BUILDING_FIELDS の自動反映専用キー（LAND_AUTO_ONLY_KEYS と同一・[F2-C Task3]）。一棟も
 * building relation を配線せず layoutType も持たないため、land と同じ4キー（layout 無し）。
 */
const BUILDING_AUTO_ONLY_KEYS = new Set<string>(["address", "roadKind", "coverageRatio", "floorRatio"]);

const AUTO_ONLY_KEYS_BY_KIND: Record<SalesSheetTemplateKind, ReadonlySet<string>> = {
  land: LAND_AUTO_ONLY_KEYS,
  mansion: MANSION_AUTO_ONLY_KEYS,
  house: HOUSE_AUTO_ONLY_KEYS,
  building: BUILDING_AUTO_ONLY_KEYS,
};

function groupBySection(
  fields: readonly SheetField[],
): (readonly [string, SheetField[]])[] {
  const order: string[] = [];
  const bySection = new Map<string, SheetField[]>();
  for (const f of fields) {
    if (!bySection.has(f.section)) {
      bySection.set(f.section, []);
      order.push(f.section);
    }
    bySection.get(f.section)!.push(f);
  }
  return order.map((s) => [s, bySection.get(s)!] as const);
}
// 各種別の FIELDS は静的なためモジュール読み込み時に一度だけ section 分けする（全種別）。
const SECTIONS_BY_KIND: Record<SalesSheetTemplateKind, (readonly [string, SheetField[]])[]> = {
  land: groupBySection(LAND_FIELDS),
  mansion: groupBySection(MANSION_FIELDS),
  house: groupBySection(HOUSE_FIELDS),
  building: groupBySection(BUILDING_FIELDS),
};

/**
 * ダイアログが自動反映の元データとして読む、物件詳細フェッチ結果の最小限の形（mansion 版）。
 * 実レスポンス（GET /api/properties/[id]）はこれより広いフィールドを持つが、
 * ここでは使う分だけを防御的に（すべて任意で）読む。
 */
interface MansionAutoSource {
  address?: string | null;
  occupancyStatus?: string | null;
  zoningDistrict?: string | null;
  exclusiveArea?: number | string | null;
  balconyArea?: number | string | null;
  layoutType?: string | null;
  orientation?: string | null;
  floorNo?: number | null;
  managementFee?: number | null;
  repairReserveFee?: number | null;
  building?: {
    name?: string | null;
    totalFloors?: number | null;
    builtYear?: number | null;
    structureType?: string | null;
    managementCompany?: string | null;
    totalUnits?: number | null;
  } | null;
}

/**
 * 売土地版の MansionAutoSource（[F2-A Task4]）。土地は building relation を持たないため、
 * 物件スカラのみを防御的に（すべて任意で）読む。
 */
interface LandAutoSource {
  address?: string | null;
  occupancyStatus?: string | null;
  zoningDistrict?: string | null;
  buildingCoverageRatio?: number | string | null;
  floorAreaRatio?: number | string | null;
  roadType?: string | null;
  roadWidth?: number | string | null;
}

/**
 * 売戸建版の MansionAutoSource（[F2-B Task3]）。house も building relation を配線しないため、
 * LandAutoSource と同じく物件スカラのみを防御的に（すべて任意で）読む。layoutType のみ
 * LandAutoSource には無い追加フィールド（土地は間取りを持たないが house は持つ＝
 * HOUSE_AUTO_ONLY_KEYS の layout に対応）。
 */
interface HouseAutoSource {
  address?: string | null;
  occupancyStatus?: string | null;
  zoningDistrict?: string | null;
  layoutType?: string | null;
  buildingCoverageRatio?: number | string | null;
  floorAreaRatio?: number | string | null;
  roadType?: string | null;
  roadWidth?: number | string | null;
}

/**
 * 一棟(building)版の自動反映ソース（[F2-C Task3]）。building relation は配線せず layoutType も
 * 持たないため LandAutoSource と同一形。occupancy 語彙のみ house/mansion と同じ（下記 compute 参照）。
 */
interface BuildingAutoSource {
  address?: string | null;
  occupancyStatus?: string | null;
  zoningDistrict?: string | null;
  buildingCoverageRatio?: number | string | null;
  floorAreaRatio?: number | string | null;
  roadType?: string | null;
  roadWidth?: number | string | null;
}

/**
 * ダイアログが使う「自動反映専用プレビュー値・occupancy(現況)初期選択ヒント・テキスト系の
 * 自動反映ヒント」をまとめた種別非依存の形（[F2-A Task4]・旧 MansionAutoValues を一般化）。
 * mansion/land それぞれの compute*AutoValues がこの形へ populate する。
 * - preview: 自動反映専用（disabled、AUTO_ONLY_KEYS_BY_KIND）フィールドの表示値
 *   （キー=field.key）。
 * - occupancySeed: occupancy(現況) select の「表示専用」の初期値ヒント。mansionValues/
 *   landValues 自体には書き込まない＝ユーザーが select を操作しない限り送信ペイロードに
 *   occupancy は含まれず、サーバ側の同一写像関数によるデフォルトに委ねる
 *   （フェッチの成否・タイミングに依存させないための設計・@codex P2 fix・mansion から継承）。
 * - hints: useDistrict/builtYearMonth/roadWidth 等、override 可能だが自動反映元もある
 *   テキスト系フィールドの上に出す案内文言（キー=field.key、値=「自動反映: 」に続けて表示
 *   する完成文字列＝末尾の案内文言も compute 側で組み立て済み）。自動反映値が無い
 *   フィールドはキー自体を持たない。
 */
interface FieldModelAutoValues {
  preview: Record<string, string>;
  occupancySeed?: string;
  hints: Record<string, string>;
}

function toPreviewString(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 物件詳細フェッチ結果 → 自動反映専用プレビュー値・occupancy初期選択・テキスト系ヒント。 */
function computeMansionAutoValues(data: MansionAutoSource): FieldModelAutoValues {
  const b = data.building ?? undefined;
  const hints: Record<string, string> = {};
  if (data.zoningDistrict) {
    hints.useDistrict = `${data.zoningDistrict}（追加の用途地域があれば選択してください）`;
  }
  if (b?.builtYear != null) {
    hints.builtYearMonth = `${b.builtYear}年（月まで分かる場合は入力してください）`;
  }
  return {
    preview: {
      buildingName: toPreviewString(b?.name),
      managementFee: toPreviewString(data.managementFee),
      repairFee: toPreviewString(data.repairReserveFee),
      address: toPreviewString(data.address),
      exclusiveArea: toPreviewString(data.exclusiveArea),
      balconyArea: toPreviewString(data.balconyArea),
      balconyDir: toPreviewString(data.orientation),
      layout: toPreviewString(data.layoutType),
      structure: toPreviewString(b?.structureType),
      floorNo: toPreviewString(data.floorNo),
      totalFloors: toPreviewString(b?.totalFloors),
      totalUnits: toPreviewString(b?.totalUnits),
      managementCompany: toPreviewString(b?.managementCompany),
    },
    occupancySeed: mapOccupancyStatusToMansionOccupancy(data.occupancyStatus),
    hints,
  };
}

/**
 * LAND_FIELDS 向けの自動反映プレビュー計算（computeMansionAutoValues と同じ役割・
 * [F2-A Task4]）。土地は建物 relation を持たないため、物件スカラのみを読む。
 */
function computeLandAutoValues(data: LandAutoSource): FieldModelAutoValues {
  const hints: Record<string, string> = {};
  if (data.zoningDistrict) {
    hints.useDistrict = `${data.zoningDistrict}（追加の用途地域があれば選択してください）`;
  }
  if (data.roadWidth != null && data.roadWidth !== "") {
    hints.roadWidth = `${data.roadWidth}m（より正確な値が分かる場合は入力してください）`;
  }
  return {
    preview: {
      address: toPreviewString(data.address),
      roadKind: toPreviewString(data.roadType),
      coverageRatio: toPreviewString(data.buildingCoverageRatio),
      floorRatio: toPreviewString(data.floorAreaRatio),
    },
    occupancySeed: mapOccupancyStatusToLandOccupancy(data.occupancyStatus),
    hints,
  };
}

/**
 * HOUSE_FIELDS 向けの自動反映プレビュー計算（computeLandAutoValues と同じ役割・
 * [F2-B Task3]）。house も building relation を配線しないため、物件スカラのみを読む。
 * LAND_AUTO_ONLY_KEYS と異なり layout（layoutType 由来）もプレビュー対象に含む
 * （HOUSE_AUTO_ONLY_KEYS 参照）。occupancySeed は戸建の現況語彙がマンションと同一のため
 * mapOccupancyStatusToMansionOccupancy を再利用する（build-document.ts の buildHouseValues
 * と同じ関数＝作成ダイアログと図面ビルダーで写像がずれない）。
 */
function computeHouseAutoValues(data: HouseAutoSource): FieldModelAutoValues {
  const hints: Record<string, string> = {};
  if (data.zoningDistrict) {
    hints.useDistrict = `${data.zoningDistrict}（追加の用途地域があれば選択してください）`;
  }
  if (data.roadWidth != null && data.roadWidth !== "") {
    hints.roadWidth = `${data.roadWidth}m（より正確な値が分かる場合は入力してください）`;
  }
  return {
    preview: {
      address: toPreviewString(data.address),
      layout: toPreviewString(data.layoutType),
      roadKind: toPreviewString(data.roadType),
      coverageRatio: toPreviewString(data.buildingCoverageRatio),
      floorRatio: toPreviewString(data.floorAreaRatio),
    },
    occupancySeed: mapOccupancyStatusToMansionOccupancy(data.occupancyStatus),
    hints,
  };
}

/**
 * BUILDING_FIELDS 向けの自動反映プレビュー計算（[F2-C Task3]）。building relation は配線せず
 * layoutType も持たないため preview は land と同じ4キー（layout 無し）。occupancySeed は一棟の
 * 現況語彙がマンション/戸建と同一のため mapOccupancyStatusToMansionOccupancy を再利用する
 * （build-document.ts の buildBuildingValues と同じ関数＝ダイアログと図面ビルダーで写像がずれない）。
 */
function computeBuildingAutoValues(data: BuildingAutoSource): FieldModelAutoValues {
  const hints: Record<string, string> = {};
  if (data.zoningDistrict) {
    hints.useDistrict = `${data.zoningDistrict}（追加の用途地域があれば選択してください）`;
  }
  if (data.roadWidth != null && data.roadWidth !== "") {
    hints.roadWidth = `${data.roadWidth}m（より正確な値が分かる場合は入力してください）`;
  }
  return {
    preview: {
      address: toPreviewString(data.address),
      roadKind: toPreviewString(data.roadType),
      coverageRatio: toPreviewString(data.buildingCoverageRatio),
      floorRatio: toPreviewString(data.floorAreaRatio),
    },
    occupancySeed: mapOccupancyStatusToMansionOccupancy(data.occupancyStatus),
    hints,
  };
}

/**
 * kind → 自動反映プレビュー計算関数（[F2-C Task3] で building も追加＝全種別）。
 */
const AUTO_COMPUTE_BY_KIND: Partial<
  Record<SalesSheetTemplateKind, (raw: unknown) => FieldModelAutoValues>
> = {
  mansion: (raw) => computeMansionAutoValues(raw as MansionAutoSource),
  land: (raw) => computeLandAutoValues(raw as LandAutoSource),
  house: (raw) => computeHouseAutoValues(raw as HouseAutoSource),
  building: (raw) => computeBuildingAutoValues(raw as BuildingAutoSource),
};

/**
 * 送信直前に field-model の values → overrides payload へ変換する（[F2-A Task4] 汎用化・
 * mansion/land 共通＝両者とも salesPoints をレイアウト専用の1行1つ文字列として同じ規約で
 * 扱うため kind 分岐は不要）。
 * - salesPoints は編集中「1行に1つ」の文字列として保持し、ここで初めて改行区切り→配列化
 *   する（controlled textarea の value を都度フィルタ済み配列から再構成すると、入力中の
 *   末尾の空行/改行が消えて改行を打てなくなるため、編集中は文字列のまま保持する設計）。
 * - 空文字列・空配列のキーは省略する（未入力=undefined と等価に扱う既存規約に合わせる）。
 */
function buildFieldModelOverridePayload(
  values: FieldModelValues,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, v] of Object.entries(values)) {
    if (key === "salesPoints") {
      const text = typeof v === "string" ? v : Array.isArray(v) ? v.join("\n") : "";
      const arr = text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length > 0) out.salesPoints = arr;
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length > 0) out[key] = v;
      continue;
    }
    if (typeof v === "string" && v.trim() !== "") out[key] = v;
  }
  return out;
}

/**
 * 「その他」を持つ select 欄の描画（[Task2] 実装／@codex P2 final review M1 で堅牢化）。
 * `FieldModelWidget` は widget 種別ごとに複数の早期 return を持つ関数のため、特定の
 * 分岐内だけで hooks を呼ぶと rules-of-hooks（条件付き呼び出し）に抵触する。そのため
 * その他対応部分だけをここへ切り出し、hooks を安全にトップレベルで呼べるようにする。
 *
 * 表示可否（自由入力欄を出すか）は `otherOpen`（ローカル state）で決め、値からの
 * 毎レンダー再推論はしない。自由入力欄の value も `freeText`（ローカル state）の
 * バッファを表示する。以前は `selectOtherState(value, options)` を毎レンダー呼んで
 * isOther を直接使っていたため、選択肢と完全一致する自由入力（例:「RC造」の入力途中の
 * 「RC」）を打った瞬間に isOther が false へ反転し、自由入力欄が消えて選択肢へ
 * 畳まれてしまっていた（@codex P2）。otherOpen は `<select>` の実際の操作
 * （その他⇔実選択肢の切替）でのみ変える＝自由入力欄への打鍵では変えないため再現しない。
 *
 * 初期値は現在値からの導出（selectOtherState、マウント時の1回のみ）。ダイアログは
 * one-shot（作成時のみ・値は外部から書き換わらない）ためローカル state で desync しない。
 * 保存する値の表現（options外文字列＝自由入力・空は「その他」）は不変
 * （other-input.ts の純関数は初期化にのみ引き続き使用）。
 */
function SelectWithOther({
  field,
  value,
  onChange,
  id,
}: {
  field: SheetField;
  value: string;
  onChange: (v: FieldModelValue) => void;
  id: string;
}) {
  const options = field.options ?? [];
  const [otherOpen, setOtherOpen] = useState(() => selectOtherState(value, options).isOther);
  const [freeText, setFreeText] = useState(() => selectOtherState(value, options).freeText);
  const selectValue = otherOpen ? OTHER_OPTION : value;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300">
          {field.label}
        </label>
        <select
          id={id}
          aria-label={field.label}
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER_OPTION) {
              setOtherOpen(true);
              setFreeText("");
              onChange(OTHER_OPTION);
            } else {
              setOtherOpen(false);
              setFreeText("");
              onChange(v);
            }
          }}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        >
          <option value="">選択してください</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
      {otherOpen && (
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0" aria-hidden="true" />
          <input
            aria-label={`${field.label}（その他）`}
            value={freeText}
            onChange={(e) => {
              const t = e.target.value;
              setFreeText(t);
              onChange(t.trim() === "" ? OTHER_OPTION : t);
            }}
            placeholder="その他の内容を入力"
            className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
          />
        </div>
      )}
    </div>
  );
}

/**
 * 「その他」を持つ multiselect 欄の描画（SelectWithOther と同じ理由・@codex P2 堅牢化）。
 * `otherOpen`/`freeText` はローカル state＝「その他」チェックボックスの操作でのみ変わり、
 * 自由入力欄への打鍵では変わらない（選択肢と完全一致する自由入力でチェックが外れて
 * 欄が消える不具合を防ぐ、SelectWithOther 同様）。`optionSelections`（その他以外の実選択）は
 * チェックボックス操作のたびに変わる普通の選択状態＝表示可否/自由入力バッファの再推論とは
 * 別物のため、親から渡る最新の `selected` から毎レンダー再計算してよい
 * （multiOtherState は純関数・other-input.test.ts でテスト済み）。
 */
function MultiSelectWithOther({
  field,
  options,
  selected,
  onChange,
}: {
  field: SheetField;
  options: readonly string[];
  selected: string[];
  onChange: (v: FieldModelValue) => void;
}) {
  const [otherOpen, setOtherOpen] = useState(() => multiOtherState(selected, options).isOther);
  const [freeText, setFreeText] = useState(() => multiOtherState(selected, options).freeText);
  const optionSelections = multiOtherState(selected, options).optionSelections;
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm text-gray-700 dark:text-gray-300">{field.label}</legend>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {options.map((opt) =>
          opt === OTHER_OPTION ? (
            // 「その他」チェックボックス: チェック状態は otherOpen（ローカル state）で決める
            // （raw の selected.includes("その他") だけだと、自由入力テキストが入っている間は
            // 配列にリテラル「その他」が無いため見た目上チェックが外れてしまう）。
            <label key={opt} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                aria-label={opt}
                checked={otherOpen}
                onChange={(e) => {
                  if (e.target.checked) {
                    setOtherOpen(true);
                    setFreeText("");
                    onChange([...optionSelections, OTHER_OPTION]);
                  } else {
                    setOtherOpen(false);
                    setFreeText("");
                    onChange(optionSelections);
                  }
                }}
              />
              {opt}
            </label>
          ) : (
            <label key={opt} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                aria-label={opt}
                checked={selected.includes(opt)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, opt]
                    : selected.filter((s) => s !== opt);
                  onChange(next);
                }}
              />
              {opt}
            </label>
          ),
        )}
      </div>
      {otherOpen && (
        <input
          aria-label={`${field.label}（その他）`}
          value={freeText}
          onChange={(e) => {
            const t = e.target.value;
            setFreeText(t);
            onChange(setMultiFreeText(selected, options, t));
          }}
          placeholder="その他の内容を入力"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
      )}
    </fieldset>
  );
}

/** 1フィールド分の入力ウィジェット（select/multiselect/number/text）。mansion/land 共通
 * （[F2-A Task4] 汎用化・idPrefix で DOM id の名前空間を種別ごとに分ける）。 */
function FieldModelWidget({
  field,
  value,
  onChange,
  idPrefix,
  placeholder,
}: {
  field: SheetField;
  value: FieldModelValue | undefined;
  onChange: (v: FieldModelValue) => void;
  idPrefix: string;
  /** number widget の `<input>` に付ける placeholder（例: 売土地の坪単価の自動計算プレビュー）。
   *  他の widget では未使用（[Task1] 坪単価ライブプレースホルダ）。 */
  placeholder?: string;
}) {
  const id = `ss-${idPrefix}-${field.key}`;

  if (field.widget === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    const options = field.options ?? [];
    // [Task2] options に「その他」を含む欄のみ、その他対応の専用コンポーネントへ委譲する
    // （明示モード＋ローカルバッファで保持し、値からの毎レンダー再推論はしない＝@codex P2）。
    // 持たない欄は従来どおり（プレーンなチェックボックス群のみ・以下は不変）。
    if (hasOtherOption(options)) {
      return (
        <MultiSelectWithOther field={field} options={options} selected={selected} onChange={onChange} />
      );
    }
    return (
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm text-gray-700 dark:text-gray-300">{field.label}</legend>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                aria-label={opt}
                checked={selected.includes(opt)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, opt]
                    : selected.filter((s) => s !== opt);
                  onChange(next);
                }}
              />
              {opt}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.widget === "select") {
    const v = typeof value === "string" ? value : "";
    const options = field.options ?? [];
    // [Task2] options に「その他」を含む欄のみ、その他対応の専用コンポーネントへ委譲する
    // （明示モード＋ローカルバッファで保持し、値からの毎レンダー再推論はしない＝@codex P2）。
    // 持たない欄は従来どおり（プレーンな select のみ・以下は不変）。
    if (hasOtherOption(options)) {
      return <SelectWithOther field={field} value={v} onChange={onChange} id={id} />;
    }
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300">
            {field.label}
          </label>
          <select
            id={id}
            aria-label={field.label}
            value={v}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
          >
            <option value="">選択してください</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  if (field.widget === "combo") {
    // [Task3] 報酬など「プリセットから選ぶ／自由入力する」両方を許す欄。datalist は
    // ブラウザネイティブのコンボボックス（プリセットを提示しつつ自由入力可）＝
    // options は候補の一つに過ぎず、value は常に自由文字列（サーバ zod も
    // z.string() のため無改修で通る＝ other-input.ts の「その他」機構とは別物）。
    const v = typeof value === "string" ? value : "";
    const options = field.options ?? [];
    const listId = `${id}-list`;
    return (
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300">
          {field.label}
        </label>
        <input
          id={id}
          aria-label={field.label}
          list={listId}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
        <datalist id={listId}>
          {options.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
      </div>
    );
  }

  if (field.widget === "number") {
    const v = typeof value === "string" ? value : "";
    return (
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300">
          {field.label}
        </label>
        <input
          id={id}
          aria-label={field.label}
          inputMode="decimal"
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-28 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
        {field.unit && <span className="text-xs text-neutral-500 dark:text-neutral-400">{field.unit}</span>}
      </div>
    );
  }

  // text（および将来追加されうる未知 widget のフォールバック）
  const v = typeof value === "string" ? value : "";
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300">
        {field.label}
      </label>
      <input
        id={id}
        aria-label={field.label}
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
      />
    </div>
  );
}

/** 自動反映専用フィールドの参照表示（disabled・編集不可＝物件/建物レコードが正）。
 * mansion/land 共通（[F2-A Task4] 汎用化）。 */
function AutoPreviewField({
  field,
  value,
  idPrefix,
}: {
  field: SheetField;
  value: string;
  idPrefix: string;
}) {
  const id = `ss-${idPrefix}-${field.key}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-28 shrink-0 text-sm text-gray-500 dark:text-gray-400">
        {field.label}
      </label>
      <input
        id={id}
        aria-label={field.label}
        disabled
        readOnly
        value={value}
        title="物件/建物の登録情報から自動反映（この画面では変更できません）"
        className="flex-1 rounded border border-neutral-200 bg-neutral-100 px-2 py-1 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400"
      />
      {field.unit && <span className="text-xs text-neutral-400">{field.unit}</span>}
    </div>
  );
}

/** 売土地の坪単価フィールド向けライブプレースホルダ（[Task1]）。現在の価格/土地面積
 *  （フォーム入力中の生値）から computeTsuboUnitPrice した自動計算値があれば
 *  "自動: {v}万円"、算出不可（面積0/空 等）なら undefined（プレースホルダ無し）を返す。
 *  values 自体は変更しない＝上書き入力すればそちらが優先され、空欄のまま送信すれば
 *  ビルダー側（buildLandValues）が同じ関数で同じ値を自動計算する。 */
function tsuboUnitPricePlaceholder(
  price: FieldModelValue | undefined,
  landArea: FieldModelValue | undefined,
): string | undefined {
  const p = typeof price === "string" ? price : "";
  const a = typeof landArea === "string" ? landArea : "";
  const auto = computeTsuboUnitPrice(p, a);
  return auto === "" ? undefined : `自動: ${auto}万円`;
}

/**
 * field-model 駆動の作成ダイアログ入力本体（section 別にグルーピングして描画）。mansion/land
 * 共通の汎用レンダラ（[F2-A Task4]: 旧 MansionFieldModelForm を一般化。house/building は
 * field-model が無いため呼ばれない）。状態を持たない提示コンポーネントとして切り出し、
 * SSR（renderToStaticMarkup）で構造を検証できるようにする（親の SalesSheetCreateDialog が
 * state / 自動反映フェッチを保持する）。
 */
export function FieldModelForm({
  kind,
  sections,
  autoOnlyKeys,
  values,
  onChange,
  autoPreview,
  occupancySeed,
  hints,
}: {
  kind: SalesSheetTemplateKind;
  /** SECTIONS_BY_KIND[kind]（groupBySection(FIELDS_BY_KIND[kind]) 済み）。 */
  sections: (readonly [string, SheetField[]])[];
  /** AUTO_ONLY_KEYS_BY_KIND[kind]。 */
  autoOnlyKeys: ReadonlySet<string>;
  values: FieldModelValues;
  onChange: (key: string, value: FieldModelValue) => void;
  autoPreview: Record<string, string>;
  /** occupancy(現況) select の表示専用の初期値ヒント（未編集時のみ使う。詳細は
   * FieldModelAutoValues 参照）。 */
  occupancySeed?: string;
  /** useDistrict/builtYearMonth/roadWidth 等の自動反映ヒント（詳細は FieldModelAutoValues.hints 参照）。 */
  hints: Record<string, string>;
}) {
  return (
    <>
      {sections.map(([section, fields]) => (
        <fieldset
          key={section}
          className="mb-3 space-y-2 border-t border-neutral-200 pt-2 first:border-t-0 first:pt-0 dark:border-neutral-700"
        >
          <legend className="mb-1 text-xs font-bold text-neutral-500 dark:text-neutral-400">
            {section}
          </legend>
          {fields.map((f) => {
            // showWhen: 制御フィールドの現在値が一致しない限り描画しない
            // （sheet-rows.ts の buildSheetRows と同じ判定＝非string値は""扱い）。
            if (f.showWhen) {
              const ctrl = values[f.showWhen.field];
              const ctrlStr = typeof ctrl === "string" ? ctrl : "";
              if (ctrlStr !== f.showWhen.equals) return null;
            }
            if (autoOnlyKeys.has(f.key)) {
              return (
                <AutoPreviewField
                  key={f.key}
                  idPrefix={kind}
                  field={f}
                  value={autoPreview[f.key] ?? ""}
                />
              );
            }
            // occupancy(現況): 未編集時は自動反映ヒント(occupancySeed)を表示専用の初期値として
            // 見せるが、values(=送信payload の元)は書き換えない。ユーザーが select を実際に
            // 操作(onChange)しない限り occupancy は送信されず、サーバ側の決定的デフォルト
            // （mapOccupancyStatusToMansionOccupancy/mapOccupancyStatusToLandOccupancy）に
            // 委ねる（@codex P2 fix: フェッチのタイミングに依存して現況が変わる不具合の解消。
            // mansion/land 共通のパターン）。
            const displayValue =
              f.key === "occupancy" && values[f.key] === undefined ? occupancySeed : values[f.key];
            // 売土地の坪単価: 未入力時にビルダーが自動計算する値(computeTsuboUnitPrice)を
            // ライブプレースホルダとして見せる。price/landArea の入力に追随する（[Task1]）。
            const placeholder =
              kind === "land" && f.key === "unitPrice"
                ? tsuboUnitPricePlaceholder(values.price, values.landArea)
                : undefined;
            return (
              <div key={f.key}>
                {hints[f.key] && (
                  <p className="mb-1 text-[11px] text-neutral-400">自動反映: {hints[f.key]}</p>
                )}
                <FieldModelWidget
                  idPrefix={kind}
                  field={f}
                  value={displayValue}
                  onChange={(v) => onChange(f.key, v)}
                  placeholder={placeholder}
                />
              </div>
            );
          })}
        </fieldset>
      ))}
    </>
  );
}

/**
 * キャッチコピー／セールスポイント（field-model の行ではない、レイアウト専用の上書き）。
 * mansion/land 共通（[F2-A Task4] 汎用化。両ビルダーとも buildSpecSheetDocument へ同じ
 * catchCopy/salesPoints を渡す＝レイアウトが共有のため入力欄も共有できる）。salesPoints は
 * 「1行に1つ」の文字列として編集し、送信直前に buildFieldModelOverridePayload が配列化する。
 */
export function CatchCopyFields({
  kind,
  values,
  onChange,
}: {
  kind: SalesSheetTemplateKind;
  values: FieldModelValues;
  onChange: (key: string, value: FieldModelValue) => void;
}) {
  const salesPointsText =
    typeof values.salesPoints === "string"
      ? values.salesPoints
      : Array.isArray(values.salesPoints)
        ? values.salesPoints.join("\n")
        : "";
  return (
    <fieldset className="mb-1 space-y-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
      <legend className="mb-1 text-xs font-bold text-neutral-500 dark:text-neutral-400">
        キャッチ・訴求
      </legend>
      <div className="flex items-center gap-2">
        <label
          htmlFor={`ss-${kind}-catchCopy`}
          className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300"
        >
          キャッチコピー
        </label>
        <input
          id={`ss-${kind}-catchCopy`}
          aria-label="キャッチコピー"
          value={typeof values.catchCopy === "string" ? values.catchCopy : ""}
          onChange={(e) => onChange("catchCopy", e.target.value)}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
      </div>
      <div className="flex items-start gap-2">
        <label
          htmlFor={`ss-${kind}-salesPoints`}
          className="w-28 shrink-0 pt-1 text-sm text-gray-700 dark:text-gray-300"
        >
          セールスポイント
        </label>
        <textarea
          id={`ss-${kind}-salesPoints`}
          aria-label="セールスポイント"
          value={salesPointsText}
          onChange={(e) => onChange("salesPoints", e.target.value)}
          rows={3}
          placeholder="1行に1つ入力"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
      </div>
    </fieldset>
  );
}

/**
 * 販売図面の作成ダイアログ（制御コンポーネント）。
 * 物件詳細の作成ボタンと、販売図面ピッカー（/sales-sheets/new）の両方から使う。
 * 呼び出し側は物件が変わるたび key={propertyId} で remount して入力値の持ち越しを防ぐ。
 */
export function SalesSheetCreateDialog({
  propertyId,
  kind,
  open,
  onClose,
}: {
  propertyId: string;
  kind: SalesSheetTemplateKind;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const cfg = FIELD_SETS[kind];
  const fieldModel = FIELDS_BY_KIND[kind];
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldModelValues, setFieldModelValues] = useState<FieldModelValues>({});
  const [autoPreview, setAutoPreview] = useState<Record<string, string>>({});
  const [occupancySeed, setOccupancySeed] = useState<string | undefined>(undefined);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // field-model がある種別(mansion/land)のみ: 開いたときに物件（＋建物、mansionのみ）データを
  // 取得し、自動反映専用フィールドのプレビューと occupancy(現況) select の表示ヒント、
  // useDistrict/roadWidth/builtYearMonth 等のテキスト系ヒントを用意する（ベストエフォート・
  // 取得失敗時は自動反映無しでダイアログ自体は使用可能なまま）。SSR
  // （renderToStaticMarkup）は effect を実行しないため、この fetch は静的マークアップ
  // （widget構造）の検証には影響しない。
  //
  // occupancy は意図的に fieldModelValues へ書き込まない（@codex P2 fix・mansion から
  // 継承した設計）: 以前はここで setMansionValues して occupancy を送信payloadへ混入させて
  // いたため、fetch が submit に間に合うかどうかのタイミングだけで、同じ物件から異なる
  // 現況が生成される不具合があった。occupancySeed は FieldModelForm の表示専用ヒントにしか
  // 使わない＝ユーザーが select を実際に操作しない限り occupancy は送信されず、
  // buildMansionValues/buildLandValues 側の決定的デフォルト
  // （mapOccupancyStatusToMansionOccupancy/mapOccupancyStatusToLandOccupancy、これらと
  // 同一関数）に委ねられる。
  useEffect(() => {
    const compute = AUTO_COMPUTE_BY_KIND[kind];
    if (!open || !compute) return;
    let cancelled = false;
    fetchPropertyDetail(propertyId)
      .then((raw) => {
        if (cancelled) return;
        const auto = compute(raw);
        setAutoPreview(auto.preview);
        setOccupancySeed(auto.occupancySeed);
        setHints(auto.hints);
      })
      .catch(() => {
        /* ベストエフォート。取得失敗時は自動反映プレビュー無しで継続する。 */
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, propertyId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = fieldModel ? buildFieldModelOverridePayload(fieldModelValues) : values;
      const { url, init } = buildCreateRequest(propertyId, body);
      const res = await fetch(url, init);
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(errBody?.error?.message ?? "販売図面の作成に失敗しました");
        return;
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/properties/${propertyId}/sales-sheets/${id}/edit`);
    } catch {
      setError("販売図面の作成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-800">
        <h2 className="mb-3 text-base font-bold text-gray-900 dark:text-gray-100">
          販売図面（{cfg.label}）の作成
        </h2>
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          システムに無い項目を入力してください（空欄可）。作成後、配置や文字はエディタで調整できます。
        </p>
        {fieldModel ? (
          <div>
            <FieldModelForm
              kind={kind}
              sections={SECTIONS_BY_KIND[kind]}
              autoOnlyKeys={AUTO_ONLY_KEYS_BY_KIND[kind]}
              values={fieldModelValues}
              onChange={(key, v) => setFieldModelValues((prev) => ({ ...prev, [key]: v }))}
              autoPreview={autoPreview}
              occupancySeed={occupancySeed}
              hints={hints}
            />
            <CatchCopyFields
              kind={kind}
              values={fieldModelValues}
              onChange={(key, v) => setFieldModelValues((prev) => ({ ...prev, [key]: v }))}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {cfg.fields.map((f) => (
              <div key={f.key} className="flex items-center gap-2">
                <label
                  htmlFor={`ss-${f.key}`}
                  className="w-24 shrink-0 text-sm text-gray-700 dark:text-gray-300"
                >
                  {f.label}
                </label>
                <input
                  id={`ss-${f.key}`}
                  aria-label={f.label}
                  className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-neutral-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "作成中…" : "作成してエディタを開く"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 物件種別に応じた販売図面の作成ボタン＋作成フォーム（作成後エディタへ遷移）。 */
export function SalesSheetCreateButton({
  propertyId,
  canWrite,
  kind,
}: {
  propertyId: string;
  canWrite: boolean;
  kind: SalesSheetTemplateKind;
}) {
  const cfg = FIELD_SETS[kind];
  const [open, setOpen] = useState(false);

  // /sales-sheets/new は property:write を要求するため、read-only ユーザーには作成導線を出さない
  // （表示してもクリックで 403 dead-end になる）。route 側の property:write チェックは別途維持。
  if (!canWrite) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-indigo-300 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
      >
        販売図面を作成（{cfg.label}）
      </button>
      <SalesSheetCreateDialog
        propertyId={propertyId}
        kind={kind}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
