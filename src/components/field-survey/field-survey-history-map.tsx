"use client";

/**
 * Phase 1-J: 過去ルートの履歴閲覧マップ (完全 read-only)。
 *
 * - `?sessionId=xxx` で遷移した時のみ mount される (field-survey-map-client が分岐)。
 * - GET /api/field-survey/sessions/[id] で session メタを取得 (staffName / 件数)。
 * - GET /api/field-survey/sessions/[id]/track-points を cursor pagination で全件取得し
 *   RoutePolyline で過去ルートを描画する。
 * - GET /api/field-survey/pins?sessionId=xxx でその session の pin だけ marker 表示。
 *   archived は既定除外。pin クリックで read-only の PinDetailPanel を開く。
 * - 記録系 (巡回開始終了 / 位置記録 / 現在地 / pin 追加) の UI は一切 mount しない。
 * - 端末位置取得 API も track point の書き込み API も呼ばない (GET 専用)。
 * - 座標 / memo / 写真URL / storageKey / PII を console に出さない。
 * - localStorage / sessionStorage / IndexedDB を使わない。
 */

import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
} from "@vis.gl/react-google-maps";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMapGestureHandling } from "@/components/field-survey/use-map-gesture-handling";
import RoutePolyline, {
  type RoutePolylinePoint,
} from "@/components/field-survey/route-polyline";
import PinDetailPanel from "@/components/field-survey/pin-detail-panel";
import {
  coerceLat,
  coerceLng,
} from "@/lib/field-survey-map-util";
import { formatPinStatus, formatPinType } from "@/lib/field-survey-pin-util";

const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const DEFAULT_ZOOM = 15;
const SINGLE_POINT_ZOOM = 17;
const TRACK_PAGE_LIMIT = 500;
const TRACK_PAGE_MAX = 50; // 最大 25,000 点まで取得 (decimation は今回しない)
const PIN_LIMIT = 100;
const PIN_PAGE_MAX = 20; // 最大 2,000 件まで取得。超過時は truncated 警告。

// fitBounds / panTo / setZoom のみ使う最小 map interface (SSR / 型依存回避)。
interface MapLike {
  fitBounds: (bounds: unknown, padding?: number) => void;
  panTo: (latLng: { lat: number; lng: number }) => void;
  setZoom: (zoom: number) => void;
}

interface LatLngBoundsLike {
  extend: (latLng: { lat: number; lng: number }) => void;
}
interface GoogleMapsNs {
  LatLngBounds: new () => LatLngBoundsLike;
}

interface SessionMeta {
  id: string;
  staffUserId: string;
  staffName: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  pointCount: number;
  pinCount: number;
}

interface HistoryPinRow {
  id: string;
  lat: number;
  lng: number;
  pinType: string;
  status: string;
  propertyId: string | null;
}

interface TrackPointApiRow {
  sequence: number;
  lat: unknown;
  lng: unknown;
}

export default function FieldSurveyHistoryMap({
  apiKey,
  mapId,
  currentUserId,
  sessionId,
}: {
  apiKey: string;
  mapId: string;
  currentUserId: string;
  sessionId: string;
}) {
  // タッチ端末では地図ジェスチャを cooperative(1本指=ページスクロール / 2本指=地図移動)に
  // して、地図が画面を占有し周囲の UI に触れなくなる問題を避ける。PC は greedy 継続。共有フック。
  const mapGestureHandling = useMapGestureHandling();
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [routePoints, setRoutePoints] = useState<RoutePolylinePoint[]>([]);
  const [pins, setPins] = useState<HistoryPinRow[]>([]);
  const [pinsTruncated, setPinsTruncated] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [detailPinId, setDetailPinId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapInstance, setMapInstance] = useState<MapLike | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // セッションごとに初回のみ自動で表示範囲へ移動する (以後ユーザー操作を尊重)。
  const hasFitRef = useRef(false);
  // 読み込み世代。新しい load が始まったら古い load の遅延継続を無効化し、
  // 古い fetch 結果が新 session の state を上書きしないようにする。
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // session 固有の表示 state を全消去する。読み込み開始時 / session 切替時に呼ぶ。
  // 座標・PII は state に残さず確実にクリアする (mountedRef に依存せず実行)。
  const clearHistorySessionState = useCallback(() => {
    setMeta(null);
    setRoutePoints([]);
    setPins([]);
    setPinsTruncated(false);
    setSelectedPinId(null);
    setDetailPinId(null);
    setError(null);
    hasFitRef.current = false;
  }, []);

  // sessionId が変われば前 session の route / pin / meta を即時クリアし、
  // 自動 fit もやり直せるよう reset する (新 load が失敗しても stale を残さない)。
  useEffect(() => {
    clearHistorySessionState();
  }, [sessionId, clearHistorySessionState]);

  const loadAll = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++loadGenerationRef.current;
    // この load が最新でない / unmount 済みなら以降の state 反映を止める。
    const stale = () => !mountedRef.current || loadGenerationRef.current !== gen;
    // 開始時点で前 session の表示データを必ずクリアする。これにより metadata が
    // 403 / 404 / malformed で早期 return しても古い route / pin / meta が残らない。
    clearHistorySessionState();
    setLoading(true);
    try {
      // 1) session メタ
      const metaRes = await fetch(
        `/api/field-survey/sessions/${encodeURIComponent(sessionId)}`,
        { credentials: "same-origin", signal: ac.signal },
      );
      if (stale()) return;
      if (!metaRes.ok) {
        setError(
          metaRes.status === 403
            ? "この巡回を閲覧する権限がありません。"
            : metaRes.status === 404
              ? "巡回の記録が見つかりません。"
              : "巡回履歴の取得に失敗しました。",
        );
        return;
      }
      const metaBody = (await metaRes.json().catch(() => null)) as
        | { data?: SessionMeta }
        | null;
      if (stale()) return;
      if (!metaBody?.data) {
        setError("巡回履歴の取得に失敗しました。");
        return;
      }
      const m = metaBody.data;
      setMeta(m);

      // 2) track points を cursor pagination で全件取得 → polyline
      const points: RoutePolylinePoint[] = [];
      let cursor: number | null = null;
      let routeOverCap = false;
      for (let i = 0; i < TRACK_PAGE_MAX; i++) {
        const qs = new URLSearchParams({ limit: String(TRACK_PAGE_LIMIT) });
        if (cursor !== null) qs.set("cursorSequence", String(cursor));
        const tpRes = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(sessionId)}/track-points?${qs.toString()}`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (stale()) return;
        // non-2xx は「途中まで表示」にせず読み込み失敗として扱う (fail closed)。
        if (!tpRes.ok) throw new Error("history_load_failed");
        const tpBody = (await tpRes.json().catch(() => null)) as
          | { data?: TrackPointApiRow[]; nextCursor?: number | null }
          | null;
        if (stale()) return;
        const rows = Array.isArray(tpBody?.data) ? tpBody!.data! : [];
        for (const r of rows) {
          const lat = coerceLat(r.lat);
          const lng = coerceLng(r.lng);
          if (lat !== null && lng !== null) points.push({ lat, lng });
        }
        const next = tpBody?.nextCursor;
        if (typeof next !== "number") break;
        cursor = next;
        // 最終反復でも nextCursor が残る = 上限超過。route は途中切れを完全な
        // 履歴として見せると巡回済/未巡回の判断を誤るため fail closed にする。
        if (i === TRACK_PAGE_MAX - 1) routeOverCap = true;
      }
      if (stale()) return;
      // 上限超過時は incomplete route を表示せず読み込み失敗として扱う (pin の
      // truncated 警告とは区別し、route は警告表示にしない)。
      if (routeOverCap) throw new Error("history_route_over_cap");
      setRoutePoints(points);

      // 3) session に紐づく pin (archived 除外) を nextCursor で全件ページング取得。
      //    他人 session は staffUserId を付与して既存 pin_list_others 監査を発火させる。
      //    view=map で memo を載せない。上限ページ到達時は truncated 警告を出す。
      const normalized: HistoryPinRow[] = [];
      let pinCursor: string | null = null;
      let truncated = false;
      for (let i = 0; i < PIN_PAGE_MAX; i++) {
        const pinQs = new URLSearchParams({
          view: "map",
          sessionId,
          staffUserId: m.staffUserId,
          limit: String(PIN_LIMIT),
        });
        if (pinCursor) pinQs.set("cursor", pinCursor);
        const pinRes = await fetch(
          `/api/field-survey/pins?${pinQs.toString()}`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (stale()) return;
        // non-2xx は「一部 pin のみ表示」にせず読み込み失敗として扱う (fail closed)。
        // truncated 警告は page 上限到達専用であり、HTTP failure を隠さない。
        if (!pinRes.ok) throw new Error("history_load_failed");
        const pinBody = (await pinRes.json().catch(() => null)) as
          | { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
          | null;
        if (stale()) return;
        const list = Array.isArray(pinBody?.data) ? pinBody!.data! : [];
        for (const raw of list) {
          const lat = coerceLat(raw.lat);
          const lng = coerceLng(raw.lng);
          if (lat === null || lng === null) continue;
          normalized.push({
            id: String(raw.id),
            lat,
            lng,
            pinType: String(raw.pinType ?? ""),
            status: String(raw.status ?? ""),
            propertyId:
              typeof raw.propertyId === "string" ? raw.propertyId : null,
          });
        }
        const nextCursor = pinBody?.nextCursor;
        if (typeof nextCursor !== "string") break;
        pinCursor = nextCursor;
        // 次ループが無い (最終反復) のに nextCursor が残っていれば truncated。
        if (i === PIN_PAGE_MAX - 1) truncated = true;
      }
      if (stale()) return;
      setPins(normalized);
      setPinsTruncated(truncated);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (stale()) return;
      // 不完全な route / pin / meta を残さず安全側にクリアしてからエラー表示する。
      // raw response / 座標 / PII は出さず汎用文言のみ。
      clearHistorySessionState();
      const overCap =
        err instanceof Error && err.message === "history_route_over_cap";
      setError(
        overCap
          ? "巡回ルートの点数が多すぎるため、履歴を表示できません。管理者に確認してください。"
          : "巡回履歴の読み込みに失敗しました。時間をおいて再度お試しください。",
      );
    } finally {
      // 最新 load かつ mount 中のときのみ loading を解除する (古い load が新 load
      // の spinner を消さないように世代で判定)。
      if (!stale()) setLoading(false);
    }
  }, [sessionId, clearHistorySessionState]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 読み込み後に表示範囲へ自動移動 (route 優先、無ければ pins)。session ごと初回のみ。
  // map instance / google 未取得時は安全に何もしない。lat/lng は console に出さない。
  useEffect(() => {
    if (hasFitRef.current) return;
    if (!mapInstance) return;
    const pts = routePoints.length > 0 ? routePoints : pins;
    if (pts.length === 0) return;
    const g =
      typeof window !== "undefined"
        ? (window as unknown as { google?: { maps?: GoogleMapsNs } }).google
            ?.maps
        : undefined;
    if (!g || typeof g.LatLngBounds !== "function") return;
    try {
      if (pts.length === 1) {
        mapInstance.panTo({ lat: pts[0].lat, lng: pts[0].lng });
        mapInstance.setZoom(SINGLE_POINT_ZOOM);
      } else {
        const bounds = new g.LatLngBounds();
        for (const p of pts) bounds.extend({ lat: p.lat, lng: p.lng });
        mapInstance.fitBounds(bounds, 48);
      }
      hasFitRef.current = true;
    } catch {
      // fitBounds / panTo 失敗時も座標や内部詳細は出さない。
    }
  }, [mapInstance, routePoints, pins]);

  const center = routePoints[0] ?? pins[0] ?? DEFAULT_CENTER;

  return (
    <div className="relative h-full w-full">
      {/* 履歴閲覧中バナー + 通常マップへ戻る導線 */}
      <div
        data-testid="history-mode-banner"
        className="flex items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-300"
      >
        <span>
          履歴閲覧中（read-only）
          {meta?.staffName ? ` / ${meta.staffName}` : ""}
        </span>
        <Link
          href="/field-survey/map"
          data-testid="history-back-to-map"
          className="rounded border border-blue-300 bg-white px-2 py-1 text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-gray-900 dark:text-blue-400 dark:hover:bg-gray-800"
        >
          通常マップに戻る
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
        >
          {error}
        </div>
      )}
      {loading && !error && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-md bg-white/90 px-3 py-1 text-xs text-gray-700 shadow dark:bg-gray-900/90 dark:text-gray-300">
          読み込み中…
        </div>
      )}
      {pinsTruncated && (
        <div
          role="status"
          data-testid="history-pins-truncated"
          className="absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-900 shadow dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
        >
          ピンが多いため一部のみ表示されています。
        </div>
      )}

      <div className="h-[calc(100%-2.25rem)] w-full">
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={center}
            defaultZoom={DEFAULT_ZOOM}
            mapId={mapId}
            gestureHandling={mapGestureHandling}
            disableDefaultUI={false}
            style={{ width: "100%", height: "100%" }}
          >
            <MapInstanceCapture onMap={setMapInstance} />
            <RoutePolyline points={routePoints} />
            {pins.map((pin) => (
              <AdvancedMarker
                key={pin.id}
                position={{ lat: pin.lat, lng: pin.lng }}
                onClick={() => setSelectedPinId(pin.id)}
                title={pin.pinType}
              />
            ))}
            {selectedPinId &&
              (() => {
                const pin = pins.find((p) => p.id === selectedPinId);
                if (!pin) return null;
                return (
                  <InfoWindow
                    position={{ lat: pin.lat, lng: pin.lng }}
                    onCloseClick={() => setSelectedPinId(null)}
                  >
                    <HistoryPinInfo
                      pin={pin}
                      onOpenDetail={() => {
                        setSelectedPinId(null);
                        setDetailPinId(pin.id);
                      }}
                    />
                  </InfoWindow>
                );
              })()}
          </Map>
        </APIProvider>
      </div>

      {detailPinId && (
        <PinDetailPanel
          pinId={detailPinId}
          currentUserId={currentUserId}
          readOnly
          onClose={() => setDetailPinId(null)}
        />
      )}
    </div>
  );
}

// <Map> 内で useMap() した instance を親へ伝搬する (fitBounds 用)。
// google.maps へ直接アクセスせず vis.gl の hook 経由で取得 / cleanup する。
function MapInstanceCapture({ onMap }: { onMap: (m: MapLike | null) => void }) {
  const map = useMap();
  useEffect(() => {
    onMap((map as unknown as MapLike) ?? null);
    return () => {
      onMap(null);
    };
  }, [map, onMap]);
  return null;
}

function HistoryPinInfo({
  pin,
  onOpenDetail,
}: {
  pin: HistoryPinRow;
  onOpenDetail: () => void;
}) {
  return (
    <div className="min-w-[180px] max-w-[260px] text-xs">
      <div className="mb-1 font-semibold text-gray-800">調査ピン</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>種類</dt>
        <dd>{formatPinType(pin.pinType)}</dd>
        <dt>状態</dt>
        <dd>{formatPinStatus(pin.status)}</dd>
        <dt>物件</dt>
        <dd>
          {pin.propertyId ? (
            <a
              href={`/properties/${pin.propertyId}`}
              className="text-indigo-600 hover:underline"
            >
              紐付け済 →
            </a>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <button
        type="button"
        onClick={onOpenDetail}
        data-testid="history-pin-open-detail"
        className="mt-2 text-indigo-600 hover:underline"
      >
        詳細を見る
      </button>
    </div>
  );
}
