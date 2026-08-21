"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Send,
  Ban,
  Pause,
  FileCheck,
  UserCheck,
  Loader2,
} from "lucide-react";
import { executePropertyAction } from "@/lib/api-client";

interface ActionBarProps {
  propertyId: string;
  registryStatus: string;
  dmStatus: string;
  investigationConfirmedAt: string | null;
  onActionComplete: () => void;
}

interface ActionConfig {
  key: string;
  label: string;
  icon: typeof CheckCircle2;
  color: string;
  condition?: (props: ActionBarProps) => boolean;
}

/**
 * DM判断は「今どれか」を選択で示す3状態の切替。
 *
 * ⚠なぜ切替にしたか(2026-08-21 発注者から報告): 以前は「今の状態のボタンだけを隠して」
 *   残り2つを並べていたため、**「DM送付不可」ボタン＝この物件は送付不可** と読まれた
 *   (実際は送付可で、警告「登記未取得なのにDM送付可」は正しかった)。
 *   **文言が状態と同じ** + **今の状態がその場に無い** + **2つ並ぶこと自体が状態のサイン**、
 *   という三重の読みにくさだった。同種の混乱は B-10 UI総点検でも報告があり、
 *   そのときは見出しを足しただけで足りていなかった。
 * ⚠**色は状態の意味と対応させる**(送付可=indigo / 送付不可=red / 未判断=amber)。
 *   選んでいないものは無彩色にして、選択中だけが色で浮くようにする。
 */
const DM_CHOICES = [
  { key: "set_dm_send", value: "send", label: "送付可", selectedColor: "bg-indigo-600" },
  { key: "set_dm_no_send", value: "no_send", label: "送付不可", selectedColor: "bg-red-600" },
  { key: "set_dm_hold", value: "hold", label: "未判断", selectedColor: "bg-amber-600" },
] as const;

/**
 * 状態を変える操作。⚠**動詞で書く**(「登記取得済」だと現在の状態に見えるため)。
 * 済んでいる操作は出さない(押しても意味がないため)。
 */
const ACTIONS: ActionConfig[] = [
  {
    key: "confirm_investigation",
    label: "調査を確認する",
    icon: CheckCircle2,
    color: "bg-green-600 hover:bg-green-700",
    condition: (p) => !p.investigationConfirmedAt,
  },
  {
    key: "mark_registry_obtained",
    label: "登記取得済にする",
    icon: FileCheck,
    color: "bg-indigo-600 hover:bg-indigo-700",
    condition: (p) => p.registryStatus !== "obtained",
  },
  {
    key: "assign_to_me",
    label: "自分を担当にする",
    icon: UserCheck,
    color: "bg-gray-600 hover:bg-gray-700",
  },
];

const DM_ICONS = { send: Send, no_send: Ban, hold: Pause } as const;

export default function ActionBar(props: ActionBarProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (actionKey: string) => {
    setLoading(actionKey);
    setMessage(null);
    setError(null);

    try {
      const json = await executePropertyAction(props.propertyId, actionKey) as { message: string };
      setMessage(json.message);
      props.onActionComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "アクションに失敗しました");
    } finally {
      setLoading(null);
    }
  };

  const availableActions = ACTIONS.filter(
    (a) => !a.condition || a.condition(props),
  );

  return (
    <div className="mb-4">
      {/* B-10 UI総点検: 色付きボタンがステータスバッジと紛らわしく「操作」と気づきにくかった。見出しで操作群と
          明示する(表示される操作は物件の状態で変わる=「行える操作」と表現)。 */}
      <p className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">この物件で行える操作</p>

      {/* DM判断: 3状態の切替(現在値が選択として見える) */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">DM判断</span>
        <div
          role="group"
          aria-label="DM判断"
          className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600"
        >
          {DM_CHOICES.map((choice) => {
            const selected = props.dmStatus === choice.value;
            const isLoading = loading === choice.key;
            const Icon = DM_ICONS[choice.value];
            return (
              <button
                key={choice.key}
                type="button"
                aria-pressed={selected}
                // ⚠選択中は押せない(同じ状態への変更は何も起こさないため)。
                disabled={selected || loading !== null}
                onClick={() => handleAction(choice.key)}
                className={
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium " +
                  "border-r border-gray-300 last:border-r-0 dark:border-gray-600 " +
                  "disabled:cursor-default " +
                  (selected
                    ? `${choice.selectedColor} text-white`
                    : "bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50 " +
                      "dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700")
                }
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {availableActions.map((action) => {
          const Icon = action.icon;
          const isLoading = loading === action.key;
          return (
            <button
              key={action.key}
              type="button"
              onClick={() => handleAction(action.key)}
              disabled={loading !== null}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${action.color}`}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Icon className="h-3.5 w-3.5" />
              )}
              {action.label}
            </button>
          );
        })}
      </div>

      {message && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">{message}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
