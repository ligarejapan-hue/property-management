"use client";

import { Lock } from "lucide-react";

interface OwnerData {
  name: string | null;
  nameKana: string | null;
  phone: string | null;
  zip: string | null;
  address: string | null;
  note: string | null;
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
        <div className="md:col-span-2">
          {renderField("備考", owner.note)}
        </div>
      </dl>
    </div>
  );
}
