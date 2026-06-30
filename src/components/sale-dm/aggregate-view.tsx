"use client";

import type { SaleDmCampaign } from "@/lib/api-client";
import { buildVariantRows } from "@/lib/sale-dm-letter/aggregate-view-model";

export default function SaleDmAggregateView({ campaign }: { campaign: SaleDmCampaign }) {
  const rows = buildVariantRows(campaign);
  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-3 py-2 font-medium text-gray-600">型</th>
            <th className="px-3 py-2 font-medium text-gray-600">送付</th>
            <th className="px-3 py-2 font-medium text-gray-600">到達</th>
            <th className="px-3 py-2 font-medium text-gray-600">宛先不明</th>
            <th className="px-3 py-2 font-medium text-gray-600">反響</th>
            <th className="px-3 py-2 font-medium text-gray-600">反響率</th>
            <th className="px-3 py-2 font-medium text-gray-600">宛先不明率</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.variantId}>
              <td className="px-3 py-2 font-semibold">型 {r.label}</td>
              <td className="px-3 py-2">{r.sent}</td>
              <td className="px-3 py-2">{r.delivered}</td>
              <td className="px-3 py-2">{r.undeliverable}</td>
              <td className="px-3 py-2">{r.inquiries}</td>
              <td className="px-3 py-2 font-medium text-indigo-700">{r.inquiryRate}</td>
              <td className="px-3 py-2 font-medium text-red-700">{r.undeliverableRate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
