"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  Building2,
  Edit,
  Loader2,
  Trash2,
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
import { fetchPropertyDetail, deleteProperty, updatePropertyOwner, updateOwner } from "@/lib/api-client";
import { OwnerEditableFields, buildOwnerUpdatePayload, canEditOwner } from "@/lib/owner-edit-utils";
import { OwnerMemoHistory } from "@/components/owners/OwnerMemoHistory";

// ---------- Label maps ----------

import {
  PROPERTY_TYPE_LABELS,
  CASE_STATUS_LABELS,
  CASE_STATUS_OPTIONS,
  INTRODUCTION_ROUTE_LABELS,
  INTRODUCTION_ROUTE_OPTIONS,
} from "@/lib/property-types";

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
  /** hidden 時は API レスポンスにキーが存在しない（undefined）。null は「空値」と区別する。 */
  email?: string | null;
  /** owner:read がない場合は API レスポンスが { id } のみになるため optional。 */
  version?: number;
}

interface ApiPropertyOwner {
  id: string;
  propertyId: string;
  ownerId: string;
  relationship: string | null;
  isPrimary: boolean;
  /** 物件×所有者単位のメモ（PropertyOwner.note）。Owner.note とは別軸。 */
  note: string | null;
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
  introductionRoute: string | null;
  importSource: string | null;
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
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("basic");
  const [property, setProperty] = useState<ApiProperty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [canWriteProperty, setCanWriteProperty] = useState(false);
  const [canWriteOwner, setCanWriteOwner] = useState(false);
  const [canReadOwner, setCanReadOwner] = useState(false);
  const [canCreateOwnerMemo, setCanCreateOwnerMemo] = useState(false);
  const [ownerEditableFields, setOwnerEditableFields] = useState<OwnerEditableFields>({
    name: false,
    nameKana: false,
    phone: false,
    zip: false,
    address: false,
    email: false,
  });

  const handleDelete = async () => {
    if (!property) return;
    const ok = window.confirm(
      `物件「${property.address}」を削除します。この操作は取り消せません。よろしいですか？`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteProperty(property.id);
      router.push("/properties");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "削除に失敗しました");
      setDeleting(false);
    }
  };

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

  useEffect(() => {
    fetch("/api/me/permissions")
      .then((r) => r.json())
      .then((json: { permissions?: { resource: string; action: string; granted: boolean }[] }) => {
        const perms = json.permissions ?? [];
        setCanWriteProperty(
          perms.some((p) => p.resource === "property" && p.action === "write" && p.granted),
        );
        setCanWriteOwner(
          perms.some((p) => p.resource === "owner" && p.action === "write" && p.granted),
        );
        setCanReadOwner(
          perms.some((p) => p.resource === "owner" && p.action === "read" && p.granted),
        );
        const hasFullPerm = (resource: string) =>
          perms.some((p) => p.resource === resource && p.action === "full" && p.granted);
        const hasEditPerm = (resource: string) =>
          perms.some((p) => p.resource === resource && p.action === "edit" && p.granted);
        setOwnerEditableFields({
          name: hasFullPerm("owner_name"),
          nameKana: hasFullPerm("owner_name_kana"),
          phone: hasFullPerm("owner_phone"),
          zip: hasFullPerm("owner_zip"),
          address: hasFullPerm("owner_address"),
          email: hasFullPerm("owner_email"),
        });
        // OwnerMemo 作成可否: owner:write かつ owner_note の full/edit を要求（API 側の canCreateOwnerMemo と整合）
        const ownerWrite = perms.some(
          (p) => p.resource === "owner" && p.action === "write" && p.granted,
        );
        setCanCreateOwnerMemo(
          ownerWrite && (hasFullPerm("owner_note") || hasEditPerm("owner_note")),
        );
      })
      .catch(() => {});
  }, []);

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
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            削除
          </button>
        </div>
      </div>

      {/* Action bar */}
      <ActionBar
        propertyId={property.id}
        registryStatus={property.registryStatus}
        dmStatus={property.dmStatus}
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
        {activeTab === "basic" && <BasicTab property={property} onRefresh={fetchProperty} canWrite={canWriteProperty} />}
        {activeTab === "owner" && (
          <OwnerTab
            owners={property.propertyOwners}
            canRead={canReadOwner}
            canWrite={canWriteOwner}
            editableFields={ownerEditableFields}
            canCreateMemo={canCreateOwnerMemo}
            onRefresh={fetchProperty}
          />
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

function BasicTab({
  property,
  onRefresh,
  canWrite,
}: {
  property: ApiProperty;
  onRefresh: () => void;
  canWrite: boolean;
}) {
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
      <Field label="管理ID" value={property.importSource ?? "—"} mono />
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

      <Field label="物件住所" value={property.address} />
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
      <CaseStatusField property={property} onRefresh={onRefresh} canWrite={canWrite} />
      <IntroductionRouteField property={property} onRefresh={onRefresh} canWrite={canWrite} />
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

function OwnerTab({
  owners,
  canRead,
  canWrite,
  editableFields,
  canCreateMemo,
  onRefresh,
}: {
  owners: ApiPropertyOwner[];
  canRead: boolean;
  canWrite: boolean;
  editableFields: OwnerEditableFields;
  canCreateMemo: boolean;
  onRefresh: () => Promise<void>;
}) {
  // owner:read がない場合、API は owner を { id } のみで返すため詳細表示・編集は不可。
  // 編集ボタンも出さない（OwnerCard 側の canEditOwner でも防御するが、ここで早期に閉じる）。
  if (!canRead) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        所有者情報を閲覧する権限がありません
      </p>
    );
  }

  if (owners.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        所有者が紐付けられていません
      </p>
    );
  }

  const isShared = owners.length > 1;

  return (
    <div className="space-y-4">
      {isShared && (
        <p className="text-xs text-gray-500">
          共有名義: {owners.length} 名（メモは所有者ごと・物件単位で保持されます）
        </p>
      )}
      {owners.map((po, idx) => (
        <OwnerCard
          key={po.id}
          po={po}
          idx={idx}
          total={owners.length}
          canRead={canRead}
          canWrite={canWrite}
          editableFields={editableFields}
          canCreateMemo={canCreateMemo}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

// ---------- Owner card (表示 + インライン編集) ----------

function OwnerCard({
  po,
  idx,
  total,
  canRead,
  canWrite,
  editableFields,
  canCreateMemo,
  onRefresh,
}: {
  po: ApiPropertyOwner;
  idx: number;
  total: number;
  canRead: boolean;
  canWrite: boolean;
  editableFields: OwnerEditableFields;
  canCreateMemo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // email が API レスポンスに含まれているか（hidden の場合キーが存在しない）
  const emailReturned = "email" in po.owner;

  // 少なくとも1項目でも full 編集可能かどうか
  const hasAnyEditable =
    editableFields.name ||
    editableFields.nameKana ||
    editableFields.phone ||
    editableFields.zip ||
    editableFields.address ||
    editableFields.email;

  // 編集ボタン表示条件: canEditOwner pure helper を使用。
  // owner:read がない場合は API レスポンスが { id } のみで version も undefined になるため編集不可。
  const editAllowed = canEditOwner(canRead, canWrite, hasAnyEditable, po.owner.version);

  const [form, setForm] = useState({
    name: po.owner.name ?? "",
    nameKana: po.owner.nameKana ?? "",
    phone: po.owner.phone ?? "",
    zip: po.owner.zip ?? "",
    address: po.owner.address ?? "",
    email: po.owner.email ?? "",
  });

  const handleEdit = () => {
    setForm({
      name: po.owner.name ?? "",
      nameKana: po.owner.nameKana ?? "",
      phone: po.owner.phone ?? "",
      zip: po.owner.zip ?? "",
      address: po.owner.address ?? "",
      email: po.owner.email ?? "",
    });
    setSaveError(null);
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    // 編集ボタン非表示時の異常呼び出しガード:
    // owner:read がない・version 未返却の場合は保存不可。
    if (typeof po.owner.version !== "number") {
      setSaveError("保存に必要な情報が取得できていません。画面を再読み込みしてください。");
      return;
    }
    const version = po.owner.version;
    setSaving(true);
    setSaveError(null);
    try {
      // full 権限のある項目だけ payload に含める。masked/hidden 項目は送信しない。
      const payload = buildOwnerUpdatePayload(form, editableFields, version);
      await updateOwner(po.ownerId, payload as Parameters<typeof updateOwner>[1]);
      setEditing(false);
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存に失敗しました";
      setSaveError(msg.includes("CONFLICT") ? "他のユーザーが先に更新しました。画面を再読み込みしてください。" : msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      {/* 見出し: 番号 + 氏名 + バッジ */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-gray-100 pb-3">
        <span className="text-xs font-medium text-gray-500">
          所有者 {idx + 1}
          {total > 1 ? ` / ${total}` : ""}
        </span>
        <h3 className="text-base font-semibold text-gray-900">
          {po.owner.name ?? "（氏名未登録）"}
        </h3>
        {po.isPrimary && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
            主所有者
          </span>
        )}
        {po.relationship && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-700">
            {po.relationship}
          </span>
        )}
        {/* 編集ボタンは canEditOwner (owner:read + owner:write + 編集可能項目あり + version 取得済み) のみ表示 */}
        {editAllowed && !editing && (
          <button
            type="button"
            onClick={handleEdit}
            className="ml-auto flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <Edit className="h-3 w-3" />
            編集
          </button>
        )}
      </div>

      {editing ? (
        /* ── 編集フォーム（full 権限のある項目のみ input を表示） ── */
        <div className="space-y-4">
          {/* 複数物件紐づき警告 */}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              所有者情報の変更は、この所有者が紐付けられているすべての物件に反映されます。
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {editableFields.name && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">
                  所有者名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {editableFields.nameKana && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">
                  氏名カナ（任意）
                </label>
                <input
                  type="text"
                  value={form.nameKana}
                  onChange={(e) => setForm((f) => ({ ...f, nameKana: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {editableFields.phone && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">電話番号</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {editableFields.zip && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">郵便番号</label>
                <input
                  type="text"
                  value={form.zip}
                  onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {editableFields.address && (
              <div className="space-y-1 md:col-span-2">
                <label className="text-xs font-medium text-gray-700">現住所</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {/* email は full 権限かつ API レスポンスに含まれる場合のみ入力フィールドを表示 */}
            {editableFields.email && emailReturned && (
              <div className="space-y-1 md:col-span-2">
                <label className="text-xs font-medium text-gray-700">メールアドレス</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
          </div>

          {saveError && (
            <p className="text-xs text-red-600">{saveError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (editableFields.name && !form.name.trim())}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded-md border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed"
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        /* ── 表示ビュー ── */
        <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <OwnerField label="氏名カナ" value={po.owner.nameKana} />
          <OwnerField label="電話番号" value={po.owner.phone} mono />
          <OwnerField label="郵便番号" value={po.owner.zip} mono />
          {emailReturned && (
            <OwnerField label="メールアドレス" value={po.owner.email} />
          )}
          <div className="md:col-span-2">
            <OwnerField label="現住所" value={po.owner.address} />
          </div>
        </dl>
      )}

      {/* メモ: PropertyOwner 単位（常時表示） */}
      <div className="mt-5 border-t border-gray-100 pt-4">
        <PropertyOwnerNoteEditor po={po} />
      </div>

      {/* メモ履歴: Owner 単位（追記のみ） */}
      {canRead && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <OwnerMemoHistory
            ownerId={po.ownerId}
            canCreate={canCreateMemo}
          />
        </div>
      )}
    </div>
  );
}

// ---------- Property-Owner note editor ----------
// 物件×所有者単位のメモ（PropertyOwner.note）。
// 共有名義でも所有者ごと、同じ Owner が別物件にいても物件ごとに別メモを保持する。
function PropertyOwnerNoteEditor({ po }: { po: ApiPropertyOwner }) {
  const [value, setValue] = useState(po.note ?? "");
  const [savedValue, setSavedValue] = useState(po.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = value !== savedValue;

  const persist = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await updatePropertyOwner(po.propertyId, po.ownerId, { note: next });
      setSavedValue(next ?? "");
      setValue(next ?? "");
      setSavedAt(Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        メモ（この物件における所有者メモ）
      </dt>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="例: 連絡時間帯、相続関係、現地でのやり取りなど"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => persist(value.trim() === "" ? null : value)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {saving ? "保存中..." : "保存"}
        </button>
        <button
          type="button"
          disabled={saving || (savedValue === "" && value === "")}
          onClick={() => persist(null)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          削除
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
        {!error && savedAt && !dirty && !saving && (
          <span className="text-xs text-green-600">保存しました</span>
        )}
      </div>
    </div>
  );
}

// ---------- Case status inline dropdown ----------

function CaseStatusField({
  property,
  onRefresh,
  canWrite,
}: {
  property: ApiProperty;
  onRefresh: () => void;
  canWrite: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseStatus: value, version: property.version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `エラー: ${res.status}`);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const label = CASE_STATUS_LABELS[property.caseStatus] ?? property.caseStatus;

  if (!canWrite) {
    return (
      <div>
        <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
          案件ステータス
        </dt>
        <dd className="text-sm text-gray-900">{label}</dd>
      </div>
    );
  }

  // deprecated 値を持つ既存レコードでも選択肢に表示する
  const options = CASE_STATUS_OPTIONS.some((o) => o.value === property.caseStatus)
    ? CASE_STATUS_OPTIONS
    : [
        ...CASE_STATUS_OPTIONS,
        { value: property.caseStatus, label },
      ];

  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        案件ステータス
      </dt>
      <dd>
        <select
          value={property.caseStatus}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-50"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400" />}
        {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
      </dd>
    </div>
  );
}

// ---------- Introduction route inline dropdown ----------

function IntroductionRouteField({
  property,
  onRefresh,
  canWrite,
}: {
  property: ApiProperty;
  onRefresh: () => void;
  canWrite: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ introductionRoute: value || null, version: property.version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `エラー: ${res.status}`);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const label = property.introductionRoute
    ? (INTRODUCTION_ROUTE_LABELS[property.introductionRoute] ?? property.introductionRoute)
    : "—";

  if (!canWrite) {
    return (
      <div>
        <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
          導入ルート
        </dt>
        <dd className="text-sm text-gray-900">{label}</dd>
      </div>
    );
  }

  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        導入ルート
      </dt>
      <dd>
        <select
          value={property.introductionRoute ?? ""}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-50"
        >
          <option value="">未設定</option>
          {INTRODUCTION_ROUTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400" />}
        {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
      </dd>
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
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  const hasValue = value != null && String(value).trim() !== "";
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </dt>
      <dd
        className={`text-sm ${hasValue ? "text-gray-900" : "text-gray-400"} ${
          mono ? "font-mono" : ""
        }`}
      >
        {hasValue ? value : "未登録"}
      </dd>
    </div>
  );
}

