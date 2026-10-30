import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { resolveAppearance, type Appearance } from "./options";

// 会社全体の初期値(段階4で管理者が画面から変える)。system_settings の key/value。
export const COMPANY_APPEARANCE_KEYS = {
  theme: "appearance.default.theme",
  density: "appearance.default.density",
  layout: "appearance.default.layout",
} as const;

export async function loadCompanyAppearance(): Promise<{ theme?: string; density?: string; layout?: string }> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(COMPANY_APPEARANCE_KEYS) } },
    select: { key: true, value: true },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    theme: get(COMPANY_APPEARANCE_KEYS.theme),
    density: get(COMPANY_APPEARANCE_KEYS.density),
    layout: get(COMPANY_APPEARANCE_KEYS.layout),
  };
}

/** その人の個人の設定(未設定=null)と、会社の初期値・既定を足した実際の見た目。 */
export async function loadUserAppearance(userId: string) {
  const [user, company] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { theme: true, density: true, layout: true } }),
    loadCompanyAppearance(),
  ]);
  return {
    user: { theme: user?.theme ?? null, density: user?.density ?? null, layout: user?.layout ?? null },
    company,
    effective: resolveAppearance(user, company),
  };
}

/** DB が遅いときに見た目の読み込みを打ち切るまでの時間(ms)。 */
export const APPEARANCE_LOAD_TIMEOUT_MS = 1500;

/**
 * 画面を作るとき(ルートの layout)に使う。ログイン中なら DB の設定=正。
 * ログインしていない・読めないときは null(画面側は端末に覚えた値=localStorage を使う)。見た目のために画面を落とさない。
 */
export async function loadAppearanceForRequest(timeoutMs = APPEARANCE_LOAD_TIMEOUT_MS): Promise<Appearance | null> {
  try {
    // ログインの cookie が無い(公開ページ・ログイン前)なら DB に触らない(proxy.ts と同じ名前)。
    const jar = await cookies();
    if (!jar.get("authjs.session-token")?.value && !jar.get("__Secure-authjs.session-token")?.value) return null;
    // DB が固まっても画面を待たせない(打ち切ったら端末に覚えた値で描く)。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const load = (async () => {
      const session = await auth();
      const id = (session?.user as { id?: string } | undefined)?.id;
      if (!id) return null;
      return (await loadUserAppearance(id)).effective;
    })().catch(() => null);
    try {
      return await Promise.race([load, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
