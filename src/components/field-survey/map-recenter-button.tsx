"use client";

/**
 * 地図の「現在地へ移動」ボタン (地図左下に常設する FAB)。
 *
 * ⚠**なぜ新設したか**: 同じ操作は表示切替パネル最下部の CurrentLocationStatus
 * にもあるが、スマホではパネルを開いて最下部までスクロールしないと押せず、
 * さらに**巡回中 (位置記録中) にしか使えない**。街歩き中に地図をずらして
 * 自分の場所へ戻る、という最も頻度の高い操作が最も遠い場所にあった
 * (2026-08-03 発注者の実機フィードバック「現在位置に移動するボタンが欲しい」)。
 *
 * 位置の取り方は 2 通り (分岐は field-survey-map-recenter.ts の純関数):
 *   1. 位置記録中 = recorder が持っている最新位置をそのまま使う (即座に動く)
 *   2. それ以外 = この場で単発取得する (getCurrentPosition・watch は張らない)
 *
 * 取り扱いの制約 (現地調査まわりの既定ルール):
 * - **座標を保存しない・送信しない**。親へ渡して地図を寄せるためだけに使う。
 * - lat / lng / raw position を console・画面表示・エラー文言に出さない。
 * - localStorage / sessionStorage / IndexedDB を使わない。
 * - watchPosition は使わない (継続的な追跡は巡回中の recorder だけが行う)。
 * - ⚠この単発取得は**記録ではない**ため、位置記録の同意 (LocationConsentNotice)
 *   の対象外。同意文の「記録は巡回中だけです」を破らないよう、取得した座標は
 *   panTo に渡した時点で捨てる (state にも ref にも残さない)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LocateFixed, Loader2 } from "lucide-react";
import {
  describeGeolocationError,
  recenterPlan,
  RECENTER_UNSUPPORTED_MESSAGE,
  type RecenterPosition,
} from "@/lib/field-survey-map-recenter";

/** 単発取得の待ち時間。屋内・電波が弱い場所を考慮しつつ、無限に待たせない。 */
const GEOLOCATION_TIMEOUT_MS = 10_000;
/**
 * 直近の測位結果を再利用してよい時間。街歩きの「自分の場所へ戻る」用途では
 * 30 秒前の位置で十分実用になり、その分ボタンが即座に反応する。
 */
const GEOLOCATION_MAX_AGE_MS = 30_000;

export interface MapRecenterButtonProps {
  /**
   * 位置記録中に recorder が保持している最新位置。あるときは追加取得せずこれを使う。
   * 記録していない (= null) ときだけ単発取得に落ちる。
   */
  livePosition: RecenterPosition | null;
  /** 地図を寄せる。座標はここへ渡すだけで、本コンポーネントは保持しない。 */
  onRecenter: (pos: RecenterPosition) => void;
  /**
   * 環境差の吸収用 (テストで navigator.geolocation を差し替える窓口)。
   * 未指定なら実ブラウザの navigator.geolocation を使う。
   */
  geolocation?: Pick<Geolocation, "getCurrentPosition"> | null;
}

export default function MapRecenterButton({
  livePosition,
  onRecenter,
  geolocation,
}: MapRecenterButtonProps) {
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // unmount 後の setState を止める (取得は最大 10 秒かかるため実際に起こる)。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ⚠**取得完了時は「そのときの最新の onRecenter」を呼ぶ** (@codex #351 P2)。
  // 地図の初期化前にこのボタンを押すと、click 時点の onRecenter は
  // mapInstance === null の closure を掴んでいる。単発取得には最大 10 秒
  // かかるので、その間に地図が用意できても**古い closure が黙って何もせず
  // 戻り、最初の 1 タップだけ効かない**ように見える。ref 経由で呼べば、
  // 取得が終わった時点で有効になっている handler へ届く。
  const onRecenterRef = useRef(onRecenter);
  useEffect(() => {
    onRecenterRef.current = onRecenter;
  }, [onRecenter]);

  const handleClick = useCallback(() => {
    const plan = recenterPlan({ livePosition, locating });
    if (plan.kind === "busy") return;
    setError(null);
    if (plan.kind === "use-live") {
      onRecenterRef.current(plan.pos);
      return;
    }
    const geo =
      geolocation ??
      (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geo) {
      setError(RECENTER_UNSUPPORTED_MESSAGE);
      return;
    }
    setLocating(true);
    geo.getCurrentPosition(
      (pos) => {
        if (!mountedRef.current) return;
        setLocating(false);
        // ⚠座標はここで親へ渡すだけ。state にも ref にも残さない。
        onRecenterRef.current({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      (err) => {
        if (!mountedRef.current) return;
        setLocating(false);
        setError(describeGeolocationError(err?.code ?? null));
      },
      {
        enableHighAccuracy: true,
        timeout: GEOLOCATION_TIMEOUT_MS,
        maximumAge: GEOLOCATION_MAX_AGE_MS,
      },
    );
    // onRecenter は ref 経由で読むので依存に入れない (毎レンダーの作り直しを避ける)。
  }, [geolocation, livePosition, locating]);

  return (
    <div className="pointer-events-none absolute bottom-14 left-3 z-10 flex flex-col items-start gap-1">
      {/* エラーはボタンの上に出す (下だと画面外へ落ちることがある)。
          タッチ端末では title が出ないため可視テキストで示す。 */}
      {error && (
        <p
          role="status"
          data-testid="map-recenter-error"
          className="pointer-events-auto max-w-[15rem] rounded bg-white/95 px-2 py-1 text-[10px] leading-snug text-amber-800 shadow dark:bg-gray-900/95 dark:text-amber-300"
        >
          {error}
        </p>
      )}
      {/* ⚠アイコンだけのボタンなので、用途は aria-label (読み上げ) と
          title (PC のツールチップ) で必ず伝える。 */}
      <button
        type="button"
        onClick={handleClick}
        disabled={locating}
        data-testid="map-recenter-button"
        aria-label="現在地へ移動"
        title="現在地へ移動"
        className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-70 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
      >
        {locating ? (
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        ) : (
          <LocateFixed className="h-6 w-6" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
