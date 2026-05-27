"use client";

/**
 * 現地調査マップ (Phase 1-E) のメイン UI。
 *
 * - Google Maps を APIProvider + Map で描画する。
 * - 地図 pan/zoom が落ち着いたタイミング (idle) で bbox を取り、
 *   /api/field-survey/map/properties と /api/field-survey/pins を並行取得。
 *   過剰リクエストにならないよう debounce を挟む。
 * - Property / Pin の marker 表示と、クリック時の InfoWindow 簡易情報を提供。
 *   owner 氏名・住所などの PII は表示しない (API も返さない設計)。
 * - 巡回開始 / 終了 / 現在位置 / ルート表示 は次フェーズで実装する
 *   プレースホルダ UI のみ用意。
 * - lat/lng/bbox を console / AuditLog に流さない。エラーはユーザー向け
 *   汎用メッセージのみ表示。
 */

import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
} from "@vis.gl/react-google-maps";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bbox,
  buildMapPropertiesQuery,
  debounce,
  validateBbox,
} from "@/lib/field-survey-map-util";

// 東京駅付近を初期表示の中心にする (海外案件用ではない国内利用前提)。
const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const DEFAULT_ZOOM = 14;
const FETCH_DEBOUNCE_MS = 500;
const PROPERTY_LIMIT = 200;
const PIN_LIMIT = 100;

interface FieldSurveyMapProps {
  apiKey: string;
  mapId?: string;
}

interface PropertyRow {
  id: string;
  address: string;
  gpsLat: number;
  gpsLng: number;
  propertyType: string;
  registryStatus: string;
  dmStatus: string;
  caseStatus: string;
  updatedAt: string;
}

interface PinRow {
  id: string;
  staffUserId: string;
  sessionId: string | null;
  propertyId: string | null;
  lat: number;
  lng: number;
  pinType: string;
  status: string;
  // memo 本文は Map UI に出さない (Codex P2)。「メモあり」boolean のみ別途 derive。
  hasMemo?: boolean;
}

type Layer = "properties" | "pins";

export default function FieldSurveyMap({ apiKey, mapId }: FieldSurveyMapProps) {
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    properties: true,
    pins: true,
  });
  const [error, setError] = useState<string | null>(null);

  return (
    <APIProvider apiKey={apiKey}>
      <div className="relative h-full w-full">
        <Map
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={DEFAULT_ZOOM}
          mapId={mapId}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: "100%", height: "100%" }}
        >
          <MapDataLayer layers={layers} onError={setError} />
        </Map>

        <ControlPanel
          layers={layers}
          onToggle={(key) =>
            setLayers((prev) => ({ ...prev, [key]: !prev[key] }))
          }
        />

        {error && (
          <div
            role="alert"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 shadow"
          >
            {error}
          </div>
        )}
      </div>
    </APIProvider>
  );
}

function ControlPanel({
  layers,
  onToggle,
}: {
  layers: Record<Layer, boolean>;
  onToggle: (key: Layer) => void;
}) {
  return (
    <div className="absolute right-3 top-3 w-56 rounded-md border border-gray-200 bg-white p-3 text-sm shadow">
      <div className="mb-2 text-xs font-semibold text-gray-600">表示切替</div>
      <label className="mb-1 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={layers.properties}
          onChange={() => onToggle("properties")}
        />
        <span>既存物件</span>
      </label>
      <label className="mb-3 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={layers.pins}
          onChange={() => onToggle("pins")}
        />
        <span>調査ピン</span>
      </label>

      <div className="mb-1 text-xs font-semibold text-gray-600">巡回操作</div>
      <p className="mb-2 text-[11px] leading-snug text-gray-500">
        次フェーズで実装予定 (Phase 1-F)
      </p>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="mb-1 w-full cursor-not-allowed rounded border border-gray-200 bg-gray-100 px-2 py-1 text-xs text-gray-400"
      >
        巡回開始
      </button>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="mb-1 w-full cursor-not-allowed rounded border border-gray-200 bg-gray-100 px-2 py-1 text-xs text-gray-400"
      >
        巡回終了
      </button>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="w-full cursor-not-allowed rounded border border-gray-200 bg-gray-100 px-2 py-1 text-xs text-gray-400"
      >
        現在位置
      </button>
    </div>
  );
}

function MapDataLayer({
  layers,
  onError,
}: {
  layers: Record<Layer, boolean>;
  onError: (msg: string | null) => void;
}) {
  const map = useMap();
  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [pins, setPins] = useState<PinRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<
    | { kind: "property"; row: PropertyRow }
    | { kind: "pin"; row: PinRow }
    | null
  >(null);
  const abortRef = useRef<AbortController | null>(null);

  // bbox を取って fetch する関数 (debounce 後に呼ばれる)
  const fetchForBbox = useCallback(
    async (b: Bbox) => {
      const v = validateBbox(b);
      if (!v.ok) {
        // 面積過大はユーザーにズームアップを促す (詳細座標は出さない)
        if (v.reason === "too_large_lat" || v.reason === "too_large_lng") {
          onError(
            "表示範囲が広すぎます。ズームインしてください。",
          );
        }
        return;
      }
      onError(null);

      // 先行 request を中断する
      if (abortRef.current) abortRef.current.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      try {
        const tasks: Promise<Response>[] = [];
        if (layers.properties) {
          tasks.push(
            fetch(
              `/api/field-survey/map/properties?${buildMapPropertiesQuery(b, {
                limit: PROPERTY_LIMIT,
              })}`,
              { signal: ac.signal, credentials: "same-origin" },
            ),
          );
        }
        if (layers.pins) {
          // Codex P2: pin fetch も bbox スコープに絞り、viewport 外の他人 pin
          // を取らない。bbox は Property と同じ map bounds を使う。
          const pinQs = new URLSearchParams({
            north: String(b.north),
            south: String(b.south),
            east: String(b.east),
            west: String(b.west),
            limit: String(PIN_LIMIT),
          });
          tasks.push(
            fetch(`/api/field-survey/pins?${pinQs.toString()}`, {
              signal: ac.signal,
              credentials: "same-origin",
            }),
          );
        }

        const results = await Promise.all(tasks);
        let idx = 0;
        if (layers.properties) {
          const r = results[idx++];
          if (r.ok) {
            const j = (await r.json()) as { data?: PropertyRow[] };
            setProperties(filterValidGps(j.data ?? []));
          } else {
            handleHttpError(r.status, onError);
          }
        } else {
          setProperties([]);
        }
        if (layers.pins) {
          const r = results[idx++];
          if (r.ok) {
            // API は memo を返すが UI では本文を持ち回らない。
            // 「メモあり」boolean のみ derive して以後 raw memo は捨てる。
            const j = (await r.json()) as {
              data?: (PinRow & { memo?: string | null })[];
            };
            setPins(filterValidPinGps(stripPinMemo(j.data ?? [])));
          } else {
            handleHttpError(r.status, onError);
          }
        } else {
          setPins([]);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        // 詳細は console / UI に出さない
        onError("地図データの取得に失敗しました。");
      } finally {
        setLoading(false);
      }
    },
    [layers.properties, layers.pins, onError],
  );

  // map idle イベントで bbox を debounce 取得
  useEffect(() => {
    if (!map) return;
    const debounced = debounce((b: Bbox) => {
      void fetchForBbox(b);
    }, FETCH_DEBOUNCE_MS);

    const listener = map.addListener("idle", () => {
      const bounds = map.getBounds();
      if (!bounds) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      debounced({
        north: ne.lat(),
        south: sw.lat(),
        east: ne.lng(),
        west: sw.lng(),
      });
    });

    return () => {
      debounced.cancel();
      listener.remove();
      if (abortRef.current) abortRef.current.abort();
    };
  }, [map, fetchForBbox]);

  // layer toggle 時にも一回取り直す (現在 bbox で)
  useEffect(() => {
    if (!map) return;
    const bounds = map.getBounds();
    if (!bounds) return;
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    void fetchForBbox({
      north: ne.lat(),
      south: sw.lat(),
      east: ne.lng(),
      west: sw.lng(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.properties, layers.pins]);

  return (
    <>
      {layers.properties &&
        properties.map((p) => (
          <AdvancedMarker
            key={p.id}
            position={{ lat: p.gpsLat, lng: p.gpsLng }}
            onClick={() => setSelected({ kind: "property", row: p })}
            title={p.address}
          />
        ))}
      {layers.pins &&
        pins.map((pin) => (
          <AdvancedMarker
            key={pin.id}
            position={{ lat: pin.lat, lng: pin.lng }}
            onClick={() => setSelected({ kind: "pin", row: pin })}
            title={pin.pinType}
          />
        ))}

      {selected && selected.kind === "property" && (
        <InfoWindow
          position={{ lat: selected.row.gpsLat, lng: selected.row.gpsLng }}
          onCloseClick={() => setSelected(null)}
        >
          <PropertyInfo row={selected.row} />
        </InfoWindow>
      )}
      {selected && selected.kind === "pin" && (
        <InfoWindow
          position={{ lat: selected.row.lat, lng: selected.row.lng }}
          onCloseClick={() => setSelected(null)}
        >
          <PinInfo row={selected.row} />
        </InfoWindow>
      )}

      {loading && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
          読み込み中…
        </div>
      )}
    </>
  );
}

function PropertyInfo({ row }: { row: PropertyRow }) {
  return (
    <div className="min-w-[200px] max-w-[280px] text-xs">
      <div className="mb-1 font-semibold text-gray-800">{row.address}</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>種別</dt>
        <dd>{row.propertyType}</dd>
        <dt>登記</dt>
        <dd>{row.registryStatus}</dd>
        <dt>DM</dt>
        <dd>{row.dmStatus}</dd>
        <dt>案件</dt>
        <dd>{row.caseStatus}</dd>
      </dl>
      <div className="mt-2">
        <a
          href={`/properties/${row.id}`}
          className="text-blue-600 hover:underline"
        >
          詳細を開く →
        </a>
      </div>
    </div>
  );
}

function PinInfo({ row }: { row: PinRow }) {
  return (
    <div className="min-w-[200px] max-w-[280px] text-xs">
      <div className="mb-1 font-semibold text-gray-800">調査ピン</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>種類</dt>
        <dd>{row.pinType}</dd>
        <dt>状態</dt>
        <dd>{row.status}</dd>
        <dt>session</dt>
        <dd>{row.sessionId ? "あり" : "—"}</dd>
        <dt>物件</dt>
        <dd>
          {row.propertyId ? (
            <a
              href={`/properties/${row.propertyId}`}
              className="text-blue-600 hover:underline"
            >
              紐付け済 →
            </a>
          ) : (
            "—"
          )}
        </dd>
        <dt>メモ</dt>
        <dd>{row.hasMemo ? "あり (詳細は pin 編集画面で確認)" : "—"}</dd>
      </dl>
    </div>
  );
}

function handleHttpError(status: number, onError: (m: string) => void) {
  if (status === 401) onError("ログインが必要です。再ログインしてください。");
  else if (status === 403) onError("閲覧権限がありません。");
  else if (status === 422) onError("リクエストが不正です。");
  else onError("地図データの取得に失敗しました。");
}

// 念のため数値の lat/lng のみ残す。string や null/undefined は marker に出さない。
function filterValidGps(rows: PropertyRow[]): PropertyRow[] {
  return rows.filter(
    (r) =>
      typeof r.gpsLat === "number" &&
      typeof r.gpsLng === "number" &&
      Number.isFinite(r.gpsLat) &&
      Number.isFinite(r.gpsLng),
  );
}

function filterValidPinGps(rows: PinRow[]): PinRow[] {
  return rows.filter(
    (r) =>
      typeof r.lat === "number" &&
      typeof r.lng === "number" &&
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lng),
  );
}

// API レスポンス上の memo 本文を Map UI の state に持ち込まない (Codex P2)。
// 「メモあり」boolean のみ derive して raw memo は捨てる。
// これにより React DevTools / 後段の console / 派生 state に memo 本文が
// 残らないことを構造的に保証する。
function stripPinMemo(
  rows: (PinRow & { memo?: string | null })[],
): PinRow[] {
  return rows.map(({ memo, ...rest }) => ({
    ...rest,
    hasMemo: typeof memo === "string" && memo.trim().length > 0,
  }));
}
