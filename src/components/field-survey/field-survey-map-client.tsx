"use client";

import { useSearchParams } from "next/navigation";
import FieldSurveyMap from "@/components/field-survey/field-survey-map";
import FieldSurveyHistoryMap from "@/components/field-survey/field-survey-history-map";
import {
  isGoogleMapsBillingAcknowledged,
  isGoogleMapsKeyConfigured,
  isGoogleMapsMapIdConfigured,
} from "@/lib/field-survey-map-util";

// Phase 1-E: 現地調査マップの client 側 gating + Google Maps mount。
// 呼び出し元 (server component page.tsx) で field_survey:read 権限の gate を
// 通った場合のみ render される。この component に到達した時点で「閲覧権限あり」が
// 保証されている前提で、env (APIキー / billing / MAP_ID) ベースの 3 段 gating を
// 行い、すべて揃った時のみ FieldSurveyMap (= Maps JS API loader) を mount する。

export default function FieldSurveyMapClient({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
  const billingAckFlag =
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED;
  const hasKey = isGoogleMapsKeyConfigured(apiKey);
  const billingAcknowledged = isGoogleMapsBillingAcknowledged(billingAckFlag);
  const hasMapId = isGoogleMapsMapIdConfigured(mapId);

  // Phase 1-J: ?sessionId=xxx があれば過去ルートの履歴閲覧モード (完全 read-only)。
  const searchParams = useSearchParams();
  const rawSessionId = searchParams?.get("sessionId") ?? null;
  const historySessionId = isValidUuid(rawSessionId) ? rawSessionId : null;

  if (!hasKey) return <MissingKeyNotice />;
  // Codex P1: APIキーが入っていても billing 未確認なら Maps JS API loader を
  // 起動しない fallback に切り替える。
  if (!billingAcknowledged) return <BillingNotAcknowledgedFallback />;
  // Codex (Phase 1-E 追加): MAP_ID 未設定では AdvancedMarker が出ない壊れた
  // 地図 UI になるため、Maps JS API を読み込まず fallback に切り替える。
  if (!hasMapId) return <MissingMapIdFallback />;
  // 履歴閲覧モードは完全 read-only の専用コンポーネントへ分岐する。
  // (通常マップの記録 / pin 作成・編集経路を一切 mount しない)。
  if (historySessionId) {
    return (
      <FieldSurveyHistoryMap
        apiKey={apiKey as string}
        mapId={mapId as string}
        currentUserId={currentUserId}
        sessionId={historySessionId}
      />
    );
  }
  return (
    <FieldSurveyMap
      apiKey={apiKey as string}
      mapId={mapId as string}
      currentUserId={currentUserId}
    />
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(v: string | null): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function MissingMapIdFallback() {
  // APIキー + billing 承認は揃っているが、AdvancedMarker 描画に必須の
  // Map ID が未設定。Maps JavaScript API を起動しないことで「marker が
  // 出ない壊れた地図」を出さない。固定料金はここに書かない。
  return (
    <div
      role="alert"
      data-testid="gmaps-mapid-fallback"
      className="flex h-full items-center justify-center bg-gray-50 p-6 dark:bg-gray-800/50"
    >
      <div className="max-w-2xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
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
          <code className="rounded bg-white px-1 dark:bg-gray-800">
            NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
          </code>{" "}
          に設定して build / restart してください。
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-400">
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
      className="flex h-full items-center justify-center bg-gray-50 p-6 dark:bg-gray-800/50"
    >
      <div className="max-w-2xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
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
          <code className="rounded bg-white px-1 dark:bg-gray-800">
            NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED=true
          </code>{" "}
          を設定し、build / restart してください。
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-400">
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
      className="flex h-full items-center justify-center bg-gray-50 p-6 dark:bg-gray-800/50"
    >
      <div className="max-w-xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
        <h2 className="mb-2 text-base font-semibold">
          Google Maps APIキーが未設定です
        </h2>
        <p className="mb-2">
          現地調査マップを表示するには、環境変数{" "}
          <code className="rounded bg-white px-1 dark:bg-gray-800">
            NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
          </code>{" "}
          を設定してください。
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-400">
          APIキーは client 側に出るため、Google Cloud Console で必ず HTTP
          referrer 制限と API 制限 (Maps JavaScript API のみ) を設定してください。
        </p>
      </div>
    </div>
  );
}
