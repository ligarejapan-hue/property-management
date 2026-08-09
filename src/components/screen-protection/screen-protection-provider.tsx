"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
import { usePermissionsRevalidation } from "./use-permissions-revalidation";
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
  /** 所在検索（番号無し物件を所在で検索して取得）が使えるか（provider が所在検索対応のときのみ）。 */
  registryLocationSearch: boolean;
  /** 段階②(2026-08-01): 候補からの有料取得が有効か(専用オプトイン込み)。 */
  registryPurchase: boolean;
  /** ピン座標→住所の自動入力(逆ジオコーディング)が有効か(env 未設定なら導線を出さない)。 */
  reverseGeocode: boolean;
  /** scanned 謄本の OCR 下書き生成が使えるか（OCR 設定済み ∧ admin を server 側で束ねた値）。 */
  registryOcrDraft: boolean;
  /** 売却促進DM の文面生成 provider が設定済みか（未設定なら作成導線を出さない）。 */
  saleDmLetter: boolean;
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
  /**
   * F12-2 Codex 対応: 復旧・鮮度再確認の導線。初回 mount 時の fetch と同じ処理を
   * 再実行し、完了で解決する Promise を返す（in-flight 中は進行中の同一 Promise を
   * 返して dedupe = 多重実行防止）。consumer は完了を待って表示判定に使える。
   */
  refetchPermissions: () => Promise<void>;
}

const ScreenProtectionContext = createContext<ScreenProtectionState>({
  bypass: false,
  watermarkText: null,
  // provider 外で参照された場合も fail-safe（権限なし・取得中扱い）に倒す。
  permissions: null,
  capabilities: null,
  permissionsLoading: true,
  permissionsError: false,
  // provider 外では no-op（何も取得しない＝広く許可しない側のまま）。
  refetchPermissions: () => Promise.resolve(),
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

  // F12-2 Codex 対応: unmount 後の setState 防止（共有 load 関数は effect 外のため ref 管理）。
  const mountedRef = useRef(true);
  // F12-2 Codex 対応: 多重実行防止。in-flight 中の呼び出しには進行中の同一 Promise を
  // 返して dedupe する（StrictMode の二重 effect・consumer からの連続呼び出しでも
  // fetch は同時に 1 本。呼び出し側はその完了を await できる）。
  const inFlightRef = useRef<Promise<void> | null>(null);

  // F12-2 Codex 対応: 初回 mount と refetch で共通の取得処理（完了で解決する Promise を返す）。
  // transient な失敗（一時的な 5xx・ネットワーク断）で layout 生存中ずっと
  // permissions=null が残り、consumer のボタンが full reload まで復旧しない問題への
  // 復旧導線として、context の refetchPermissions からも再実行できるようにする。
  // @codex #367 P2: 最後に取得を試みた時刻(復帰時の再検証を間引くため)。
  const lastPermissionsLoadRef = useRef(0);

  // options.background=true は「画面に居たまま裏で最新化する」経路(復帰時の再検証)。
  // permissionsLoading を立てない = consumer のボタンが一瞬消えない。剥奪の反映は応答が
  // 返った時点(1RTT遅れ)になるが、従来は**リロードするまで反映されなかった**ので改善。
  // 失敗時の fail-safe(permissions=null → ボタン非表示)は前景経路と完全に同一。
  const loadPermissions = useCallback((options?: { background?: boolean }): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    if (!options?.background) setPermissionsLoading(true);
    const run = fetch("/api/me/permissions")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!mountedRef.current) return;
        if (!json) {
          // 非 2xx = 信頼できる permissions 応答が得られていない。配布しない
          // （permissions=null = 権限なし扱い）だけでなく、bypass も false
          // （透かし表示側）へ倒す（Codex 対応3: bypass 剥奪後に refetch が
          // 失敗しても古い bypass=true が残らない）。
          setBypass(false);
          setPermissions(null);
          setCapabilities(null);
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
          registryLocationSearch: json.capabilities?.registryLocationSearch === true,
          registryPurchase: json.capabilities?.registryPurchase === true,
          reverseGeocode: json.capabilities?.reverseGeocode === true,
          registryOcrDraft: json.capabilities?.registryOcrDraft === true,
          saleDmLetter: json.capabilities?.saleDmLetter === true,
        });
        setPermissionsError(false);
        setPermissionsLoading(false);
      })
      .catch(() => {
        // 取得失敗時も同一の fail-safe 一式へ倒す: permissions/capabilities=null
        // （権限なし扱い）+ bypass=false（透かし表示側）+ error 通知
        // （Codex 対応3: 信頼できる応答が無いときは bypass を維持しない）。
        if (!mountedRef.current) return;
        setBypass(false);
        setPermissions(null);
        setCapabilities(null);
        setPermissionsLoading(false);
        setPermissionsError(true);
      })
      .finally(() => {
        inFlightRef.current = null;
        lastPermissionsLoadRef.current = Date.now();
      });
    inFlightRef.current = run;
    return run;
  }, []);

  // consumer へ配る refetch は常に前景(従来どおり permissionsLoading を立てる)。
  // context に options を漏らさない=画面側から間引き規則を壊せないようにする。
  const refetchPermissions = useCallback(
    (): Promise<void> => loadPermissions(),
    [loadPermissions],
  );

  useEffect(() => {
    mountedRef.current = true;
    loadPermissions();
    return () => {
      mountedRef.current = false;
    };
  }, [loadPermissions]);

  // @codex #367 P2: 画面に居続けている間の権限変更に追従する。各画面の「進入時に最大1回」
  // だけでは、開きっぱなしの画面で管理者が権限を剥奪しても遷移・リロードまで反映されない。
  // ここ1箇所で追従させる=全画面が同時に直り、画面ごとに実装がばらつかない。
  // ⚠監視の実体(可視状態の判定・間引き・listener 解除)は use-permissions-revalidation へ
  // 分離している。画面保護(S1b-2)は「この provider にタブの可視状態やフォーカスを監視する
  // 挙動を持ち込まない」というスコープ線引きをしており、権限鮮度はその関心の外だから
  // (透かし・コピー抑止・監査には一切触れない)。線引きはテストで固定している。
  // in-flight 中の dedupe は loadPermissions 側の inFlightRef が担う。
  // background=true = permissionsLoading を立てない → 復帰のたびにボタンが一瞬消えない。
  const revalidatePermissions = useCallback(() => {
    loadPermissions({ background: true });
  }, [loadPermissions]);
  usePermissionsRevalidation(revalidatePermissions, lastPermissionsLoadRef);

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
        refetchPermissions,
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
