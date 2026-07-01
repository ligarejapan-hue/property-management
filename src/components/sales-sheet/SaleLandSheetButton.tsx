"use client";

// 後方互換の薄いラッパー。実体は種別汎用の SalesSheetCreateButton に統合済み。
// 売土地専用の呼び出し箇所・既存テスト向けに kind="land" 固定で公開する。
import { SalesSheetCreateButton } from "./SalesSheetCreateButton";

export { buildCreateRequest } from "./SalesSheetCreateButton";

export function SaleLandSheetButton(props: { propertyId: string; canWrite: boolean }) {
  return <SalesSheetCreateButton {...props} kind="land" />;
}
