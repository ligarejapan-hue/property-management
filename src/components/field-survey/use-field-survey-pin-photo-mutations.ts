"use client";

/**
 * 現地調査マップ Phase 1-H: 調査ピン写真の list / upload / delete mutation hook。
 *
 * - 既存 API (`/api/field-survey/pins/[id]/photos` GET/POST、
 *   `/api/field-survey/pins/[id]/photos/[photoId]` DELETE) を呼ぶ。
 * - upload は multipart/form-data (Content-Type は fetch が自動付与)。
 * - list(GET) のみ AbortController で stale request 中断。**upload(POST)/delete(DELETE)
 *   は中断しない**(下記)。unmount 後の setState は mountedRef で抑止する。
 * - 画像情報 / fileUrl / fileName / API key / raw response 全文を console や
 *   error UI に出さない。エラーは status から汎用文言にマップ。
 * - localStorage / sessionStorage / IndexedDB は使わない。
 * - storageKey を UI に渡さない (API も返さない)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { pinApiErrorMessage } from "@/lib/field-survey-pin-util";
import { prepareFieldSurveyPhotoForUpload } from "@/lib/field-survey-photo-prepare";

export interface PinPhoto {
  id: string;
  pinId: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sortOrder: number;
  createdAt: string;
}

export interface PinPhotoMutationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * unmount を跨いで走り続ける upload の状況を、**hook インスタンスの外**で持つ。
 *
 * ⚠abort をやめただけでは足りない (@codex #331 R1)。パネルを閉じてすぐ開き直すと、
 * 新しい写真セクションの初回 GET が upload の commit より先に終わることがある。
 * 古い hook は mountedRef で完了処理を抑止するため、新しい一覧に「増えたよ」と
 * 伝える手段が無く、**保存された写真が次の再読込まで見えない**。利用者は消えたと
 * 思って同じ写真をもう一度送る (= 重複)。
 *
 * そこで pinId ごとの進行中件数と完了通知を module スコープに置き、再マウント側が
 * 「送信中がある」ことを知り、完了時に自動で読み直せるようにする。
 * PII は持たない (pinId のみ・件数のみ)。
 *
 * ⚠**削除も同じ通知に乗せる** (@codex #331 R1)。削除中に閉じてすぐ開き直すと、
 * 初回 GET が DELETE の commit より先に終わり、**削除済みの写真が一覧に残る**。
 * そのまま消そうとすると 404 になる。upload と同様、完了で読み直させる。
 */
/**
 * 完了通知に載せる結果。
 *
 * ⚠**成否を載せないと足りない** (@codex #331 R1)。閉じてすぐ開き直したあとに
 * 通信・認証・変換・検証で失敗した場合、通知だけでは「送信中」表示が消えて
 * 一覧を読み直すだけになり、**「出ますのでお待ちください」と案内したのに
 * 何も出ず、エラーも出ない**。写真が端末のピッカーにしか無い状況で、
 * 利用者は失敗に気づけない。結果を運んで再マウント側で案内する。
 *
 * error は pinApiErrorMessage 由来の汎用文言のみ (PII / 生レスポンスを載せない)。
 */
export interface PhotoMutationOutcome {
  kind: "upload" | "delete";
  ok: boolean;
  error?: string;
  /**
   * この操作を開始した hook インスタンスの識別子。
   *
   * ⚠これが無いと、**パネルを開いたまま**失敗したときにも「離れている間に
   * 失敗しました」の赤い案内が出てしまう (@codex #331 R1)。その場合は hook 自身の
   * uploadError / deleteError が既に出ているので、二重表示かつ事実と違う文言になる。
   * 購読側は「自分が始めた操作でない」ものだけを離席中の失敗として扱う。
   */
  ownerId: number;
}

/** hook インスタンスの連番 (どのインスタンスが始めた操作かの識別に使う)。 */
let photoHookInstanceSeq = 0;

const inFlightUploads = new Map<string, number>();
/**
 * 進行中の削除 (pinId → photoId の集合)。
 *
 * ⚠upload だけ追跡していると足りない (@codex #331 R1)。削除中に閉じてすぐ
 * 開き直すと、初回 GET が DELETE の commit より先に終わって**まだ在る写真が
 * 削除ボタン付きで表示される**。押すと二重 DELETE になり、後発が 404 を返して
 * 「離れている間に失敗しました」という誤った案内が出る。
 */
const inFlightDeletes = new Map<string, Set<string>>();
const mutationSettledListeners = new Set<
  (pinId: string, outcome: PhotoMutationOutcome) => void
>();
/**
 * 直近の失敗を pin ごとに保持する。
 *
 * ⚠購読者が居るときだけ通知する形では足りない (@codex #331 R1)。パネルを閉じた
 * あとに失敗が確定し、その**あとで**開き直した場合は誰も受け取っておらず、
 * 「送信中」表示も消えているため、利用者は失敗に気づけないまま終わる。
 * 失敗を残しておき、次にその pin の一覧が立ち上がったときに一度だけ出す。
 * 保持するのは pinId と汎用文言だけ (PII は載らない)。
 */
const lastFailures = new Map<string, PhotoMutationOutcome>();

/** その pin の直近の失敗を取り出す (取り出したら消す = 一度だけ出す)。 */
export function takeLastPhotoMutationFailure(
  pinId: string,
): PhotoMutationOutcome | null {
  const failure = lastFailures.get(pinId);
  if (!failure) return null;
  lastFailures.delete(pinId);
  return failure;
}

/** upload / delete の完了を、その pin を表示している一覧へ知らせる。 */
function notifyPhotoMutationSettled(
  pinId: string,
  outcome: PhotoMutationOutcome,
): void {
  // 購読者が居なくても失敗は残す (開き直した時に出せるようにする)。
  if (!outcome.ok) lastFailures.set(pinId, outcome);
  for (const listener of mutationSettledListeners) listener(pinId, outcome);
}

function markUploadStarted(pinId: string): void {
  inFlightUploads.set(pinId, (inFlightUploads.get(pinId) ?? 0) + 1);
}

function markUploadSettled(
  pinId: string,
  outcome: PhotoMutationOutcome,
): void {
  const next = (inFlightUploads.get(pinId) ?? 1) - 1;
  if (next <= 0) inFlightUploads.delete(pinId);
  else inFlightUploads.set(pinId, next);
  notifyPhotoMutationSettled(pinId, outcome);
}

/** その pin に送信中の写真があるか (再マウント直後の案内表示用)。 */
export function hasInFlightPhotoUpload(pinId: string): boolean {
  return (inFlightUploads.get(pinId) ?? 0) > 0;
}

/** その pin で削除中の photoId (再マウント後に削除ボタンを押させないため)。 */
export function pendingPhotoDeleteIds(pinId: string): string[] {
  return Array.from(inFlightDeletes.get(pinId) ?? []);
}

function markDeleteStarted(pinId: string, photoId: string): void {
  const set = inFlightDeletes.get(pinId) ?? new Set<string>();
  set.add(photoId);
  inFlightDeletes.set(pinId, set);
}

function markDeleteSettled(
  pinId: string,
  photoId: string,
  outcome: PhotoMutationOutcome,
): void {
  const set = inFlightDeletes.get(pinId);
  if (set) {
    set.delete(photoId);
    if (set.size === 0) inFlightDeletes.delete(pinId);
  }
  notifyPhotoMutationSettled(pinId, outcome);
}

/** upload / delete の完了 (成功/失敗どちらも) を購読する。戻り値で解除。 */
export function subscribePhotoMutationSettled(
  listener: (pinId: string, outcome: PhotoMutationOutcome) => void,
): () => void {
  mutationSettledListeners.add(listener);
  return () => {
    mutationSettledListeners.delete(listener);
  };
}

export function useFieldSurveyPinPhotoMutations() {
  const [listState, setListState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [uploadState, setUploadState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [deleteState, setDeleteState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });

  const listAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // このインスタンスの識別子 (ライフタイム中不変)。
  const instanceIdRef = useRef(0);
  if (instanceIdRef.current === 0) {
    photoHookInstanceSeq += 1;
    instanceIdRef.current = photoHookInstanceSeq;
  }
  const instanceId = instanceIdRef.current;

  // ⚠unmount で中断してよいのは list(GET) だけ (総点検 2026-07-27)。
  //
  // 旧実装は upload(POST)/delete(DELETE) も unmount で abort していた。
  // 写真セクションは「詳細パネルの × を押した」「編集ボタンを押した
  // (= 写真セクションが !editing 条件で消える)」だけで unmount するため、
  // **送信中に × か編集を押すと、撮ったばかりの写真が黙って消えていた**。
  // 現地で撮った写真は端末にしか無いことがあり、取り返しがつかない。
  //
  // unmount 後の setState 抑止は mountedRef が担っているので、abort は
  // そもそも不要だった。送信済みのリクエストは最後まで走らせ、サーバー側で
  // 保存を完了させる (次にパネルを開いたとき一覧に出る)。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (listAbortRef.current) listAbortRef.current.abort();
    };
  }, []);

  const isAbortError = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError";

  const listPhotos = useCallback(
    async (pinId: string): Promise<PinPhotoMutationResult<PinPhoto[]>> => {
      if (listAbortRef.current) listAbortRef.current.abort();
      const ac = new AbortController();
      listAbortRef.current = ac;
      if (mountedRef.current) setListState({ loading: true, error: null });
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}/photos`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setListState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinPhoto[] }
          | null;
        if (!mountedRef.current) return { ok: false };
        setListState({ loading: false, error: null });
        return { ok: true, data: Array.isArray(body?.data) ? body!.data : [] };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return { ok: false };
        const msg = pinApiErrorMessage(0);
        setListState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const uploadPhoto = useCallback(
    async (
      pinId: string,
      file: File,
    ): Promise<PinPhotoMutationResult<PinPhoto>> => {
      // ⚠先行の upload を abort しない。別の写真を続けて選んだとき、先に
      // 選んだ写真が消えてしまう (どちらもユーザーが送るつもりで選んでいる)。
      //
      // ⚠**unmount で途中 return してはいけない** (@codex #331 R1)。
      // 旧実装は端末内変換 (HEIC→JPEG / 8MB 超の縮小) の直後に unmount チェックで
      // 打ち切っていたため、**変換中に × や編集を押すと POST に到達する前に
      // 捨てられていた**。大きい写真の変換は数秒かかる
      // ので、signal を外しただけでは「fetch まで到達した upload」しか守れない。
      // mountedRef は **setState の抑止だけ**に使い、変換と POST は最後まで走らせる。
      const setUploadStateIfMounted = (next: {
        loading: boolean;
        error: string | null;
      }): void => {
        if (mountedRef.current) setUploadState(next);
      };
      setUploadStateIfMounted({ loading: true, error: null });
      // unmount を跨いでも完了を再マウント側へ伝えられるようにする。
      markUploadStarted(pinId);
      // finally で通知するため、返す結果をここに集約する。
      let outcome: PhotoMutationOutcome = {
        kind: "upload",
        ok: false,
        error: pinApiErrorMessage(0),
        ownerId: instanceId,
      };
      try {
        // 送信前に端末内で自動変換 (HEIC → JPEG / 8MB 超の縮小)。変換できない
        // 端末ではサーバー 422 の代わりに平易な案内 (「互換性優先」設定) を返す。
        // decode 資源 (ImageBitmap / objectURL) は prepare 関数内部の
        // try/finally で必ず解放されてから返るため、unmount 後に走り続けても
        // 資源を保持しない。
        const prepared = await prepareFieldSurveyPhotoForUpload(file);
        if (!prepared.ok) {
          setUploadStateIfMounted({ loading: false, error: prepared.error });
          outcome = { kind: "upload", ok: false, error: prepared.error, ownerId: instanceId };
          return { ok: false, error: prepared.error };
        }
        const formData = new FormData();
        formData.append("file", prepared.file);
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}/photos`,
          {
            method: "POST",
            credentials: "same-origin",
            body: formData,
          },
        );
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setUploadStateIfMounted({ loading: false, error: msg });
          outcome = { kind: "upload", ok: false, error: msg, ownerId: instanceId };
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinPhoto }
          | null;
        setUploadStateIfMounted({ loading: false, error: null });
        outcome = { kind: "upload", ok: true, ownerId: instanceId };
        return { ok: true, data: body?.data };
      } catch {
        const msg = pinApiErrorMessage(0);
        setUploadStateIfMounted({ loading: false, error: msg });
        outcome = { kind: "upload", ok: false, error: msg, ownerId: instanceId };
        return { ok: false, error: msg };
      } finally {
        // 成功・失敗のいずれでも必ず通知する
        // (通知漏れは「送信中」が残り続けて案内が消えないことになる)。
        markUploadSettled(pinId, outcome);
      }
    },
    [instanceId],
  );

  const deletePhoto = useCallback(
    async (
      pinId: string,
      photoId: string,
    ): Promise<PinPhotoMutationResult<null>> => {
      // ⚠先行の delete を abort しない (別写真の削除を巻き添えで止めない)。
      // upload と同じ方針: mountedRef は setState の抑止だけに使う。
      const setDeleteStateIfMounted = (next: {
        loading: boolean;
        error: string | null;
      }): void => {
        if (mountedRef.current) setDeleteState(next);
      };
      setDeleteStateIfMounted({ loading: true, error: null });
      markDeleteStarted(pinId, photoId);
      let outcome: PhotoMutationOutcome = {
        kind: "delete",
        ok: false,
        error: pinApiErrorMessage(0),
        ownerId: instanceId,
      };
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}/photos/${encodeURIComponent(photoId)}`,
          { method: "DELETE", credentials: "same-origin" },
        );
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setDeleteStateIfMounted({ loading: false, error: msg });
          outcome = { kind: "delete", ok: false, error: msg, ownerId: instanceId };
          return { ok: false, error: msg };
        }
        setDeleteStateIfMounted({ loading: false, error: null });
        outcome = { kind: "delete", ok: true, ownerId: instanceId };
        return { ok: true };
      } catch {
        const msg = pinApiErrorMessage(0);
        setDeleteStateIfMounted({ loading: false, error: msg });
        outcome = { kind: "delete", ok: false, error: msg, ownerId: instanceId };
        return { ok: false, error: msg };
      } finally {
        // 削除も完了を通知する。通知が無いと、閉じてすぐ開き直したときに
        // **削除済みの写真が一覧に残り**、もう一度消そうとして 404 になる。
        markDeleteSettled(pinId, photoId, outcome);
      }
    },
    [instanceId],
  );

  return {
    instanceId,
    listPhotos,
    uploadPhoto,
    deletePhoto,
    listLoading: listState.loading,
    listError: listState.error,
    uploadLoading: uploadState.loading,
    uploadError: uploadState.error,
    deleteLoading: deleteState.loading,
    deleteError: deleteState.error,
  };
}
