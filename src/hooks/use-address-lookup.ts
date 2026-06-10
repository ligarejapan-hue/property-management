"use client";

/**
 * 住所補完 hook（PR2・UI core）。
 *
 *  - lookupByPostalCode(zip): 郵便番号 → 住所候補。明示操作（ボタン）想定で debounce なし。
 *    保留中の住所検索 debounce は取り消す（Codex P2-B＝明示操作の結果を後発の住所検索で
 *    上書きさせない）。
 *  - searchByAddress(address): 住所 → 郵便番号付き候補。入力途中で叩くため debounce 300ms。
 *    スケジュール時点で旧リクエストを無効化する（Codex P2-1＝debounce 窓内の stale 応答対策）。
 *  - loading / error / candidates / reset を公開。
 *
 * 取得は api-client の wrapper（fetchAddressByPostalCode / fetchAddressCandidates）経由＝
 * 社内 route だけを叩き、APIキー(secret)・外部 provider には一切触れない。
 * seq stale ガード・debounce・cancel の実行順序は createAddressLookupController（utils）に
 * 集約して node 環境で実挙動テストし、hook は React への結線（reducer / ref / cleanup）のみ担う。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  fetchAddressByPostalCode,
  fetchAddressCandidates,
} from "@/lib/api-client";
import {
  addressLookupReducer,
  initialLookupState,
  createAddressLookupController,
  type AddressLookupController,
} from "@/lib/address-lookup-ui-utils";

const SEARCH_DEBOUNCE_MS = 300;

export function useAddressLookup() {
  const [state, dispatch] = useReducer(addressLookupReducer, initialLookupState);

  // controller の生成は render 中ではなく mount 時の effect で行う（refs ルール遵守）。
  const controllerRef = useRef<AddressLookupController | null>(null);

  // unmount では dispose＝保留 debounce を cancel し、in-flight の遅延応答を捨てる。
  useEffect(() => {
    const controller = createAddressLookupController(
      {
        fetchByPostalCode: fetchAddressByPostalCode,
        fetchByAddress: fetchAddressCandidates,
        onAction: dispatch,
      },
      SEARCH_DEBOUNCE_MS,
    );
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // 郵便番号 → 住所候補（明示操作・debounce なし）。保留中の住所検索は controller が破棄。
  const lookupByPostalCode = useCallback((zip: string) => {
    controllerRef.current?.lookupByPostalCode(zip);
  }, []);

  // 住所 → 郵便番号付き候補（debounce 300ms・スケジュール時点で旧リクエスト無効化）。
  const searchByAddress = useCallback((address: string) => {
    controllerRef.current?.searchByAddress(address);
  }, []);

  // 明示リセット: in-flight 無効化＋保留 debounce 取り消し＋状態初期化。
  const reset = useCallback(() => {
    controllerRef.current?.reset();
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
