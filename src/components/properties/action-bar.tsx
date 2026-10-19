"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Send,
  Ban,
  Pause,
  UserCheck,
  Loader2,
} from "lucide-react";
import { executePropertyAction } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

/**
 * 物件の状態を変える操作(POST /api/properties/[id]/actions)の実行と結果の表示。
 *
 * 画面すっきり化 第3回(発注者決定 2026-10-16): 「登記取得済にする」は物件の画面の
 * 「その他 ▾」へ移したため、実行は ActionBar の外(メニュー)からも呼ぶ。結果の文言は
 * どこから押しても ActionBar の下に出す(同じ場所に出す=見落とさない)。
 */
export function usePropertyAction(propertyId: string, onActionComplete: () => void) {
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (actionKey: string) => {
    setLoading(actionKey);
    setMessage(null);
    setError(null);

    try {
      const json = await executePropertyAction(propertyId, actionKey) as { message: string };
      setMessage(json.message);
      onActionComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "アクションに失敗しました");
    } finally {
      setLoading(null);
    }
  };

  return { loading, message, error, run };
}

export type PropertyActionState = ReturnType<typeof usePropertyAction>;

interface ActionBarProps {
  dmStatus: string;
  investigationConfirmedAt: string | null;
  /** いまの担当者が自分か。自分ならすでに担当なので「自分を担当にする」を出さない。 */
  assignedToMe: boolean;
  action: PropertyActionState;
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

const DM_ICONS = { send: Send, no_send: Ban, hold: Pause } as const;

export default function ActionBar(props: ActionBarProps) {
  const { loading, message, error, run: handleAction } = props.action;

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

      {/* ⚠状態を変える操作は**動詞で書く**(「登記取得済」だと現在の状態に見えるため)。
          「自分を担当にする」は、すでに自分が担当なら出さない(押しても何も変わらないため)。 */}
      {!props.assignedToMe && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleAction("assign_to_me")}
            disabled={loading !== null}
            loading={loading === "assign_to_me"}
            loadingLabel="自分を担当にする"
          >
            <UserCheck className="h-3.5 w-3.5" />
            自分を担当にする
          </Button>
        </div>
      )}

      {/* 調査が未確認の帯。確かめたら帯の中の「確認した」で消す(画面すっきり化 第3回で
          別にあった「調査を確認する」ボタンをこの帯へまとめた)。 */}
      {!props.investigationConfirmedAt && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-800 dark:bg-amber-950/40">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm text-amber-800 dark:text-amber-300">
            調査情報が未確認です。最新の情報を取得してください。
          </span>
          <Button
            variant="success"
            size="sm"
            onClick={() => handleAction("confirm_investigation")}
            disabled={loading !== null}
            loading={loading === "confirm_investigation"}
            loadingLabel="確認した"
            aria-label="調査を確認する"
            className="ml-auto"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            確認した
          </Button>
        </div>
      )}

      {message && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">{message}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
