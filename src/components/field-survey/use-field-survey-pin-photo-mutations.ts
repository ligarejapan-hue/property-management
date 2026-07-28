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
 */
const inFlightUploads = new Map<string, number>();
const uploadSettledListeners = new Set<(pinId: string) => void>();

function markUploadStarted(pinId: string): void {
  inFlightUploads.set(pinId, (inFlightUploads.get(pinId) ?? 0) + 1);
}

function markUploadSettled(pinId: string): void {
  const next = (inFlightUploads.get(pinId) ?? 1) - 1;
  if (next <= 0) inFlightUploads.delete(pinId);
  else inFlightUploads.set(pinId, next);
  for (const listener of uploadSettledListeners) listener(pinId);
}

/** その pin に送信中の写真があるか (再マウント直後の案内表示用)。 */
export function hasInFlightPhotoUpload(pinId: string): boolean {
  return (inFlightUploads.get(pinId) ?? 0) > 0;
}

/** upload の完了 (成功/失敗どちらも) を購読する。戻り値で解除。 */
export function subscribePhotoUploadSettled(
  listener: (pinId: string) => void,
): () => void {
  uploadSettledListeners.add(listener);
  return () => {
    uploadSettledListeners.delete(listener);
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
      try {
        // 送信前に端末内で自動変換 (HEIC → JPEG / 8MB 超の縮小)。変換できない
        // 端末ではサーバー 422 の代わりに平易な案内 (「互換性優先」設定) を返す。
        // decode 資源 (ImageBitmap / objectURL) は prepare 関数内部の
        // try/finally で必ず解放されてから返るため、unmount 後に走り続けても
        // 資源を保持しない。
        const prepared = await prepareFieldSurveyPhotoForUpload(file);
        if (!prepared.ok) {
          setUploadStateIfMounted({ loading: false, error: prepared.error });
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
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinPhoto }
          | null;
        setUploadStateIfMounted({ loading: false, error: null });
        return { ok: true, data: body?.data };
      } catch {
        const msg = pinApiErrorMessage(0);
        setUploadStateIfMounted({ loading: false, error: msg });
        return { ok: false, error: msg };
      } finally {
        // 成功・失敗・early return のいずれでも必ず通知する
        // (通知漏れは「送信中」が残り続けて案内が消えないことになる)。
        markUploadSettled(pinId);
      }
    },
    [],
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
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}/photos/${encodeURIComponent(photoId)}`,
          { method: "DELETE", credentials: "same-origin" },
        );
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setDeleteStateIfMounted({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        setDeleteStateIfMounted({ loading: false, error: null });
        return { ok: true };
      } catch {
        const msg = pinApiErrorMessage(0);
        setDeleteStateIfMounted({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  return {
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
