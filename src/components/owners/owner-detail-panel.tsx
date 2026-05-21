"use client";

import { AlertTriangle, Lock } from "lucide-react";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";

interface OwnerData {
  name: string | null;
  nameKana: string | null;
  phone: string | null;
  zip: string | null;
  address: string | null;
  note: string | null;
  /** 法人番号（13桁、表示権限に応じて masked/hidden の場合もある）。 */
  corporateNumber?: string | null;
}

interface OwnerDetailPanelProps {
  owner: OwnerData;
}

function renderField(label: string, value: string | null): React.ReactNode {
  if (value === null || value === undefined) {
    return (
      <div key={label}>
        <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
          {label}
        </dt>
        <dd className="flex items-center gap-1.5 text-sm text-gray-400">
          <Lock className="h-3.5 w-3.5" />
          非表示
        </dd>
      </div>
    );
  }

  return (
    <div key={label}>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </dt>
      <dd className="text-sm text-gray-900">{value || "-"}</dd>
    </div>
  );
}

export default function OwnerDetailPanel({ owner }: OwnerDetailPanelProps) {
  // 法人番号が未設定で、name/address/note に法人番号らしき文字列が含まれる場合は
  // UI 上の注意表示を出す（自動上書きはしない）。
  // 候補値は detect の戻り値だが、ここでは表示せず「含まれている」事実だけ伝える。
  const detection = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  const showCorporateSuspect =
    !owner.corporateNumber && detection.candidates.length > 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
      <dl className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {renderField("氏名", owner.name)}
        {renderField("氏名カナ", owner.nameKana)}
        {renderField("電話番号", owner.phone)}
        {renderField("郵便番号", owner.zip)}
        <div className="md:col-span-2">
          {renderField("現住所", owner.address)}
        </div>
        {/* 法人番号（display-level に応じて null/masked/full）。
            将来 (Phase B) に「法人情報を検索」ボタンを置きやすい位置として
            「現住所」の直下に配置する。 */}
        {owner.corporateNumber !== undefined && (
          <div className="md:col-span-2">
            {renderField("法人番号", owner.corporateNumber)}
          </div>
        )}
        {showCorporateSuspect && (
          <div className="md:col-span-2">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                所有者の氏名・現住所・備考欄に法人番号らしき文字列が含まれています。
                編集モードで法人番号欄に転記してください。
              </div>
            </div>
          </div>
        )}
        <div className="md:col-span-2">
          {renderField("備考", owner.note)}
        </div>
      </dl>
    </div>
  );
}
