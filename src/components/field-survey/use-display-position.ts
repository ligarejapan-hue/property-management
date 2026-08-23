"use client";

/**
 * 表示専用の現在地 (地図操作性 第1弾 A6・発注者承認 2026-08-24)。
 *
 * 背景(実測): 現在地マーカーは「巡回中かつ位置記録中」しか出ず、巡回なしの
 * 撮影や記録停止中は「家の上をタップして」と言われても自分の立ち位置が地図に
 * 出ていなかった。
 *
 * 方針:
 * - **勝手に権限プロンプトを出さない**。permissions.query が "granted" を返す
 *   ときだけ watch する (prompt 状態では何もしない=同意の導線は位置記録側が持つ)。
 * - permissions API が無い環境(古いiOS等)では従来どおり出さない(安全側)。
 * - 位置記録中は recorder が既に watch しているため、こちらは止める
 *   (enabled=false で呼ぶ)。二重 watch で電池を余計に使わない。
 * - 表示専用なので高精度は要求しない(enableHighAccuracy: false・30秒キャッシュ可)。
 *   失敗も静かに握る(エラー表示の役割は記録側にある)。
 */
import { useEffect, useState } from "react";

export interface DisplayPosition {
  lat: number;
  lng: number;
}

export function useGrantedGeolocationWatch(
  enabled: boolean,
): DisplayPosition | null {
  const [pos, setPos] = useState<DisplayPosition | null>(null);
  useEffect(() => {
    // ⚠effect 本体での同期 setState は禁止(repo 規約 react-hooks/set-state-in-effect)。
    //   無効時の「消す」は下の return 値のゲートで行い、ここでは何もしない。
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const permissions = (
      navigator as Navigator & { permissions?: Permissions }
    ).permissions;
    if (!permissions?.query) return;
    let watchId: number | null = null;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const start = () => {
      if (cancelled || watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(
        (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {
          // ⚠一度出た後の失敗(位置情報オフ・提供不能)で**古い現在地を出し
          //   続けない**(@codex #407 R1 P2)。現場が古い印を信じて隣の家を
          //   選ぶ事故につながる。エラー表示は出さない(役割は記録側)が、
          //   印は消す。次に取れたら再表示される。
          setPos(null);
        },
        { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
      );
    };
    const stop = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      setPos(null);
    };
    const onChange = () => {
      if (status?.state === "granted") start();
      else stop();
    };
    permissions
      .query({ name: "geolocation" })
      .then((s) => {
        if (cancelled) return;
        status = s;
        // ⚠"granted" のときだけ。"prompt" で watch すると許可ダイアログが
        //   勝手に出る(同意の導線は位置記録側の説明モーダルが持つ)。
        if (s.state === "granted") start();
        s.addEventListener?.("change", onChange);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      status?.removeEventListener?.("change", onChange);
      stop();
    };
  }, [enabled]);
  // enabled=false の間は古い値を見せない(state の掃除は次回 watch が上書きする)。
  return enabled ? pos : null;
}
