"use client";

/**
 * 現地調査マップ Phase 1-H: 調査ピン写真の list / upload / delete mutation hook。
 *
 * - 既存 API (`/api/field-survey/pins/[id]/photos` GET/POST、
 *   `/api/field-survey/pins/[id]/photos/[photoId]` DELETE) を呼ぶ。
 * - upload は multipart/form-data (Content-Type は fetch が自動付与)。
 * - AbortController + mountedRef で stale request 中断 / unmount 後 setState 抑止。
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
  const uploadAbortRef = useRef<AbortController | null>(null);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (listAbortRef.current) listAbortRef.current.abort();
      if (uploadAbortRef.current) uploadAbortRef.current.abort();
      if (deleteAbortRef.current) deleteAbortRef.current.abort();
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
      if (uploadAbortRef.current) uploadAbortRef.current.abort();
      const ac = new AbortController();
      uploadAbortRef.current = ac;
      if (mountedRef.current) setUploadState({ loading: true, error: null });
      try {
        // 送信前に端末内で自動変換 (HEIC → JPEG / 8MB 超の縮小)。変換できない
        // 端末ではサーバー 422 の代わりに平易な案内 (「互換性優先」設定) を返す。
        // decode 資源 (ImageBitmap / objectURL) は prepare 関数内部の
        // try/finally で必ず解放されてから返るため、直後の unmount early
        // return が資源を保持することはない。
        const prepared = await prepareFieldSurveyPhotoForUpload(file);
        if (!mountedRef.current) return { ok: false };
        if (!prepared.ok) {
          setUploadState({ loading: false, error: prepared.error });
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
            signal: ac.signal,
          },
        );
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setUploadState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinPhoto }
          | null;
        if (!mountedRef.current) return { ok: false };
        setUploadState({ loading: false, error: null });
        return { ok: true, data: body?.data };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return { ok: false };
        const msg = pinApiErrorMessage(0);
        setUploadState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const deletePhoto = useCallback(
    async (
      pinId: string,
      photoId: string,
    ): Promise<PinPhotoMutationResult<null>> => {
      if (deleteAbortRef.current) deleteAbortRef.current.abort();
      const ac = new AbortController();
      deleteAbortRef.current = ac;
      if (mountedRef.current) setDeleteState({ loading: true, error: null });
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}/photos/${encodeURIComponent(photoId)}`,
          { method: "DELETE", credentials: "same-origin", signal: ac.signal },
        );
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setDeleteState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        if (!mountedRef.current) return { ok: false };
        setDeleteState({ loading: false, error: null });
        return { ok: true };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return { ok: false };
        const msg = pinApiErrorMessage(0);
        setDeleteState({ loading: false, error: msg });
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
