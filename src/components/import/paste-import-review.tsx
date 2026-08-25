"use client";

/**
 * 「貼り付けて物件化」確認画面の表示部品（Task 9）。
 *
 * 左に貼った原文、右に読み取り結果。読み取り結果の各欄は次の3状態を
 * 見た目で区別する:
 *   ① 拾えた   → 値 + どの見出しから来たかを小さく添える(emerald)
 *   ② 資料に無い → 空欄 + 「元の資料に記載がありません」(dashed gray・推測で埋めない)
 *   ③ 要確認   → 値 + 警告文(amber。今のところ物件種別が判別できなかった場合のみ)
 *
 * 値の保持は呼び出し元(page.tsx)が行う。この部品は`propertyValues`等の
 * controlled props を受け取り、`onXxxChange`へ差分を返すだけ(状態を持たない)。
 * ただし単体表示・テスト用に、props省略時は draft からそのまま初期値を作る。
 */
import type { ChangeEvent } from "react";
import Link from "next/link";
import type { DraftWarningCode, PasteDraft } from "@/lib/paste-import/types";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// API 契約（POST /api/import/paste のレスポンスの一部）。
// この部品でしか使わないのでここに置く。page.tsx から re-export して使う。
// ---------------------------------------------------------------------------

export interface PasteDuplicatesResult {
  blocked: boolean;
  blockedByPropertyId: string | null;
  similarPropertyIds: string[];
}

export interface SimilarPropertySummary {
  id: string;
  address: string | null;
  lotNumber: string | null;
}

export type OwnerMatchKind = "current_address" | "registry_address" | "name_only";

export interface OwnerCandidateSummary {
  id: string;
  name: string;
  matchKind: OwnerMatchKind;
}

export type OwnerMode = "link" | "new" | "none";

export type PropertyFieldKey = keyof PasteDraft["property"];
export type PropertyValues = Record<PropertyFieldKey, string>;

export type OwnerFieldKey = "name" | "nameKana" | "phone" | "email" | "currentAddress";
export type OwnerValues = Record<OwnerFieldKey, string>;

const OCCUPANCY_OPTIONS: { value: string; label: string }[] = [
  { value: "vacant", label: "空室" },
  { value: "occupied", label: "入居中" },
  { value: "unknown", label: "不明" },
];

/** 欄の並び（設計書のサンプルに合わせた順）。 */
const PROPERTY_FIELD_LABELS: { key: PropertyFieldKey; label: string }[] = [
  { key: "address", label: "住所" },
  { key: "lotNumber", label: "地番" },
  { key: "buildingName", label: "建物名" },
  { key: "roomNo", label: "部屋番号" },
  { key: "propertyType", label: "種別" },
  { key: "exclusiveArea", label: "専有面積(m²)" },
  { key: "landArea", label: "土地面積(m²)" },
  { key: "layoutType", label: "間取り" },
  { key: "occupancyStatus", label: "現況" },
  { key: "builtYear", label: "築年" },
];

const OWNER_FIELD_LABELS: { key: OwnerFieldKey; label: string }[] = [
  { key: "name", label: "氏名" },
  { key: "nameKana", label: "フリガナ" },
  { key: "phone", label: "電話番号" },
  { key: "email", label: "メールアドレス" },
  { key: "currentAddress", label: "現住所" },
];

const MATCH_KIND_LABELS: Record<OwnerMatchKind, string> = {
  current_address: "連絡先の住所も一致",
  registry_address: "登記上の住所と一致",
  name_only: "氏名だけ一致（同姓同名の別人かもしれません）",
};

/** 欄ごとに紐づく警告コード(要確認状態を出す欄のみ)。 */
const FIELD_WARNING_CODE: Partial<Record<PropertyFieldKey, DraftWarningCode>> = {
  propertyType: "property_type_unknown",
};

export function defaultPropertyValues(draft: PasteDraft): PropertyValues {
  return {
    address: draft.property.address.value ?? "",
    lotNumber: draft.property.lotNumber.value ?? "",
    buildingName: draft.property.buildingName.value ?? "",
    roomNo: draft.property.roomNo.value ?? "",
    propertyType: draft.property.propertyType.value ?? "",
    exclusiveArea: draft.property.exclusiveArea.value ?? "",
    landArea: draft.property.landArea.value ?? "",
    layoutType: draft.property.layoutType.value ?? "",
    occupancyStatus: draft.property.occupancyStatus.value ?? "",
    builtYear: draft.property.builtYear.value ?? "",
  };
}

export function defaultOwnerValues(draft: PasteDraft): OwnerValues {
  const o = draft.owner;
  return {
    name: o?.name.value ?? "",
    nameKana: o?.nameKana.value ?? "",
    phone: o?.phone.value ?? "",
    email: o?.email.value ?? "",
    currentAddress: o?.currentAddress.value ?? "",
  };
}

export function defaultOwnerMode(draft: PasteDraft): OwnerMode {
  return draft.owner ? "new" : "none";
}

// ---------------------------------------------------------------------------
// FieldRow: 1つの欄。3状態を見た目で分ける。
// ---------------------------------------------------------------------------

const BOX_BASE = "w-full rounded-md border px-3 py-2 text-sm";
const BOX_OK = `${BOX_BASE} border-emerald-600 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-500/10 dark:text-gray-100`;
const BOX_MISSING = `${BOX_BASE} border-dashed border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300`;
const BOX_WARN = `${BOX_BASE} border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-500/10 dark:text-gray-100`;

function FieldRow({
  fieldKey,
  label,
  value,
  sourceLabel,
  warningMessage,
  onChange,
  selectOptions,
}: {
  fieldKey: string;
  label: string;
  value: string;
  sourceLabel: string | null;
  warningMessage?: string;
  onChange?: (value: string) => void;
  selectOptions?: { value: string; label: string }[];
}) {
  const hasValue = value.trim() !== "";
  const boxClass = !hasValue ? BOX_MISSING : warningMessage ? BOX_WARN : BOX_OK;
  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => onChange?.(e.target.value);

  return (
    <div
      data-field={fieldKey}
      data-value={hasValue ? value : undefined}
      className="grid grid-cols-1 gap-1 border-b border-dashed border-gray-200 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 dark:border-gray-700"
    >
      <label htmlFor={`paste-field-${fieldKey}`} className="pt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        {label}
      </label>
      <div>
        {selectOptions ? (
          <select
            id={`paste-field-${fieldKey}`}
            className={boxClass}
            value={value}
            onChange={handleChange}
          >
            <option value="">（未選択）</option>
            {selectOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`paste-field-${fieldKey}`}
            type="text"
            className={boxClass}
            value={value}
            onChange={handleChange}
          />
        )}
        {hasValue && sourceLabel && (
          <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-gray-500">
            {sourceLabel} から
          </span>
        )}
        {!hasValue && (
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            元の資料に記載がありません
          </p>
        )}
        {hasValue && warningMessage && (
          <p role="alert" className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
            {warningMessage}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PasteImportReview 本体
// ---------------------------------------------------------------------------

export interface PasteImportReviewProps {
  draft: PasteDraft;
  rawText: string;

  propertyValues?: PropertyValues;
  onPropertyFieldChange?: (key: PropertyFieldKey, value: string) => void;

  ownerValues?: OwnerValues;
  onOwnerFieldChange?: (key: OwnerFieldKey, value: string) => void;

  note?: string;
  onNoteChange?: (value: string) => void;

  duplicates?: PasteDuplicatesResult;
  similar?: SimilarPropertySummary[];

  ownerCandidates?: OwnerCandidateSummary[];
  ownerMode?: OwnerMode;
  onOwnerModeChange?: (mode: OwnerMode) => void;
  linkedOwnerId?: string | null;
  onLinkedOwnerChange?: (ownerId: string) => void;

  onRegister?: () => void;
  registering?: boolean;
  registerError?: string | null;
}

export function PasteImportReview({
  draft,
  rawText,
  propertyValues,
  onPropertyFieldChange,
  ownerValues,
  onOwnerFieldChange,
  note,
  onNoteChange,
  duplicates,
  similar,
  ownerCandidates,
  ownerMode,
  onOwnerModeChange,
  linkedOwnerId,
  onLinkedOwnerChange,
  onRegister,
  registering,
  registerError,
}: PasteImportReviewProps) {
  const pValues = propertyValues ?? defaultPropertyValues(draft);
  const oValues = ownerValues ?? defaultOwnerValues(draft);
  const noteValue = note ?? draft.noteFromUnmapped;
  const dup = duplicates ?? { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] };
  const similarList = similar ?? [];
  const candidates = ownerCandidates ?? [];
  const mode = ownerMode ?? defaultOwnerMode(draft);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* 左: 貼った原文 */}
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          貼った原文
        </h2>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {rawText}
        </pre>
      </section>

      {/* 右: 読み取り結果 */}
      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          読み取り結果（{draft.sourceProfileLabel}）
        </h2>

        {draft.warnings.map((w) => (
          <div
            key={w.code}
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {w.message}
          </div>
        ))}

        {dup.blocked && dup.blockedByPropertyId && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-red-400 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300"
          >
            この案件は登録済みです。{" "}
            <Link href={`/properties/${dup.blockedByPropertyId}`} className="underline">
              既存の物件を見る
            </Link>
          </div>
        )}

        {similarList.length > 0 && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300"
          >
            似た物件が見つかりました。二重登録でないか確認してください（登録はブロックしません）。
            <ul className="mt-1 list-disc pl-5">
              {similarList.map((s) => (
                <li key={s.id}>
                  <Link href={`/properties/${s.id}`} className="underline">
                    {s.address ?? s.lotNumber ?? s.id}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {PROPERTY_FIELD_LABELS.map((f) => {
          const draftField = draft.property[f.key];
          const warningCode = FIELD_WARNING_CODE[f.key];
          const warning = warningCode
            ? draft.warnings.find((w) => w.code === warningCode)
            : undefined;
          return (
            <FieldRow
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={pValues[f.key]}
              sourceLabel={draftField.sourceLabel}
              warningMessage={warning?.message}
              onChange={(v) => onPropertyFieldChange?.(f.key, v)}
              selectOptions={
                f.key === "propertyType"
                  ? PROPERTY_TYPE_OPTIONS.filter((o) =>
                      ["land", "house", "apartment_unit", "apartment_building", "apartment_block", "store", "office", "warehouse", "factory", "parking", "other", "unknown"].includes(o.value),
                    )
                  : f.key === "occupancyStatus"
                    ? OCCUPANCY_OPTIONS
                    : undefined
              }
            />
          );
        })}

        {/* 備考: 辞書に無かった見出しをまとめたもの。人が直せる */}
        <div className="grid grid-cols-1 gap-1 border-b border-dashed border-gray-200 py-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3 dark:border-gray-700">
          <label htmlFor="paste-field-note" className="pt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            備考
          </label>
          <textarea
            id="paste-field-note"
            rows={3}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            value={noteValue}
            onChange={(e) => onNoteChange?.(e.target.value)}
          />
        </div>

        {/* 所有者 */}
        <h3 className="mb-2 mt-4 text-xs font-bold tracking-wider text-gray-500 dark:text-gray-400">
          所有者
        </h3>

        <fieldset className="mb-3 space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
          <legend className="px-1 text-xs text-gray-500 dark:text-gray-400">
            所有者の扱いを選んでください
          </legend>

          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input
                type="radio"
                name="paste-owner-mode"
                checked={mode === "link" && linkedOwnerId === c.id}
                onChange={() => {
                  onOwnerModeChange?.("link");
                  onLinkedOwnerChange?.(c.id);
                }}
              />
              <span>
                {c.name}（{MATCH_KIND_LABELS[c.matchKind]}）
              </span>
            </label>
          ))}

          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="paste-owner-mode"
              checked={mode === "new"}
              onChange={() => onOwnerModeChange?.("new")}
            />
            <span>新しい所有者として登録する</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="paste-owner-mode"
              checked={mode === "none"}
              onChange={() => onOwnerModeChange?.("none")}
            />
            <span>所有者なしで登録する</span>
          </label>
        </fieldset>

        {mode === "new" &&
          OWNER_FIELD_LABELS.map((f) => {
            const draftField = draft.owner ? draft.owner[f.key] : null;
            return (
              <FieldRow
                key={f.key}
                fieldKey={`owner-${f.key}`}
                label={f.label}
                value={oValues[f.key]}
                sourceLabel={draftField?.sourceLabel ?? null}
                onChange={(v) => onOwnerFieldChange?.(f.key, v)}
              />
            );
          })}

        {/* 登録 */}
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={onRegister}
            disabled={dup.blocked || Boolean(registering)}
            title={dup.blocked ? "この案件は登録済みのため登録できません" : undefined}
          >
            {registering ? "登録しています…" : "この内容で登録"}
          </Button>
          {registerError && (
            <span role="alert" className="text-sm text-red-600 dark:text-red-400">
              {registerError}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
