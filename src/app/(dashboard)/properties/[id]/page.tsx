"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Building2,
  Edit,
  RefreshCw,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import CommentTab from "@/components/properties/comment-tab";
import NextActionTab from "@/components/properties/next-action-tab";
import AttachmentTab from "@/components/properties/attachment-tab";
import HistoryTab from "@/components/properties/history-tab";
import PhotoTab from "@/components/properties/photo-tab";
import CandidateList from "@/components/properties/candidate-list";
import ActionBar from "@/components/properties/action-bar";
import PropertyEditForm from "@/components/properties/property-edit-form";
import {
  fetchPropertyDetail,
  fetchInvestigationData,
  triggerInvestigation,
  confirmInvestigation,
} from "@/lib/api-client";

// ---------- Label maps ----------

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  land: "土地",
  building: "建物",
  unit: "区分",
  unknown: "不明",
};

const REGISTRY_STATUS_LABELS: Record<string, string> = {
  unconfirmed: "未取得",
  scheduled: "取得中",
  obtained: "取得済",
};

const DM_STATUS_LABELS: Record<string, string> = {
  send: "送付可",
  hold: "未判断",
  no_send: "送付不可",
};

const CASE_STATUS_LABELS: Record<string, string> = {
  new_case: "新規",
  site_checked: "現地確認済",
  waiting_registry: "登記待ち",
  dm_target: "DM対象",
  dm_sent: "DM送付済",
  hold: "保留",
  done: "完了",
};

const registryBadgeStyles: Record<string, string> = {
  obtained: "bg-green-100 text-green-800",
  unconfirmed: "bg-red-100 text-red-800",
  scheduled: "bg-yellow-100 text-yellow-800",
};

const dmBadgeStyles: Record<string, string> = {
  send: "bg-green-100 text-green-800",
  no_send: "bg-red-100 text-red-800",
  hold: "bg-gray-100 text-gray-600",
};

// ---------- Tabs ----------

const tabs = [
  { key: "basic", label: "基本情報" },
  { key: "photos", label: "写真" },
  { key: "owner", label: "所有者" },
  { key: "investigation", label: "調査情報" },
  { key: "actions", label: "ネクストアクション" },
  { key: "comments", label: "コメント" },
  { key: "attachments", label: "添付ファイル" },
  { key: "history", label: "変更履歴" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

// ---------- Types ----------

interface ApiOwner {
  id: string;
  name: string | null;
  nameKana: string | null;
  phone: string | null;
  zip: string | null;
  address: string | null;
  note: string | null;
}

interface ApiPropertyOwner {
  id: string;
  propertyId: string;
  ownerId: string;
  relationship: string | null;
  isPrimary: boolean;
  owner: ApiOwner;
}

interface ApiPhoto {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number;
}

interface ApiNextAction {
  id: string;
  title: string;
  scheduledAt: string;
  isCompleted: boolean;
  assignee: { id: string; name: string } | null;
}

interface ApiProperty {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
  registryStatus: string;
  dmStatus: string;
  caseStatus: string;
  isArchived: boolean;
  note: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  heightDistrict: string | null;
  firePreventionZone: string | null;
  scenicRestriction: string | null;
  roadType: string | null;
  roadWidth: number | null;
  frontageWidth: number | null;
  frontageDirection: string | null;
  setbackRequired: string | null;
  rosenkaValue: number | null;
  rosenkaYear: number | null;
  rebuildPermission: string | null;
  architectureNote: string | null;
  investigationConfirmedAt: string | null;
  // Unit-specific fields
  buildingId: string | null;
  building: { id: string; name: string } | null;
  roomNo: string | null;
  floorNo: number | null;
  exclusiveArea: number | null;
  balconyArea: number | null;
  layoutType: string | null;
  orientation: string | null;
  managementFee: number | null;
  repairReserveFee: number | null;
  occupancyStatus: string | null;
  ownershipShareNote: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  assignedTo: string | null;
  assignee: { id: string; name: string } | null;
  creator: { id: string; name: string } | null;
  propertyOwners: ApiPropertyOwner[];
  photos: ApiPhoto[];
  nextActions: ApiNextAction[];
}

// ---------- Component ----------

export default function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [activeTab, setActiveTab] = useState<TabKey>("basic");
  const [property, setProperty] = useState<ApiProperty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);

  const fetchProperty = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPropertyDetail(id);
      setProperty(data as unknown as ApiProperty);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "データ取得に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchProperty();
  }, [fetchProperty]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">読み込み中...</span>
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm text-red-700">
          {error ?? "物件が見つかりません"}
        </p>
        <Link
          href="/properties"
          className="mt-3 inline-block text-sm text-blue-600 hover:underline"
        >
          物件一覧に戻る
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/properties"
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="h-4 w-4" />
            物件一覧
          </Link>
          <span className="text-gray-300">/</span>
          <h2 className="text-xl font-bold text-gray-800">
            {property.address}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
            title="調査情報を取得（準備中）"
          >
            <RefreshCw className="h-4 w-4" />
            調査情報取得
          </button>
          <button
            onClick={() => setShowEditForm(true)}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Edit className="h-4 w-4" />
            編集
          </button>
        </div>
      </div>

      {/* Action bar */}
      <ActionBar
        propertyId={property.id}
        registryStatus={property.registryStatus}
        dmStatus={property.dmStatus}
        caseStatus={property.caseStatus}
        investigationConfirmedAt={property.investigationConfirmedAt}
        onActionComplete={fetchProperty}
      />

      {/* Warning badge */}
      {!property.investigationConfirmedAt && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="text-sm text-amber-800">
            調査情報が未確認です。最新の情報を取得してください。
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 border-b border-gray-200">
        <nav className="-mb-px flex gap-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
              }`}
            >
              {tab.label}
              {tab.key === "owner" && property.propertyOwners.length > 0 && (
                <span className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
                  {property.propertyOwners.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        {activeTab === "basic" && <BasicTab property={property} />}
        {activeTab === "owner" && (
          <OwnerTab owners={property.propertyOwners} />
        )}
        {activeTab === "photos" && <PhotoTab propertyId={property.id} />}
        {activeTab === "investigation" && (
          <InvestigationTab
            property={property}
            onConfirmed={fetchProperty}
          />
        )}
        {activeTab === "actions" && (
          <NextActionTab propertyId={property.id} />
        )}
        {activeTab === "comments" && (
          <CommentTab propertyId={property.id} />
        )}
        {activeTab === "attachments" && (
          <AttachmentTab propertyId={property.id} />
        )}
        {activeTab === "history" && (
          <HistoryTab propertyId={property.id} />
        )}
      </div>

      {/* Edit form modal */}
      {showEditForm && (
        <PropertyEditForm
          property={property}
          onClose={() => setShowEditForm(false)}
          onSaved={() => {
            setShowEditForm(false);
            fetchProperty();
          }}
        />
      )}
    </div>
  );
}

// ---------- Basic info tab ----------

function BasicTab({ property }: { property: ApiProperty }) {
  const isUnit = property.propertyType === "unit";
  const OCCUPANCY_LABELS: Record<string, string> = {
    vacant: "空室",
    occupied: "入居中",
    unknown: "不明",
  };

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <Field label="物件ID" value={property.id} mono />
      <Field
        label="種別"
        value={PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType}
      />

      {/* Building link for units */}
      {isUnit && property.building && (
        <div className="md:col-span-2">
          <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
            所属マンション
          </dt>
          <dd>
            <Link
              href={`/buildings/${property.building.id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors"
            >
              <Building2 className="h-4 w-4" />
              {property.building.name}
            </Link>
          </dd>
        </div>
      )}

      <Field label="住所" value={property.address} />
      <Field label="地番" value={property.lotNumber} />
      <Field label="家屋番号" value={property.buildingNumber} />
      <Field label="不動産番号" value={property.realEstateNumber} mono />

      {/* Unit-specific fields */}
      {isUnit && (
        <>
          <Field label="部屋番号" value={property.roomNo} />
          <Field label="階" value={property.floorNo != null ? `${property.floorNo}F` : null} />
          <Field
            label="専有面積"
            value={property.exclusiveArea != null ? `${Number(property.exclusiveArea).toFixed(2)}m²` : null}
          />
          <Field
            label="バルコニー面積"
            value={property.balconyArea != null ? `${Number(property.balconyArea).toFixed(2)}m²` : null}
          />
          <Field label="間取り" value={property.layoutType} />
          <Field label="向き" value={property.orientation} />
          <Field
            label="管理費"
            value={property.managementFee != null ? `${property.managementFee.toLocaleString()}円/月` : null}
          />
          <Field
            label="修繕積立金"
            value={property.repairReserveFee != null ? `${property.repairReserveFee.toLocaleString()}円/月` : null}
          />
          <Field
            label="入居状況"
            value={property.occupancyStatus ? OCCUPANCY_LABELS[property.occupancyStatus] ?? property.occupancyStatus : null}
          />
          <Field label="持分メモ" value={property.ownershipShareNote} />
        </>
      )}

      <Field
        label="登記状況"
        value={property.registryStatus}
        badgeStyle={registryBadgeStyles[property.registryStatus]}
        badgeLabel={REGISTRY_STATUS_LABELS[property.registryStatus]}
      />
      <Field
        label="DM判断"
        value={property.dmStatus}
        badgeStyle={dmBadgeStyles[property.dmStatus]}
        badgeLabel={DM_STATUS_LABELS[property.dmStatus]}
      />
      <Field
        label="案件ステータス"
        value={CASE_STATUS_LABELS[property.caseStatus] ?? property.caseStatus}
      />
      <Field label="担当者" value={property.assignee?.name ?? null} />
      <Field label="登録者" value={property.creator?.name ?? null} />
      <Field
        label="登録日"
        value={new Date(property.createdAt).toLocaleDateString("ja-JP")}
      />
      <Field
        label="更新日"
        value={new Date(property.updatedAt).toLocaleDateString("ja-JP")}
      />
      <Field label="バージョン" value={String(property.version)} />
      {property.gpsLat != null && property.gpsLng != null && (
        <Field
          label="GPS座標"
          value={`${property.gpsLat}, ${property.gpsLng}`}
        />
      )}
      <div className="md:col-span-2">
        <Field label="備考" value={property.note} />
      </div>

      {/* Candidates */}
      <div className="md:col-span-2 mt-2">
        <dt className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
          候補物件
        </dt>
        <CandidateList propertyId={property.id} />
      </div>
    </div>
  );
}

// ---------- Investigation tab (enhanced with diff, confirm, failure handling) ----------

interface InvestigationData {
  status: "idle" | "fetching" | "done" | "failed";
  fetchedAt: string | null;
  data: Record<string, string | number | null>;
  source: string;
  fetchedBy?: { id: string; name: string };
  manuallyEdited?: boolean;
}

const INVESTIGATION_FIELDS: Array<{
  key: string;
  label: string;
  format?: (v: string | number | null) => string;
}> = [
  { key: "zoningDistrict", label: "用途地域" },
  { key: "buildingCoverageRatio", label: "建蔽率", format: (v) => (v != null ? `${v}%` : "-") },
  { key: "floorAreaRatio", label: "容積率", format: (v) => (v != null ? `${v}%` : "-") },
  { key: "heightDistrict", label: "高度地区" },
  { key: "firePreventionZone", label: "防火地域" },
  { key: "scenicRestriction", label: "景観規制" },
  { key: "roadType", label: "道路種別" },
  { key: "roadWidth", label: "道路幅員", format: (v) => (v != null ? `${v}m` : "-") },
  { key: "frontageWidth", label: "間口幅", format: (v) => (v != null ? `${v}m` : "-") },
  { key: "frontageDirection", label: "間口方角" },
  { key: "setbackRequired", label: "セットバック" },
  { key: "rosenkaValue", label: "路線価", format: (v) => (v != null ? `${Number(v).toLocaleString()}円/m²` : "-") },
  { key: "rosenkaYear", label: "路線価年度", format: (v) => (v != null ? `${v}年` : "-") },
  { key: "rebuildPermission", label: "再建築許可" },
];

function InvestigationTab({
  property,
  onConfirmed,
}: {
  property: ApiProperty;
  onConfirmed: () => void;
}) {
  const [invData, setInvData] = useState<InvestigationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchInvestigationData(property.id);
        if (!cancelled) setInvData(data as InvestigationData);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [property.id]);

  const handleFetch = async () => {
    setFetching(true);
    setMessage(null);
    setFetchError(null);
    try {
      const result = await triggerInvestigation(property.id);
      const data = result as InvestigationData;
      setInvData(data);
      if (data.status === "failed") {
        setFetchError("外部API取得に失敗しました。時間を置いて再試行してください。");
      } else {
        setMessage("調査情報を取得しました");
      }
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : "取得に失敗しました。ネットワーク状態を確認してください。",
      );
    } finally {
      setFetching(false);
    }
  };

  const handleStartEdit = () => {
    const values: Record<string, string> = {};
    for (const f of INVESTIGATION_FIELDS) {
      const propVal = (property as unknown as Record<string, unknown>)[f.key];
      const fetchedVal = invData?.data?.[f.key];
      const val = fetchedVal ?? propVal;
      values[f.key] = val != null ? String(val) : "";
    }
    setEditValues(values);
    setEditMode(true);
  };

  // Apply fetched values to edit form (one-click)
  const handleApplyFetched = () => {
    if (!invData?.data) return;
    const values: Record<string, string> = { ...editValues };
    for (const f of INVESTIGATION_FIELDS) {
      if (invData.data[f.key] != null) {
        values[f.key] = String(invData.data[f.key]);
      }
    }
    setEditValues(values);
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(editValues)) {
        if (val === "") continue;
        const numFields = [
          "buildingCoverageRatio", "floorAreaRatio", "roadWidth",
          "frontageWidth", "rosenkaValue", "rosenkaYear",
        ];
        payload[key] = numFields.includes(key) ? Number(val) || val : val;
      }
      await confirmInvestigation(property.id, payload);
      setMessage("調査情報を確認済みにしました");
      setEditMode(false);
      onConfirmed();
    } catch {
      setMessage("確認に失敗しました");
    } finally {
      setConfirming(false);
    }
  };

  // Current property values
  const currentValues: Record<string, string | number | null> = {};
  for (const f of INVESTIGATION_FIELDS) {
    currentValues[f.key] = (property as unknown as Record<string, string | number | null>)[f.key] ?? null;
  }

  // Count differences
  const diffCount = INVESTIGATION_FIELDS.filter((f) => {
    const current = currentValues[f.key];
    const fetched = invData?.data?.[f.key] ?? null;
    return fetched != null && String(fetched) !== String(current ?? "");
  }).length;

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {property.investigationConfirmedAt ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
              <CheckCircle2 className="h-3.5 w-3.5" />
              確認済み ({new Date(property.investigationConfirmedAt).toLocaleDateString("ja-JP")})
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              未確認
            </span>
          )}
          {invData?.manuallyEdited && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700">
              手動修正あり
            </span>
          )}
          {invData?.source && (
            <span className="text-xs text-gray-500">
              出典: {invData.source}
            </span>
          )}
          {invData?.fetchedAt && (
            <span className="text-xs text-gray-400">
              取得: {new Date(invData.fetchedAt).toLocaleString("ja-JP")}
            </span>
          )}
          {invData?.fetchedBy && (
            <span className="text-xs text-gray-400">
              ({invData.fetchedBy.name})
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleFetch}
            disabled={fetching}
            className="flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            {fetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {fetching ? "取得中..." : "調査情報を取得"}
          </button>
          {!editMode && (
            <button
              onClick={handleStartEdit}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Edit className="h-3.5 w-3.5" />
              確認・修正
            </button>
          )}
        </div>
      </div>

      {/* Fetch error */}
      {fetchError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          {fetchError}
          <button
            onClick={handleFetch}
            disabled={fetching}
            className="ml-3 text-xs font-medium text-red-800 underline hover:no-underline"
          >
            再試行
          </button>
        </div>
      )}

      {/* Success message */}
      {message && (
        <div
          className={`rounded-md border p-2 text-xs ${
            message.includes("失敗")
              ? "border-red-200 bg-red-50 text-red-600"
              : "border-green-200 bg-green-50 text-green-600"
          }`}
        >
          {message.includes("失敗") ? (
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          )}
          {message}
        </div>
      )}

      {/* Diff summary */}
      {diffCount > 0 && !editMode && (
        <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          <span className="text-sm text-amber-700">
            取得データと現在値に <strong>{diffCount}件</strong> の差分があります
          </span>
          <button
            onClick={() => setShowDiff(!showDiff)}
            className="ml-auto text-xs text-amber-700 underline hover:no-underline"
          >
            {showDiff ? "差分を隠す" : "差分を表示"}
          </button>
          <button
            onClick={handleStartEdit}
            className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            確認・反映
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      ) : editMode ? (
        /* Edit/confirm mode with side-by-side diff */
        <div className="space-y-4">
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700">
            確認モード: 値を修正して「確認済みにする」を押すと物件レコードに反映されます
          </div>

          {invData?.status === "done" && (
            <button
              onClick={handleApplyFetched}
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <RefreshCw className="h-3 w-3" />
              取得値を全て適用
            </button>
          )}

          {/* Table with Current / Fetched / Edit columns */}
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="border-b border-gray-200">
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-[130px]">
                    項目
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                    現在値
                  </th>
                  {invData?.status === "done" && (
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      取得値
                    </th>
                  )}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                    確認値（編集可）
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {INVESTIGATION_FIELDS.map((f) => {
                  const current = currentValues[f.key];
                  const fetched = invData?.data?.[f.key] ?? null;
                  const currentStr = current != null ? String(current) : "";
                  const fetchedStr = fetched != null ? String(fetched) : "";
                  const editStr = editValues[f.key] ?? "";
                  const hasDiff = fetchedStr && fetchedStr !== currentStr;

                  return (
                    <tr key={f.key} className={hasDiff ? "bg-amber-50/50" : ""}>
                      <td className="px-3 py-2 text-xs font-medium text-gray-600 whitespace-nowrap">
                        {f.label}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {f.format ? f.format(current) : currentStr || "-"}
                      </td>
                      {invData?.status === "done" && (
                        <td className={`px-3 py-2 text-xs ${hasDiff ? "text-amber-700 font-medium" : "text-gray-500"}`}>
                          {fetchedStr || "-"}
                          {hasDiff && (
                            <button
                              onClick={() =>
                                setEditValues((prev) => ({
                                  ...prev,
                                  [f.key]: fetchedStr,
                                }))
                              }
                              className="ml-1 text-[10px] text-blue-600 hover:underline"
                              title="この値を適用"
                            >
                              適用
                            </button>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={editStr}
                          onChange={(e) =>
                            setEditValues((prev) => ({
                              ...prev,
                              [f.key]: e.target.value,
                            }))
                          }
                          className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 border-t border-gray-200 pt-4">
            <button
              onClick={handleConfirm}
              disabled={confirming}
              className="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {confirming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              確認済みにする
            </button>
            <button
              onClick={() => setEditMode(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        /* Display mode - with diff highlighting */
        <div>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="border-b border-gray-200">
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-[130px]">
                    項目
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                    現在値
                  </th>
                  {showDiff && invData?.status === "done" && (
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      取得値
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {INVESTIGATION_FIELDS.map((f) => {
                  const current = currentValues[f.key];
                  const fetched = invData?.data?.[f.key] ?? null;
                  const currentStr = current != null ? String(current) : "";
                  const fetchedStr = fetched != null ? String(fetched) : "";
                  const hasDiff = fetchedStr && fetchedStr !== currentStr;
                  const displayVal = f.format ? f.format(current) : currentStr || "-";

                  return (
                    <tr key={f.key} className={hasDiff ? "bg-amber-50/50" : ""}>
                      <td className="px-3 py-2 text-xs font-medium text-gray-600 whitespace-nowrap">
                        {f.label}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-900">
                        {displayVal}
                      </td>
                      {showDiff && invData?.status === "done" && (
                        <td className={`px-3 py-2 text-sm ${hasDiff ? "text-amber-700 font-medium" : "text-gray-400"}`}>
                          {fetchedStr ? (f.format ? f.format(fetched) : fetchedStr) : "-"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Additional fields */}
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="調査確認日"
              value={
                property.investigationConfirmedAt
                  ? new Date(property.investigationConfirmedAt).toLocaleDateString("ja-JP")
                  : null
              }
            />
            <Field label="建築備考" value={property.architectureNote} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Owner tab ----------

function OwnerTab({ owners }: { owners: ApiPropertyOwner[] }) {
  if (owners.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        所有者が紐付けられていません
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {owners.map((po) => (
        <div
          key={po.id}
          className="rounded-lg border border-gray-200 bg-gray-50 p-5"
        >
          <div className="mb-3 flex items-center gap-2">
            {po.isPrimary && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                主所有者
              </span>
            )}
            {po.relationship && (
              <span className="text-xs text-gray-500">
                関係: {po.relationship}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <OwnerField label="氏名" value={po.owner.name} />
            <OwnerField label="氏名カナ" value={po.owner.nameKana} />
            <OwnerField label="電話番号" value={po.owner.phone} />
            <OwnerField label="郵便番号" value={po.owner.zip} />
            <div className="md:col-span-2">
              <OwnerField label="現住所" value={po.owner.address} />
            </div>
            <div className="md:col-span-2">
              <OwnerField label="備考" value={po.owner.note} />
            </div>
          </dl>
        </div>
      ))}
    </div>
  );
}

// ---------- Shared field components ----------

function Field({
  label,
  value,
  mono,
  badgeStyle,
  badgeLabel,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  badgeStyle?: string;
  badgeLabel?: string;
}) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </dt>
      <dd className={`text-sm text-gray-900 ${mono ? "font-mono" : ""}`}>
        {badgeStyle ? (
          <span
            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeStyle}`}
          >
            {badgeLabel ?? value}
          </span>
        ) : (
          value || "-"
        )}
      </dd>
    </div>
  );
}

function OwnerField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </dt>
      <dd className="text-sm text-gray-900">{value ?? "-"}</dd>
    </div>
  );
}

