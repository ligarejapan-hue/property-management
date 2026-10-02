"use client";

import { createContext, useContext } from "react";
import type { PermissionEntry } from "@/lib/api-helpers";

/**
 * 画面保護の context(状態の形・既定値・読み出し)だけを持つ小さな部品。
 * 小窓の器(ModalShell)など広く使われる部品が透かしを描くために読む。provider 本体(取得・監視・
 * 画面保護の見張り)を import しないで済むよう分けた=器を使う全画面の依存を膨らませない。
 * provider は同じものを re-export する(既存の import 先はそのまま使える)。
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
  saleDmPrintReady: boolean;
}

export interface ScreenProtectionState {
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

export const ScreenProtectionContext = createContext<ScreenProtectionState>({
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

