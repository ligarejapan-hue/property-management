"use client";

import { useEffect, useState } from "react";
import { shouldWarnInsecureContext } from "@/lib/field-survey-secure-context";

/**
 * insecure context (非HTTPS かつ非localhost) を事前検知して警告する小バナー。
 *
 * - 現地調査の Geolocation API / camera capture は HTTPS もしくは localhost でのみ
 *   安定動作する。LAN IP の http では位置情報が silent fail しやすいため、実機検証で
 *   原因不明の「現在地が取れない」を避けるための事前ヒント。
 * - 表示のみ。機能は止めない (geolocation / camera の permission 処理・Google Maps の
 *   env gate は一切変更しない)。
 * - 判定は mount 後の effect で行う (SSR では何も出さず hydration mismatch を避ける)。
 * - hostname / protocol を画面に出さない (PII ではないが余計な情報を出さない方針)。
 */
export default function InsecureContextBanner() {
  const [warn, setWarn] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setWarn(
      shouldWarnInsecureContext({
        isSecureContext: window.isSecureContext,
        protocol: window.location.protocol,
        hostname: window.location.hostname,
      }),
    );
  }, []);

  if (!warn) return null;

  return (
    <div
      role="alert"
      data-testid="field-survey-insecure-context-banner"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900"
    >
      <p className="font-semibold">
        この URL は HTTPS ではありません（位置情報・カメラが動作しない場合があります）
      </p>
      <p className="mt-0.5 text-amber-800">
        現地調査の位置情報・カメラは HTTPS または localhost でのみ安定動作します。
        LAN IP（例: http のローカルアドレス）では現在地を取得できないことがあります。
        本番・実機検証では HTTPS の URL を使用してください。
      </p>
    </div>
  );
}
