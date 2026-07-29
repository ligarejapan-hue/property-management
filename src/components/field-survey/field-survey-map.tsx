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
  Pin,
  useMap,
} from "@vis.gl/react-google-maps";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMapGestureHandling } from "@/components/field-survey/use-map-gesture-handling";
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
import CoverageHeatLayer from "@/components/field-survey/coverage-heat-layer";
import CoverageTracksLayer from "@/components/field-survey/coverage-tracks-layer";
import CoverageLegend from "@/components/field-survey/coverage-legend";
import {
  COVERAGE_DEFAULT_DAYS,
  COVERAGE_PERIOD_DAYS,
  coveragePeriodLabel,
  type CoverageCell,
  canTrustCoverageLegend,
  type CoverageCellSize,
  type CoverageStatus,
} from "@/lib/field-survey-coverage";
import { useFieldSurveyLocationRecorder } from "@/components/field-survey/use-field-survey-location-recorder";
import type { ActiveSessionLike } from "@/lib/field-survey-trip-util";
import PinAddModeToggle from "@/components/field-survey/pin-add-mode-toggle";
import PinCreateModal from "@/components/field-survey/pin-create-modal";
import CameraFirstButton from "@/components/field-survey/camera-first-button";
import CameraFirstBanner from "@/components/field-survey/camera-first-banner";
import {
  cameraFirstButtonState,
  cameraFirstCandidateFromPosition,
  cameraFirstFallbackMessage,
  isCameraPrefetchFresh,
  type CameraFirstPhase,
} from "@/lib/field-survey-camera-first";
import PinDetailPanel from "@/components/field-survey/pin-detail-panel";
import { useFieldSurveyPinMutations } from "@/components/field-survey/use-field-survey-pin-mutations";
import {
  clearPhotoMutationFailure,
  useFieldSurveyPinPhotoMutations,
} from "@/components/field-survey/use-field-survey-pin-photo-mutations";
import {
  formatPinStatus,
  formatPinType,
  isFieldSurveyPinType,
  type FieldSurveyPinType,
} from "@/lib/field-survey-pin-util";
import {
  PROPERTY_TYPE_LABELS,
  REGISTRY_STATUS_LABELS,
  DM_STATUS_LABELS,
  CASE_STATUS_LABELS,
} from "@/lib/property-types";
import CurrentLocationMarker from "@/components/field-survey/current-location-marker";
import PinMarkerLegend from "@/components/field-survey/pin-marker-legend";
import { pinMarkerStyle } from "@/lib/field-survey-pin-marker";
import CurrentLocationStatus from "@/components/field-survey/current-location-status";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";

// 東京駅付近を初期表示の中心にする (海外案件用ではない国内利用前提)。
const DEFAULT_CENTER = { lat: 35.6812, lng: 139.7671 };
const DEFAULT_ZOOM = 14;
// 巡回開始時に寄せる倍率。既定 (14) は市区町村が入る広さで、街を歩きながら
// 使うには広すぎる。17 なら建物の並びが判別できる。
const TRIP_START_ZOOM = 17;
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
  // 完成待ち一覧などからの「この場所を地図で見る」導線 (?focusPin=<uuid>)。
  // 指定ピンへ地図を寄せて詳細を開く。座標は URL でなく pin 詳細 API から取得。
  focusPinId?: string | null;
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

type Layer = "properties" | "pins" | "coverage" | "tracks";

/**
 * 撮影と並行して走らせる現在地取得の結果。
 * 座標は保持するが console / ログには出さない (PII 扱い)。
 */
type CameraPrefetchResult =
  | { ok: true; pos: GeolocationPosition }
  | { ok: false; code: number | null };

export default function FieldSurveyMap({
  apiKey,
  mapId,
  currentUserId,
  focusPinId = null,
}: FieldSurveyMapProps) {
  // タッチ端末では地図ジェスチャを cooperative(1本指=ページスクロール / 2本指=地図移動)に
  // して、地図が画面を占有し周囲の UI に触れなくなる問題を避ける。PC は greedy 継続。共有フック。
  const mapGestureHandling = useMapGestureHandling();
  // 踏破ヒートは**既定 ON**。この地図を開く主目的が「次にどこを回るか決める」
  // なので毎回トグルさせない。
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    properties: true,
    pins: true,
    coverage: true,
    // 面の色だけでは実際に歩いた筋が出ない（マスが道より広い・点の間を
    // つながない）。以前の画面は線だったので、線も既定 ON にする。
    tracks: true,
  });
  // 踏破ヒートの期間 (365=直近1年 / 0=全期間)。ユーザー決定でこの2択のみ。
  const [coverageDays, setCoverageDays] = useState<number>(COVERAGE_DEFAULT_DAYS);
  // 踏破ヒートの状態 (1マスの実寸ラベル / 打ち切り有無)。凡例と注意書きに使う。
  // 線（過去に歩いた道筋）の状態。面とは別に切り替えられるので状態も別に持つ。
  const [tracksState, setTracksState] = useState<{
    status: CoverageStatus;
    /** 量が多くて描けなかった巡回の本数。0 より大きければ必ず断りを出す。 */
    droppedTrips: number;
    /** false なら「droppedTrips 件以上」の意味 (@codex #334 P2)。 */
    droppedTripsExact: boolean;
  }>({ status: "off", droppedTrips: 0, droppedTripsExact: true });
  const handleTracksState = useCallback(
    (v: {
      status: CoverageStatus;
      droppedTrips: number;
      droppedTripsExact: boolean;
    }) => setTracksState(v),
    [],
  );

  const [coverageState, setCoverageState] = useState<{
    cellSize: CoverageCellSize | null;
    status: CoverageStatus;
  }>({ cellSize: null, status: "loading" });
  const handleCoverageState = useCallback(
    (next: { cellSize: CoverageCellSize | null; status: CoverageStatus }) => {
      setCoverageState((prev) =>
        prev.cellSize === next.cellSize && prev.status === next.status
          ? prev
          : next,
      );
    },
    [],
  );
  // 「対応済み (closed)」ピンを地図から一時的に隠す表示フィルタ。
  // 未対応だけを見たい巡回中の視認性向上が目的で、データは消さない (表示のみ)。
  // ブラウザ保存はしない方針のためページ滞在中のみ有効。
  const [hideClosedPins, setHideClosedPins] = useState(false);
  // 直前に保存したピンの種類。連続ピンで同じ種類を続けて立てることが多いため、
  // 次の作成モーダルの初期値に引き継いで選び直しのタップを省く。
  // 巡回の終了/切替で既定 (candidate) に戻す (handleActiveSessionChange)。
  const [lastPinType, setLastPinType] = useState<FieldSurveyPinType>("candidate");
  const [error, setError] = useState<string | null>(null);
  // Phase 1-F-2: TripControls から active session (own のみ) の通知を受け、
  // location recorder hook を駆動する。session が無い間 hook は何もしない。
  const [activeSession, setActiveSession] = useState<ActiveSessionLike | null>(
    null,
  );
  // handleActiveSessionChange はカメラファースト reset と束ねるため
  // resetCameraFirst 定義後 (下方) で宣言する (JSX からのみ参照)。
  //
  // #317: recorder の開始フェンスが「巡回は既に終了」を検知した時、TripControls
  // が登録した再取得ハンドラを呼んで巡回中表示を真の状態へ整合させる
  // (registerStartRequest と同型の event 駆動登録)。
  const sessionRefreshRef = useRef<(() => void) | null>(null);
  const registerSessionRefresh = useCallback((fn: (() => void) | null) => {
    sessionRefreshRef.current = fn;
  }, []);
  const handleRecorderSessionEnded = useCallback(() => {
    sessionRefreshRef.current?.();
  }, []);
  const recorder = useFieldSurveyLocationRecorder({
    sessionId: activeSession?.id ?? null,
    onSessionEnded: handleRecorderSessionEnded,
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

  // Phase 1-G / 1-I: pin 追加モード / 詳細パネル用の write/manage 権限。
  //
  // F12 展開(19-A): permissions は ScreenProtectionProvider（dashboard 全体を覆う）が
  // mount 時に 1 回取得して context 配布するため、本コンポーネント独自の
  // /api/me/permissions fetch は撤去し、provider 配布値から導出する
  // （properties 一覧 F12-2 と同方針・同一エンドポイントの重複 fetch 撤去）。
  //
  // tristate を維持する: canWritePin / canManagePin は boolean | null。
  //   null  = 判定不能（取得中 / 取得失敗 / 進入時 refresh 中 / 未取得）→ UI は押下可とし
  //           API 403 で委譲（PinAddModeToggle は disable しない）。
  //   true  = field_survey:write|manage を granted===true で保有。
  //   false = 取得済みだが未付与 → PinAddModeToggle を disable。
  // 取得中/取得失敗を [] や false へ collapse すると「権限がありません」を誤表示するため、
  // 従来の「fetch 未完了/失敗時は null 据え置き」を permissionsLoading/Error/null で再現する。
  // Codex P2: 明示 deny（granted:false）/ 欠損 entry は granted===true 判定で安全側 false。
  // response 全文は console に出さない（provider も同様）。
  const {
    permissions: mePermissions,
    permissionsLoading,
    permissionsError,
    refetchPermissions,
  } = useScreenProtection();

  // 進入時 refresh（properties 一覧と同方針）: App Router の layout は client
  // navigation で保持されるため、provider の mount 時 1 回 fetch だけでは dashboard
  // 滞在中の権限付与・剥奪に追従できない。進入（mount）あたり最大 1 回だけ
  // refetchPermissions() を呼び、旧 page-local fetch が持っていた鮮度を復元する。
  // - 取得進行中（permissionsLoading）は呼ばない＝初回 fetch と重複させない。
  // - mount 時進行中だった取得が成功した場合はそのデータが最新なので追加 fetch しない。
  // - mount 時取得完了済み（stale 可能性）/ 進行中だった取得の失敗（復旧）は 1 回再取得。
  // - ref ガード＋provider 側 in-flight dedupe の二重防御で多重 fetch・無限リトライなし。
  const permissionsRefreshRequestedRef = useRef(false);
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  // 進入時 refresh 完了まで stale な granted permissions で判定しない。mount 時点で
  // 取得完了済み（= この後 refresh が走る）なら最初の描画から pending=true で開始する。
  const [permissionsRefreshPending, setPermissionsRefreshPending] = useState(
    () => !permissionsLoading,
  );
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    if (permissionsLoading) return;
    if (permissionsLoadingAtMountRef.current === true && mePermissions !== null) {
      // mount 時に進行中だった取得が成功 → 見ているデータは最新。追加 fetch しない。
      permissionsRefreshRequestedRef.current = true;
      return;
    }
    permissionsRefreshRequestedRef.current = true;
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, mePermissions, refetchPermissions]);

  // tristate 導出（純関数・context 値の派生・state 持ち越しなし）。進入時 refresh 中
  // （pending）・provider 取得中（loading）・取得失敗（error）・未取得（null）は判定不能
  // null（= API 403 委譲）に倒す。ここで [] や false に倒すと PinAddModeToggle が
  // 「権限がありません」を誤表示するため、tristate の null を維持して stale 権限表示を防ぐ。
  const {
    canWritePin,
    canManagePin,
    canWriteProperty,
    canSeeOtherPins,
    canQuickCapture,
  } = useMemo<{
    canWritePin: boolean | null;
    canManagePin: boolean | null;
    canWriteProperty: boolean | null;
    canSeeOtherPins: boolean;
    canQuickCapture: boolean | null;
  }>(() => {
    if (
      permissionsRefreshPending ||
      permissionsLoading ||
      permissionsError ||
      mePermissions === null
    ) {
      return {
        canWritePin: null,
        canManagePin: null,
        canWriteProperty: null,
        canSeeOtherPins: false,
        canQuickCapture: null,
      };
    }
    // granted===true のみ許可（明示 deny / 欠損 entry は false）。
    const canWrite = mePermissions.some(
      (p) =>
        p.resource === "field_survey" &&
        p.action === "write" &&
        p.granted === true,
    );
    // Phase 1-I: 他人 pin 削除可否は manage の granted===true のみで判定（read_all 不可）。
    const canManage = mePermissions.some(
      (p) =>
        p.resource === "field_survey" &&
        p.action === "manage" &&
        p.granted === true,
    );
    // 候補ピンの「物件にする」ボタン用: property:write の granted===true のみ。
    const canWriteProp = mePermissions.some(
      (p) =>
        p.resource === "property" &&
        p.action === "write" &&
        p.granted === true,
    );
    // 凡例の「白いふちどり = 他の担当者」行の表示用: read_all/manage が無い
    // スタッフには API が own のみを返し他人ピンは一度も出ないため、存在しない
    // 見分け方を案内しない (判定不能時も非表示 = 表示専用ヒントなので安全側)。
    const canSeeOthers = mePermissions.some(
      (p) =>
        p.resource === "field_survey" &&
        (p.action === "read_all" || p.action === "manage") &&
        p.granted === true,
    );
    // 巡回を開始せずに撮って登録できるか (server 側の POST /pins も同権限で判定)。
    const canQuick = mePermissions.some(
      (p) =>
        p.resource === "field_survey" &&
        p.action === "quick_capture" &&
        p.granted === true,
    );
    return {
      canWritePin: canWrite,
      canManagePin: canManage,
      canWriteProperty: canWriteProp,
      canSeeOtherPins: canSeeOthers,
      canQuickCapture: canQuick,
    };
  }, [permissionsRefreshPending, permissionsLoading, permissionsError, mePermissions]);

  const [pinAddMode, setPinAddMode] = useState(false);
  // 地図 click / 「現在地を使う」/ カメラファーストで確定した作成候補座標。
  // cameraPhoto はカメラファースト経由の撮影済み写真 (modal を選択済みで開く)。
  // cameraPhotoPreviewUrl は同写真の preview 用 objectURL (イベントハンドラ内で
  // 生成し、revoke は modal 側の既存 cleanup が担う)。
  const [createCandidate, setCreateCandidate] = useState<
    | {
        lat: number;
        lng: number;
        accuracy?: number;
        cameraPhoto?: File;
        cameraPhotoPreviewUrl?: string;
      }
    | null
  >(null);
  const [detailPinId, setDetailPinId] = useState<string | null>(null);
  // 「この場所を地図で見る」(?focusPin): 指定ピンの場所へ地図を寄せ、そのピンを
  // 強調マーカーで必ず表示する。map instance が揃った後に一度だけ、pin 詳細 API
  // から座標を取得して panTo + 強調マーカーを立てる。
  // - MapDataLayer は bbox を PIN_LIMIT (新しい順) で取得するため、古い候補は
  //   marker 一覧から漏れ得る (この完成待ちキューが処理する対象がまさに古い候補)。
  //   panTo だけだと marker の無い中心に着地するので、取得済み座標で専用の強調
  //   マーカーを立てて「指定した場所」を必ず示す (@codex P2)。
  // - 詳細パネルは自動で開かない: 座標取得のこの 1 回だけを field_survey_pin_view
  //   監査に載せる (パネルも同 API を fetch するため、開くと他人 pin で監査が
  //   二重計上される。@codex 指摘)。ピンの中身を見たい場合は marker タップで開く。
  // - 座標は URL でなく API から取得し、console / ログには出さない。
  // - 取得失敗・権限外は静かにスキップし、once-guard を解除して再訪で再試行できる。
  const [focusPinPos, setFocusPinPos] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const focusedPinRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusPinId || !mapInstance) return;
    if (focusedPinRef.current === focusPinId) return;
    // App Router のソフト遷移で ?focusPin が A→B に変わると (remount せず) 本 effect
    // が再実行され、2 つの取得が重なり得る (@codex P2)。focusedPinRef が最新要求 id
    // を保持するので、await 明けに現 focusPinId と一致しない完了は stale として捨てる。
    focusedPinRef.current = focusPinId;
    void (async () => {
      // id 変更時は前回 (A) の強調位置を消す (B が失敗しても A の marker が残らない)。
      setFocusPinPos(null);
      try {
        // 座標のみ射影 (memo 本文を client メモリに乗せない・@codex P2)。
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(focusPinId)}/location`,
          { credentials: "same-origin" },
        );
        // stale: await 中に focusPinId が変わっていたら (新しい focus が所有) 破棄。
        if (focusedPinRef.current !== focusPinId) return;
        if (!res.ok) {
          focusedPinRef.current = null;
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          data?: { lat?: unknown; lng?: unknown };
        } | null;
        if (focusedPinRef.current !== focusPinId) return;
        const lat = Number(body?.data?.lat);
        const lng = Number(body?.data?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          focusedPinRef.current = null;
          return;
        }
        setFocusPinPos({ lat, lng });
        const m = mapInstance as {
          panTo?: (p: { lat: number; lng: number }) => void;
        };
        if (m?.panTo) m.panTo({ lat, lng });
      } catch {
        // 座標 / API 内部情報を出さない。現要求のままなら guard 解除で再試行可。
        if (focusedPinRef.current === focusPinId) focusedPinRef.current = null;
      }
    })();
  }, [focusPinId, mapInstance]);
  // カメラファースト (撮って登録): 撮影→現在地取得→ピン作成 modal の進行状態。
  const [cameraFirstPhase, setCameraFirstPhase] =
    useState<CameraFirstPhase>("idle");
  // 現在地が取れず地図タップ待ちへフォールバックした理由の案内文。
  const [cameraFirstNotice, setCameraFirstNotice] = useState<string | null>(
    null,
  );
  // 撮影済みで位置未確定の写真 (locating / awaiting-map-tap の間だけ保持)。
  const cameraPhotoFileRef = useRef<File | null>(null);
  // 今回の作成候補がカメラファースト由来か。finalize で詳細パネルを開かず
  // トースト表示にして、次の撮影へすぐ移れるようにする。
  const createdFromCameraRef = useRef(false);
  // 保存完了トースト (自動で消える)。カメラファーストおよび写真付き保存で
  // 詳細パネルの代わりに出す (連続作業を遮らないため)。
  // 作成した pin の id を保持し、「取り消す」(誤作成の即時 undo) と
  // 「写真を追加」(2枚目の最短経路 = 詳細パネルを開く) をトーストから提供する。
  const [savedToastPinId, setSavedToastPinId] = useState<string | null>(null);
  const cameraToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // modal 表示中かを closure から読むための ref (locating 完了時の競合ガード)。
  const createCandidateOpenRef = useRef(false);
  useEffect(() => {
    createCandidateOpenRef.current = !!createCandidate;
  }, [createCandidate]);
  // 最新のカメラ発行 token。共有 token (currentLocationRequestIdRef) が他経路
  // (モーダル操作 / 現在地を使う / session 再取得) で bump された遅延 callback が、
  // 自分がまだ最新のカメラ要求か判定して後始末するための照合用。
  // これが無いと phase が "locating" のまま固着し FAB が復帰不能になる。
  const cameraRequestIdRef = useRef(0);
  // モバイルの表示切替パネル開閉 (ControlPanel から持ち上げ)。展開中は
  // FAB / banner がパネル下部を覆ってタップを遮るため描画を止める。
  const [panelOpen, setPanelOpen] = useState(false);
  // 地図上の「巡回を開始」ボタン → TripControls の開始確認 modal を開く
  // ハンドラ (TripControls が effect で登録する)。パネルを開かずに開始できる
  // 導線 (毎朝の 6 タップ → 2 タップ)。
  const startTripRef = useRef<(() => void) | null>(null);
  const registerStartRequest = useCallback((fn: (() => void) | null) => {
    startTripRef.current = fn;
  }, []);
  // 「巡回を開始」ボタン経由の開始かどうか。開始成功時にパネルを自動で
  // 畳んで撮影 FAB へ直行できるようにする (パネル手動操作でリセット)。
  const quickStartRef = useRef(false);
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
    // 巡回なし撮影 (quick_capture) では作成 modal が巡回外でも開くため、
    // requestSessionId=null を正常系として通す (@codex R1)。位置情報が一時的に
    // 失敗した後や、その場で許可を出し直した後に再取得できないと詰むため。
    // 巡回外でも modal が開いていない状態での要求は従来どおり拒否する
    // (パネルからの「現在地を使う」は巡回中のみ描画される)。
    const requestSessionId = activeSessionIdRef.current;
    if (!requestSessionId && !createCandidateOpenRef.current) {
      setCurrentLocationError(
        "巡回を開始してから現在地を取得してください。",
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
        // 巡回中に始めた取得は session 切替で無効化する (従来どおり)。巡回外
        // (requestSessionId=null) の取得は途中で巡回が始まっても捨てない。
        if (
          requestSessionId !== null &&
          activeSessionIdRef.current !== requestSessionId
        )
          return;
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
        // 巡回中に始めた取得は session 切替で無効化する (従来どおり)。巡回外
        // (requestSessionId=null) の取得は途中で巡回が始まっても捨てない。
        if (
          requestSessionId !== null &&
          activeSessionIdRef.current !== requestSessionId
        )
          return;
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

  // 撮影と並行して走らせる現在地取得の結果入れ。撮影ボタンを押した瞬間に開始し、
  // 写真が返ってきた時点で解決済みなら待たずに保存画面を開く。
  // この ref 自体は state を触らない (= カメラを閉じただけの場合は何も起きない)。
  const cameraLocationPrefetchRef = useRef<{
    requestId: number;
    promise: Promise<CameraPrefetchResult>;
    settled: boolean;
    result?: CameraPrefetchResult;
  } | null>(null);

  /**
   * 撮影ボタンを押した瞬間に現在地の取得を開始する (カメラ起動と並行)。
   *
   * 従来は「撮影完了 → 取得開始」の直列で、GPS が確定するまで保存画面が開かず
   * 「現在地を取得中…」で待たせていた。撮影中に取得を進めておけば、写真が
   * 返った時点で解決済みのことが多く、待ち時間なしで保存画面へ進める。
   *
   * - state は触らない。カメラを閉じただけ (写真なし) の場合は何も起きず、
   *   結果は次のリセット / 次回の撮影開始で捨てられる。
   * - 共有 token を bump するので、進行中だった別経路の取得は無効化される
   *   (「現在地を使う」と同じ規約)。
   */
  const startCameraLocationPrefetch = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      cameraLocationPrefetchRef.current = null;
      return;
    }
    currentLocationRequestIdRef.current += 1;
    const requestId = currentLocationRequestIdRef.current;
    cameraRequestIdRef.current = requestId;
    const entry: {
      requestId: number;
      promise: Promise<CameraPrefetchResult>;
      settled: boolean;
      result?: CameraPrefetchResult;
    } = {
      requestId,
      settled: false,
      promise: new Promise<CameraPrefetchResult>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ ok: true, pos }),
          (err) => {
            const code = (err as { code?: number })?.code;
            resolve({ ok: false, code: typeof code === "number" ? code : null });
          },
          { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
        );
      }),
    };
    // 解決済みかを同期的に判定できるようにしておく (待ちゼロなら
    // 「現在地を取得中…」を一瞬も出さずに保存画面へ進める)。
    void entry.promise.then((r) => {
      entry.settled = true;
      entry.result = r;
    });
    cameraLocationPrefetchRef.current = entry;
  }, []);

  // カメラファースト状態の一括リセット。撮影待ちの写真は破棄し、進行中の
  // 現在地取得 callback も token bump で無効化する。
  const resetCameraFirst = useCallback(() => {
    currentLocationRequestIdRef.current += 1;
    cameraLocationPrefetchRef.current = null;
    // 照合 ID も無効化する (Codex P2): reset 後に届いた旧カメラ callback の
    // 後始末分岐を発火させない。残したままだと後始末の resetCameraFirst が
    // 共有 token を再 bump し、モーダルの「現在地を使う」など reset 後に
    // 始まった新しい取得まで握り潰してしまう (取得中表示で固まる)。
    cameraRequestIdRef.current = 0;
    cameraPhotoFileRef.current = null;
    createdFromCameraRef.current = false;
    setCameraFirstPhase("idle");
    setCameraFirstNotice(null);
  }, []);

  // TripControls からの active session 通知。session の切替 (開始 / 終了 /
  // 別 session 化) ではカメラファーストの撮影待ち状態を持ち越さない
  // (effect でなくイベント駆動で reset し、cascading render を避ける)。
  const prevActiveSessionIdRef = useRef<string | null>(null);
  // 巡回開始時に一度だけ走らせる自動処理の予約。開始の瞬間には session id も
  // 現在地もまだ無いため、その場では実行できない (下の effect で消化する)。
  const autoStartRecordingRef = useRef(false);
  const autoCenterOnStartRef = useRef(false);
  const handleActiveSessionChange = useCallback(
    (s: ActiveSessionLike | null, opts?: { justStarted?: boolean }) => {
      const nextId = s?.id ?? null;
      const prevId = prevActiveSessionIdRef.current;
      if (prevId !== nextId) {
        prevActiveSessionIdRef.current = nextId;
        // 「巡回を開始」ボタン経由の開始成功時はパネルを畳み、撮影 FAB へ直行
        if (prevId === null && nextId !== null && quickStartRef.current) {
          quickStartRef.current = false;
          setPanelOpen(false);
        }
        // 巡回なし撮影の進行中 (現在地取得中 / 地図タップ待ち) に巡回が開始された
        // 場合は撮影を破棄しない (撮った写真を黙って失わない。@codex R1)。保存時に
        // activeSession?.id を見るので、そのまま新しい巡回へ紐づく。
        // それ以外の遷移 (巡回の終了 / 別巡回への切替) は従来どおり破棄する。
        if (prevId !== null || nextId === null) {
          resetCameraFirst();
        }
        // ⚠**巡回開始 = 位置記録開始 + 現在地へ寄せる** (2026-07-29 業務判断)。
        // 本番の巡回 11 件中 9 件が軌跡ゼロだった原因は、記録の開始が別操作
        // でパネルの奥にあり資料にも載っていなかったこと。ここで予約し、
        // session id が届いてから実行する (下の effect)。
        //
        // ⚠**復元 (justStarted=false) では自動開始しない**。再読込や画面復帰の
        // たびに始めると、休憩中に自分で「位置記録停止」を押した人の意思を
        // 覆して休憩場所を記録してしまう。
        if (prevId === null && nextId !== null && opts?.justStarted) {
          autoStartRecordingRef.current = true;
          autoCenterOnStartRef.current = true;
        }
        // 終了したら予約を取り消す。位置が最後まで取れないまま終わった場合に
        // 予約が残ると、次に地図が用意できた時点で意図せず寄ってしまう。
        if (nextId === null) {
          autoStartRecordingRef.current = false;
          autoCenterOnStartRef.current = false;
        }
        // ピン追加モードも巡回の終了/切替で解除する。連続ピンモードで保存後も
        // ON が続くため、ここで畳まないと巡回終了後に「・ピン追加中」表示が
        // 残るのに OFF 導線 (パネル内トグル=巡回中のみ描画) が消えて復帰
        // 不能になり、次の巡回開始時も暗黙 ON で復活してしまう。
        setPinAddMode(false);
        // 種類の引き継ぎも巡回単位でリセットする (別の巡回に前回の種類を
        // 持ち越さない。既定 = candidate)。
        setLastPinType("candidate");
        // ⚠**巡回が終わったら踏破ヒートを取り直す** (@codex #332)。
        // 集計は「終了した巡回」だけを数えるので、終了した瞬間に
        //   ・進行中の軌跡の線は消える (activeSession が null になるため)
        //   ・終わったばかりの巡回はまだ色に入っていない
        // となり、**いま歩いたばかりの場所が「誰も通っていない」表示になる**。
        // 地図を動かすまで直らないので、終了の遷移で明示的に取り直す。
        if (prevId !== null && nextId === null) {
          bumpRefetch();
        }
      }
      setActiveSession(s);
    },
    [resetCameraFirst, bumpRefetch],
  );

  // 巡回が始まったら位置記録も始める。
  // ⚠**同じイベントの中で recorder.start() を呼んではいけない**。recorder は
  // sessionId を effect で ref に同期するため、handleActiveSessionChange の
  // 時点では sessionId がまだ null で、start() が「巡回中でない」と判断して
  // 何もせずに戻る。session id が state に載った後のこの effect で始める。
  useEffect(() => {
    if (!autoStartRecordingRef.current) return;
    if (!activeSession?.id) return;
    autoStartRecordingRef.current = false;
    recorder.start();
    // recorder は毎レンダー新しい object になるが、上の ref ガードにより
    // 予約が立っている時しか走らないので再実行は無害。
  }, [activeSession?.id, recorder]);

  // 開始したら現在地へ寄せ、街歩き用の倍率まで上げる。
  // ⚠位置が取れるまでは**予約を落とさずに戻る**。屋内・電波が弱い場所では
  // 数十秒かかることがあり、ここで諦めると寄らないまま巡回が始まる。
  // 位置が最後まで取れなくても巡回自体は続く (許可拒否・HTTP・圏外)。
  useEffect(() => {
    if (!autoCenterOnStartRef.current) return;
    const pos = recorder.latestPositionForDisplay;
    if (!pos) return;
    const m = mapInstance as {
      panTo?: (p: { lat: number; lng: number }) => void;
      setZoom?: (z: number) => void;
    } | null;
    // 地図がまだ用意できていない間も予約を残す (用意でき次第この effect が
    // 再実行される)。ここで落とすと「位置は取れたが地図が間に合わなかった」
    // 時に永久に寄らない。
    if (!m || typeof m.panTo !== "function") return;
    autoCenterOnStartRef.current = false;
    m.panTo({ lat: pos.lat, lng: pos.lng });
    if (typeof m.setZoom === "function") m.setZoom(TRIP_START_ZOOM);
    // activeSession?.id も依存に入れる。2回目の巡回で現在地の値がたまたま
    // 前回と同一参照のままだと、予約を立てても再実行されず寄らない。
  }, [activeSession?.id, mapInstance, recorder.latestPositionForDisplay]);

  // 保存完了トーストの timer を unmount で必ず止める。
  useEffect(() => {
    return () => {
      if (cameraToastTimerRef.current) clearTimeout(cameraToastTimerRef.current);
    };
  }, []);

  // カメラファースト: 撮影ボタンを押した時点で開始した現在地取得 (prefetch) の
  // 結果を使って、作成 modal を写真選択済みで開く。
  // - 解決済みかつ十分に新しければ「現在地を取得中…」を出さずに開く (待ちゼロ)
  // - 古い場合は取り直す。カメラを開けたまま移動すると、撮影地点ではなく
  //   ボタンを押した地点の座標でピンが立ってしまう (@codex #329 R1)
  // - まだ取得中なら従来どおり locating 表示にして待つ
  // - 取れない環境 (http / 権限拒否 / タイムアウト) は「地図をタップして場所を
  //   指定」へフォールバックする (写真は保持=撮り直し不要)
  // token / mount / session ガードは「現在地を使う」と同型。
  const handleCameraPhotoCaptured = useCallback(
    (file: File) => {
      // 巡回なし撮影では requestSessionId = null が正常系。撮影ボタン自体が
      // 「巡回中 or quick_capture 権限」でしか描画されないため、ここで巡回を
      // 要求しない (要求すると巡回外の撮影が即破棄される)。
      const requestSessionId = activeSessionIdRef.current;
      if (createCandidateOpenRef.current) return;
      cameraPhotoFileRef.current = file;

      const fallbackToMapTap = (code: number | null, notice?: string) => {
        setCameraFirstPhase("awaiting-map-tap");
        setCameraFirstNotice(notice ?? cameraFirstFallbackMessage(code));
      };

      // 取得結果を state へ反映する。requestId は結果を持ってきた prefetch の
      // もの (取り直した場合は新しい requestId) を使う。
      const apply = (requestId: number, result: CameraPrefetchResult) => {
        if (!fsMapMountedRef.current) return;
        if (
          currentLocationRequestIdRef.current !== requestId ||
          // 巡回中に始めた撮影は session 切替で無効化する (従来どおり)。
          // 巡回外で始めた撮影 (requestSessionId=null) は、取得中に巡回が
          // 開始されても破棄しない。保存時に activeSession?.id を見るので
          // 新しい巡回へ自然に紐づく (写真を黙って失わない)。
          (requestSessionId !== null &&
            activeSessionIdRef.current !== requestSessionId)
        ) {
          // 共有 token の bump / session 切替で無効化された遅延結果。
          // 自分がまだ最新のカメラ要求なら (新しい撮影が始まっていなければ)
          // "locating" 固着と写真リークを防ぐため状態を後始末する。
          if (cameraRequestIdRef.current === requestId) {
            resetCameraFirst();
          }
          return;
        }
        if (createCandidateOpenRef.current) {
          // 取得中に別経路 (ピン追加モードの地図タップ) で modal が開いた。
          // カメラ側の写真は破棄して衝突させない。
          resetCameraFirst();
          return;
        }
        if (!result.ok) {
          fallbackToMapTap(result.code);
          return;
        }
        const cand = cameraFirstCandidateFromPosition(result.pos);
        if (!cand) {
          fallbackToMapTap(null);
          return;
        }
        const photo = cameraPhotoFileRef.current ?? undefined;
        cameraPhotoFileRef.current = null;
        createdFromCameraRef.current = true;
        setCameraFirstPhase("idle");
        setCameraFirstNotice(null);
        setCreateCandidate({
          ...cand,
          cameraPhoto: photo,
          cameraPhotoPreviewUrl: photo ? URL.createObjectURL(photo) : undefined,
        });
      };

      // prefetch の結果を消費する。settled / 未解決のどちらの経路でも
      // **同じ鮮度検証**を通す。
      // ⚠settled=false でも「カメラ起動前に取得済み」の場合がある
      // (ネイティブカメラがページを一時停止すると、解決済みでも .then が
      //  走らないまま change が先に届く。@codex #329 R2)。待機側で検証を
      // 省くとこの経路だけ古い座標が通ってしまう。
      // 取り直しは1回まで (無限ループ防止)。撮った写真は捨てない。
      const consume = (
        entry: {
          requestId: number;
          promise: Promise<CameraPrefetchResult>;
          settled: boolean;
          result?: CameraPrefetchResult;
        },
        attempt: number,
      ) => {
        // 取り直す (1回まで)。上限に達したら手動指定へ倒す。いずれの経路でも
        // 撮影済みの写真は保持したまま = 撮り直しを要求しない。
        const retryOrFallback = (code: number | null, notice?: string) => {
          if (attempt >= 1) {
            fallbackToMapTap(code, notice);
            return;
          }
          startCameraLocationPrefetch();
          const renewed = cameraLocationPrefetchRef.current;
          if (!renewed) {
            fallbackToMapTap(code, notice);
            return;
          }
          consume(renewed, attempt + 1);
        };
        const finish = (r: CameraPrefetchResult) => {
          if (currentLocationRequestIdRef.current !== entry.requestId) {
            // より新しい撮影が始まった / 別経路で作成 modal が開いた場合は
            // 従来どおり破棄する (apply のガードに委ねる)。
            if (
              createCandidateOpenRef.current ||
              cameraRequestIdRef.current !== entry.requestId
            ) {
              apply(entry.requestId, r);
              return;
            }
            // 自分がまだ最新の撮影なのに token だけ進んでいる = 巡回の復元
            // (null→active) などで共有 token が bump されたケース
            // (@codex #329 R3)。撮った写真を捨てず、取り直して続行する。
            retryOrFallback(null, "撮った場所の現在地を取得できませんでした。地図をタップして、撮った場所を指定してください。");
            return;
          }
          if (r.ok && !isCameraPrefetchFresh(r.pos)) {
            // カメラを開けたまま移動した = 撮影地点とずれる。取り直す。
            retryOrFallback(null, "撮った場所の現在地を取得できませんでした。地図をタップして、撮った場所を指定してください。");
            return;
          }
          if (!r.ok && r.code !== 1) {
            // 一時的な失敗 (timeout / 位置不明 / 不詳) は撮影後に取り直せば
            // 成功し得る。カメラ滞在が prefetch の制限時間を超えた場合に
            // 即あきらめないため (@codex #329 R3)。
            // 権限拒否 (code 1) は取り直しても無駄なので即フォールバック。
            retryOrFallback(r.code);
            return;
          }
          apply(entry.requestId, r);
        };
        if (entry.settled && entry.result) {
          // 待たせずにその場で判定 (新しければ locating を一瞬も出さない)。
          finish(entry.result);
          return;
        }
        setCameraFirstPhase("locating");
        setCameraFirstNotice(null);
        void entry.promise.then(finish);
      };
      const prefetch = cameraLocationPrefetchRef.current;
      if (!prefetch) {
        // geolocation 非対応、または撮影開始の通知が来ていない (想定外) 場合は
        // 場所指定へ回す。写真は保持したままなので撮り直しは不要。
        fallbackToMapTap(null);
        return;
      }
      consume(prefetch, 0);
    },
    [resetCameraFirst, startCameraLocationPrefetch],
  );

  const pinMutations = useFieldSurveyPinMutations();
  const photoMutations = useFieldSurveyPinPhotoMutations();

  // pin 作成 (+写真) が完結した時の共通後処理。modal を閉じる。
  // 連続ピンモード: 地図タップ経路でも pin 追加モードは維持する (保存のたびに
  // モードを入れ直す 2 タップを無くす。誤タップは modal のキャンセルで防げる)。
  // 写真付き保存 (カメラファースト含む) は詳細パネルを開かずトーストのみ出し、
  // 次のピンへの移動をパネル閉じ操作で遮らない。写真なし保存は従来どおり
  // 詳細パネルを開く (写真の追加先を提示するため)。
  const finalizePinCreate = useCallback(
    (pinId: string, hadPhoto: boolean) => {
      // ⚠この画面の写真送信は自前の再試行 UI で失敗を出しており、写真セクションの
      // 購読者が居ない。作成フローを完了する時点で利用者はその失敗を見て
      // 「再試行」か「写真なしで完了」を選んでいるので、保持している失敗は
      // 解決済みとして捨てる (@codex #331 R1)。捨てないと直後に開く詳細パネルが
      // 「離れている間に写真の処理が失敗しました」と蒸し返す。
      clearPhotoMutationFailure(pinId);
      invalidateCurrentLocationRequest();
      setCreateCandidate(null);
      setPhotoUploadFailed(false);
      createdPinIdRef.current = null;
      pendingPhotoFileRef.current = null;
      const fromCamera = createdFromCameraRef.current;
      createdFromCameraRef.current = false;
      if (fromCamera || hadPhoto) {
        setSavedToastPinId(pinId);
        if (cameraToastTimerRef.current) {
          clearTimeout(cameraToastTimerRef.current);
        }
        // ボタン (取り消す / 写真を追加) 付きのため従来の 4 秒から少し延長。
        cameraToastTimerRef.current = setTimeout(() => {
          if (fsMapMountedRef.current) setSavedToastPinId(null);
        }, 7000);
        return;
      }
      // Phase 1-H: 写真なしの作成後は detail panel を開く。
      setDetailPinId(pinId);
    },
    [invalidateCurrentLocationRequest],
  );

  // トーストの「取り消す」: 直前に作成した pin を論理削除 (アーカイブ) する。
  // 誤作成をマーカー探し + 4 タップの削除導線なしで即時に戻せるようにする。
  const handleUndoCreatedPin = useCallback(async () => {
    const pinId = savedToastPinId;
    if (!pinId) return;
    const r = await pinMutations.deletePin(pinId);
    if (!fsMapMountedRef.current) return;
    if (r.ok) {
      // 削除中に別ピンの保存でトーストが切替済みなら、そちらは消さない
      // (timer は共有 ref のため触らない。発火時の null 化は no-op で安全)。
      setSavedToastPinId((cur) => (cur === pinId ? null : cur));
      bumpRefetch();
    } else {
      setError("ピンの取り消しに失敗しました。ピンをタップして削除してください。");
    }
  }, [savedToastPinId, pinMutations, bumpRefetch]);

  // トーストの「写真を追加」: 作成した pin の詳細パネルを開く (写真セクション
  // から即撮影できる)。連続ピンモードで 2 枚目の最短経路が長くなった件の解消。
  const handleAddPhotoToCreatedPin = useCallback(() => {
    const pinId = savedToastPinId;
    if (!pinId) return;
    setSavedToastPinId((cur) => (cur === pinId ? null : cur));
    setDetailPinId(pinId);
  }, [savedToastPinId]);

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
      const r = await pinMutations.createPin({
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy,
        pinType: input.pinType,
        memo: input.memo === "" ? null : input.memo,
        // 巡回中は必ず sessionId を付ける (session touch = 12h放置確認/24h自動終了の
        // 誤発火防止が働く)。巡回外は undefined → hook が body から落とすので
        // 「終了済み/他人 session に紐づけない」不変条件を一切踏まない。
        sessionId: activeSession?.id,
      });
      if (!r.ok || !r.data) return;
      // 保存成功した種類を次のモーダル初期値へ引き継ぐ (連続ピンの入力時短)。
      // allowlist 検証つき: 未知の値は記憶しない (モーダルの radio に無い値で
      // 開くと何も選択されないため)。
      if (isFieldSurveyPinType(input.pinType)) {
        setLastPinType(input.pinType);
      }
      // pin 作成成功。pending な「現在地を使う」callback を無効化し marker を再取得。
      invalidateCurrentLocationRequest();
      bumpRefetch();
      const newPinId = r.data.id;
      createdPinIdRef.current = newPinId;
      if (!file) {
        // modal close / トースト / detail panel は finalizePinCreate に集約。
        finalizePinCreate(newPinId, false);
        return;
      }
      // 二段階目: 作成済み pin に写真を添付。失敗時は pin を残したまま再試行 UI へ。
      pendingPhotoFileRef.current = file;
      const up = await photoMutations.uploadPhoto(newPinId, file);
      if (up.ok) {
        finalizePinCreate(newPinId, true);
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
      // 保持している失敗の破棄は finalizePinCreate が行う (完了の単一入口)。
      finalizePinCreate(pinId, true);
    }
  }, [photoMutations, finalizePinCreate]);

  const handleFinishWithoutPhoto = useCallback(() => {
    const pinId = createdPinIdRef.current;
    if (!pinId) return;
    finalizePinCreate(pinId, false);
  }, [finalizePinCreate]);

  // 詳細パネルの「作業中」(編集下書き / 削除確認 / 物件化 / 写真送信中) を
  // closure から読むための ref。true の間は地図タップでパネルを閉じない
  // (下書き・送信中の写真を黙って破棄しない。Codex P2)。
  const detailPanelBusyRef = useRef(false);
  const handleDetailPanelBusyChange = useCallback((busy: boolean) => {
    detailPanelBusyRef.current = busy;
  }, []);

  const handleMapClick = useCallback(
    (latLng: { lat: number; lng: number }) => {
      // 既に modal 表示中はスルー (誤操作防止)
      if (createCandidate) return;
      // 巡回中でなくても、巡回なし撮影の「地図をタップして場所を指定」
      // (現在地が取れない HTTP 本番での主経路) だけは通す。
      // ピン追加モード経由の新規作成は従来どおり巡回中のみ (後段のモード判定で止まる)。
      if (!activeSession && cameraFirstPhase !== "awaiting-map-tap") return;
      // 詳細パネルで作業中なら新規作成のタップを無視する (パネルは維持)。
      if (detailPinId && detailPanelBusyRef.current) return;
      // カメラファーストの位置指定待ちを最優先 (pin 追加モードと独立に動く)。
      // タップ座標 + 撮影済み写真で作成 modal を開く。
      if (cameraFirstPhase === "awaiting-map-tap") {
        const photo = cameraPhotoFileRef.current ?? undefined;
        cameraPhotoFileRef.current = null;
        createdFromCameraRef.current = true;
        setCameraFirstPhase("idle");
        setCameraFirstNotice(null);
        // 開いたままの詳細パネルは閉じる (旧ピンのパネル残留と、スマホで
        // bottom sheet が保存トーストを覆い隠すのを防ぐ)。
        setDetailPinId(null);
        setCreateCandidate({
          lat: latLng.lat,
          lng: latLng.lng,
          cameraPhoto: photo,
          cameraPhotoPreviewUrl: photo ? URL.createObjectURL(photo) : undefined,
        });
        setCurrentLocationError(null);
        return;
      }
      // mode OFF はスルー (誤操作防止)
      if (!pinAddMode) return;
      // 撮影の現在地取得中に通常経路で modal を開くなら、カメラ側は同期的に
      // 破棄する (以後のモーダル操作による共有 token bump で "locating" に
      // 固着させない。callback 側の後始末は防御の二重化)。
      if (cameraFirstPhase === "locating") resetCameraFirst();
      // 連続ピンモードでは詳細パネル表示中でも地図タップが有効なため、
      // 新規作成の確定でパネルを閉じる (上と同旨)。
      setDetailPinId(null);
      setCreateCandidate({ lat: latLng.lat, lng: latLng.lng });
      setCurrentLocationError(null);
    },
    [
      pinAddMode,
      activeSession,
      createCandidate,
      cameraFirstPhase,
      resetCameraFirst,
      detailPinId,
    ],
  );

  // カメラファーストボタンの表示 / 無効判定 (純関数)。
  const cameraButton = cameraFirstButtonState({
    hasActiveSession: !!activeSession,
    canCaptureWithoutTrip: canQuickCapture,
    canWrite: canWritePin,
    phase: cameraFirstPhase,
    modalOpen: !!createCandidate,
  });

  return (
    <APIProvider apiKey={apiKey}>
      <div className="relative h-full w-full">
        <Map
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={DEFAULT_ZOOM}
          mapId={mapId}
          gestureHandling={mapGestureHandling}
          disableDefaultUI={false}
          style={{ width: "100%", height: "100%" }}
        >
          <MapDataLayer
            layers={layers}
            hideClosedPins={hideClosedPins}
            coverageDays={coverageDays}
            onCoverageState={handleCoverageState}
            onTracksState={handleTracksState}
            onError={setError}
            refetchNonce={refetchNonce}
            currentUserId={currentUserId}
            captureMapClick={pinAddMode || cameraFirstPhase === "awaiting-map-tap"}
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
          {/* 「この場所を地図で見る」で指定されたピンの強調マーカー。PIN_LIMIT で
              marker 一覧から漏れる古い候補でも、指定した場所を必ず示す (@codex P2)。
              タップで詳細を開く: 前面 (zIndex) のこのマーカーが背後の通常マーカーの
              タップを奪うため onClick が無いと詳細を開けない。ユーザー操作時のみ
              setDetailPinId を呼ぶ (自動オープンしないので監査は二重計上されない・
              タップは 1 回の意図的な閲覧として正しく監査される。@codex P2)。 */}
          {focusPinPos && focusPinId && (
            <AdvancedMarker
              position={focusPinPos}
              zIndex={1000}
              title="指定した場所 (タップで詳細)"
              onClick={() => setDetailPinId(focusPinId)}
            >
              <Pin
                background="#2563EB"
                borderColor="#FFFFFF"
                glyphColor="#FFFFFF"
                glyph="★"
                scale={1.4}
              />
            </AdvancedMarker>
          )}
        </Map>

        <ControlPanel
          layers={layers}
          onToggle={(key) =>
            setLayers((prev) => ({ ...prev, [key]: !prev[key] }))
          }
          hideClosedPins={hideClosedPins}
          onToggleHideClosedPins={() => setHideClosedPins((v) => !v)}
          coverageDays={coverageDays}
          onChangeCoverageDays={setCoverageDays}
          coverageCellSize={coverageState.cellSize}
          coverageStatus={coverageState.status}
          tracksStatus={tracksState.status}
          tracksDroppedTrips={tracksState.droppedTrips}
          tracksDroppedTripsExact={tracksState.droppedTripsExact}
          panelOpen={panelOpen}
          onTogglePanelOpen={() => {
            quickStartRef.current = false;
            setPanelOpen((v) => !v);
          }}
          currentUserId={currentUserId}
          registerStartRequest={registerStartRequest}
          registerSessionRefresh={registerSessionRefresh}
          onDiscardUnsentLocations={() => recorder.discardBufferAndStop()}
          onAbortPendingFlush={() => recorder.abortInFlightFlush()}
          onEndFailedRestoreRecorder={() =>
            recorder.restoreIdleAfterFailedEnd()
          }
          onBlockRecorderForEnd={() => recorder.blockRecorderForPendingEnd()}
          onActiveSessionChange={handleActiveSessionChange}
          onBeforeSessionEnd={handleBeforeSessionEnd}
          recorder={recorder}
          hasActiveSession={!!activeSession}
          pinAddMode={pinAddMode}
          onTogglePinAddMode={() => setPinAddMode((v) => !v)}
          canWritePin={canWritePin}
          showOthersLegendHint={canSeeOtherPins}
          onPanToCurrent={handlePanToCurrent}
        />

        {/* カメラファースト: 巡回中は「撮って登録」ボタンを地図下部に常設。
            表示切替パネルを開かなくても撮影→ピン登録へ直行できる。
            モバイルでパネル展開中 (panelOpen) はパネル下部を覆いタップを
            遮るため FAB / banner を描画しない (md+ はトグル自体が無い)。 */}
        {/* 巡回中は「撮って登録」だけを中央に置く (従来どおり)。 */}
        {activeSession && cameraButton.visible && !panelOpen && (
          <CameraFirstButton
            disabled={cameraButton.disabled}
            locating={cameraFirstPhase === "locating"}
            permissionDenied={canWritePin === false}
            onCaptureStart={startCameraLocationPrefetch}
            onPhotoCaptured={handleCameraPhotoCaptured}
          />
        )}
        {cameraFirstPhase === "awaiting-map-tap" && !panelOpen && (
          <CameraFirstBanner
            notice={cameraFirstNotice}
            onCancel={resetCameraFirst}
          />
        )}

        {/* 巡回していない時の地図下部。「巡回なしで撮影」権限があれば
            「📷撮って登録」を主ボタンとして左に、「🚶巡回を開始」を副ボタンとして
            右に横並びで置く (両方 bottom-14 left-1/2 だと完全に重なるため、
            ここでは行レイアウトにして CameraFirstButton を inline で描画する)。
            権限が無ければ従来どおり「巡回を開始」だけを中央に出す。 */}
        {!activeSession && !panelOpen && (
          <div className="pointer-events-none absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 items-start gap-2">
            {cameraButton.visible && (
              <CameraFirstButton
                inline
                disabled={cameraButton.disabled}
                locating={cameraFirstPhase === "locating"}
                permissionDenied={canWritePin === false}
                onCaptureStart={startCameraLocationPrefetch}
            onPhotoCaptured={handleCameraPhotoCaptured}
              />
            )}
            <button
              type="button"
              data-testid="trip-quick-start"
              onClick={() => {
                quickStartRef.current = true;
                setPanelOpen(true);
                startTripRef.current?.();
              }}
              className={
                cameraButton.visible
                  ? // 撮影が主導線のときは巡回開始を控えめな副ボタンにする。
                    "pointer-events-auto flex items-center gap-1.5 whitespace-nowrap rounded-full border border-emerald-700 bg-white px-4 py-3 text-sm font-semibold text-emerald-700 shadow-lg hover:bg-emerald-50 dark:border-emerald-500 dark:bg-gray-900 dark:text-emerald-300 dark:hover:bg-gray-800"
                  : "pointer-events-auto flex items-center gap-2 whitespace-nowrap rounded-full border border-emerald-700 bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-lg hover:bg-emerald-700 dark:border-emerald-500"
              }
            >
              <span aria-hidden="true">🚶</span>
              巡回を開始
            </button>
          </div>
        )}

        {/* 位置記録の状態チップ (巡回中のみ)。撮影でタブが再読込されると記録が
            静かに止まる・開始し忘れに気づけない問題への可視化。位置記録は任意
            機能 (撮って登録だけの巡回では使わない) なので、意図的な「オフ」は
            警告色にせず中立の灰色にする (常時オフの巡回で警告が鳴りっぱなしに
            なるのを防ぐ)。一方、権限拒否・取得不可などの「エラー」で予期せず
            止まった場合 (@codex P2) は琥珀色で明示し、意図的オフと区別する。
            記録中は緑・準備中は青。タップでパネルへ。 */}
        {activeSession && (
          <button
            type="button"
            data-testid="location-recording-chip"
            onClick={() => setPanelOpen(true)}
            className={
              recorder.status === "recording"
                ? "absolute left-3 top-14 z-10 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-800 shadow dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                : recorder.status === "preparing"
                  ? "absolute left-3 top-14 z-10 rounded-full border border-sky-300 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold text-sky-800 shadow dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-300"
                  : recorder.status === "error"
                    ? "absolute left-3 top-14 z-10 rounded-full border border-amber-400 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-900 shadow dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-300"
                    : "absolute left-3 top-14 z-10 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-semibold text-gray-500 shadow dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }
          >
            {recorder.status === "recording" ? (
              <>
                <span aria-hidden="true" className="animate-pulse">
                  ●
                </span>{" "}
                位置記録中
              </>
            ) : recorder.status === "preparing" ? (
              "位置記録の準備中…"
            ) : recorder.status === "error" ? (
              <>
                <span aria-hidden="true">⚠</span> 位置記録エラー
              </>
            ) : (
              "位置記録オフ"
            )}
          </button>
        )}
        {savedToastPinId && (
          <div
            role="status"
            data-testid="pin-saved-toast"
            className="pointer-events-auto absolute bottom-28 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 shadow dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
          >
            <span>ピンを保存しました</span>
            <button
              type="button"
              onClick={handleAddPhotoToCreatedPin}
              data-testid="pin-saved-add-photo"
              className="rounded border border-emerald-400 bg-white px-2 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/50 dark:bg-gray-900 dark:text-emerald-300 dark:hover:bg-gray-800"
            >
              写真を追加
            </button>
            <button
              type="button"
              onClick={() => {
                void handleUndoCreatedPin();
              }}
              disabled={pinMutations.deleteLoading}
              data-testid="pin-saved-undo"
              className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {pinMutations.deleteLoading ? "取り消し中…" : "取り消す"}
            </button>
          </div>
        )}

        {createCandidate && (
          <PinCreateModal
            initialLat={createCandidate.lat}
            initialLng={createCandidate.lng}
            initialAccuracy={createCandidate.accuracy ?? null}
            initialPhotoFile={createCandidate.cameraPhoto ?? null}
            initialPhotoPreviewUrl={createCandidate.cameraPhotoPreviewUrl ?? null}
            // 巡回外の撮影は必ず「物件化候補」で始める。完成待ち一覧は
            // candidate/open/未物件化しか出さないため、種類引継ぎ (lastPinType)
            // がそのまま効くと巡回履歴にも一覧にも出ない孤児ピンになる。
            initialPinType={activeSession ? lastPinType : "candidate"}
            sessionId={activeSession?.id ?? null}
            saving={pinMutations.createLoading}
            serverError={pinMutations.createError}
            photoUploading={photoMutations.uploadLoading}
            photoUploadFailed={photoUploadFailed}
            photoUploadErrorDetail={photoMutations.uploadError}
            onCancel={() => {
              // Codex P2: pending geolocation callback を無効化してから modal を閉じる
              invalidateCurrentLocationRequest();
              // キャンセルは finalizePinCreate を通らないので個別に捨てる
              // (作成済み pin があり写真送信が失敗していたケース)。
              if (createdPinIdRef.current) {
                clearPhotoMutationFailure(createdPinIdRef.current);
              }
              setCreateCandidate(null);
              setCurrentLocationError(null);
              setPhotoUploadFailed(false);
              createdPinIdRef.current = null;
              pendingPhotoFileRef.current = null;
              // カメラファースト経由の candidate を破棄した場合も origin flag を戻す
              createdFromCameraRef.current = false;
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
            onReplaceRetryPhoto={(file) => {
              // 失敗中に選び直された写真で再試行できるよう保持 file を差し替える
              pendingPhotoFileRef.current = file;
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
            canManage={canManagePin === true}
            canWriteProperty={canWriteProperty === true}
            onClose={() => setDetailPinId(null)}
            onUpdated={() => bumpRefetch()}
            onDeleted={() => {
              setDetailPinId(null);
              bumpRefetch();
            }}
            onBusyStateChange={handleDetailPanelBusyChange}
          />
        )}

        {error && (
          <div
            role="alert"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 shadow dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
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
  hideClosedPins,
  onToggleHideClosedPins,
  coverageDays,
  onChangeCoverageDays,
  coverageCellSize,
  coverageStatus,
  tracksStatus,
  tracksDroppedTrips,
  tracksDroppedTripsExact,
  panelOpen,
  onTogglePanelOpen,
  currentUserId,
  registerStartRequest,
  registerSessionRefresh,
  onDiscardUnsentLocations,
  onAbortPendingFlush,
  onEndFailedRestoreRecorder,
  onBlockRecorderForEnd,
  onActiveSessionChange,
  onBeforeSessionEnd,
  recorder,
  hasActiveSession,
  pinAddMode,
  onTogglePinAddMode,
  canWritePin,
  showOthersLegendHint,
  onPanToCurrent,
}: {
  layers: Record<Layer, boolean>;
  onToggle: (key: Layer) => void;
  /** 「対応済みのピンを隠す」表示フィルタ (親 state。データは消さない)。 */
  hideClosedPins: boolean;
  onToggleHideClosedPins: () => void;
  /** 踏破ヒートの期間 (365=直近1年 / 0=全期間)。 */
  coverageDays: number;
  onChangeCoverageDays: (days: number) => void;
  /** 表示中の格子の粗さ (凡例に「1マス 約50m」を出すため)。取得前は null。 */
  coverageCellSize: CoverageCellSize | null;
  /**
   * 踏破ヒートの状態。**"ready" のときだけ凡例を出す**。
   * 「色が無い」の意味が状態で変わるため（誰も通っていない / まだ分からない）。
   */
  coverageStatus: CoverageStatus;
  /** 線（過去に歩いた道筋）の状態。落とした本数があれば必ず断りを出す。 */
  tracksStatus: CoverageStatus;
  tracksDroppedTrips: number;
  /** false なら「◯件以上」と伝える (@codex #334 P2)。 */
  tracksDroppedTripsExact: boolean;
  /**
   * モバイルでは初期折りたたみ: 常時展開だと地図の「地図/航空写真」ボタンに
   * パネルが覆い被さる(実機で確認)。md 以上は従来どおり常時展開。
   * 開閉 state は親 (FieldSurveyMap) 管理: 展開中はカメラ FAB / banner の
   * 描画を止めてパネル下部のタップを遮らないようにするため。
   */
  panelOpen: boolean;
  onTogglePanelOpen: () => void;
  currentUserId: string;
  /** 地図上「巡回を開始」→ TripControls の開始確認 modal を開くハンドラ登録。 */
  registerStartRequest: (fn: (() => void) | null) => void;
  /** #317: 開始フェンスの終了検知 → 巡回状態の再取得ハンドラ登録 (TripControls)。 */
  registerSessionRefresh: (fn: (() => void) | null) => void;
  /** 圏外時の「未送信の位置記録を破棄して終了」の破棄側 (recorder)。 */
  onDiscardUnsentLocations: () => void;
  /** 「破棄して終了」前に進行中 flush を中断する (buffer 保持・recorder)。 */
  onAbortPendingFlush: () => void;
  /** 破棄経路の終了 PATCH 失敗時に recorder を操作可能へ戻す (recorder)。 */
  onEndFailedRestoreRecorder: () => void;
  /** 曖昧な終了の間 recorder を stopping にし新 watch を防ぐ (recorder)。 */
  onBlockRecorderForEnd: () => void;
  onActiveSessionChange: (s: ActiveSessionLike | null) => void;
  onBeforeSessionEnd: () => Promise<boolean>;
  recorder: ReturnType<typeof useFieldSurveyLocationRecorder>;
  hasActiveSession: boolean;
  pinAddMode: boolean;
  onTogglePinAddMode: () => void;
  canWritePin: boolean | null;
  /** 凡例に「白いふちどり = 他の担当者」を出すか (read_all/manage 保持者のみ)。 */
  showOthersLegendHint: boolean;
  onPanToCurrent: () => void;
}) {
  // パネルは地図エリア(flex-1 overflow-hidden)に絶対配置されるため、内容が地図高より
  // 高いと下部が切れる(スマホで発生)。上限を viewport 固定値で見積もるとバナー
  // (InsecureContextBanner)やヘッダ折返し等の可変高で狂うため、コンテナ自身を地図
  // エリアの実高(top-3〜bottom-3)に固定し、その中でパネルをスクロールさせる。空き
  // 領域は pointer-events-none で地図操作を透過し、overscroll-contain で端でのスクロール
  // 連鎖(地図/ページ)を止める。
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 top-3 flex flex-col items-end md:w-56">
      <button
        type="button"
        onClick={onTogglePanelOpen}
        aria-expanded={panelOpen}
        className="pointer-events-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200 md:hidden"
      >
        {/* ラベルは排他表示で短く保つ (ピン追加は巡回中にしか ON にならない)。
            併記で長くなると左上の地図/航空写真ボタンに重なりタップを奪う
            (過去に実機で発生した既知ホットスポット)。 */}
        表示切替{pinAddMode ? "・ピン追加" : hasActiveSession ? "・巡回中" : ""} {panelOpen ? "▴" : "▾"}
      </button>
      <div
        className={`${panelOpen ? "mt-2 block" : "hidden"} pointer-events-auto min-h-0 w-56 overflow-y-auto overscroll-contain rounded-md border border-gray-200 bg-white p-3 text-sm shadow dark:border-gray-800 dark:bg-gray-900 md:mt-0 md:block`}
      >
      <div className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">表示切替</div>
      <label className="mb-1 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={layers.properties}
          onChange={() => onToggle("properties")}
        />
        <span>既存物件</span>
      </label>
      {/* 入れ子トグル表示中は下の mb-3 が余白を担う (OFF 時は従来どおり)。 */}
      <label
        className={`${layers.pins ? "mb-1" : "mb-3"} flex cursor-pointer items-center gap-2`}
      >
        <input
          type="checkbox"
          checked={layers.pins}
          onChange={() => onToggle("pins")}
        />
        <span>調査ピン</span>
      </label>
      {/* 対応済み (closed=灰✓) を一時的に隠す表示フィルタ。未対応だけを
          見たい時のノイズ削減。調査ピン表示中のみ意味があるため入れ子で出す。 */}
      {layers.pins && (
        <label className="mb-3 ml-6 flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={hideClosedPins}
            onChange={onToggleHideClosedPins}
            data-testid="hide-closed-pins-toggle"
          />
          <span>対応済みのピンを隠す</span>
        </label>
      )}

      {/* ピンの配色凡例 (調査ピン表示中のみ)。 */}
      {layers.pins && <PinMarkerLegend showOthersHint={showOthersLegendHint} />}

      {/* 踏破ヒート: 全員が歩いた場所の蓄積。この地図を開く主目的が
          「次にどこを回るか決める」なので既定 ON。 */}
      <label
        className={`${layers.coverage ? "mb-1" : "mb-3"} mt-2 flex cursor-pointer items-center gap-2 border-t border-gray-200 pt-2 dark:border-gray-800`}
      >
        <input
          type="checkbox"
          checked={layers.coverage}
          onChange={() => onToggle("coverage")}
          data-testid="coverage-layer-toggle"
        />
        <span>歩いた場所</span>
      </label>
      {layers.coverage && (
        <div className="mb-3 ml-6">
          <label className="mb-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <span>期間</span>
            <select
              value={coverageDays}
              onChange={(e) => onChangeCoverageDays(Number(e.target.value))}
              data-testid="coverage-period-select"
              className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              {COVERAGE_PERIOD_DAYS.map((d) => (
                <option key={d} value={d}>
                  {coveragePeriodLabel(d)}
                </option>
              ))}
            </select>
          </label>
          {/* ⚠凡例（色なし＝誰も通っていません）を出してよいのは "ready" だけ。
              まだ分からない状態で同じ見た目にすると、踏破済みのエリアへ人を
              送り出すことになる。 */}
          {canTrustCoverageLegend(coverageStatus) ? (
            <CoverageLegend cellSize={coverageCellSize ?? undefined} />
          ) : coverageStatus === "loading" ? (
            <p
              role="status"
              data-testid="coverage-loading-notice"
              className="mb-1 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300"
            >
              歩いた場所を確認中…
            </p>
          ) : coverageStatus === "too-wide" ? (
            <p
              role="status"
              data-testid="coverage-truncated-notice"
              className="mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
            >
              範囲が広すぎて歩いた場所を出せません。地図を寄せてください。
            </p>
          ) : coverageStatus === "unavailable" ? (
            <p
              role="alert"
              data-testid="coverage-unavailable-notice"
              className="mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
            >
              歩いた場所を取得できませんでした。
              <b>色が付いていない場所も、通っている可能性があります。</b>
            </p>
          ) : null}
        </div>
      )}

      {/* 線: 実際に歩いた道筋。面（マス）は道より広く、点の間もつながないので
          「本当にこの道を歩いたか」は線でしか分からない。既定 ON。
          ⚠発注者判断により**全員が見られる** (field_survey:read だけで通す)。
          二度歩きを避けるのが目的なので、街を歩く当人が見られないと意味がない。 */}
      <label
        className={`${layers.tracks ? "mb-1" : "mb-3"} flex cursor-pointer items-center gap-2`}
      >
        <input
          type="checkbox"
          checked={layers.tracks}
          onChange={() => onToggle("tracks")}
          data-testid="tracks-layer-toggle"
        />
        <span>歩いた道筋（線）</span>
      </label>
      {layers.tracks && (
        <div className="mb-3 ml-6">
          {tracksStatus === "loading" ? (
            <p
              role="status"
              data-testid="tracks-loading-notice"
              className="mb-1 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300"
            >
              歩いた道筋を確認中…
            </p>
          ) : tracksStatus === "too-wide" ? (
            <p
              role="status"
              data-testid="tracks-truncated-notice"
              className="mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
            >
              範囲が広すぎて道筋を出せません。地図を寄せてください。
            </p>
          ) : tracksStatus === "unavailable" ? (
            <p
              role="alert"
              data-testid="tracks-unavailable-notice"
              className="mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
            >
              歩いた道筋を取得できませんでした。
              <b>線が無い場所も、通っている可能性があります。</b>
            </p>
          ) : tracksDroppedTrips > 0 ? (
            /* ⚠黙って減らさない。線が出ていない場所を「歩いていない」と
               読まれると無駄足の指示になる。 */
            <p
              role="status"
              data-testid="tracks-dropped-notice"
              className="mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
            >
              線が多いため、古い巡回 {tracksDroppedTrips}
              {tracksDroppedTripsExact ? " 件" : " 件以上"}
              は表示していません。地図を寄せるか期間を「直近1年」にすると
              全部出ます。
            </p>
          ) : (
            <p className="mb-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              灰色の線＝過去に歩いた道。青い線＝いま巡回中の道。
            </p>
          )}
        </div>
      )}

      {/* Phase 1-F-1: 巡回開始/終了 + active session 復元。
          Phase 1-F-2: 終了前に位置記録 (watchPosition / flush timer / buffer)
          を確実に停止するため onBeforeSessionEnd を渡す。 */}
      <TripControls
        currentUserId={currentUserId}
        onActiveSessionChange={onActiveSessionChange}
        onBeforeSessionEnd={onBeforeSessionEnd}
        registerStartRequest={registerStartRequest}
        registerSessionRefresh={registerSessionRefresh}
        onDiscardUnsentLocations={onDiscardUnsentLocations}
        onAbortPendingFlush={onAbortPendingFlush}
        onEndFailedRestoreRecorder={onEndFailedRestoreRecorder}
        onBlockRecorderForEnd={onBlockRecorderForEnd}
        unsentLocationCount={recorder.bufferedCount}
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
  hideClosedPins,
  onError,
  refetchNonce,
  currentUserId,
  captureMapClick,
  onMapClick,
  onOpenPinDetail,
  coverageDays,
  onCoverageState,
  onTracksState,
}: {
  layers: Record<Layer, boolean>;
  /**
   * 「対応済みのピンを隠す」表示フィルタ。fetch 条件は変えず描画だけを
   * 間引く (トグルのたびに再取得しない。closed は #315 の灰✓ marker)。
   */
  hideClosedPins: boolean;
  /** 踏破ヒートの期間 (365=直近1年 / 0=全期間)。 */
  coverageDays: number;
  /** 踏破ヒートの状態を親へ返す (凡例と注意書きの表示に使う)。 */
  onTracksState: (state: {
    status: CoverageStatus;
    droppedTrips: number;
    droppedTripsExact: boolean;
  }) => void;
  onCoverageState: (state: {
    cellSize: CoverageCellSize | null;
    status: CoverageStatus;
  }) => void;
  onError: (msg: string | null) => void;
  refetchNonce: number;
  /** ピンの「自分/他人」縁色の判定用 (server-side で確定済みのログイン userId)。 */
  currentUserId: string;
  /** pin 追加モード中またはカメラファーストの地図タップ待ち中に map click を転送する。 */
  captureMapClick: boolean;
  onMapClick: (latLng: { lat: number; lng: number }) => void;
  onOpenPinDetail: (pinId: string) => void;
}) {
  const map = useMap();
  const [properties, setProperties] = useState<PropertyRow[]>([]);
  const [pins, setPins] = useState<PinRow[]>([]);
  // 踏破ヒート。cells は「格子番号と回数」だけで、座標も人名も含まない。
  const [coverageCells, setCoverageCells] = useState<CoverageCell[]>([]);
  const [trackLines, setTrackLines] = useState<RoutePolylinePoint[][]>([]);
  const [coverageStep, setCoverageStep] = useState<{
    latStep: number;
    lngStep: number;
  } | null>(null);
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
        // ⚠ここでも**古い色を必ず消す** (@codex #332 P2)。消さないと、取得を
        // 行っていない広い範囲に前の色が残り、周りの無色を「誰も通っていない」
        // と誤読させる。飛んでいる古い要求が後から色を戻すのも防ぐ。
        if (abortRef.current) abortRef.current.abort();
        setCoverageCells([]);
        setCoverageStep(null);
        onCoverageState({ cellSize: null, status: "too-wide" });
        // 線も同じ理由で消す。古い線が残ると、そこを歩いたのが今の範囲の
        // 話だと誤読される。
        setTrackLines([]);
        onTracksState({
          status: "too-wide",
          droppedTrips: 0,
          droppedTripsExact: true,
        });
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

        // ⚠踏破ヒートは**既存の地図データと同じ Promise.all に入れない**
        // (@codex #332 P2)。集計は座標の索引が無いぶん重くなり得るので、
        // 同じ待ち行列に入れると**物件とピンの更新まで一緒に止まる**。
        // 中断(AbortController)と debounce は共有したまま、待ち合わせだけ分ける。
        const coveragePromise = layers.coverage
          ? fetch(
              "/api/field-survey/coverage/cells?" +
                new URLSearchParams({
                  north: String(b.north),
                  south: String(b.south),
                  east: String(b.east),
                  west: String(b.west),
                  days: String(coverageDays),
                }).toString(),
              { signal: ac.signal, credentials: "same-origin" },
            )
          : null;

        // ⚠線も**別の待ち行列**にする（面と同じ理由）。生点を読むので面より
        // 重くなり得る。面・物件・ピンの更新を線が止めないようにする。
        const tracksPromise = layers.tracks
          ? fetch(
              "/api/field-survey/coverage/tracks?" +
                new URLSearchParams({
                  north: String(b.north),
                  south: String(b.south),
                  east: String(b.east),
                  west: String(b.west),
                  days: String(coverageDays),
                }).toString(),
              { signal: ac.signal, credentials: "same-origin" },
            )
          : null;

        if (tracksPromise) {
          setTrackLines([]);
          onTracksState({
            status: "loading",
            droppedTrips: 0,
            droppedTripsExact: true,
          });
          void tracksPromise
            .then(async (r) => {
              if (ac.signal.aborted) return;
              if (!r.ok) {
                handleHttpError(r.status, onError);
                setTrackLines([]);
                onTracksState({
                  status: "unavailable",
                  droppedTrips: 0,
                  droppedTripsExact: true,
                });
                return;
              }
              const j = (await r.json()) as {
                data?: {
                  lines?: RoutePolylinePoint[][];
                  droppedTrips?: number;
                  droppedTripsExact?: boolean;
                };
              };
              if (ac.signal.aborted) return;
              // ⚠線は打ち切っても**描いたぶんは正しい**（面と違い、描けなかった
              // 線が「歩いていない」を意味しない）。消さずに出し、落とした本数を
              // 断りとして必ず添える。
              setTrackLines(j.data?.lines ?? []);
              onTracksState({
                status: "ready",
                droppedTrips: j.data?.droppedTrips ?? 0,
                droppedTripsExact: j.data?.droppedTripsExact !== false,
              });
            })
            .catch((err: unknown) => {
              if ((err as { name?: string }).name === "AbortError") return;
              setTrackLines([]);
              onTracksState({
                status: "unavailable",
                droppedTrips: 0,
                droppedTripsExact: true,
              });
            });
        } else {
          setTrackLines([]);
          onTracksState({
            status: "off",
            droppedTrips: 0,
            droppedTripsExact: true,
          });
        }

        if (coveragePromise) {
          // ⚠問い合わせ開始時に**前の色を消して「確認中」にする** (@codex #332)。
          // 期間を「全期間」から「直近1年」へ変えた直後などに古い色が残ると、
          // 選択と表示が食い違ったまま（集計は索引が無いぶん時間がかかる）。
          setCoverageCells([]);
          onCoverageState({ cellSize: null, status: "loading" });
          void coveragePromise
            .then(async (r) => {
              if (ac.signal.aborted) return;
              if (!r.ok) {
                handleHttpError(r.status, onError);
                setCoverageCells([]);
                onCoverageState({ cellSize: null, status: "unavailable" });
                return;
              }
              const j = (await r.json()) as {
                data?: {
                  cells?: CoverageCell[];
                  latStep?: number;
                  lngStep?: number;
                  truncated?: boolean;
                  cell?: CoverageCellSize;
                };
              };
              if (ac.signal.aborted) return;
              const d = j.data;
              // ⚠打ち切り時は**色を一切描かない**(サーバも空配列を返す)。
              // この画面は「色が無い＝誰も通っていない」と読ませるので、
              // 一部だけ描くと踏破済みエリアへ人を送り出すことになる。
              const truncated = d?.truncated === true;
              setCoverageCells(truncated ? [] : (d?.cells ?? []));
              setCoverageStep(
                d?.latStep != null && d?.lngStep != null
                  ? { latStep: d.latStep, lngStep: d.lngStep }
                  : null,
              );
              onCoverageState({
                cellSize: d?.cell ?? null,
                status: truncated ? "too-wide" : "ready",
              });
            })
            .catch((err: unknown) => {
              if ((err as { name?: string }).name === "AbortError") return;
              // 通信失敗でも古い色を残さない(古い期間の色を描き続けない)。
              setCoverageCells([]);
              onCoverageState({ cellSize: null, status: "unavailable" });
            });
        } else {
          setCoverageCells([]);
          onCoverageState({ cellSize: null, status: "off" });
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
        // ⚠通信失敗でも**古い色を必ず消す** (@codex #332 P2)。残すと、期間を
        // 「直近1年」から「全期間」へ切り替えた直後に失敗した場合、画面は新しい
        // 期間を選んだ状態のまま**古い期間の色**を描き続ける。
        // 「色が無い＝誰も通っていない」と読ませる画面なので、古い色が残ることは
        // 誤った指示に直結する。
        setCoverageCells([]);
        onCoverageState({ cellSize: null, status: "unavailable" });
        setTrackLines([]);
        onTracksState({
          status: "unavailable",
          droppedTrips: 0,
          droppedTripsExact: true,
        });
        // 詳細は console / UI に出さない
        onError("地図データの取得に失敗しました。");
      } finally {
        setLoading(false);
      }
    },
    [
      layers.properties,
      layers.pins,
      layers.coverage,
      layers.tracks,
          coverageDays,
      onError,
      onCoverageState,
      onTracksState,
    ],
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
  }, [
    layers.properties,
    layers.pins,
    layers.coverage,
    layers.tracks,
      coverageDays,
    refetchNonce,
  ]);

  // Phase 1-G: pin 追加モード中 (またはカメラファーストの地図タップ待ち中) のみ
  // map click を pin 作成候補に転送する。
  // OFF のときは marker click (AdvancedMarker onClick) のみが動く。
  // raw click 座標は console に出さない。
  useEffect(() => {
    if (!map) return;
    if (!captureMapClick) return;
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
  }, [map, captureMapClick, onMapClick]);

  return (
    <>
      {/* 踏破ヒート。zIndex 0 で最下層に敷き、軌跡の線やピンが必ず上に乗る。
          clickable:false なので地図タップ (ピン追加・撮影後の場所指定) を奪わない。 */}
      {coverageStep && (
        <CoverageHeatLayer
          cells={coverageCells}
          latStep={coverageStep.latStep}
          lngStep={coverageStep.lngStep}
          visible={layers.coverage}
        />
      )}
      {/* 過去に歩いた道筋。面（マス）は道より広く点の間もつながないので、
          実際に歩いた筋はこちらでしか出ない。 */}
      {layers.tracks && (
        <CoverageTracksLayer lines={trackLines} visible={layers.tracks} />
      )}
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
        (hideClosedPins
          ? pins.filter((p) => p.status !== "closed")
          : pins
        ).map((pin) => (
          <AdvancedMarker
            key={pin.id}
            position={{ lat: pin.lat, lng: pin.lng }}
            onClick={() => setSelected({ kind: "pin", row: pin })}
            title={formatPinType(pin.pinType)}
          >
            {/* 種別=色+グリフ / 対応済み=灰✓ / 他人=白縁 (凡例と純関数を共有) */}
            <Pin
              {...pinMarkerStyle({
                pinType: pin.pinType,
                status: pin.status,
                isOwn: pin.staffUserId === currentUserId,
              })}
            />
          </AdvancedMarker>
        ))}

      {selected && selected.kind === "property" && (
        <InfoWindow
          position={{ lat: selected.row.gpsLat, lng: selected.row.gpsLng }}
          onCloseClick={() => setSelected(null)}
        >
          <PropertyInfo row={selected.row} />
        </InfoWindow>
      )}
      {/* 開いたまま「対応済みを隠す」を ON にした closed ピンの吹き出しは
          marker と一緒に非表示にする (marker が消えたのに吹き出しだけ残ると
          位置の手がかりが無い浮遊 UI になる)。OFF に戻せば再表示される。 */}
      {selected &&
        selected.kind === "pin" &&
        !(hideClosedPins && selected.row.status === "closed") && (
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
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-white/90 px-3 py-1 text-xs text-gray-700 shadow dark:bg-gray-900/90 dark:text-gray-300">
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
      {/* 値は他画面と同じ共有ラベル辞書で日本語表示する (生の enum 英字を
          現場に見せない)。未知の値はフォールバックで素通し (既存データ保全)。 */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
        <dt>種別</dt>
        <dd>{PROPERTY_TYPE_LABELS[row.propertyType] ?? row.propertyType}</dd>
        <dt>登記</dt>
        <dd>{REGISTRY_STATUS_LABELS[row.registryStatus] ?? row.registryStatus}</dd>
        <dt>DM</dt>
        <dd>{DM_STATUS_LABELS[row.dmStatus] ?? row.dmStatus}</dd>
        <dt>案件</dt>
        <dd>{CASE_STATUS_LABELS[row.caseStatus] ?? row.caseStatus}</dd>
      </dl>
      <div className="mt-2">
        <a
          href={`/properties/${row.id}`}
          className="text-indigo-600 hover:underline"
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
        <dt>巡回</dt>
        {/* 巡回なし撮影が入ったため「—」が常態になる。何が起きたか分かる語にする。 */}
        <dd>{row.sessionId ? "あり" : "巡回外の撮影"}</dd>
        <dt>物件</dt>
        <dd>
          {row.propertyId ? (
            <a
              href={`/properties/${row.propertyId}`}
              className="text-indigo-600 hover:underline"
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
        className="mt-2 text-indigo-600 hover:underline"
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
