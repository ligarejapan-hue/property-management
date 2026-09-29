import type { InquiryStatusKey, InquiryView } from "@/lib/api-client";
import { Tabs, tabPanelProps } from "@/components/ui/tabs";
import { CHANNEL_LABEL, KIND_LABEL, STATUS_LABEL, agentLabel, formatJst } from "@/lib/agent-inquiry/desk-form";

const TABS: InquiryStatusKey[] = ["open", "in_progress", "done"];

/** 反響の一覧(設計 §2.1)。状態タブ・自分の担当だけ・新しい順・もっと見る。 */
export function InquiryListView({
  tab,
  onTab,
  mine,
  onMine,
  items,
  openCount,
  onOpen,
  hasMore,
  onMore,
}: {
  tab: InquiryStatusKey;
  onTab: (t: InquiryStatusKey) => void;
  mine: boolean;
  onMine: (v: boolean) => void;
  items: InquiryView[];
  openCount: number | null;
  onOpen: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Tabs
          idBase="agent-inquiry-status"
          tabs={TABS.map((t) => ({
            key: t,
            label: t === "open" && openCount != null ? `${STATUS_LABEL[t]} ${openCount}` : STATUS_LABEL[t],
          }))}
          active={tab}
          onChange={onTab}
        />
        <label className="mb-1 flex items-center gap-1 text-xs">
          <input type="checkbox" checked={mine} onChange={(e) => onMine(e.target.checked)} />
          自分の担当だけ
        </label>
      </div>
      <ul className="space-y-1" {...tabPanelProps("agent-inquiry-status", tab)}>
        {items.map((q) => (
          <li key={q.id}>
            <button
              type="button"
              onClick={() => onOpen(q.id)}
              className="block w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-left hover:border-teal-600 dark:border-gray-800 dark:bg-gray-900"
            >
              <span className="flex justify-between text-xs text-gray-500">
                <span>
                  {formatJst(q.receivedAt)} ・ {CHANNEL_LABEL[q.channel]}
                </span>
                <span>{KIND_LABEL[q.kind]}</span>
              </span>
              <span className="block text-sm font-medium">
                {q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name} ― {agentLabel(q.agent)}
                {/* 画面保護はボタンの中を外で見ないので、個人情報には自前の印を付ける(@codex #459 R4)。 */}
                {q.contactName && (
                  <span data-pii-protected="true" data-pii-surface="dashboard">{`(${q.contactName}様)`}</span>
                )}
              </span>
              <span className="block text-xs text-gray-500">担当:{q.assignee?.name ?? "未定"}</span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-gray-500">ありません</li>}
      </ul>
      {hasMore && (
        <button type="button" onClick={onMore} className="w-full rounded-md border border-gray-300 py-2 text-sm dark:border-gray-700">
          もっと見る
        </button>
      )}
    </section>
  );
}
