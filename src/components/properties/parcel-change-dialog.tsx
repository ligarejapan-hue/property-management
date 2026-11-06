"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { editLockHeaders } from "@/lib/edit-lock/screen-token-client";
import { landChoices, SPLIT_PIECES_MAX } from "@/lib/property-parcel-changes";

const inputCls = "w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
const landLabel = (x: { number: string; location: string | null; key: string }) =>
  `土地 ${x.location ? `${x.location} ` : ""}${x.number}${x.key === "main:land" ? "（1筆目）" : ""}`;

/** 保存できた結果の文(取引の選びを直した件数つき)。 */
export function parcelChangeDoneText(op: "split" | "merge", retargetedDeals: number): string {
  const head = op === "split" ? "分筆を記録しました。" : "合筆を記録しました。";
  if (!retargetedDeals) return `${head}元の地番はコメントに残しました。`;
  return `${head}元の地番はコメントに残しました。この土地を選んでいた取引${retargetedDeals}件の「この取引の土地・建物」も合わせました（書類の地番は、取引の「物件から取り直す」で入れ直してください）。`;
}

/**
 * 分筆・合筆を記録する小窓(2026-11-06 発注者 案A 3回目の2つ目・土地だけ)。物件の画面の「その他 ▾」から開く。
 * ⚠鍵は取らない保存(地番の小窓と同じ)=合言葉だけ送る。編集中の人がいれば親が開かせない・サーバーも 409。
 */
export default function ParcelChangeDialog({
  propertyId, version, lotNumber, extraParcels, onClose, onSaved,
}: {
  propertyId: string;
  version: number;
  lotNumber: string | null;
  extraParcels: unknown;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const choices = landChoices({ lotNumber, extraParcels });
  const [op, setOp] = useState<"split" | "merge">("split");
  const [source, setSource] = useState(choices[0]?.key ?? "");
  const [pieces, setPieces] = useState<{ number: string; area: string }[]>(() => [
    { number: choices[0]?.number ?? "", area: "" }, { number: "", area: "" },
  ]);
  const [mergeKeys, setMergeKeys] = useState<string[]>([]);
  const [mergeNumber, setMergeNumber] = useState("");
  const [mergeArea, setMergeArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickSource = (key: string) => {
    setSource(key);
    // 1つ目は元の地番から始める(残す側の番号を打ち直さなくてよい)。
    setPieces((cur) => [{ ...cur[0], number: choices.find((c) => c.key === key)?.number ?? "" }, ...cur.slice(1)]);
  };
  const toggleMerge = (key: string) => {
    const next = mergeKeys.includes(key) ? mergeKeys.filter((k) => k !== key) : choices.filter((c) => c.key === key || mergeKeys.includes(c.key)).map((c) => c.key);
    setMergeKeys(next);
    // 合わせたあとの地番は、物件の並びで最初の筆の番号から始める(まだ打っていなければ)。
    if (!mergeNumber.trim() && next[0]) setMergeNumber(choices.find((c) => c.key === next[0])?.number ?? "");
  };
  const setPiece = (i: number, k: "number" | "area", v: string) => setPieces((cur) => cur.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  const canSubmit = !busy && (op === "split"
    ? !!source && pieces.length >= 2 && pieces.every((p) => p.number.trim())
    : mergeKeys.length >= 2 && !!mergeNumber.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const body = op === "split"
        ? { op, version, source, pieces: pieces.map((p) => ({ number: p.number, area: p.area.trim() || null })) }
        : { op, version, keys: mergeKeys, number: mergeNumber, area: mergeArea.trim() || null };
      const res = await fetch(`/api/properties/${propertyId}/parcel-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...editLockHeaders() },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error?.message ?? "記録できませんでした。もう一度お試しください。");
        return;
      }
      onSaved(parcelChangeDoneText(op, typeof json?.retargetedDeals === "number" ? json.retargetedDeals : 0));
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="分筆・合筆を記録"
      size="lg"
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} loading={busy} loadingLabel="記録中">記録する</Button>
        </>
      )}
    >
      <div className="space-y-4 text-sm">
        <p className="text-gray-600 dark:text-gray-400">
          登記で分筆・合筆をしたあとに、物件の地番と「ほかの土地・建物」を書き換えます。元の地番はこの物件のコメントに残ります。土地面積の欄（物件全体）は変わりません。
        </p>
        <div className="flex gap-4" role="radiogroup" aria-label="記録する内容">
          {(["split", "merge"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name="parcel-change-op" checked={op === v} onChange={() => setOp(v)} disabled={busy || (v === "merge" && choices.length < 2)} />
              {v === "split" ? "分筆（1つの土地を分ける）" : "合筆（いくつかの土地を1つにする）"}
            </label>
          ))}
        </div>

        {op === "split" ? (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-gray-600 dark:text-gray-400">分ける土地</span>
              <select className={inputCls} value={source} onChange={(e) => pickSource(e.target.value)} disabled={busy} aria-label="分ける土地">
                {choices.map((c) => <option key={c.key} value={c.key}>{landLabel(c)}</option>)}
              </select>
            </label>
            <div className="space-y-2">
              <p className="text-xs text-gray-600 dark:text-gray-400">分けたあとの地番と地積（1つ目が元の土地のまま残ります。地積は分かれば。1筆目の地積はコメントにだけ残ります）</p>
              {pieces.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className={inputCls} value={p.number} onChange={(e) => setPiece(i, "number", e.target.value)} placeholder="地番（例 1番5）" aria-label={`${i + 1}つ目の地番`} maxLength={50} disabled={busy} />
                  <input className={`${inputCls} max-w-[8rem]`} inputMode="decimal" value={p.area} onChange={(e) => setPiece(i, "area", e.target.value)} placeholder="地積㎡" aria-label={`${i + 1}つ目の地積`} disabled={busy} />
                  {pieces.length > 2 && (
                    <Button variant="ghost" size="sm" onClick={() => setPieces((cur) => cur.filter((_, j) => j !== i))} aria-label={`${i + 1}つ目を外す`} disabled={busy}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              {pieces.length < SPLIT_PIECES_MAX && (
                <Button variant="secondary" size="sm" onClick={() => setPieces((cur) => [...cur, { number: "", area: "" }])} disabled={busy}>
                  <Plus className="h-4 w-4" />
                  分けた土地を足す
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <fieldset className="space-y-1">
              <legend className="text-xs text-gray-600 dark:text-gray-400">合わせる土地（2つ以上）</legend>
              {choices.map((c) => (
                <label key={c.key} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={mergeKeys.includes(c.key)} onChange={() => toggleMerge(c.key)} disabled={busy} />
                  {landLabel(c)}
                </label>
              ))}
            </fieldset>
            <div className="flex items-center gap-2">
              <input className={inputCls} value={mergeNumber} onChange={(e) => setMergeNumber(e.target.value)} placeholder="合わせたあとの地番" aria-label="合わせたあとの地番" maxLength={50} disabled={busy} />
              <input className={`${inputCls} max-w-[8rem]`} inputMode="decimal" value={mergeArea} onChange={(e) => setMergeArea(e.target.value)} placeholder="地積㎡" aria-label="合わせたあとの地積" disabled={busy} />
            </div>
          </div>
        )}
        {error && <p className="text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
}
