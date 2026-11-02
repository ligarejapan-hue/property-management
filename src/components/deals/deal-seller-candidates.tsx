"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import type { SellerCandidates } from "@/lib/deals/seller-from-owners";

type Candidate = SellerCandidates["candidates"][number];

/** 見た目だけ。候補がいなければ何も出さない。 */
export function SellerCandidatesView({ candidates, selected, mismatch, busy, onToggle, onAdd }: {
  candidates: Candidate[]; selected: string[]; mismatch: boolean; busy: boolean;
  onToggle: (ownerId: string) => void; onAdd: () => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
      <p className="font-medium text-gray-700 dark:text-gray-300">物件の所有者で、売主にいない人:{candidates.length}名</p>
      {mismatch && <p className="text-xs text-amber-700 dark:text-amber-400">相続登記などが必要か確認してください。</p>}
      <ul className="space-y-1">
        {candidates.map((c) => (
          <li key={c.ownerId}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={selected.includes(c.ownerId)} onChange={() => onToggle(c.ownerId)} />
              {c.name}
            </label>
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" disabled={busy || selected.length === 0} onClick={onAdd}>
        <UserPlus className="h-4 w-4" />
        売主に加える
      </Button>
    </section>
  );
}

/**
 * 売主がいる取引で、売主にいない所有者を選んで足す欄。自動では足さない。
 * revision(当事者の変更)が変わったら読み直す。権限がない人には人数も出さない。
 */
export function DealSellerCandidates({ dealId, revision, mismatch, onAdded }: {
  dealId: string; revision: string; mismatch: boolean; onAdded: (added: number) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    dealsApi.sellerCandidates(dealId)
      .then((r) => { if (alive) { setCandidates(r.candidates); setSelected([]); setError(null); } })
      .catch((e) => {
        if (!alive) return;
        setCandidates([]);
        setSelected([]);
        // 権限がない人には、何も出さない。
        setError(e instanceof DealApiError && e.status === 403 ? null : errorText(e));
      });
    return () => { alive = false; };
  }, [dealId, revision]);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { added } = await dealsApi.addSellersFromOwners(dealId, selected);
      await onAdded(added);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <SellerCandidatesView
        candidates={candidates} selected={selected} mismatch={mismatch} busy={busy}
        onToggle={(id) => setSelected((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))}
        onAdd={() => void add()}
      />
    </>
  );
}
