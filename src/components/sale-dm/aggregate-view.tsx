"use client";

import type { SaleDmCampaign } from "@/lib/api-client";
import { buildVariantRows, buildDmViewRows, buildLpVariantRows, buildPairRows } from "@/lib/sale-dm-letter/aggregate-view-model";
// 表示の可否は画面と API で**同じ1か所**を見る(@codex R4 P2)。
import { LP_METRICS_ENABLED } from "@/lib/sale-dm-letter/lp-metrics-flag";

const th = "px-3 py-2 font-medium text-gray-600";
const td = "px-3 py-2";

function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<{ key: string; cells: Array<string | number>; strong?: number[]; danger?: number[] }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600">{title}</div>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) => (
                <td
                  key={i}
                  className={`${td} ${i === 0 ? "font-semibold" : ""} ${r.danger?.includes(i) ? "font-medium text-red-700" : r.strong?.includes(i) ? "font-medium text-indigo-700" : ""}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 3つの見方(設計 2026-09-08 §2.1)。率の隣に必ず分母と件数を置く(少数での早合点を防ぐ)。
export default function SaleDmAggregateView({ campaign }: { campaign: SaleDmCampaign }) {
  const dmRows = buildVariantRows(campaign);
  const viewRows = new Map(buildDmViewRows(campaign).map((r) => [r.variantId, r]));
  const lpRows = buildLpVariantRows(campaign);
  const pairRows = buildPairRows(campaign);
  if (dmRows.length === 0) return null;
  return (
    <div className="space-y-3">
      <Table
        title="DM型ごと(文面の成績 = 閲覧率)"
        head={["型", "送付", "到達", "宛先不明", "閲覧", "閲覧率", "反響", "反響率", "宛先不明率"]}
        rows={dmRows.map((r) => {
          const v = viewRows.get(r.variantId);
          return { key: r.variantId, cells: [`型 ${r.label}`, r.sent, r.delivered, r.undeliverable, v?.viewed ?? 0, v?.viewRate ?? "—", r.inquiries, r.inquiryRate, r.undeliverableRate], strong: [5, 7], danger: [8] };
        })}
      />
      {LP_METRICS_ENABLED ? (
        <>
          <Table
            title="LP型ごと(ページの成績。申込率は申込フォーム対応後に追加)"
            head={["LP型", "送付", "到達", "閲覧", "閲覧率"]}
            rows={lpRows.map((r) => ({ key: r.lpVariantId, cells: [r.label, r.sent, r.delivered, r.viewed, r.viewRate], strong: [4] }))}
          />
          <Table
            title="組み合わせ(DM型 × LP型)"
            head={["組", "送付", "到達", "閲覧"]}
            rows={pairRows.map((r) => ({ key: r.key, cells: [r.label, r.sent, r.delivered, r.viewed] }))}
          />
        </>
      ) : campaign.lpVariants.length > 0 ? (
        <p className="text-xs text-gray-500">LP型ごとの成績は、QRの飛び先がアプリ内のご案内ページになる次の段階から表示します(いまは全員が同じ外部LPを開くため、LP型別の閲覧は比べられません)。</p>
      ) : null}
    </div>
  );
}
