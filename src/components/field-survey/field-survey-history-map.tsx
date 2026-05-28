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
} from "@vis.gl/react-google-maps";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
const TRACK_PAGE_LIMIT = 500;
const TRACK_PAGE_MAX = 50; // 最大 25,000 点まで取得 (decimation は今回しない)
const PIN_LIMIT = 100;

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
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [routePoints, setRoutePoints] = useState<RoutePolylinePoint[]>([]);
  const [pins, setPins] = useState<HistoryPinRow[]>([]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [detailPinId, setDetailPinId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const loadAll = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      // 1) session メタ
      const metaRes = await fetch(
        `/api/field-survey/sessions/${encodeURIComponent(sessionId)}`,
        { credentials: "same-origin", signal: ac.signal },
      );
      if (!mountedRef.current) return;
      if (!metaRes.ok) {
        setError(
          metaRes.status === 403
            ? "この巡回を閲覧する権限がありません。"
            : metaRes.status === 404
              ? "巡回 session が見つかりません。"
              : "巡回履歴の取得に失敗しました。",
        );
        return;
      }
      const metaBody = (await metaRes.json().catch(() => null)) as
        | { data?: SessionMeta }
        | null;
      if (!mountedRef.current || !metaBody?.data) return;
      const m = metaBody.data;
      setMeta(m);

      // 2) track points を cursor pagination で全件取得 → polyline
      const points: RoutePolylinePoint[] = [];
      let cursor: number | null = null;
      for (let i = 0; i < TRACK_PAGE_MAX; i++) {
        const qs = new URLSearchParams({ limit: String(TRACK_PAGE_LIMIT) });
        if (cursor !== null) qs.set("cursorSequence", String(cursor));
        const tpRes = await fetch(
          `/api/field-survey/sessions/${encodeURIComponent(sessionId)}/track-points?${qs.toString()}`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (!mountedRef.current) return;
        if (!tpRes.ok) break;
        const tpBody = (await tpRes.json().catch(() => null)) as
          | { data?: TrackPointApiRow[]; nextCursor?: number | null }
          | null;
        if (!mountedRef.current) return;
        const rows = Array.isArray(tpBody?.data) ? tpBody!.data! : [];
        for (const r of rows) {
          const lat = coerceLat(r.lat);
          const lng = coerceLng(r.lng);
          if (lat !== null && lng !== null) points.push({ lat, lng });
        }
        const next = tpBody?.nextCursor;
        if (typeof next !== "number") break;
        cursor = next;
      }
      if (!mountedRef.current) return;
      setRoutePoints(points);

      // 3) session に紐づく pin (archived 除外)。他人 session は staffUserId を
      //    付与して既存 pin_list_others 監査を発火させる。view=map で memo を載せない。
      const pinQs = new URLSearchParams({
        view: "map",
        sessionId,
        staffUserId: m.staffUserId,
        limit: String(PIN_LIMIT),
      });
      const pinRes = await fetch(
        `/api/field-survey/pins?${pinQs.toString()}`,
        { credentials: "same-origin", signal: ac.signal },
      );
      if (!mountedRef.current) return;
      if (pinRes.ok) {
        const pinBody = (await pinRes.json().catch(() => null)) as
          | { data?: Array<Record<string, unknown>> }
          | null;
        if (!mountedRef.current) return;
        const list = Array.isArray(pinBody?.data) ? pinBody!.data! : [];
        const normalized: HistoryPinRow[] = [];
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
        setPins(normalized);
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (!mountedRef.current) return;
      setError("巡回履歴の取得に失敗しました。");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const center = routePoints[0] ?? pins[0] ?? DEFAULT_CENTER;

  return (
    <div className="relative h-full w-full">
      {/* 履歴閲覧中バナー + 通常マップへ戻る導線 */}
      <div
        data-testid="history-mode-banner"
        className="flex items-center justify-between gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900"
      >
        <span>
          履歴閲覧中（read-only）
          {meta?.staffName ? ` / ${meta.staffName}` : ""}
        </span>
        <Link
          href="/field-survey/map"
          data-testid="history-back-to-map"
          className="rounded border border-blue-300 bg-white px-2 py-1 text-blue-700 hover:bg-blue-100"
        >
          通常マップに戻る
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow"
        >
          {error}
        </div>
      )}
      {loading && !error && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 rounded-md bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
          読み込み中…
        </div>
      )}

      <div className="h-[calc(100%-2.25rem)] w-full">
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={center}
            defaultZoom={DEFAULT_ZOOM}
            mapId={mapId}
            gestureHandling="greedy"
            disableDefaultUI={false}
            style={{ width: "100%", height: "100%" }}
          >
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
              className="text-blue-600 hover:underline"
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
        className="mt-2 text-blue-600 hover:underline"
      >
        詳細を見る
      </button>
    </div>
  );
}
