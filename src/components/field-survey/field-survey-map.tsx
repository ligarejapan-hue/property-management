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
  coerceLat,
  coerceLng,
  debounce,
  validateBbox,
} from "@/lib/field-survey-map-util";
import TripControls from "@/components/field-survey/trip-controls";
import LocationRecorderControls from "@/components/field-survey/location-recorder-controls";
import RoutePolyline, {
  type RoutePolylinePoint,
} from "@/components/field-survey/route-polyline";
import { useFieldSurveyLocationRecorder } from "@/components/field-survey/use-field-survey-location-recorder";
import type { ActiveSessionLike } from "@/lib/field-survey-trip-util";
import PinAddModeToggle from "@/components/field-survey/pin-add-mode-toggle";
import PinCreateModal from "@/components/field-survey/pin-create-modal";
import PinDetailPanel from "@/components/field-survey/pin-detail-panel";
import { useFieldSurveyPinMutations } from "@/components/field-survey/use-field-survey-pin-mutations";
import { useFieldSurveyPinPhotoMutations } from "@/components/field-survey/use-field-survey-pin-photo-mutations";
import {
  formatPinStatus,
  formatPinType,
} from "@/lib/field-survey-pin-util";
import CurrentLocationMarker from "@/components/field-survey/current-location-marker";
import CurrentLocationStatus from "@/components/field-survey/current-location-status";

// 東京駅付近を初期表示の中心にする (海外案件用ではない国内利用前提)。
const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const DEFAULT_ZOOM = 14;
const FETCH_DEBOUNCE_MS = 500;
const PROPERTY_LIMIT = 200;
const PIN_LIMIT = 100;

interface FieldSurveyMapProps {
  apiKey: string;
  // AdvancedMarker を使うため Map ID は必須 (Codex Phase 1-E)。
  // 未設定での mount は呼び出し側 (page.tsx) で MissingMapIdFallback に
  // 切替済。本コンポーネントには必ず非空文字列が渡る前提。
  mapId: string;
  // Phase 1-F-1: 巡回 session の own/active 復元用に server-side で確定した
  // ログインユーザー ID を受け取る (client 側で再 fetch しないため漏洩面を絞る)。
  currentUserId: string;
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

export default function FieldSurveyMap({
  apiKey,
  mapId,
  currentUserId,
}: FieldSurveyMapProps) {
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    properties: true,
    pins: true,
  });
  const [error, setError] = useState<string | null>(null);
  // Phase 1-F-2: TripControls から active session (own のみ) の通知を受け、
  // location recorder hook を駆動する。session が無い間 hook は何もしない。
  const [activeSession, setActiveSession] = useState<ActiveSessionLike | null>(
    null,
  );
  const handleActiveSessionChange = useCallback(
    (s: ActiveSessionLike | null) => setActiveSession(s),
    [],
  );
  const recorder = useFieldSurveyLocationRecorder({
    sessionId: activeSession?.id ?? null,
  });
  // 巡回終了ボタン押下 → recorder を確実に停止してから session PATCH を打つ。
  // recorder.stopBeforeSessionEnd は idle 中なら no-op で安全。
  const handleBeforeSessionEnd = useCallback(
    () => recorder.stopBeforeSessionEnd(),
    [recorder],
  );
  // active session が消えたら parent 経由で polyline 表示も自然に空になる。
  // 表示する点は「保存済 + memory 上の未送信」を sequence 順で結合
  // (sequence 重複は flush 直後の race のみ。useMemo 内で saved 優先で dedup)。
  const polylinePoints: RoutePolylinePoint[] = useMemo(() => {
    if (!activeSession) return [];
    return mergePolylinePoints(recorder.savedPoints, recorder.pendingPoints);
  }, [activeSession, recorder.savedPoints, recorder.pendingPoints]);

  // Phase 1-F-3: 「現在地へ移動」ボタン用に Map インスタンスを保持する。
  // ControlPanel は <Map> の外にあるため、Map 内で useMap() で捕捉した値を
  // state に上げる (<MapInstanceCapture>)。クリック時のみ panTo を呼ぶ。
  const [mapInstance, setMapInstance] = useState<unknown>(null);
  const handlePanToCurrent = useCallback(() => {
    // Codex P2 (Phase 1-F-3 follow-up): recording 中以外 (idle / error / stopping /
    // preparing) では古い座標への panTo を許可しない。CurrentLocationStatus 側でも
    // disabled をかけているが、外部から直接呼ばれた場合 (将来の hotkey 等) に
    // 備えた server-side ガード相当の二重防御。
    if (recorder.status !== "recording") return;
    const pos = recorder.latestPositionForDisplay;
    if (!pos) return;
    const m = mapInstance as
      | { panTo?: (p: { lat: number; lng: number }) => void }
      | null;
    if (m && typeof m.panTo === "function") {
      m.panTo({ lat: pos.lat, lng: pos.lng });
    }
  }, [mapInstance, recorder.status, recorder.latestPositionForDisplay]);
  // 位置記録中かつ最新位置が取得済の時のみ現在地マーカーを描画する。
  const showCurrentLocationMarker =
    !!activeSession &&
    recorder.status === "recording" &&
    !!recorder.latestPositionForDisplay;

  // Phase 1-G: pin 追加モード / 詳細パネル / write 権限。
  // canWrite は /api/me/permissions で 1 回取得して memoize する。
  // 判定できない場合 (fetch 失敗) は null のまま、UI は API 403 を汎用化する。
  //
  // Codex P2 (本 fix): permission entry の `granted: boolean` を必ず見る。
  // resource + action だけで判定すると、明示 deny (granted: false) も
  // 「許可」として扱ってしまうため、`granted === true` を必須にする。
  // malformed / 欠損 entry は安全側で false。response 全文は console に出さない。
  const [canWritePin, setCanWritePin] = useState<boolean | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/me/permissions", {
          credentials: "same-origin",
          signal: ac.signal,
        });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | {
              permissions?: {
                resource?: string;
                action?: string;
                granted?: boolean;
              }[];
            }
          | null;
        if (!Array.isArray(body?.permissions)) {
          setCanWritePin(false);
          return;
        }
        const has = body!.permissions!.some(
          (p) =>
            p !== null &&
            typeof p === "object" &&
            p.resource === "field_survey" &&
            p.action === "write" &&
            p.granted === true,
        );
        setCanWritePin(has);
      } catch {
        // 判定不能。null のまま (API 403 で汎用化)。
      }
    })();
    return () => ac.abort();
  }, []);

  const [pinAddMode, setPinAddMode] = useState(false);
  // 地図 click / 「現在地を使う」で確定した作成候補座標。
  const [createCandidate, setCreateCandidate] = useState<
    | { lat: number; lng: number; accuracy?: number }
    | null
  >(null);
  const [detailPinId, setDetailPinId] = useState<string | null>(null);
  // Phase 1-H: pin 作成済みだが写真アップロードだけ失敗した状態。modal を閉じず
  // 「写真だけ再試行 / 写真なしで完了」に誘導し、pin を作り直させない。
  const [photoUploadFailed, setPhotoUploadFailed] = useState(false);
  // 作成済み pin id と再試行用の file を保持する (state 更新の非同期性を避け ref で持つ)。
  const createdPinIdRef = useRef<string | null>(null);
  const pendingPhotoFileRef = useRef<File | null>(null);
  // marker 再 fetch をトリガするためのバンプ値。pin 作成 / 編集成功で increment。
  const [refetchNonce, setRefetchNonce] = useState(0);
  const bumpRefetch = useCallback(() => {
    setRefetchNonce((n) => n + 1);
  }, []);
  // 「現在地を使う」用の単発取得 state (RouteRecorder hook は流用しない)。
  const [currentLocationLoading, setCurrentLocationLoading] = useState(false);
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(
    null,
  );
  // Codex P2: getCurrentPosition は API 上キャンセル不能のため、late callback を
  // 無視する token 方式で防御する。modal cancel / session 終了 / session 切替 /
  // unmount で必ず token を進めて pending callback を無効化する。
  const currentLocationRequestIdRef = useRef(0);
  // activeSession.id を ref 同期して closure 内で最新値を読めるようにする
  // (useCallback の stale closure 回避)。null = active session 無し。
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id ?? null;
  }, [activeSession]);
  const fsMapMountedRef = useRef(true);
  const invalidateCurrentLocationRequest = useCallback(() => {
    currentLocationRequestIdRef.current += 1;
    if (fsMapMountedRef.current) {
      setCurrentLocationLoading(false);
    }
  }, []);
  // unmount cleanup: late callback の state 更新を確実に止める
  useEffect(() => {
    fsMapMountedRef.current = true;
    return () => {
      fsMapMountedRef.current = false;
      currentLocationRequestIdRef.current += 1;
    };
  }, []);
  // active session が変わったら (null 化 / id 切替) pending request を無効化
  useEffect(() => {
    invalidateCurrentLocationRequest();
  }, [activeSession, invalidateCurrentLocationRequest]);

  const useCurrentLocationForCreate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setCurrentLocationError(
        "この端末では位置情報の利用ができません。",
      );
      return;
    }
    // active session が無ければ「現在地」自体不要 (modal も mount されない前提)
    const requestSessionId = activeSessionIdRef.current;
    if (!requestSessionId) {
      setCurrentLocationError(
        "巡回 session が無いため現在地を取得できません。",
      );
      return;
    }
    // 新 token を発行 (= 進行中の旧 callback を無効化)
    currentLocationRequestIdRef.current += 1;
    const requestId = currentLocationRequestIdRef.current;
    setCurrentLocationLoading(true);
    setCurrentLocationError(null);
    // 単発取得のみ。watchPosition は使わない。
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // late callback ガード: unmount / token 不一致 / session 終了 or 切替
        if (!fsMapMountedRef.current) return;
        if (currentLocationRequestIdRef.current !== requestId) return;
        if (activeSessionIdRef.current !== requestSessionId) return;
        setCurrentLocationLoading(false);
        // raw position を console / error に出さない
        const lat = pos?.coords?.latitude;
        const lng = pos?.coords?.longitude;
        if (
          typeof lat !== "number" ||
          typeof lng !== "number" ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lng)
        ) {
          setCurrentLocationError("現在地を取得できませんでした。");
          return;
        }
        const acc = pos?.coords?.accuracy;
        setCreateCandidate({
          lat,
          lng,
          accuracy:
            typeof acc === "number" && Number.isFinite(acc) ? acc : undefined,
        });
      },
      (err) => {
        if (!fsMapMountedRef.current) return;
        if (currentLocationRequestIdRef.current !== requestId) return;
        if (activeSessionIdRef.current !== requestSessionId) return;
        setCurrentLocationLoading(false);
        const code = (err as { code?: number })?.code;
        if (code === 1) {
          setCurrentLocationError(
            "位置情報の利用が拒否されています。ブラウザ設定で許可してください。",
          );
        } else if (code === 3) {
          setCurrentLocationError(
            "現在地の取得がタイムアウトしました。",
          );
        } else {
          setCurrentLocationError("現在地を取得できませんでした。");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
  }, []);

  const pinMutations = useFieldSurveyPinMutations();
  const photoMutations = useFieldSurveyPinPhotoMutations();

  // pin 作成 (+写真) が完結した時の共通後処理。modal を閉じ、誤タップ防止に
  // pin 追加モードを OFF にし、作成した pin の detail panel を開く。
  const finalizePinCreate = useCallback(
    (pinId: string) => {
      invalidateCurrentLocationRequest();
      setCreateCandidate(null);
      setPinAddMode(false);
      setPhotoUploadFailed(false);
      createdPinIdRef.current = null;
      pendingPhotoFileRef.current = null;
      // Phase 1-H: 作成後は detail panel を開く。
      setDetailPinId(pinId);
    },
    [invalidateCurrentLocationRequest],
  );

  const handlePinCreateSubmit = useCallback(
    async (
      input: {
        lat: number;
        lng: number;
        pinType: string;
        memo: string;
        accuracy?: number;
      },
      file: File | null,
    ) => {
      if (!activeSession) return;
      const r = await pinMutations.createPin({
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy,
        pinType: input.pinType,
        memo: input.memo === "" ? null : input.memo,
        sessionId: activeSession.id,
      });
      if (!r.ok || !r.data) return;
      // pin 作成成功。pending な「現在地を使う」callback を無効化し marker を再取得。
      invalidateCurrentLocationRequest();
      bumpRefetch();
      const newPinId = r.data.id;
      createdPinIdRef.current = newPinId;
      if (!file) {
        setCreateCandidate(null);
        setPinAddMode(false);
        finalizePinCreate(newPinId);
        return;
      }
      // 二段階目: 作成済み pin に写真を添付。失敗時は pin を残したまま再試行 UI へ。
      pendingPhotoFileRef.current = file;
      const up = await photoMutations.uploadPhoto(newPinId, file);
      if (up.ok) {
        finalizePinCreate(newPinId);
      } else {
        setPhotoUploadFailed(true);
      }
    },
    [
      activeSession,
      pinMutations,
      photoMutations,
      bumpRefetch,
      invalidateCurrentLocationRequest,
      finalizePinCreate,
    ],
  );

  const handleRetryPhoto = useCallback(async () => {
    const pinId = createdPinIdRef.current;
    const file = pendingPhotoFileRef.current;
    if (!pinId || !file) return;
    const up = await photoMutations.uploadPhoto(pinId, file);
    if (up.ok) {
      finalizePinCreate(pinId);
    }
  }, [photoMutations, finalizePinCreate]);

  const handleFinishWithoutPhoto = useCallback(() => {
    const pinId = createdPinIdRef.current;
    if (!pinId) return;
    finalizePinCreate(pinId);
  }, [finalizePinCreate]);

  const handleMapClick = useCallback(
    (latLng: { lat: number; lng: number }) => {
      // mode OFF / active session 無し / 既に modal 表示中はスルー (誤操作防止)
      if (!pinAddMode) return;
      if (!activeSession) return;
      if (createCandidate) return;
      setCreateCandidate({ lat: latLng.lat, lng: latLng.lng });
      setCurrentLocationError(null);
    },
    [pinAddMode, activeSession, createCandidate],
  );

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
          <MapDataLayer
            layers={layers}
            onError={setError}
            refetchNonce={refetchNonce}
            pinAddMode={pinAddMode}
            onMapClick={handleMapClick}
            onOpenPinDetail={setDetailPinId}
          />
          <MapInstanceCapture onMap={setMapInstance} />
          {activeSession && <RoutePolyline points={polylinePoints} />}
          {showCurrentLocationMarker && recorder.latestPositionForDisplay && (
            <CurrentLocationMarker
              lat={recorder.latestPositionForDisplay.lat}
              lng={recorder.latestPositionForDisplay.lng}
            />
          )}
        </Map>

        <ControlPanel
          layers={layers}
          onToggle={(key) =>
            setLayers((prev) => ({ ...prev, [key]: !prev[key] }))
          }
          currentUserId={currentUserId}
          onActiveSessionChange={handleActiveSessionChange}
          onBeforeSessionEnd={handleBeforeSessionEnd}
          recorder={recorder}
          hasActiveSession={!!activeSession}
          pinAddMode={pinAddMode}
          onTogglePinAddMode={() => setPinAddMode((v) => !v)}
          canWritePin={canWritePin}
          onPanToCurrent={handlePanToCurrent}
        />

        {createCandidate && activeSession && (
          <PinCreateModal
            initialLat={createCandidate.lat}
            initialLng={createCandidate.lng}
            sessionId={activeSession.id}
            saving={pinMutations.createLoading}
            serverError={pinMutations.createError}
            photoUploading={photoMutations.uploadLoading}
            photoUploadFailed={photoUploadFailed}
            onCancel={() => {
              // Codex P2: pending geolocation callback を無効化してから modal を閉じる
              invalidateCurrentLocationRequest();
              setCreateCandidate(null);
              setCurrentLocationError(null);
              setPhotoUploadFailed(false);
              createdPinIdRef.current = null;
              pendingPhotoFileRef.current = null;
            }}
            onSubmit={(payload, file) => {
              void handlePinCreateSubmit(
                {
                  ...payload,
                  accuracy:
                    payload.accuracy ?? createCandidate.accuracy ?? undefined,
                },
                file,
              );
            }}
            onRetryPhoto={() => {
              void handleRetryPhoto();
            }}
            onFinishWithoutPhoto={handleFinishWithoutPhoto}
            onUseCurrentLocation={useCurrentLocationForCreate}
            currentLocationLoading={currentLocationLoading}
            currentLocationError={currentLocationError}
          />
        )}

        {detailPinId && (
          <PinDetailPanel
            pinId={detailPinId}
            currentUserId={currentUserId}
            onClose={() => setDetailPinId(null)}
            onUpdated={() => bumpRefetch()}
          />
        )}

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
  currentUserId,
  onActiveSessionChange,
  onBeforeSessionEnd,
  recorder,
  hasActiveSession,
  pinAddMode,
  onTogglePinAddMode,
  canWritePin,
  onPanToCurrent,
}: {
  layers: Record<Layer, boolean>;
  onToggle: (key: Layer) => void;
  currentUserId: string;
  onActiveSessionChange: (s: ActiveSessionLike | null) => void;
  onBeforeSessionEnd: () => Promise<boolean>;
  recorder: ReturnType<typeof useFieldSurveyLocationRecorder>;
  hasActiveSession: boolean;
  pinAddMode: boolean;
  onTogglePinAddMode: () => void;
  canWritePin: boolean | null;
  onPanToCurrent: () => void;
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

      {/* Phase 1-F-1: 巡回開始/終了 + active session 復元。
          Phase 1-F-2: 終了前に位置記録 (watchPosition / flush timer / buffer)
          を確実に停止するため onBeforeSessionEnd を渡す。 */}
      <TripControls
        currentUserId={currentUserId}
        onActiveSessionChange={onActiveSessionChange}
        onBeforeSessionEnd={onBeforeSessionEnd}
      />

      {/* Phase 1-F-2: 位置記録 UI。active session がある時のみ表示。
          active 復元時に自動 start しない (ユーザー操作で start)。 */}
      {hasActiveSession && (
        <LocationRecorderControls
          status={recorder.status}
          savedCount={recorder.savedPoints.length}
          bufferedCount={recorder.bufferedCount}
          lastFlushAt={recorder.lastFlushAt}
          isFlushing={recorder.isFlushing}
          isLowAccuracyNow={recorder.isLowAccuracyNow}
          error={recorder.error}
          onStart={recorder.start}
          onStop={() => {
            void recorder.stop();
          }}
        />
      )}

      {/* Phase 1-F-3: 現在地ステータス + 現在地へ移動。active session 中のみ表示。
          地図クリック (pin 追加モード) と干渉しないよう、marker は clickable:false。 */}
      {hasActiveSession && (
        <CurrentLocationStatus
          latestPositionForDisplay={recorder.latestPositionForDisplay}
          isWaitingForFirstLocation={recorder.isWaitingForFirstLocation}
          lastLocationErrorForDisplay={recorder.lastLocationErrorForDisplay}
          recording={recorder.status === "recording"}
          onPanToCurrent={onPanToCurrent}
        />
      )}

      {/* Phase 1-G: active session 中のみ ピン追加 toggle を出す。
          field_survey:write 不所持と既知なら disable、判定不能なら API 403 を
          汎用エラーで処理する。 */}
      {hasActiveSession && (
        <PinAddModeToggle
          active={pinAddMode}
          onToggle={onTogglePinAddMode}
          canWrite={canWritePin}
        />
      )}
    </div>
  );
}

// Phase 1-F-3: <Map> の外にある ControlPanel から「現在地へ移動」用に map.panTo を
// 呼ぶため、Map 内部で useMap() した instance を state へ伝搬する。直接 google.maps
// にアクセスせず、vis.gl の hook 経由で取得 / cleanup する。
function MapInstanceCapture({
  onMap,
}: {
  onMap: (m: unknown | null) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onMap(map ?? null);
    return () => {
      onMap(null);
    };
  }, [map, onMap]);
  return null;
}

function MapDataLayer({
  layers,
  onError,
  refetchNonce,
  pinAddMode,
  onMapClick,
  onOpenPinDetail,
}: {
  layers: Record<Layer, boolean>;
  onError: (msg: string | null) => void;
  refetchNonce: number;
  pinAddMode: boolean;
  onMapClick: (latLng: { lat: number; lng: number }) => void;
  onOpenPinDetail: (pinId: string) => void;
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
          // view=map は memo 本文を Network レスポンスに載せない map-safe
          // projection (Codex Phase 1-E pin memo projection fix)。
          const pinQs = new URLSearchParams({
            view: "map",
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
            // view=map projection で API 側が memo を返さず hasMemo: boolean
            // のみを返すため、クライアント側 strip は不要。防御として
            // 万一 memo key が残っていた場合に備えた追加 strip は行わない
            // (生 memo を一度でも client メモリに乗せないため)。
            const j = (await r.json()) as { data?: PinRow[] };
            setPins(filterValidPinGps(j.data ?? []));
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

  // layer toggle / pin 作成 / 編集成功時に現在 bbox で再 fetch する。
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
  }, [layers.properties, layers.pins, refetchNonce]);

  // Phase 1-G: pin 追加モード中のみ map click を pin 作成候補に転送する。
  // mode OFF のときは marker click (AdvancedMarker onClick) のみが動く。
  // raw click 座標は console に出さない。
  useEffect(() => {
    if (!map) return;
    if (!pinAddMode) return;
    const listener = map.addListener(
      "click",
      (e: { latLng?: { lat: () => number; lng: () => number } }) => {
        const ll = e?.latLng;
        if (!ll) return;
        const lat = ll.lat();
        const lng = ll.lng();
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        onMapClick({ lat, lng });
      },
    );
    return () => listener.remove();
  }, [map, pinAddMode, onMapClick]);

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
          <PinInfo
            row={selected.row}
            onOpenDetail={() => {
              const id = selected.row.id;
              setSelected(null);
              onOpenPinDetail(id);
            }}
          />
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

function PinInfo({ row, onOpenDetail }: { row: PinRow; onOpenDetail: () => void }) {
  return (
    <div className="min-w-[200px] max-w-[280px] text-xs">
      <div className="mb-1 font-semibold text-gray-800">調査ピン</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>種類</dt>
        <dd>{formatPinType(row.pinType)}</dd>
        <dt>状態</dt>
        <dd>{formatPinStatus(row.status)}</dd>
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
        <dd>{row.hasMemo ? "あり (詳細パネルで確認)" : "—"}</dd>
      </dl>
      <button
        type="button"
        onClick={onOpenDetail}
        data-testid="pin-info-open-detail"
        className="mt-2 text-blue-600 hover:underline"
      >
        詳細を見る →
      </button>
    </div>
  );
}

function handleHttpError(status: number, onError: (m: string) => void) {
  if (status === 401) onError("ログインが必要です。再ログインしてください。");
  else if (status === 403) onError("閲覧権限がありません。");
  else if (status === 422) onError("リクエストが不正です。");
  else onError("地図データの取得に失敗しました。");
}

// API 側で number 正規化済 (Codex P1) だが、防御として coerceLat/Lng/Accuracy を
// 再適用する。numeric string が万一残っていても marker 表示でき、NaN /
// Infinity / 範囲外 / null は確実に除外する。座標を console には出さない。
function filterValidGps(rows: PropertyRow[]): PropertyRow[] {
  const out: PropertyRow[] = [];
  for (const r of rows) {
    const lat = coerceLat(r.gpsLat);
    const lng = coerceLng(r.gpsLng);
    if (lat === null || lng === null) continue;
    out.push({ ...r, gpsLat: lat, gpsLng: lng });
  }
  return out;
}

function filterValidPinGps(rows: PinRow[]): PinRow[] {
  const out: PinRow[] = [];
  for (const r of rows) {
    const lat = coerceLat(r.lat);
    const lng = coerceLng(r.lng);
    if (lat === null || lng === null) continue;
    // accuracy は UI で marker 表示に使わない (API 側で正規化済)。型に含めず
    // 素通しする。PinRow には載せないが Object.assign で残しても弊害なし。
    out.push({ ...r, lat, lng });
  }
  return out;
}

// memo 本文の client side strip は廃止。view=map projection で API 側が
// memo 本文を一切返さないため、Map UI が memo 文字列を扱う経路がない。

// saved + memory 未送信 (pending) を sequence 順に結合する。
// flush 直後の race で sequence 重複があった場合は saved を優先して dedup する。
// console / error には何も流さない (戻り値のみ polyline path に渡る)。
function mergePolylinePoints(
  saved: { sequence: number; lat: number; lng: number }[],
  pending: { sequence: number; lat: number; lng: number }[],
): RoutePolylinePoint[] {
  if (pending.length === 0) {
    return saved.map((p) => ({ lat: p.lat, lng: p.lng }));
  }
  const seen = new Set<number>();
  const merged: { sequence: number; lat: number; lng: number }[] = [];
  for (const p of saved) {
    if (!seen.has(p.sequence)) {
      merged.push(p);
      seen.add(p.sequence);
    }
  }
  for (const p of pending) {
    if (!seen.has(p.sequence)) {
      merged.push(p);
      seen.add(p.sequence);
    }
  }
  merged.sort((a, b) => a.sequence - b.sequence);
  return merged.map((p) => ({ lat: p.lat, lng: p.lng }));
}
