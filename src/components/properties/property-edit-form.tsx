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
}

interface PropertyEditFormProps {
  property: PropertyData;
  onClose: () => void;
  onSaved: () => void;
}

interface FormField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea";
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
  { key: "realEstateNumber", label: "不動産番号", type: "text", section: "基本" },
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

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const f of FORM_FIELDS) {
      const val = (property as unknown as Record<string, unknown>)[f.key];
      initial[f.key] = val != null ? String(val) : "";
    }
    setValues(initial);
    // prop（既存値）再投入は user-edit ではない＝signal をリセット（初期ロードで検索しない）。
    setAddressEdited(false);
  }, [property]);

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
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    // 上限超過は保存前に止める (入力欄では打ち切っていないため)。
    // ⚠API も 422 で弾くが、どの項目かを画面で示すほうが直しやすい。
    const tooLong = FORM_FIELDS.find((f) => isOverMaxLength(f, values[f.key]));
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
      for (const f of FORM_FIELDS) {
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

  const sections = [...new Set(FORM_FIELDS.map((f) => f.section))];

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
                {FORM_FIELDS.filter((f) => f.section === section)
                  // 物件名は集合住宅の種別のときだけ出す。⚠判定は**いま選んで
                  // いる種別**(values.propertyType) で見る。保存前に種別を変えた
                  // ら、その場で欄が出入りする方が分かりやすい。
                  .filter(
                    (f) =>
                      f.key !== "buildingName" ||
                      supportsBuildingName(values.propertyType),
                  )
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
