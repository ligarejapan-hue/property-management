"use client";
import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { resolveAppearance, toNextTheme } from "@/lib/appearance/options";
import { APPEARANCE_USER_ATTR, applyDensity, applyLayout } from "@/lib/appearance/client";

/**
 * 見た目の設定: ログイン画面から画面を切り替えて入ったとき(再読み込みなし)は、ルートの layout が
 * その人の設定を読めていない。html の「この人の設定で描いた」印(data-appearance-user)がログイン中の人と
 * 違うときだけ、設定を読み直して反映する(別の PC・共有の PC で別の人が入ったときも、その人の見た目になる)。
 */
export function AppearanceSync() {
  const { data: session, status } = useSession();
  const { setTheme } = useTheme();
  const userId = (session?.user as { id?: string } | undefined)?.id;

  useEffect(() => {
    if (status !== "authenticated" || !userId) return;
    const html = document.documentElement;
    if (html.getAttribute(APPEARANCE_USER_ATTR) === userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/preferences", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { data?: { effective?: unknown } };
        const eff = resolveAppearance(body.data?.effective as Record<string, unknown> | undefined, null);
        setTheme(toNextTheme(eff.theme));
        applyDensity(eff.density);
        applyLayout(eff.layout);
        html.setAttribute(APPEARANCE_USER_ATTR, userId);
      } catch {
        // 読めなければ今の見た目のまま(次に開いたときに DB の値になる)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, userId, setTheme]);

  return null;
}
