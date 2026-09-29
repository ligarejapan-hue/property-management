import type { UpcomingViewing } from "@/lib/api-client";
import { agentLabel, formatJst, VIEWING_TYPE_LABEL } from "@/lib/agent-inquiry/desk-form";

const propLabel = (p: { name: string; roomNo: string | null }) => (p.roomNo ? `${p.name} ${p.roomNo}` : p.name);

/** 今日・明日の内見(設計 §2.1)。取り消した内見は API 側で除いてある。 */
export function UpcomingViewingsView({ viewings }: { viewings: UpcomingViewing[] }) {
  return (
    <section className="rounded-lg bg-teal-50 p-3 dark:bg-gray-900">
      <h2 className="mb-1 text-sm font-bold">今日・明日の内見</h2>
      {viewings.length === 0 ? (
        <p className="text-sm text-gray-500">ありません</p>
      ) : (
        <ul className="space-y-1 text-sm tabular-nums">
          {viewings.map((v) => (
            <li key={v.id}>
              {formatJst(v.scheduledAt)} {VIEWING_TYPE_LABEL[v.viewingType]} {propLabel(v.inquiry.property)} ―{" "}
              {agentLabel(v.inquiry.agent)}
              {v.inquiry.contactName ? `(${v.inquiry.contactName}様)` : ""}
              {v.attendant ? ` ・ 立会 ${v.attendant.name}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
