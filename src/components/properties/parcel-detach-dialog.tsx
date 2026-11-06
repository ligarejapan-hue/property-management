"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { editLockHeaders } from "@/lib/edit-lock/screen-token-client";
import { readExtraParcels } from "@/lib/property-parcels";

const rowLabel = (x: { kind: string; location: string | null; number: string }) =>
  `${x.kind === "land" ? "土地" : "建物"} ${x.location ? `${x.location} ` : ""}${x.number}`;

/** できたときの文。所有者のつながりを写せなかったときはそう書く。 */
export function parcelDetachDoneText(ownersCopied: number, ownersSkipped: boolean, dealsCoveringAll = 0): string {
  const owners = ownersSkipped
    ? "所有者のつながりは写していません（所有者を編集する権限がないため）。"
    : ownersCopied > 0 ? `所有者${ownersCopied}人のつながりも写しました。` : "";
  const deals = dealsCoveringAll > 0
    ? `この物件の取引${dealsCoveringAll}件（土地・建物は全部）からは、この土地・建物が外れました（書類の地番は、取引の「物件から取り直す」で入れ直してください）。`
    : "";
  return `別の物件にしました。両方の物件のコメントに、相手の物件へのリンクを残しました。${owners}${deals}`;
}

/**
 * 「土地・建物を別の物件にする」の小窓(2026-11-06 発注者 案A 3回目の3つ目)。物件の画面の「その他 ▾」から開く。
 * ⚠鍵は取らない保存(合言葉だけ送る)。編集中の人がいれば blocked=押せない(サーバーも 409)。
 */
export default function ParcelDetachDialog({
  propertyId, version, extraParcels, blocked, onClose, onDone,
}: {
  propertyId: string;
  version: number;
  extraParcels: unknown;
  blocked: boolean;
  onClose: () => void;
  onDone: (result: { newPropertyId: string; message: string }) => void;
}) {
  const rows = readExtraParcels(extraParcels);
  const [rowId, setRowId] = useState(rows[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!rowId || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${propertyId}/parcel-detach`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...editLockHeaders() },
        body: JSON.stringify({ version, rowId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || typeof json?.newPropertyId !== "string") {
        setError(json?.error?.message ?? "別の物件にできませんでした。もう一度お試しください。");
        return;
      }
      onDone({ newPropertyId: json.newPropertyId, message: parcelDetachDoneText(Number(json.ownersCopied) || 0, json.ownersSkipped === true, Number(json.dealsCoveringAll) || 0) });
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="土地・建物を別の物件にする"
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void submit()} disabled={!rowId || busy || blocked} loading={busy} loadingLabel="作成中">別の物件にする</Button>
        </>
      )}
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-600 dark:text-gray-400">
          選んだ土地・建物を、新しい物件の1筆目・1棟目にして、この物件の「ほかの土地・建物」から外します。新しい物件には、所在（空ならこの物件の住所）・地番または家屋番号・不動産番号・面積・種別・担当者・取扱区分と、所有者のつながりを写します。写真・添付（謄本など）・DM の履歴・取引は写しません。この物件の取引で「この取引の土地・建物」が全部のものからは、この土地・建物が外れます。
        </p>
        <fieldset className="space-y-1">
          <legend className="text-xs text-gray-600 dark:text-gray-400">別の物件にする土地・建物</legend>
          {rows.map((x) => (
            <label key={x.id} className="flex items-center gap-1.5">
              <input type="radio" name="parcel-detach-row" checked={rowId === x.id} onChange={() => setRowId(x.id)} disabled={busy} />
              {rowLabel(x)}
            </label>
          ))}
        </fieldset>
        {blocked && <p className="text-amber-700 dark:text-amber-400" role="status">ほかの人がこの物件を編集中です。終わってからお試しください。</p>}
        {error && <p className="text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
}
