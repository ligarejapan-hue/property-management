"use client";

/**
 * 物件の基本情報の「物件名」から棟につなぐ確認(発注者の指示 2026-10-11)。
 * 開くと、物件名を打ったときと同じ候補(同じ名前・丁目違い・名前の一部)を並べ、
 * 一番下に「新しい棟として作る」を置く。同じ町丁目・同じ名前の棟があればそれを、
 * 無ければ「新しい棟」を選んでおく。確定ボタンを押したときだけ保存する(保存は呼び出し側)。
 * ⚠住所はそのまま送らない(町丁目に丸めて area で送る=入力欄の候補と同じ)。
 */
import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import {
  allowsNewBuilding,
  listState,
  suggestArea,
  suggestionBadges,
  suggestQueryStringForArea,
  type SuggestResult,
} from "@/lib/building-link/combobox-model";
import { initialLinkChoice, linkConfirmButtonLabel, linkNeedsSuggestions } from "@/lib/building-link/link-dialog-model";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import type { BuildingSuggestion } from "@/lib/building-link/suggest";

export interface BuildingLinkDialogProps {
  buildingName: string;
  address: string;
  saving: boolean;
  error: string | null;
  onConfirm: (choice: BuildingChoice) => void;
  onClose: () => void;
}

export default function BuildingLinkDialog({
  buildingName,
  address,
  saving,
  error,
  onConfirm,
  onClose,
}: BuildingLinkDialogProps) {
  const area = suggestArea(address);
  // 物件名が短くて候補を探せないときは問い合わせず、自動の判断に任せる(@codex P2)。
  const searchable = linkNeedsSuggestions(buildingName);
  const [result, setResult] = useState<SuggestResult | null>(null);
  // 利用者が選び直したもの(選んでいなければ最初に選んでおくものを使う)。
  const [picked, setPicked] = useState<BuildingChoice | null>(null);

  useEffect(() => {
    if (!searchable) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/buildings/suggest?${suggestQueryStringForArea(buildingName, area)}`);
        if (!alive) return;
        const body = res.ok ? ((await res.json()) as { data?: unknown; complete?: unknown }) : null;
        if (!alive) return;
        if (!body || !Array.isArray(body.data)) {
          setResult({ query: buildingName, area, status: "error", data: [] });
          return;
        }
        setResult({
          query: buildingName,
          area,
          status: "ok",
          data: body.data as BuildingSuggestion[],
          complete: body.complete !== false,
        });
      } catch {
        if (alive) setResult({ query: buildingName, area, status: "error", data: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [buildingName, area, searchable]);

  const state = listState(result, buildingName, area);
  const suggestions = (state === "ready" || state === "partial") && result ? result.data : [];
  const allowNew = allowsNewBuilding(state);
  const choice: BuildingChoice | null = !searchable
    ? { kind: "auto" }
    : picked ?? initialLinkChoice(suggestions, state);
  const isChosen = (c: BuildingChoice) =>
    choice !== null &&
    choice.kind === c.kind &&
    (c.kind !== "existing" || (choice.kind === "existing" && choice.buildingId === c.buildingId));

  const rowClass = (active: boolean) =>
    `flex w-full cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left text-sm ${
      active
        ? "border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-950/40"
        : "border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
    }`;

  return (
    <ModalShell
      title={`物件名「${buildingName}」を棟につなぐ`}
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            やめる
          </Button>
          <Button
            data-testid="building-link-confirm"
            onClick={() => choice && onConfirm(choice)}
            disabled={saving || choice === null}
          >
            {saving ? "つないでいます…" : linkConfirmButtonLabel(choice)}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        つなぐ棟を選んでください。つなぐと、棟の画面へ移ります。
      </p>
      {!searchable && (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
          物件名が短いため、候補は出せません。つなぐと、同じ町丁目に同じ名前の棟があればそこへつなぎ、無ければ新しく作ります。
        </p>
      )}
      {searchable && state === "loading" && (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">候補を探しています…</p>
      )}
      {searchable && state === "error" && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">
          候補を読み込めませんでした。閉じてからもう一度お試しください。
        </p>
      )}
      {searchable && (state === "ready" || state === "partial") && (
        <div className="mt-3 space-y-2" role="radiogroup" aria-label="つなぐ棟">
          {suggestions.map((s) => {
            const c: BuildingChoice = { kind: "existing", buildingId: s.id };
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={isChosen(c)}
                disabled={saving}
                className={rowClass(isChosen(c))}
                onClick={() => setPicked(c)}
              >
                <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
                  {suggestionBadges(s).map((b) => (
                    <span
                      key={b}
                      className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                    >
                      {b}
                    </span>
                  ))}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {s.area || "住所不明"}・{s.unitCount}部屋
                  </span>
                </span>
              </button>
            );
          })}
          {allowNew && (
            <button
              type="button"
              role="radio"
              aria-checked={isChosen({ kind: "new" })}
              disabled={saving}
              className={rowClass(isChosen({ kind: "new" }))}
              onClick={() => setPicked({ kind: "new" })}
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">
                新しい棟として作る（「{buildingName}」）
              </span>
            </button>
          )}
          {state === "partial" && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              古い棟を全部は確かめられなかったため、新しい棟は作れません。候補から選んでください。
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </ModalShell>
  );
}
