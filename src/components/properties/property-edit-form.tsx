"use client";

import { useState, useEffect } from "react";
import { Loader2, X, Save, AlertTriangle } from "lucide-react";
import { USE_MOCK } from "@/lib/api-client";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";

interface PropertyData {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
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
}

const FORM_FIELDS: FormField[] = [
  { key: "propertyType", label: "種別", type: "select", section: "基本",
    options: PROPERTY_TYPE_OPTIONS },
  { key: "address", label: "住所", type: "text", section: "基本" },
  { key: "lotNumber", label: "地番", type: "text", section: "基本" },
  { key: "buildingNumber", label: "家屋番号", type: "text", section: "基本" },
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const f of FORM_FIELDS) {
      const val = (property as unknown as Record<string, unknown>)[f.key];
      initial[f.key] = val != null ? String(val) : "";
    }
    setValues(initial);
  }, [property]);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // Build update payload
      const payload: Record<string, unknown> = { version: property.version };
      for (const f of FORM_FIELDS) {
        const raw = values[f.key];
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
        className="mx-4 w-full max-w-3xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="text-lg font-bold text-gray-800">物件情報を編集</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {sections.map((section) => (
            <div key={section} className="mb-6">
              <h4 className="mb-3 border-b border-gray-100 pb-1 text-sm font-semibold text-gray-600">
                {section}情報
              </h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {FORM_FIELDS.filter((f) => f.section === section).map(
                  (field) => (
                    <div
                      key={field.key}
                      className={
                        field.type === "textarea" ? "md:col-span-2" : ""
                      }
                    >
                      <label className="mb-1 block text-xs font-medium text-gray-500">
                        {field.label}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        >
                          {field.options?.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "textarea" ? (
                        <textarea
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          rows={3}
                          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
                        />
                      ) : (
                        <input
                          type={field.type}
                          value={values[field.key] ?? ""}
                          onChange={(e) =>
                            handleChange(field.key, e.target.value)
                          }
                          step={field.type === "number" ? "any" : undefined}
                          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                        />
                      )}
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-4">
          <span className="mr-auto text-xs text-gray-400">
            バージョン: {property.version}
          </span>
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
