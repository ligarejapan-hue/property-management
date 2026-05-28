"use client";

/**
 * 現地調査マップ Phase 1-G: Pin 作成 / 詳細取得 / 更新 mutation hook。
 *
 * - 既存 API (`/api/field-survey/pins` POST、`/api/field-survey/pins/[id]` GET/PATCH)
 *   をそのまま呼ぶ。新規 API は追加しない。
 * - AbortController + mountedRef で stale request 中断 / unmount 後 setState 抑止。
 * - lat / lng / accuracy / memo / API key / env / raw response 全文を console や
 *   error UI に出さない。エラーは status から汎用文言にマップ (`pinApiErrorMessage`)。
 * - localStorage / sessionStorage / IndexedDB は使わない。
 * - 監査ログ系 API を UI から直接書かない (server 側で必要な分のみ書かれる)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  pinApiErrorMessage,
  type PinPatchBody,
} from "@/lib/field-survey-pin-util";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export interface PinDetail {
  id: string;
  sessionId: string | null;
  staffUserId: string;
  propertyId: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  pinType: string;
  status: string;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePinInput {
  lat: number;
  lng: number;
  accuracy?: number;
  pinType: string;
  memo?: string | null;
  sessionId?: string;
  // Phase 1-G では propertyId は送らない (Plan 承認)。
}

export interface PinMutationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function useFieldSurveyPinMutations() {
  const [createState, setCreateState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [updateState, setUpdateState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [detailState, setDetailState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [deleteState, setDeleteState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });

  const createAbortRef = useRef<AbortController | null>(null);
  const updateAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (createAbortRef.current) createAbortRef.current.abort();
      if (updateAbortRef.current) updateAbortRef.current.abort();
      if (detailAbortRef.current) detailAbortRef.current.abort();
      if (deleteAbortRef.current) deleteAbortRef.current.abort();
    };
  }, []);

  const isAbortError = (err: unknown): boolean =>
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError";

  const createPin = useCallback(
    async (input: CreatePinInput): Promise<PinMutationResult<PinDetail>> => {
      if (createAbortRef.current) createAbortRef.current.abort();
      const ac = new AbortController();
      createAbortRef.current = ac;
      if (mountedRef.current) setCreateState({ loading: true, error: null });
      try {
        const res = await fetch("/api/field-survey/pins", {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(buildCreateBody(input)),
          signal: ac.signal,
        });
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setCreateState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinDetail }
          | null;
        if (!mountedRef.current) return { ok: false };
        setCreateState({ loading: false, error: null });
        return { ok: true, data: body?.data };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) {
          return { ok: false };
        }
        const msg = pinApiErrorMessage(0);
        setCreateState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const fetchPinDetail = useCallback(
    async (pinId: string): Promise<PinMutationResult<PinDetail>> => {
      if (detailAbortRef.current) detailAbortRef.current.abort();
      const ac = new AbortController();
      detailAbortRef.current = ac;
      if (mountedRef.current) setDetailState({ loading: true, error: null });
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}`,
          { credentials: "same-origin", signal: ac.signal },
        );
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setDetailState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinDetail }
          | null;
        if (!mountedRef.current) return { ok: false };
        setDetailState({ loading: false, error: null });
        return { ok: true, data: body?.data };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) {
          return { ok: false };
        }
        const msg = pinApiErrorMessage(0);
        setDetailState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const updatePin = useCallback(
    async (
      pinId: string,
      patch: PinPatchBody,
    ): Promise<PinMutationResult<PinDetail>> => {
      // 空 patch は呼び出し側で buildPinPatch === null で抑止される前提。
      // 二重防衛として keys 0 件なら 422 を打たず即 ok を返す。
      if (Object.keys(patch).length === 0) {
        return { ok: true };
      }
      if (updateAbortRef.current) updateAbortRef.current.abort();
      const ac = new AbortController();
      updateAbortRef.current = ac;
      if (mountedRef.current) setUpdateState({ loading: true, error: null });
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: JSON_HEADERS,
            body: JSON.stringify(patch),
            signal: ac.signal,
          },
        );
        if (!mountedRef.current) return { ok: false };
        if (!res.ok) {
          const msg = pinApiErrorMessage(res.status);
          setUpdateState({ loading: false, error: msg });
          return { ok: false, error: msg };
        }
        const body = (await res.json().catch(() => null)) as
          | { data?: PinDetail }
          | null;
        if (!mountedRef.current) return { ok: false };
        setUpdateState({ loading: false, error: null });
        return { ok: true, data: body?.data };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) {
          return { ok: false };
        }
        const msg = pinApiErrorMessage(0);
        setUpdateState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  // Phase 1-I: 論理削除 (status=archived)。DELETE /api/field-survey/pins/[id]。
  // 成功レスポンスに座標 / memo / 写真 / PII は含まれない (id / status のみ)。
  const deletePin = useCallback(
    async (pinId: string): Promise<PinMutationResult<{ id: string }>> => {
      if (deleteAbortRef.current) deleteAbortRef.current.abort();
      const ac = new AbortController();
      deleteAbortRef.current = ac;
      if (mountedRef.current) setDeleteState({ loading: true, error: null });
      try {
        const res = await fetch(
          `/api/field-survey/pins/${encodeURIComponent(pinId)}`,
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
        return { ok: true, data: { id: pinId } };
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) {
          return { ok: false };
        }
        const msg = pinApiErrorMessage(0);
        setDeleteState({ loading: false, error: msg });
        return { ok: false, error: msg };
      }
    },
    [],
  );

  return {
    createPin,
    fetchPinDetail,
    updatePin,
    deletePin,
    createLoading: createState.loading,
    createError: createState.error,
    updateLoading: updateState.loading,
    updateError: updateState.error,
    detailLoading: detailState.loading,
    detailError: detailState.error,
    deleteLoading: deleteState.loading,
    deleteError: deleteState.error,
  };
}

function buildCreateBody(input: CreatePinInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    lat: input.lat,
    lng: input.lng,
    pinType: input.pinType,
  };
  if (typeof input.accuracy === "number" && Number.isFinite(input.accuracy)) {
    body.accuracy = input.accuracy;
  }
  if (input.memo !== undefined && input.memo !== null && input.memo !== "") {
    body.memo = input.memo;
  }
  if (input.sessionId) {
    body.sessionId = input.sessionId;
  }
  // Phase 1-G では物件 ID 連携を行わない (Plan 承認)。
  return body;
}
