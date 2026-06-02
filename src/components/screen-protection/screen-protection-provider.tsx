"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import type { PermissionEntry } from "@/lib/api-helpers";
import {
  isScreenProtectionBypassed,
  buildWatermarkText,
} from "@/lib/screen-protection";
import WatermarkOverlay from "./watermark-overlay";

/**
 * S1b-2: dashboard 全体を覆う画面保護 Provider（透かし表示のみ）。
 *
 * - bypass 判定: /api/me/permissions を mount 時に 1 回だけ取得し、
 *   screen_protection:bypass を持つユーザーのみ透かしを免除する。
 * - fail-safe: 判定が確定する前（取得前・取得失敗時）は透かしを表示し続ける。
 * - 透かし文言: useSession() の name / email / role と mount 時刻（閲覧者自身の身元）。
 *
 * スコープ外（後続 PR）: copy/cut/contextmenu/print 抑止・クライアント監査・
 * registry PDF preview/download enforcement。本 Provider はそれらを一切行わない。
 * context は将来 S1b-3 が bypass 状態を参照できるよう公開する。
 */

interface ScreenProtectionState {
  bypass: boolean;
  watermarkText: string;
}

const ScreenProtectionContext = createContext<ScreenProtectionState>({
  bypass: false,
  watermarkText: "",
});

export function useScreenProtection(): ScreenProtectionState {
  return useContext(ScreenProtectionContext);
}

export default function ScreenProtectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: session } = useSession();
  // fail-safe: 判定が確定するまで bypass=false（= 透かし表示）。
  const [bypass, setBypass] = useState(false);
  // mount 時刻。SSR/hydration mismatch 回避のためクライアントの effect で一度だけ確定する。
  const [mountedAt, setMountedAt] = useState<Date | null>(null);

  useEffect(() => {
    setMountedAt(new Date());
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/me/permissions")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!active || !json) return;
        const perms = (json.permissions ?? []) as PermissionEntry[];
        setBypass(isScreenProtectionBypassed(perms));
      })
      .catch(() => {
        // 取得失敗時は fail-safe（透かし表示）のまま保持する。
      });
    return () => {
      active = false;
    };
  }, []);

  const watermarkText = mountedAt
    ? buildWatermarkText({
        name: session?.user?.name,
        email: session?.user?.email,
        role: (session?.user as { role?: string } | undefined)?.role,
        now: mountedAt,
      })
    : "";

  // SSR 時は透かしを出さない（mountedAt 確定後にクライアントで表示）。
  const showWatermark = !bypass && mountedAt !== null;

  return (
    <ScreenProtectionContext.Provider value={{ bypass, watermarkText }}>
      {children}
      {showWatermark && <WatermarkOverlay text={watermarkText} />}
    </ScreenProtectionContext.Provider>
  );
}
