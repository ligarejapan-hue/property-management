"use client";

import { useState, useEffect } from "react";
import { Loader2, X, Save, AlertTriangle } from "lucide-react";
import { USE_MOCK, fetchUsers } from "@/lib/api-client";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import {
  BUILDING_NAME_MAX_LENGTH,
  supportsBuildingName,
} from "@/lib/property-building-name";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";

interface AssigneeOption {
  id: string;
  name: string;
}

interface PropertyData {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  buildingName: string | null;
  realEstateNumber: string | null;
  registryStatus: string;
  dmStatus: string;
  gpsLat: number | null;
  gpsLng: number | null;
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  heightDistrict: string | null;
  firePreventionZone: string | null;
  scenicRestriction: string | null;
  roadType: string | null;
  roadWidth: number | null;
  frontageWidth: number | null;
  frontageDirection: string | null;
  setbackRequired: string | null;
  rosenkaValue: number | null;
  rosenkaYear: number | null;
  rebuildPermission: string | null;
  architectureNote: string | null;
  note: string | null;
  assignedTo: string | null;
  version: number;
  // ── 「販売」区分(F3 Task7) ─────────────────────────────────────────────
  salePrice: number | null;
  saleTaxType: string | null;
  saleTaxAmount: number | null;
  access: string | null;
  landArea: number | null;
  landAreaMethod: string | null;
  totalFloorArea: number | null;
  builtYear: number | null;
  builtMonth: number | null;
  structureType: string | null;
  aboveFloors: number | null;
  basementFloors: number | null;
  parking: string | null;
  totalUnits: number | null;
  grossYield: number | null;
  expectedIncome: number | null;
  exclusiveArea: number | null;
  balconyArea: number | null;
  layoutType: string | null;
  orientation: string | null;
  floorNo: number | null;
  managementFee: number | null;
  repairReserveFee: number | null;
  // ⚠区分マンションの構造・地上階・総戸数・築年月・地下階は「棟の値が正」
  //   (既存設計)。この画面からは編集できない・読み取り専用表示のみ。
  building: {
    id: string;
    name: string;
    structureType: string | null;
    totalFloors: number | null;
    totalUnits: number | null;
    basementFloors: number | null;
    builtYear: number | null;
    builtMonth: number | null;
  } | null;
}

interface PropertyEditFormProps {
  property: PropertyData;
  onClose: () => void;
  onSaved: () => void;
}

interface FormField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "clearOnly";
  options?: Array<{ value: string; label: string }>;
  section: string;
  /**
   * 文字数の上限 (保存時の検証と同じ値)。
   * ⚠input の `maxLength` には渡さない。生の文字数で打ち切ると、前後に空白の
   * ある上限ちょうどの値を貼ったときに**黙って実文字が削られる**。
   * 超過は注意書きで伝え、保存を止めるために使う。
   */
  maxLength?: number;
}

/** その項目が上限を超えているか。⚠**数える前に整える**。 */
function isOverMaxLength(
  field: FormField,
  value: string | undefined,
): boolean {
  if (field.maxLength == null) return false;
  return (value ?? "").trim().length > field.maxLength;
}

/**
 * その項目をいま画面に出すか。
 *
 * ⚠**描画と保存前の検証で同じ判定を使う** (@codex #354 P2)。別々に書くと、
 * 「隠れている項目のせいで保存できない」が起きる: 長すぎる物件名を入れたまま
 * 種別を対象外へ変えると欄は消えるのに検証だけ残り、**画面に無い項目を理由に
 * 保存が止まって直しようがなくなる**。
 */
function isFieldVisible(
  field: FormField,
  values: Record<string, string>,
  /** 元々(このフォームを開いた時点で)値が入っていた clearOnly 項目のキー。 */
  clearableKeys: ReadonlySet<string>,
): boolean {
  if (field.key === "buildingName") {
    return supportsBuildingName(values.propertyType);
  }
  // ⚠clearOnly は「新しく入れる」ためではなく「消す」ための欄。
  //   元から値がある物件でだけ出す(空の物件に欄が生えると、入れられてしまう)。
  //   判定は**開いた時点の値**で固定する。編集中に消した瞬間に欄が消えると、
  //   保存前に取り消せなくなる。
  if (field.type === "clearOnly") return clearableKeys.has(field.key);
  return true;
}

/** 区分マンション(新値/旧値どちらも)か。棟の項目を読み取り専用にする判定に使う。 */
function isMansionUnit(propertyType: string): boolean {
  return propertyType === "apartment_unit" || propertyType === "unit";
}

/**
 * 「販売」区分に出す欄(物件の種別ごと)。仕様書 §5.1。
 * ⚠区分マンションの構造・地上階・総戸数は含めない(棟の値が正・読み取り専用の
 *   別ブロックで表示する)。
 */
export function salesFieldsFor(propertyType: string): FormField[] {
  const price: FormField[] = [
    { key: "salePrice", label: "価格(万円)", type: "number", section: "販売" },
  ];
  const tax: FormField[] = [
    { key: "saleTaxType", label: "消費税", type: "text", section: "販売" },
    { key: "saleTaxAmount", label: "うち消費税(万円)", type: "number", section: "販売" },
  ];
  const access: FormField[] = [{ key: "access", label: "交通", type: "text", section: "販売" }];
  const land: FormField[] = [
    { key: "landArea", label: "土地面積(㎡)", type: "number", section: "販売" },
    { key: "landAreaMethod", label: "面積計測方式", type: "text", section: "販売" },
  ];
  const buildingBody: FormField[] = [
    { key: "totalFloorArea", label: "建物面積(延べ・㎡)", type: "number", section: "販売" },
    { key: "builtYear", label: "築年", type: "number", section: "販売" },
    { key: "builtMonth", label: "築月", type: "number", section: "販売" },
    { key: "structureType", label: "構造", type: "text", section: "販売" },
    { key: "aboveFloors", label: "地上階", type: "number", section: "販売" },
    { key: "basementFloors", label: "地下階", type: "number", section: "販売" },
    { key: "parking", label: "駐車場", type: "text", section: "販売" },
  ];
  switch (propertyType) {
    case "land":
      return [...price, ...access, ...land];
    case "house":
      return [...price, ...tax, ...access, ...land, ...buildingBody];
    case "apartment_building":
    case "apartment_block":
      return [
        ...price, ...tax, ...access, ...land, ...buildingBody,
        { key: "totalUnits", label: "総戸数", type: "number", section: "販売" },
        { key: "grossYield", label: "想定利回り(%)", type: "number", section: "販売" },
        { key: "expectedIncome", label: "満室想定収入(万円/年)", type: "number", section: "販売" },
      ];
    case "apartment_unit":
    case "unit":
      return [
        ...price, ...tax, ...access,
        { key: "exclusiveArea", label: "専有面積(㎡)", type: "number", section: "販売" },
        { key: "balconyArea", label: "バルコニー面積(㎡)", type: "number", section: "販売" },
        { key: "layoutType", label: "間取り", type: "text", section: "販売" },
        { key: "orientation", label: "向き", type: "text", section: "販売" },
        { key: "floorNo", label: "所在階", type: "number", section: "販売" },
        { key: "managementFee", label: "管理費(円/月)", type: "number", section: "販売" },
        { key: "repairReserveFee", label: "修繕積立金(円/月)", type: "number", section: "販売" },
        { key: "parking", label: "駐車場", type: "text", section: "販売" },
      ];
    default:
      return [];
  }
}

/**
 * [@codex P2] 「販売」区分に出しうる欄を、種別をまたいで重複なく集めたもの。
 *
 * 初期値の読み込みを**開いた時点の種別だけ**で行うと、編集中に種別を変えたときに
 * 新しく現れた欄が「空」のまま扱われる。保存は初期値(property)との差分で送るため、
 * その欄に値が入っている物件では「空へ変えた」と解釈され、**触っていない値が消える**。
 * 欄を出すかどうかは種別で決めるが、初期値は常に全部読み込む。
 */
export function allSalesFields(): FormField[] {
  // apartment_block / unit はそれぞれ apartment_building / apartment_unit の別名で
  // 同じ欄を返すため、代表の4種別で全ての欄を網羅できる。
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const t of ["land", "house", "apartment_building", "apartment_unit"]) {
    for (const f of salesFieldsFor(t)) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      out.push(f);
    }
  }
  return out;
}

const FORM_FIELDS: FormField[] = [
  { key: "propertyType", label: "種別", type: "select", section: "基本",
    options: PROPERTY_TYPE_OPTIONS },
  { key: "postalCode", label: "郵便番号", type: "text", section: "基本" },
  { key: "address", label: "住所", type: "text", section: "基本" },
  { key: "lotNumber", label: "地番", type: "text", section: "基本" },
  { key: "buildingNumber", label: "家屋番号", type: "text", section: "基本" },
  // 物件名(任意)。⚠**集合住宅の種別を選んでいるときだけ表示する**(描画側で判定)。
  // 土地や戸建には無い項目なので、常時出すと入力欄が無駄に増える。
  {
    key: "buildingName",
    label: "物件名",
    type: "text",
    section: "基本",
    maxLength: BUILDING_NAME_MAX_LENGTH,
  },
  // ⚠不動産番号は**新しく入れられない**が、**消すことはできる**(clearOnly)。
  //   番号が入ると所在検索の対象外になり、番号での取得は実サイトへ未配線=
  //   **謄本が取れない行き止まり**になる(2026-09-08 発注者判断=番号は作らない)。
  //   ⚠ただし CSV取込・謄本PDF取込からは**番号が入り得る**(重複判定の第1キー
  //   なので塞がない)。案内文が「番号を空にしてください」と言う以上、
  //   **空にする手段が画面に無ければ本当の行き止まりになる**(@codex #420 P1)。
  //   よって「元から値がある物件でだけ出る、消すだけの欄」を残す。
  { key: "realEstateNumber", label: "不動産番号", type: "clearOnly", section: "基本" },
  { key: "registryStatus", label: "登記状況", type: "select", section: "基本", options: [
    { value: "unconfirmed", label: "未取得" },
    { value: "scheduled", label: "取得中" },
    { value: "obtained", label: "取得済" },
  ]},
  { key: "dmStatus", label: "DM判断", type: "select", section: "基本", options: [
    { value: "send", label: "送付可" },
    { value: "hold", label: "未判断" },
    { value: "no_send", label: "送付不可" },
  ]},
  // assignedTo: options は users state から実行時に組み立てるため空のまま。
  // 詳細は JSX 内 select レンダリング特例 (field.key === "assignedTo") を参照。
  { key: "assignedTo", label: "担当者", type: "select", section: "基本", options: [] },
  { key: "gpsLat", label: "緯度", type: "number", section: "基本" },
  { key: "gpsLng", label: "経度", type: "number", section: "基本" },
  { key: "note", label: "備考", type: "textarea", section: "基本" },
  // Investigation
  { key: "zoningDistrict", label: "用途地域", type: "text", section: "調査" },
  { key: "buildingCoverageRatio", label: "建蔽率(%)", type: "number", section: "調査" },
  { key: "floorAreaRatio", label: "容積率(%)", type: "number", section: "調査" },
  { key: "heightDistrict", label: "高度地区", type: "text", section: "調査" },
  { key: "firePreventionZone", label: "防火地域", type: "text", section: "調査" },
  { key: "roadType", label: "道路種別", type: "text", section: "調査" },
  { key: "roadWidth", label: "道路幅員(m)", type: "number", section: "調査" },
  { key: "frontageWidth", label: "間口幅(m)", type: "number", section: "調査" },
  { key: "frontageDirection", label: "間口方角", type: "text", section: "調査" },
  { key: "rosenkaValue", label: "路線価(円/m²)", type: "number", section: "調査" },
  { key: "rosenkaYear", label: "路線価年度", type: "number", section: "調査" },
  { key: "architectureNote", label: "建築備考", type: "textarea", section: "調査" },
];

export default function PropertyEditForm({
  property,
  onClose,
  onSaved,
}: PropertyEditFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  // 住所補完の user-edit signal（Codex P2-G）。住所 input 直接編集時だけ true。
  const [addressEdited, setAddressEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<AssigneeOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // ⚠「消すだけの欄」を出すかは**開いた時点の値**で決める(編集中に欄が
  //   消えて取り消せなくなるのを防ぐ)。property が差し替わった時だけ更新。
  const [clearableKeys, setClearableKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    // 「販売」区分(F3 Task7)の欄は FORM_FIELDS に無いので、ここで併せて読み込む
    // (読み込まないと salePrice 等の初期値が空のままになる)。
    // ⚠[@codex P2] **開いた時点の種別だけ**で読むと、編集中に種別を変えて現れた欄が
    //   空扱いになり、保存の差分判定で「消した」と解釈されて既存値が飛ぶ。
    //   出す欄は種別で決めるが、初期値は全種別ぶん読む(allSalesFields のコメント参照)。
    const fieldsToLoad = [...FORM_FIELDS, ...allSalesFields()];
    const initial: Record<string, string> = {};
    for (const f of fieldsToLoad) {
      const val = (property as unknown as Record<string, unknown>)[f.key];
      initial[f.key] = val != null ? String(val) : "";
    }
    setValues(initial);
    setClearableKeys(
      new Set(
        fieldsToLoad
          .filter(
            (f) => f.type === "clearOnly" && (initial[f.key] ?? "").trim() !== "",
          )
          .map((f) => f.key),
      ),
    );
    // prop（既存値）再投入は user-edit ではない＝signal をリセット（初期ロードで検索しない）。
    setAddressEdited(false);
  }, [property]);

  // 「販売」区分の欄は種別ごとに変わる(編集中の select 変更にも追従する)。
  // ⚠values.propertyType は上の effect が走るまで未設定なので property.propertyType へ
  //   フォールバックする(初回描画のちらつき防止)。
  const salesFields = salesFieldsFor(values.propertyType ?? property.propertyType);
  const allFields = [...FORM_FIELDS, ...salesFields];
  const isMansion = isMansionUnit(values.propertyType ?? property.propertyType);

  useEffect(() => {
    let cancelled = false;
    setUsersLoading(true);
    fetchUsers()
      .then((res) => {
        if (cancelled) return;
        setUsers(res.data.map((u) => ({ id: u.id, name: u.name })));
      })
      .catch(() => {
        // 失敗時は「(未設定)」のみ。フォーム全体は落とさない。
        if (cancelled) return;
        setUsers([]);
      })
      .finally(() => {
        if (cancelled) return;
        setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      // ⚠種別を対象外へ変えたら物件名を**その場で消す**(新規登録フォームと同じ)。
      // 隠すだけだと、画面に無い値を保存へ送ることになる。API 側も同じ判断で
      // null にするが、画面上でも消えたことが見えるほうが分かりやすい。
      if (key === "propertyType" && !supportsBuildingName(value)) {
        next.buildingName = "";
      }
      return next;
    });
  };

  const handleSave = async () => {
    // 上限超過は保存前に止める (入力欄では打ち切っていないため)。
    // ⚠API も 422 で弾くが、どの項目かを画面で示すほうが直しやすい。
    // ⚠**いま表示している項目だけ**を見る。隠れている項目を理由に止めると、
    // 画面に無いものを直せと言うことになり手詰まりになる。
    const tooLong = allFields.find(
      (f) =>
        isFieldVisible(f, values, clearableKeys) &&
        isOverMaxLength(f, values[f.key]),
    );
    if (tooLong) {
      setError(
        `${tooLong.label}は${tooLong.maxLength}文字以内で入力してください（前後の空白は数えません）`,
      );
      return;
    }
    setSaving(true);
    setError(null);

    try {
      // Build update payload — 変更した項目だけ送る(PATCH)。既存の(CSV取込等で入った)不正値が残る項目を、
      // 無関係な項目の編集のたびに再送すると入力バリデーション(A2)で 422 になり「その物件が一切編集できない」
      // 状態に陥る。初期値(property)と一致する項目は送らないことでこれを防ぎ、未編集項目の上書き(競合)も避ける。
      const payload: Record<string, unknown> = { version: property.version };
      const propRecord = property as unknown as Record<string, unknown>;
      for (const f of allFields) {
        const raw = values[f.key] ?? "";
        const initialRaw = propRecord[f.key];
        const initialStr = initialRaw != null ? String(initialRaw) : "";
        if (raw === initialStr) continue; // 未変更 → 送らない
        if (f.type === "number") {
          payload[f.key] = raw ? Number(raw) : null;
        } else {
          payload[f.key] = raw || null;
        }
      }

      if (USE_MOCK) {
        // Mock: just simulate delay
        await new Promise((r) => setTimeout(r, 300));
        onSaved();
        return;
      }

      const res = await fetch(`/api/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `エラー: ${res.status}`,
        );
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const sections = [...new Set(allFields.map((f) => f.section))];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 py-8">
      <div
        className="mx-4 w-full max-w-3xl rounded-lg bg-white dark:bg-gray-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">物件情報を編集</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {sections.map((section) => (
            <div key={section} className="mb-6">
              <h4 className="mb-3 border-b border-gray-100 dark:border-gray-800 pb-1 text-sm font-semibold text-gray-600 dark:text-gray-300">
                {section}情報
              </h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {allFields.filter((f) => f.section === section)
                  // 条件つきの項目 (物件名など) はここで出し入れする。
                  // ⚠判定は保存前の検証と共有する (isFieldVisible)。
                  .filter((f) => isFieldVisible(f, values, clearableKeys))
                  .map(
                  (field) => (
                    <div
                      key={field.key}
                      className={
                        field.type === "textarea" ? "md:col-span-2" : ""
                      }
                    >
                      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                        {field.label}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          disabled={
                            field.key === "assignedTo" && usersLoading
                          }
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none disabled:bg-gray-100 dark:disabled:bg-gray-800"
                        >
                          {field.key === "assignedTo" ? (
                            <>
                              <option value="">(未設定)</option>
                              {users.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name}
                                </option>
                              ))}
                            </>
                          ) : (
                            field.options?.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))
                          )}
                        </select>
                      ) : field.type === "clearOnly" ? (
                        // ⚠**消すだけの欄**。打ち直せないが空にはできる。
                        //   CSV取込等で入った番号がある物件は謄本を取れないため、
                        //   「番号を空にしてください」という案内に従う手段として必要。
                        <>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              readOnly
                              value={values[field.key] ?? ""}
                              data-testid={`clear-only-${field.key}`}
                              placeholder="(なし)"
                              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400"
                            />
                            <button
                              type="button"
                              onClick={() => handleChange(field.key, "")}
                              disabled={(values[field.key] ?? "") === ""}
                              data-testid={`clear-only-${field.key}-clear`}
                              className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                            >
                              空にする
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            新しく入力することはできません。空にして保存すると、地番（建物は家屋番号）での謄本取得が使えるようになります。
                          </p>
                        </>
                      ) : field.type === "textarea" ? (
                        <textarea
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          rows={3}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none resize-y"
                        />
                      ) : (
                        <input
                          type={field.type}
                          // ⚠**maxLength は使わない** (@codex #354 P2)。生の文字数で
                          // 打ち切るため、前後に空白のある上限ちょうどの値を貼ると
                          // ブラウザが**黙って実文字を削る**。超過は下の注意書きで
                          // 伝え、保存を止める。
                          value={values[field.key] ?? ""}
                          onChange={(e) => {
                            // 住所のユーザー直接編集だけ user-edit signal を立てる。
                            if (field.key === "address") setAddressEdited(true);
                            handleChange(field.key, e.target.value);
                          }}
                          step={field.type === "number" ? "any" : undefined}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        />
                      )}
                      {/* 上限のある項目の超過を、打ち終える前に伝える。
                          ⚠数える前に trim する (前後の空白で弾かない)。 */}
                      {isOverMaxLength(field, values[field.key]) && (
                        <p
                          role="status"
                          data-testid={`edit-too-long-${field.key}`}
                          className="mt-1 text-xs text-amber-700 dark:text-amber-300"
                        >
                          {field.label}は{field.maxLength}
                          文字以内で入力してください（前後の空白は数えません）
                        </p>
                      )}
                      {field.key === "address" && (
                        <div className="mt-1.5">
                          {/* 郵便番号⇄住所 補完。候補確定は postalCode/address をペア反映。
                              onZipChange/onAddressChange は addressEdited を立てない。 */}
                          <AddressLookupControls
                            zip={values.postalCode ?? ""}
                            address={values.address ?? ""}
                            onZipChange={(z) => handleChange("postalCode", z)}
                            onAddressChange={(a) => handleChange("address", a)}
                            addressEdited={addressEdited}
                            disabled={saving}
                            mode="both"
                          />
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
              {/* 区分マンション: 構造・地上階・地下階・総戸数・築年月は「棟の値が正」
                  (既存設計)。この画面では編集できない・読み取り専用表示+棟の画面への
                  リンクのみ(F3 Task7)。 */}
              {section === "販売" && isMansion && property.building && (
                <div className="mt-3 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-700">
                  <p className="mb-1 font-semibold">棟の項目(この画面では変更できません)</p>
                  <p>
                    構造 {property.building.structureType ?? "—"} / 地上階{" "}
                    {property.building.totalFloors ?? "—"} / 地下階{" "}
                    {property.building.basementFloors ?? "—"} / 総戸数{" "}
                    {property.building.totalUnits ?? "—"} / 築年月{" "}
                    {property.building.builtYear ?? "—"}年{property.building.builtMonth ?? "—"}月
                  </p>
                  <a
                    href={`/buildings/${property.building.id}`}
                    className="text-blue-600 underline dark:text-blue-400"
                  >
                    棟の画面で直す
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-800 px-6 py-4">
          <span className="mr-auto text-xs text-gray-400 dark:text-gray-500">
            バージョン: {property.version}
          </span>
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
