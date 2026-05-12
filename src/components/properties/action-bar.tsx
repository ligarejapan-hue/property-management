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
  confirmMessage?: string;
}

const ACTIONS: ActionConfig[] = [
  {
    key: "confirm_investigation",
    label: "調査確認",
    icon: CheckCircle2,
    color: "bg-green-600 hover:bg-green-700",
    condition: (p) => !p.investigationConfirmedAt,
  },
  {
    key: "mark_registry_obtained",
    label: "登記取得済",
    icon: FileCheck,
    color: "bg-indigo-600 hover:bg-indigo-700",
    condition: (p) => p.registryStatus !== "obtained",
  },
  {
    key: "set_dm_send",
    label: "DM送付可",
    icon: Send,
    color: "bg-blue-600 hover:bg-blue-700",
    condition: (p) => p.dmStatus !== "send",
  },
  {
    key: "set_dm_no_send",
    label: "DM送付不可",
    icon: Ban,
    color: "bg-red-600 hover:bg-red-700",
    condition: (p) => p.dmStatus !== "no_send",
  },
  {
    key: "set_dm_hold",
    label: "DM未判断",
    icon: Pause,
    color: "bg-amber-600 hover:bg-amber-700",
    condition: (p) => p.dmStatus !== "hold",
  },
  {
    key: "assign_to_me",
    label: "自分を担当に",
    icon: UserCheck,
    color: "bg-gray-600 hover:bg-gray-700",
  },
];

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

  if (availableActions.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-2">
        {availableActions.map((action) => {
          const Icon = action.icon;
          const isLoading = loading === action.key;
          return (
            <button
              key={action.key}
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
        <p className="mt-2 text-xs text-green-600">{message}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
