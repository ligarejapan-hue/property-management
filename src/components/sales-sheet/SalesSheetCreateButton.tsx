"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SalesSheetTemplateKind } from "@/lib/sales-sheet/template-kind";
import { fetchPropertyDetail } from "@/lib/api-client";
import { MANSION_FIELDS, type SheetField } from "@/lib/sales-sheet/field-model";
import { mapOccupancyStatusToMansionOccupancy } from "@/lib/sales-sheet/occupancy";

export type { SalesSheetTemplateKind };

interface FieldConfig {
  /** 表題・ボタン・モーダルに使うテンプレ名（例: 売マンション）。 */
  label: string;
  /** 作成時に入力する上書き項目。key は route の overridesSchema と一致させる。 */
  fields: { key: string; label: string }[];
}

// 種別ごとの作成フォーム項目。key は new route の per-type overridesSchema と揃える。
// （テンプレの実データはサーバ側で物件レコードから補完し、ここでは「システムに無い値」だけ集める）
// mansion のみ MANSION_FIELDS(field-model) 駆動のダイアログへ差し替え済みのため
// fields は未使用（label はボタン/見出し表示に引き続き使う）。
const FIELD_SETS: Record<SalesSheetTemplateKind, FieldConfig> = {
  land: {
    label: "売土地",
    fields: [
      { key: "price", label: "価格" },
      { key: "access", label: "交通" },
      { key: "landArea", label: "土地面積" },
      { key: "landCategory", label: "地目" },
      { key: "transactionType", label: "取引態様" },
      { key: "deliveryTiming", label: "引渡" },
      { key: "remarks", label: "備考（公開）" },
    ],
  },
  mansion: {
    label: "売マンション",
    fields: [],
  },
  house: {
    label: "売戸建",
    fields: [
      { key: "price", label: "価格" },
      { key: "access", label: "交通" },
      { key: "landArea", label: "土地面積" },
      { key: "buildingArea", label: "建物面積" },
      { key: "builtYearMonth", label: "築年月" },
      { key: "structure", label: "構造" },
      { key: "transactionType", label: "取引態様" },
      { key: "deliveryTiming", label: "引渡" },
      { key: "remarks", label: "備考（公開）" },
    ],
  },
  building: {
    label: "一棟",
    fields: [
      { key: "price", label: "価格" },
      { key: "access", label: "交通" },
      { key: "landArea", label: "土地面積" },
      { key: "totalFloorArea", label: "延床面積" },
      { key: "totalUnits", label: "総戸数" },
      { key: "builtYearMonth", label: "築年月" },
      { key: "structure", label: "構造" },
      { key: "grossYield", label: "想定利回り" },
      { key: "expectedIncome", label: "満室想定収入" },
      { key: "transactionType", label: "取引態様" },
      { key: "deliveryTiming", label: "引渡" },
      { key: "remarks", label: "備考（公開）" },
    ],
  },
};

/**
 * 新規デザイン作成 API へのリクエスト内容を組み立てる純関数。
 * テンプレ種別はサーバ側で物件種別から判定するため body には含めない（上書き項目のみ）。
 * mansion は multiselect（用途地域/セールスポイント）があるため string[] も許容する。
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
// 売マンション: field-model(MANSION_FIELDS) 駆動の作成ダイアログ
// ============================================================================

export type MansionFieldValue = string | string[];
export type MansionValues = Record<string, MansionFieldValue>;

/**
 * MANSION_FIELDS のうち、物件/建物レコードが正のため上書き機構を持たない自動反映専用キー。
 * ダイアログでは参照表示のみ（disabled・編集不可）にする＝編集しても送信されない。
 * route.ts の mansionOverridesSchema / build-document.ts の SaleMansionOverrides に
 * 対応するキーが無いことに合わせている（[T4→T5] carry-forward: structure は意図的に
 * 対象外。buildingName/address 等の他の自動反映専用フィールドも同じ理由＝
 * 単一ソースの事実値であり、シート単位で個別に上書きする設計にはしない）。
 * propertyType・occupancy は本タスクで新規に上書き可能へ昇格したためここには含めない。
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
// MANSION_FIELDS は静的なためモジュール読み込み時に一度だけ計算する。
const MANSION_SECTIONS = groupBySection(MANSION_FIELDS);

/**
 * ダイアログが自動反映の元データとして読む、物件詳細フェッチ結果の最小限の形。
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

interface MansionAutoValues {
  /** 自動反映専用フィールドの参照表示値（disabled input に表示）。 */
  preview: Record<string, string>;
  /**
   * occupancy(現況) select の「表示専用」初期値ヒント（mapOccupancyStatusToMansionOccupancy
   * で決定的に写像・写像できない場合もフォールバック値を返すため常に何かしら入る）。
   * mansionValues.occupancy 自体には書き込まない＝ユーザーが select を操作しない限り
   * 送信ペイロードに occupancy は含まれず、サーバ側の同一関数によるデフォルトに委ねる
   * （フェッチの成否・タイミングに依存させないための設計・@codex P2 fix）。
   */
  occupancySeed?: string;
  /** 用途地域チェック群の上に出す「自動反映済み」ヒント文言。 */
  zoningDistrictAuto?: string;
}

function toPreviewString(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 物件詳細フェッチ結果 → 自動反映専用プレビュー値・occupancy初期選択・用途地域ヒント。 */
function computeMansionAutoValues(data: MansionAutoSource): MansionAutoValues {
  const b = data.building ?? undefined;
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
    zoningDistrictAuto: data.zoningDistrict ?? undefined,
  };
}

/**
 * 送信直前に mansionValues → overrides payload へ変換する。
 * - salesPoints は編集中「1行に1つ」の文字列として保持し、ここで初めて改行区切り→配列化
 *   する（controlled textarea の value を都度フィルタ済み配列から再構成すると、入力中の
 *   末尾の空行/改行が消えて改行を打てなくなるため、編集中は文字列のまま保持する設計）。
 * - 空文字列・空配列のキーは省略する（未入力=undefined と等価に扱う既存規約に合わせる）。
 */
function buildMansionOverridePayload(
  values: MansionValues,
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

/** 1フィールド分の入力ウィジェット（select/multiselect/number/text）。 */
function MansionFieldWidget({
  field,
  value,
  onChange,
}: {
  field: SheetField;
  value: MansionFieldValue | undefined;
  onChange: (v: MansionFieldValue) => void;
}) {
  const id = `ss-mansion-${field.key}`;

  if (field.widget === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm text-gray-700 dark:text-gray-300">{field.label}</legend>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {(field.options ?? []).map((opt) => (
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
    return (
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
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
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

/** 自動反映専用フィールドの参照表示（disabled・編集不可＝物件/建物レコードが正）。 */
function MansionAutoPreviewField({ field, value }: { field: SheetField; value: string }) {
  const id = `ss-mansion-${field.key}`;
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

/**
 * 売マンション作成ダイアログの入力本体（MANSION_FIELDS 由来・section 別にグルーピングして描画）。
 * 状態を持たない提示コンポーネントとして切り出し、SSR（renderToStaticMarkup）で構造を
 * 検証できるようにする（親の SalesSheetCreateDialog が state / 自動反映フェッチを保持する）。
 */
export function MansionFieldModelForm({
  values,
  onChange,
  autoPreview,
  zoningDistrictAuto,
  occupancySeed,
}: {
  values: MansionValues;
  onChange: (key: string, value: MansionFieldValue) => void;
  autoPreview: Record<string, string>;
  zoningDistrictAuto?: string;
  /** occupancy(現況) select の表示専用の初期値ヒント（未編集時のみ使う。詳細は MansionAutoValues 参照）。 */
  occupancySeed?: string;
}) {
  return (
    <>
      {MANSION_SECTIONS.map(([section, fields]) => (
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
            if (MANSION_AUTO_ONLY_KEYS.has(f.key)) {
              return (
                <MansionAutoPreviewField key={f.key} field={f} value={autoPreview[f.key] ?? ""} />
              );
            }
            // occupancy(現況): 未編集時は自動反映ヒント(occupancySeed)を表示専用の初期値として
            // 見せるが、values(=送信payload の元)は書き換えない。ユーザーが select を実際に
            // 操作(onChange)しない限り occupancy は送信されず、サーバ側の決定的デフォルト
            // （mapOccupancyStatusToMansionOccupancy）に委ねる（@codex P2 fix: フェッチの
            // タイミングに依存して現況が変わる不具合の解消）。
            const displayValue =
              f.key === "occupancy" && values[f.key] === undefined ? occupancySeed : values[f.key];
            return (
              <div key={f.key}>
                {f.key === "useDistrict" && zoningDistrictAuto && (
                  <p className="mb-1 text-[11px] text-neutral-400">
                    自動反映: {zoningDistrictAuto}（追加の用途地域があれば選択してください）
                  </p>
                )}
                <MansionFieldWidget
                  field={f}
                  value={displayValue}
                  onChange={(v) => onChange(f.key, v)}
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
 * salesPoints は「1行に1つ」の文字列として編集し、送信直前に buildMansionOverridePayload
 * が配列化する。
 */
export function MansionExtraFields({
  values,
  onChange,
}: {
  values: MansionValues;
  onChange: (key: string, value: MansionFieldValue) => void;
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
          htmlFor="ss-mansion-catchCopy"
          className="w-28 shrink-0 text-sm text-gray-700 dark:text-gray-300"
        >
          キャッチコピー
        </label>
        <input
          id="ss-mansion-catchCopy"
          aria-label="キャッチコピー"
          value={typeof values.catchCopy === "string" ? values.catchCopy : ""}
          onChange={(e) => onChange("catchCopy", e.target.value)}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100"
        />
      </div>
      <div className="flex items-start gap-2">
        <label
          htmlFor="ss-mansion-salesPoints"
          className="w-28 shrink-0 pt-1 text-sm text-gray-700 dark:text-gray-300"
        >
          セールスポイント
        </label>
        <textarea
          id="ss-mansion-salesPoints"
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
  const [values, setValues] = useState<Record<string, string>>({});
  const [mansionValues, setMansionValues] = useState<MansionValues>({});
  const [mansionAutoPreview, setMansionAutoPreview] = useState<Record<string, string>>({});
  const [mansionZoningAuto, setMansionZoningAuto] = useState<string | undefined>(undefined);
  const [mansionOccupancySeed, setMansionOccupancySeed] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 売マンションのみ: 開いたときに物件/建物データを取得し、自動反映専用フィールドの
  // プレビューと occupancy(現況) select の表示ヒントを用意する（ベストエフォート・
  // 取得失敗時は自動反映無しでダイアログ自体は使用可能なまま）。
  // SSR（renderToStaticMarkup）は effect を実行しないため、この fetch は
  // 静的マークアップ（widget構造）の検証には影響しない。
  //
  // occupancy は意図的に mansionValues へ書き込まない（@codex P2 fix）: 以前はここで
  // setMansionValues して occupancy を送信payloadへ混入させていたため、fetch が
  // submit に間に合うかどうかのタイミングだけで、同じ物件から異なる現況が生成される
  // 不具合があった。mansionOccupancySeed は MansionFieldModelForm の表示専用ヒントに
  // しか使わない＝ユーザーが select を実際に操作しない限り occupancy は送信されず、
  // buildMansionValues 側の決定的デフォルト（mapOccupancyStatusToMansionOccupancy、
  // これと同一関数）に委ねられる。
  useEffect(() => {
    if (!open || kind !== "mansion") return;
    let cancelled = false;
    fetchPropertyDetail(propertyId)
      .then((raw) => {
        if (cancelled) return;
        const data = raw as unknown as MansionAutoSource;
        const auto = computeMansionAutoValues(data);
        setMansionAutoPreview(auto.preview);
        setMansionZoningAuto(auto.zoningDistrictAuto);
        setMansionOccupancySeed(auto.occupancySeed);
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
      const body = kind === "mansion" ? buildMansionOverridePayload(mansionValues) : values;
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
        {kind === "mansion" ? (
          <div>
            <MansionFieldModelForm
              values={mansionValues}
              onChange={(key, v) => setMansionValues((prev) => ({ ...prev, [key]: v }))}
              autoPreview={mansionAutoPreview}
              zoningDistrictAuto={mansionZoningAuto}
              occupancySeed={mansionOccupancySeed}
            />
            <MansionExtraFields
              values={mansionValues}
              onChange={(key, v) => setMansionValues((prev) => ({ ...prev, [key]: v }))}
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
