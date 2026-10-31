"use client";

import { useMemo, useState } from "react";
import { AgentPicker } from "@/components/agent-inquiry/agent-picker";
import { DeskAccessContext, type DeskAccess } from "@/components/agent-inquiry/desk-access";
import { apiErrorCode, type AgentHit } from "@/lib/api-client";

/** 取引の画面での断られ方。業者一覧を見る権限が無い(403)ときだけ知らせる(窓のように画面ごと隠さない)。 */
export function brokerSearchAccess(onForbidden: () => void): DeskAccess {
  return {
    readDenied: (e) => {
      if (apiErrorCode(e) !== "FORBIDDEN") return false;
      onForbidden();
      return true;
    },
    writeDenied: () => false,
  };
}

/** 相手方の仲介会社を業者一覧(受付の名簿+国交省の一覧)から探す。見られない人は手入力だけ。 */
export function DealBrokerSearch({ onPick }: { onPick: (hit: AgentHit) => void }) {
  const [query, setQuery] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const access = useMemo(() => brokerSearchAccess(() => setForbidden(true)), []);
  if (forbidden) {
    return <p className="text-xs text-gray-500">業者一覧を見る権限がありません。下の欄に手で入力してください。</p>;
  }
  return (
    // 候補のボタンを label(Field)の中に入れない=押すと欄へ移るため。
    <div>
      <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">業者一覧から探す</p>
      <DeskAccessContext.Provider value={access}>
        <AgentPicker
          query={query}
          selected={null}
          onQuery={setQuery}
          onPick={(hit) => {
            onPick(hit);
            setQuery("");
          }}
        />
      </DeskAccessContext.Provider>
    </div>
  );
}
