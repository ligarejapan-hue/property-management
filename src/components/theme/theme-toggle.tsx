"use client";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Monitor, Sun, Moon } from "lucide-react";

const OPTIONS = [
  { value: "system", label: "自動", Icon: Monitor },
  { value: "light", label: "明るい", Icon: Sun },
  { value: "dark", label: "暗い", Icon: Moon },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mount guard to avoid hydration mismatch (standard next-themes pattern)
    setMounted(true);
  }, []);
  const current = mounted ? (theme ?? "system") : "system";
  return (
    <div
      className="inline-flex rounded-md border border-gray-300 dark:border-gray-700 overflow-hidden"
      role="group"
      aria-label="テーマ"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={current === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setTheme(o.value)}
          className={`min-h-[40px] px-3 text-sm flex items-center gap-1 ${
            current === o.value
              ? "bg-indigo-600 text-white"
              : "bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-200"
          }`}
        >
          <o.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
