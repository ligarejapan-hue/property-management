import { apiErrorCode, type AgentDetail, type AgentHistoryItem } from "@/lib/api-client";
import { KIND_LABEL, STATUS_LABEL, isAmbiguousSaveError } from "@/lib/agent-inquiry/desk-form";
import { AGENT_EDIT_FIELDS, agentFieldValue, formatJstFull, type AgentEditKey, type AgentEdits } from "@/lib/agent-inquiry/main-view";
import { isValidPhoneJp } from "@/lib/phone-format-jp";

const inputCls =
  "mt-0.5 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

/** 業者の保存(編集・しまう・戻す)に失敗したときの文言。 */
export function agentSaveErrorMessage(e: unknown): string {
  const code = apiErrorCode(e);
  if (code === "VERSION_CONFLICT") return "他の人が先に更新しました。最新の内容を読み直しました。内容を確かめて、もう一度保存してください。";
  if (code === "FORBIDDEN") return "業者を変更する権限がありません。";
  if (code === "VALIDATION_ERROR") return "入力を確かめてください(メールの形式・文字数など)。";
  if (isAmbiguousSaveError(e)) return "保存できたか分かりません(通信が切れました)。最新の内容を読み直しました。変わっていれば押し直さないでください。";
  return e instanceof Error && e.message ? e.message : "保存できませんでした。";
}

/** 会社情報の欄。書ける人=入力欄(触った欄は打ちかけの値)/書けない人=文字。 */
export function AgentInfoFields({
  agent,
  edits,
  canWrite,
  saving,
  onEdit,
  onBlurPhone,
}: {
  agent: AgentDetail;
  edits: AgentEdits;
  canWrite: boolean;
  saving: boolean;
  onEdit: (key: AgentEditKey, value: string) => void;
  onBlurPhone: (key: AgentEditKey) => void;
}) {
  if (!canWrite) {
    return (
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {AGENT_EDIT_FIELDS.map((f) => (
          <div key={f.key} className={"multiline" in f ? "sm:col-span-2" : ""}>
            <dt className="text-xs text-gray-500 dark:text-gray-400">{f.label.replace("(必須)", "")}</dt>
            <dd className="whitespace-pre-wrap text-gray-900 dark:text-gray-100">{agent[f.key] || "—"}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    // 保存中は欄も打てない(保存は押したときの値で進むので、その後の直しは届かず黙って消える)。
    <fieldset disabled={saving} className="m-0 grid min-w-0 gap-x-6 gap-y-2 border-0 p-0 sm:grid-cols-2">
      {AGENT_EDIT_FIELDS.map((f) => {
        const value = agentFieldValue(agent, edits, f.key);
        const isPhone = "phone" in f;
        return (
          <label key={f.key} className={`block text-sm${"multiline" in f ? " sm:col-span-2" : ""}`}>
            <span className="text-xs text-gray-500 dark:text-gray-400">{f.label}</span>
            {"multiline" in f ? (
              <textarea value={value} onChange={(e) => onEdit(f.key, e.target.value)} rows={3} className={inputCls} />
            ) : (
              <input
                value={value}
                onChange={(e) => onEdit(f.key, e.target.value)}
                onBlur={isPhone ? () => onBlurPhone(f.key) : undefined}
                inputMode={isPhone ? "tel" : undefined}
                className={inputCls}
              />
            )}
            {isPhone && value.trim() !== "" && !isValidPhoneJp(value) && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">
                電話番号の桁をご確認ください(このままでも保存できます)
              </span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** その業者からの反響(新しい順)。物件は許可リストの形(物件名・部屋・町名まで)。 */
export function AgentHistoryList({ items }: { items: AgentHistoryItem[] }) {
  if (items.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">この業者からの反響はまだありません。</p>;
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {items.map((q) => (
        <li key={q.id} className="py-2 text-sm">
          <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{formatJstFull(q.receivedAt)}</span>
          <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{KIND_LABEL[q.kind]}</span>
          <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{STATUS_LABEL[q.status]}</span>
          <span className="font-medium">{q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name}</span>
          {/* 物件名の無い戸建・土地は、名前がそのまま町名=同じ文字を2回出さない。 */}
          {q.property.town !== q.property.name && (
            <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">{q.property.town}</span>
          )}
          {q.contactName && <span className="ml-2">{`${q.contactName}様`}</span>}
        </li>
      ))}
    </ul>
  );
}
