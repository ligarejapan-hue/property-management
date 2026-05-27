"use client";

import FieldSurveyMap from "@/components/field-survey/field-survey-map";
import { isGoogleMapsKeyConfigured } from "@/lib/field-survey-map-util";

// Phase 1-E: 現地調査マップの画面骨格。
// - Google Maps の表示と既存 Property / Pin の marker 表示まで。
// - 巡回開始/終了, navigator.geolocation, TrackPoint 送信, Pin 作成・編集は
//   別 PR で実装する (本ページではプレースホルダ UI のみ)。
// - APIキー未設定でも画面はクラッシュさせず案内を表示する。

export default function FieldSurveyMapPage() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
  const hasKey = isGoogleMapsKeyConfigured(apiKey);

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
        {hasKey ? (
          <FieldSurveyMap apiKey={apiKey as string} mapId={mapId} />
        ) : (
          <MissingKeyNotice />
        )}
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
