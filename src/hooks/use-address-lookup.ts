"use client";

/**
 * 住所補完 hook（PR2・UI core）。
 *
 *  - lookupByPostalCode(zip): 郵便番号 → 住所候補。明示操作（ボタン）想定で debounce なし。
 *  - searchByAddress(address): 住所 → 郵便番号付き候補。入力途中で叩くため debounce 300ms。
 *  - loading / error / candidates / reset を公開。
 *
 * 取得は api-client の wrapper（fetchAddressByPostalCode / fetchAddressCandidates）経由＝
 * 社内 route だけを叩き、APIキー(secret)・外部 provider には一切触れない。
 * 後から解決した古いリクエストが新しい状態を上書きしないよう seq でガードする（stale 対策）。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  fetchAddressByPostalCode,
  fetchAddressCandidates,
} from "@/lib/api-client";
import { debounce, type DebouncedFunction } from "@/lib/debounce";
import type { AddressLookupCandidate } from "@/lib/address-lookup/types";
import {
  addressLookupReducer,
  initialLookupState,
  classifyAddressLookupError,
  isLatestRequest,
} from "@/lib/address-lookup-ui-utils";

const SEARCH_DEBOUNCE_MS = 300;

type Fetcher = () => Promise<{ candidates: AddressLookupCandidate[] }>;

export function useAddressLookup() {
  const [state, dispatch] = useReducer(addressLookupReducer, initialLookupState);

  // 発行 seq。解決時に最新でなければ結果を破棄する（古い検索/取得が
  // 新しいクエリの状態を上書きしないため・owner-link-modal と同じ考え方）。
  const seqRef = useRef(0);
  const debouncedSearchRef = useRef<DebouncedFunction<[string]> | null>(null);

  const run = useCallback(async (fetcher: Fetcher) => {
    seqRef.current += 1;
    const seq = seqRef.current;
    dispatch({ type: "request" });
    try {
      const res = await fetcher();
      if (!isLatestRequest(seq, seqRef.current)) return; // stale → 破棄
      dispatch({ type: "success", candidates: res.candidates ?? [] });
    } catch (err) {
      if (!isLatestRequest(seq, seqRef.current)) return; // stale → 破棄
      dispatch({ type: "failure", error: classifyAddressLookupError(err) });
    }
  }, []);

  // 郵便番号 → 住所候補（明示操作・debounce なし）。
  const lookupByPostalCode = useCallback(
    (zip: string) => {
      void run(() => fetchAddressByPostalCode(zip));
    },
    [run],
  );

  // 住所 → 郵便番号付き候補（入力途中で叩くため debounce 300ms）。
  // ref への生成は render 中ではなく mount 時の effect で行う（refs ルール遵守）。
  // unmount で保留 debounce を cancel し、seq を進めて遅延結果を捨てる。
  useEffect(() => {
    const debounced = debounce((address: string) => {
      void run(() => fetchAddressCandidates(address));
    }, SEARCH_DEBOUNCE_MS);
    debouncedSearchRef.current = debounced;
    return () => {
      debounced.cancel();
      debouncedSearchRef.current = null;
      seqRef.current += 1;
    };
  }, [run]);

  const searchByAddress = useCallback((address: string) => {
    debouncedSearchRef.current?.(address);
  }, []);

  // 明示リセット: seq を進めて in-flight を無効化＋保留 debounce を取り消し＋状態初期化。
  const reset = useCallback(() => {
    seqRef.current += 1;
    debouncedSearchRef.current?.cancel();
    dispatch({ type: "reset" });
  }, []);

  return {
    loading: state.loading,
    error: state.error,
    candidates: state.candidates,
    lookupByPostalCode,
    searchByAddress,
    reset,
  };
}

export type UseAddressLookupReturn = ReturnType<typeof useAddressLookup>;
