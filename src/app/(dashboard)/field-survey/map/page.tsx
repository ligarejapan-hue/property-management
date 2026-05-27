"use client";

import FieldSurveyMap from "@/components/field-survey/field-survey-map";
import {
  isGoogleMapsBillingAcknowledged,
  isGoogleMapsKeyConfigured,
  isGoogleMapsMapIdConfigured,
} from "@/lib/field-survey-map-util";

// Phase 1-E: 現地調査マップの画面骨格。
// - Google Maps の表示と既存 Property / Pin の marker 表示まで。
// - 巡回開始/終了, navigator.geolocation, TrackPoint 送信, Pin 作成・編集は
//   別 PR で実装する (本ページではプレースホルダ UI のみ)。
// - APIキー未設定でも画面はクラッシュさせず案内を表示する。
// - APIキー設定済でも、Cloud Billing / quota / referrer / API 制限 /
//   管理者承認が未確認なら警告バナーを常時表示する (本番事故防止)。
// - Map ID 未設定では AdvancedMarker が render されない壊れた UI になるため、
//   billing 承認後でも MAP_ID 必須で gating する (Codex 指摘 / Phase 1-E)。

export default function FieldSurveyMapPage() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
  const billingAckFlag =
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED;
  const hasKey = isGoogleMapsKeyConfigured(apiKey);
  const billingAcknowledged = isGoogleMapsBillingAcknowledged(billingAckFlag);
  const hasMapId = isGoogleMapsMapIdConfigured(mapId);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-800">
            現地調査マップ
          </h1>
          <p className="text-xs text-gray-500">
            既存物件と調査ピンを地図上で確認します。
            巡回開始 / 終了は次フェーズで実装予定。
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {!hasKey ? (
          <MissingKeyNotice />
        ) : !billingAcknowledged ? (
          // Codex P1: APIキーが入っていても billing 未確認なら
          // FieldSurveyMap (= Maps JavaScript API loader) を mount しない。
          // 警告 banner だけだと地図が読み込まれて課金経路に乗ってしまうため、
          // 「地図そのものを描画しない」fallback に切り替える。
          <BillingNotAcknowledgedFallback />
        ) : !hasMapId ? (
          // Codex (Phase 1-E 追加): MAP_ID 未設定で AdvancedMarker を render
          // すると marker が一切出ない壊れた地図 UI になる。billing 承認後でも
          // MAP_ID 未設定なら Maps JavaScript API を読み込まず fallback に切替。
          <MissingMapIdFallback />
        ) : (
          <FieldSurveyMap apiKey={apiKey as string} mapId={mapId as string} />
        )}
      </div>
    </div>
  );
}

function MissingMapIdFallback() {
  // APIキー + billing 承認は揃っているが、AdvancedMarker 描画に必須の
  // Map ID が未設定。Maps JavaScript API を起動しないことで「marker が
  // 出ない壊れた地図」を出さない。固定料金はここに書かない。
  return (
    <div
      role="alert"
      data-testid="gmaps-mapid-fallback"
      className="flex h-full items-center justify-center bg-gray-50 p-6"
    >
      <div className="max-w-2xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        <h2 className="mb-2 text-base font-semibold">
          地図の Map ID が未設定です
        </h2>
        <p className="mb-2">
          Google Maps APIキーと本番運用前チェックは完了していますが、
          AdvancedMarker (marker 描画) に必須の Map ID が未設定のため、
          地図の読み込みを行いません。
        </p>
        <p className="mb-2 text-xs">
          Google Cloud Console の「Map Management」で Map ID を作成し、{" "}
          <code className="rounded bg-white px-1">
            NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
          </code>{" "}
          に設定して build / restart してください。
        </p>
        <p className="text-xs text-amber-800">
          Map ID 未設定で地図を描画すると、マーカーが一切表示されない
          壊れた UI になります。
        </p>
      </div>
    </div>
  );
}

function BillingNotAcknowledgedFallback() {
  // APIキーが入っているが、Cloud Billing / quota / referrer / API 制限 /
  // 管理者承認 の確認が完了していない状態。Maps JavaScript API の
  // loader を起動しないことで Google 側課金リクエスト自体を防ぐ。
  // 料金の固定数値はここに書かない (公式料金ページを参照)。
  return (
    <div
      role="alert"
      data-testid="gmaps-billing-fallback"
      className="flex h-full items-center justify-center bg-gray-50 p-6"
    >
      <div className="max-w-2xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        <h2 className="mb-2 text-base font-semibold">
          地図の読み込みを停止しています
        </h2>
        <p className="mb-2">
          Google Maps APIキーは設定されていますが、本番運用前チェックが
          未完了のため、Maps JavaScript API の読み込みを行いません。
        </p>
        <ul className="mb-3 ml-4 list-disc space-y-1 text-xs">
          <li>Cloud Billing budget / alert</li>
          <li>quota / usage cap (Maps JavaScript API)</li>
          <li>HTTP referrer 制限</li>
          <li>API 制限を Maps JavaScript API のみに限定</li>
          <li>管理者による本番利用承認</li>
        </ul>
        <p className="mb-2 text-xs">
          上記を全て確認した上で{" "}
          <code className="rounded bg-white px-1">
            NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED=true
          </code>{" "}
          を設定し、build / restart してください。
        </p>
        <p className="text-xs text-amber-800">
          Budget alert は通知のみで課金を停止しません。
          実際に上限で止めるには quota 制限が別途必要です。
        </p>
      </div>
    </div>
  );
}

function MissingKeyNotice() {
  return (
    <div
      role="alert"
      className="flex h-full items-center justify-center bg-gray-50 p-6"
    >
      <div className="max-w-xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        <h2 className="mb-2 text-base font-semibold">
          Google Maps APIキーが未設定です
        </h2>
        <p className="mb-2">
          現地調査マップを表示するには、環境変数{" "}
          <code className="rounded bg-white px-1">
            NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
          </code>{" "}
          を設定してください。
        </p>
        <p className="text-xs text-amber-800">
          APIキーは client 側に出るため、Google Cloud Console で必ず HTTP
          referrer 制限と API 制限 (Maps JavaScript API のみ) を設定してください。
        </p>
      </div>
    </div>
  );
}
