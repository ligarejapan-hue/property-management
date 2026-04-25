"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Building2,
  Edit,
  Loader2,
} from "lucide-react";
import CommentTab from "@/components/properties/comment-tab";
import NextActionTab from "@/components/properties/next-action-tab";
import AttachmentTab from "@/components/properties/attachment-tab";
import HistoryTab from "@/components/properties/history-tab";
import PhotoTab from "@/components/properties/photo-tab";
import CandidateList from "@/components/properties/candidate-list";
import ActionBar from "@/components/properties/action-bar";
import PropertyEditForm from "@/components/properties/property-edit-form";
import InvestigationTab from "@/components/properties/investigation-tab";
import { fetchPropertyDetail } from "@/lib/api-client";

// ---------- Label maps ----------

import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

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
          <InvestigationTab propertyId={property.id} />
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
  // 旧値 "unit" と新値 "apartment_unit" の両方を区分扱いにする
  const isUnit =
    property.propertyType === "apartment_unit" ||
    property.propertyType === "unit";
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

// (InvestigationTab extracted to src/components/properties/investigation-tab.tsx)

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

