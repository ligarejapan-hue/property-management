"use client";

import Link from "next/link";
import { X } from "lucide-react";
import type { BuildingLinkOutcome } from "@/lib/building-link/apply";
import { buildingLinkNoticeLines } from "@/lib/building-link/notice";

export function BuildingLinkNotice({ outcome, onClose }: { outcome: BuildingLinkOutcome | null; onClose: () => void }) {
  const lines = buildingLinkNoticeLines(outcome);
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid="building-link-notice" className="mb-3 flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      <ul className="flex-1 space-y-1">
        {lines.map((l) => (
          <li key={l.text} className={l.tone === "warn" ? "text-amber-800 dark:text-amber-300" : "text-indigo-900 dark:text-indigo-200"}>
            {l.text}
            {l.href && (
              <Link href={l.href} className="ml-2 underline hover:no-underline">
                {l.hrefLabel}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClose} aria-label="閉じる" className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
