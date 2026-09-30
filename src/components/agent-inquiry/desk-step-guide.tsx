"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DESK_GUIDE_TIPS, type DeskGuideStep } from "@/lib/agent-inquiry/desk-form";

/** 案内を消した設定(端末ごと)。売却DMの手順の案内と同じ名前の付け方(pm-<機能>-guide-off)。 */
export const DESK_GUIDE_STORAGE_KEY = "pm-agent-desk-guide-off";
export const DESK_GLOW_CLASSES = ["ring-4", "ring-amber-400", "ring-offset-2", "motion-safe:animate-pulse"];

const listeners = new Set<() => void>();
// 保存できない環境(プライベートブラウズ等)でも、この画面の間は切り替えを効かせる。
let memoryOff = false;

function readOff(): boolean {
  try {
    return window.localStorage.getItem(DESK_GUIDE_STORAGE_KEY) === "1";
  } catch {
    return memoryOff;
  }
}
function writeOff(v: boolean) {
  memoryOff = v;
  try {
    if (v) window.localStorage.setItem(DESK_GUIDE_STORAGE_KEY, "1");
    else window.localStorage.removeItem(DESK_GUIDE_STORAGE_KEY);
  } catch {
    // memoryOff で効かせる。
  }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 見た目(SSR テスト用)。 */
export function DeskStepGuideView({ step, off, onToggle }: { step: DeskGuideStep; off: boolean; onToggle: () => void }) {
  if (off) {
    return (
      <button type="button" onClick={onToggle} className="text-xs text-teal-700 underline dark:text-teal-300">
        案内を出す
      </button>
    );
  }
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-md bg-gray-900 px-3 py-2 text-sm text-white dark:bg-gray-100 dark:text-gray-900"
    >
      <span>{DESK_GUIDE_TIPS[step]}</span>
      <button type="button" onClick={onToggle} className="shrink-0 text-xs underline">
        案内を消す
      </button>
    </div>
  );
}

/**
 * 次に押す所を光らせる(方針14)。対象は data-guide="<step>" の要素。
 * React の state ではなく DOM のクラスを直接付け外しする(売却DMの手順の案内と同じ型)。
 */
export default function DeskStepGuide({ step }: { step: DeskGuideStep }) {
  const off = useSyncExternalStore(subscribe, readOff, () => false);
  useEffect(() => {
    if (off) return;
    const el = document.querySelector<HTMLElement>(`[data-guide="${step}"]`);
    if (!el) return;
    el.classList.add(...DESK_GLOW_CLASSES);
    return () => el.classList.remove(...DESK_GLOW_CLASSES);
  }, [step, off]);
  return <DeskStepGuideView step={step} off={off} onToggle={() => writeOff(!off)} />;
}
