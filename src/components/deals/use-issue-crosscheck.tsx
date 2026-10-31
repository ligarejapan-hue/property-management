"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { dealsApi } from "@/lib/deals/client";
import { issueWarnings, type CrosscheckItem } from "@/lib/deals/crosscheck";

/**
 * 書類を発行する前の照合の確認。食い違いがあれば確認を挟むだけで、発行は止めない。
 * 照合を読めないときは、そのまま発行へ進む(確認のために発行を止めない)。
 */
export function useIssueCrosscheck(dealId: string, docType: string) {
  const [warnings, setWarnings] = useState<CrosscheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const pending = useRef<(() => void) | null>(null);

  const guard = async (proceed: () => void) => {
    setChecking(true);
    let found: CrosscheckItem[] = [];
    try {
      found = issueWarnings((await dealsApi.crosscheck(dealId)).crosscheck, docType);
    } catch {
      found = [];
    }
    setChecking(false);
    if (found.length) {
      pending.current = proceed;
      setWarnings(found);
    } else {
      proceed();
    }
  };
  const close = () => {
    pending.current = null;
    setWarnings(null);
  };
  const confirm = () => {
    const run = pending.current;
    close();
    run?.();
  };
  const dialog = warnings && (
    <ModalShell
      title={`${warnings.length}件の食い違いがあります`}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>戻って確認する</Button>
          <Button onClick={confirm}>このまま発行する</Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {warnings.map((w) => <li key={w.key}><span className="font-medium">{w.label}</span>: {w.message}</li>)}
      </ul>
    </ModalShell>
  );
  return { guard, checking, dialog };
}
