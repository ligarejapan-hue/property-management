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
import ScreenProtectionGuard from "./screen-protection-guard";

/**
 * S1b-2: dashboard 全体を覆う画面保護 Provider（透かし表示のみ）。
 *
 * - bypass 判定: /api/me/permissions を mount 時に 1 回だけ取得し、
 *   screen_protection:bypass を持つユーザーのみ透かしを免除する。判定は fail-safe
 *   （取得前・取得失敗時は bypass=false = 透かし表示側）。
 * - 透かし文言: useSession() の name / email / role と mount 時刻（閲覧者自身の身元）。
 *
 * Codex P2-2: traceability 不十分な汎用透かしを一瞬でも出さない。
 *   - session.status が "authenticated" で、かつ name/email/role の識別情報が取れた場合のみ
 *     透かし文言を生成する（buildWatermarkText が識別情報なしで null を返す）。
 *   - loading / unauthenticated の間は watermarkText=null とし、汎用の代替透かしは出さない。
 *   - dashboard では proxy.ts が未認証を /login へ redirect 済のため、認証確定は速やかに行われる
 *     （= 完全無表示で長時間放置にはならない）。
 *
 * スコープ外（後続 PR）: copy/cut/contextmenu/print 抑止・クライアント監査・
 * registry PDF preview/download enforcement。本 Provider はそれらを一切行わない。
 * context は将来 S1b-3 が bypass 状態を参照できるよう公開する。
 *
 * F12-2(17-C): provider が既に取得している /api/me/permissions の結果
 * （permissions / capabilities）を context で配布する。配布のみで、
 * 権限判定そのもの（bypass・各ページのボタン出し分け条件）は変更しない。
 * これにより各ページの同一エンドポイント重複 fetch を撤去できる。
 * fail-safe: permissions=null（未取得・取得失敗）を消費側は「権限なし」として
 * 扱うこと（広く許可しない）。capabilities も同様に null = 機能なし扱い。
 */

/** /api/me/permissions の capabilities（boolean のみ・PR#141 の route test で契約固定済）。 */
export interface MeCapabilities {
  corporateLookup: boolean;
  registryAutoFetch: boolean;
}

interface ScreenProtectionState {
  bypass: boolean;
  watermarkText: string | null;
  /** F12-2: 取得済み permissions。null = 未取得 or 取得失敗（= 権限なし扱い・fail-safe）。 */
  permissions: PermissionEntry[] | null;
  /** F12-2: 取得済み capabilities。null = 未取得 or 取得失敗（= 機能なし扱い・fail-safe）。 */
  capabilities: MeCapabilities | null;
  /** F12-2: /api/me/permissions の取得中フラグ（初期 true）。 */
  permissionsLoading: boolean;
  /** F12-2: 取得失敗（ネットワークエラー・非 2xx）フラグ。 */
  permissionsError: boolean;
}

const ScreenProtectionContext = createContext<ScreenProtectionState>({
  bypass: false,
  watermarkText: null,
  // provider 外で参照された場合も fail-safe（権限なし・取得中扱い）に倒す。
  permissions: null,
  capabilities: null,
  permissionsLoading: true,
  permissionsError: false,
});

export function useScreenProtection(): ScreenProtectionState {
  return useContext(ScreenProtectionContext);
}

export default function ScreenProtectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: session, status } = useSession();
  // fail-safe: 判定が確定するまで bypass=false（= 透かし表示側）。
  const [bypass, setBypass] = useState(false);
  // F12-2: 配布用。null のまま = 未取得 or 取得失敗（消費側は「権限なし」として扱う）。
  const [permissions, setPermissions] = useState<PermissionEntry[] | null>(null);
  const [capabilities, setCapabilities] = useState<MeCapabilities | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [permissionsError, setPermissionsError] = useState(false);
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
        if (!active) return;
        if (!json) {
          // 非 2xx は従来どおり bypass=false（透かし表示側）のまま。
          // F12-2: 配布も行わない（permissions=null = 権限なし扱い）。
          setPermissionsLoading(false);
          setPermissionsError(true);
          return;
        }
        const perms = (json.permissions ?? []) as PermissionEntry[];
        setBypass(isScreenProtectionBypassed(perms));
        // F12-2: 取得結果を配布する。capabilities は boolean のみを厳格に通す
        // （=== true 以外は false に倒す = 広く許可しない）。
        setPermissions(perms);
        setCapabilities({
          corporateLookup: json.capabilities?.corporateLookup === true,
          registryAutoFetch: json.capabilities?.registryAutoFetch === true,
        });
        setPermissionsLoading(false);
      })
      .catch(() => {
        // 取得失敗時は fail-safe（透かし表示）のまま保持する。
        // F12-2: permissions=null のまま（権限なし扱い）。error のみ通知する。
        if (!active) return;
        setPermissionsLoading(false);
        setPermissionsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // 認証確定 + mount 後、かつ識別情報がある場合のみ透かし文言を生成（汎用透かしを出さない）。
  const watermarkText =
    mountedAt && status === "authenticated"
      ? buildWatermarkText({
          name: session?.user?.name,
          email: session?.user?.email,
          role: (session?.user as { role?: string } | undefined)?.role,
          now: mountedAt,
        })
      : null;

  // bypass されておらず、traceability 可能な文言が得られている場合のみ表示する
  // （watermarkText !== null を JSX 内で判定し、Overlay には string を渡す）。
  return (
    <ScreenProtectionContext.Provider
      value={{
        bypass,
        watermarkText,
        permissions,
        capabilities,
        permissionsLoading,
        permissionsError,
      }}
    >
      {children}
      {!bypass && watermarkText !== null && (
        <WatermarkOverlay text={watermarkText} />
      )}
      {/* S1b-3: copy/cut/contextmenu/print 抑止＋client 監査（bypass は内部で no-op）。 */}
      <ScreenProtectionGuard />
    </ScreenProtectionContext.Provider>
  );
}
