"use client";

import { useState, useEffect, useCallback, useMemo, useRef, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  Building2,
  Edit,
  Loader2,
  Mail,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  badgeIntentClass,
  REGISTRY_STATUS_INTENT,
  DM_STATUS_INTENT,
} from "@/components/ui/status-badge";
import CommentTab from "@/components/properties/comment-tab";
import NextActionTab from "@/components/properties/next-action-tab";
import AttachmentTab from "@/components/properties/attachment-tab";
import HistoryTab from "@/components/properties/history-tab";
import PhotoTab from "@/components/properties/photo-tab";
import CandidateList from "@/components/properties/candidate-list";
import ActionBar from "@/components/properties/action-bar";
import RegistryLocationSearchButton from "@/components/properties/registry-location-search-button";
import { isLandPropertyType } from "@/lib/registry-fetch/registry-target";
import PropertyEditForm from "@/components/properties/property-edit-form";
import InvestigationTab from "@/components/properties/investigation-tab";
import { fetchPropertyDetail, deleteProperty, updatePropertyOwner, updateOwner, fetchQualityCheck } from "@/lib/api-client";
import { OwnerEditableFields, buildOwnerUpdatePayload, canEditOwner } from "@/lib/owner-edit-utils";
import { canShowAddOwner } from "@/lib/owner-link-utils";
import {
  normalizeCorporateNumber,
  normalizeCompanyRegistryNumber,
  classifyCorporateIdentifier,
  detectCorporateNumberInOwnerLike,
  detectCompanyRegistryNumberInOwnerLike,
} from "@/lib/corporate-number";
import { OwnerMemoHistory } from "@/components/owners/OwnerMemoHistory";
import { OwnerMislinkModal } from "@/components/owners/OwnerMislinkModal";
import { OwnerLinkModal } from "@/components/owners/owner-link-modal";
import CorporateLookupPanel from "@/components/owners/corporate-lookup-panel";
import { AddressLookupControls } from "@/components/address/address-lookup-controls";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { SalesSheetCreateButton } from "@/components/sales-sheet/SalesSheetCreateButton";
import { SalesSheetList } from "@/components/sales-sheet/SalesSheetList";
import { salesSheetTemplateKindFor } from "@/lib/sales-sheet/template-kind";

// ---------- Label maps ----------

import {
  PROPERTY_TYPE_LABELS,
  CASE_STATUS_LABELS,
  CASE_STATUS_OPTIONS,
  INTRODUCTION_ROUTE_LABELS,
  INTRODUCTION_ROUTE_OPTIONS,
  OCCUPANCY_STATUS_LABELS,
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

// v2: バッジ色は共通レシピ(status-badge.tsx)の intent から導出。
// 一覧ページと定義が重複していたものを共通化(scheduled は yellow → amber)。
const registryBadgeStyles: Record<string, string> = {
  obtained: badgeIntentClass(REGISTRY_STATUS_INTENT.obtained),
  unconfirmed: badgeIntentClass(REGISTRY_STATUS_INTENT.unconfirmed),
  scheduled: badgeIntentClass(REGISTRY_STATUS_INTENT.scheduled),
};

const dmBadgeStyles: Record<string, string> = {
  send: badgeIntentClass(DM_STATUS_INTENT.send),
  no_send: badgeIntentClass(DM_STATUS_INTENT.no_send),
  hold: badgeIntentClass(DM_STATUS_INTENT.hold),
};

// ---------- Tabs ----------

const tabs = [
  { key: "basic", label: "基本情報" },
  { key: "owner", label: "所有者情報" },
  { key: "photos", label: "写真" },
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
  /**
   * 現住所の郵便番号。所有者が引っ越して登記を変更していない場合に使う。
   * owner_zip と同じ表示レベルでマスク/非表示になる（hidden 時はキーが無い）。
   */
  currentZip?: string | null;
  /**
   * 現住所。空（未設定）なら登記上の住所を使う（送付先の解決は
   * src/lib/owner-mailing-address.ts の resolveMailingAddress が行う）。
   * owner_address と同じ表示レベルでマスク/非表示になる。
   */
  currentAddress?: string | null;
  note: string | null;
  /** hidden 時は API レスポンスにキーが存在しない（undefined）。null は「空値」と区別する。 */
  email?: string | null;
  /** 法人番号（13桁数字、display-level に応じて masked/hidden される）。 */
  corporateNumber?: string | null;
  /** 会社法人等番号（12桁、corporateNumber と同じ display-level でマスク/非表示）。 */
  companyRegistryNumber?: string | null;
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
  /** 物件名(任意)。集合住宅の種別のときだけ値が入る。 */
  buildingName: string | null;
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

  // 品質警告 (§8-6): 一覧と同じ fetchQualityCheck の scoped モードで当該物件分のみ取得。
  // severity=info は対象外。取得失敗時はセクション非表示（fail-safe: 詳細全体を壊さない）。
  const [qualityIssues, setQualityIssues] = useState<
    Array<{ severity: "error" | "warning"; message: string }>
  >([]);

  const handleDelete = async () => {
    if (!property) return;
    const ok = window.confirm(
      `物件「${property.address}」を削除します。この操作は取り消せません。
所有者に紐づくDMの反響・送付履歴は所有者情報に引き継がれます(紐づけの無い記録は削除されます)。よろしいですか？`,
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

  // 品質警告取得 (@codex P2: 物件更新時にも再取得): useCallback 化して fetchProperty から
  // も呼ぶことで ActionBar/編集保存/所有者更新等の後も最新警告を反映する。
  // seq guard: fire-and-forget でも後着リクエストが先着の stale 結果で state を上書きしない。
  // void 呼び出しでも cancelled フラグを誰も true にしない問題を解消（ref シーケンス方式）。
  const qualityReqSeq = useRef(0);
  const loadQualityIssues = useCallback(async () => {
    const seq = ++qualityReqSeq.current;
    try {
      const json = await fetchQualityCheck({ propertyIds: [id] });
      if (seq !== qualityReqSeq.current) return; // 後発リクエストが来ていたら破棄（後着勝ち）
      const data = (
        json as {
          data?: Array<{
            propertyId: string;
            severity: "error" | "warning" | "info";
            message: string;
          }>;
        }
      ).data ?? [];
      setQualityIssues(
        data
          .filter((i) => i.severity !== "info")
          .map((i) => ({
            severity: i.severity as "error" | "warning",
            message: i.message,
          })),
      );
    } catch {
      // 取得失敗時は stale 警告を残さずクリア（最新リクエストの場合のみ＝古い失敗が新しい成功を消さない）
      if (seq === qualityReqSeq.current) setQualityIssues([]);
    }
  }, [id]);

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
    // 物件再取得に連動して品質警告も更新する（@codex P2: 更新後も最新の警告を表示）。
    void loadQualityIssues();
  }, [id, loadQualityIssues]);

  useEffect(() => {
    fetchProperty();
  }, [fetchProperty]);

  // id 変化時に品質警告をリセットする（再取得は fetchProperty 内の loadQualityIssues 呼び出しが行う）。
  // このエフェクトは reset のみ: fetchProperty も同じ id 変化で走るため二重 fetch しない。
  useEffect(() => {
    setQualityIssues([]);
  }, [id]);

  // F12 展開(19-A 第3実装): permissions / capabilities は ScreenProtectionProvider
  //（dashboard 全体を覆う）が mount 時に 1 回取得して context 配布するため、本ページ独自の
  // /api/me/permissions fetch は撤去し、provider 配布値（permissions / capabilities）から
  // 8 つの権限/capability 状態を導出する（properties 一覧 F12-2・field-survey-map・
  // admin owner 詳細 19-A と同方針・同一エンドポイントの重複 fetch 撤去）。
  // fail-safe: 未取得・取得失敗（permissions=null / capabilities=null）・取得中・進入時
  // refresh 中は「権限なし・機能なし」へ倒す（制限的 collapse = [] / false）。本ページの
  // 8 状態は全て boolean ゲート（編集ボタン/入力欄/閲覧/自動取得ボタンの表示・disabled）で
  // あり、field-survey の tristate null（API 403 委譲）とは異なる properties 一覧型の collapse。
  const {
    permissions: mePermissions,
    capabilities: meCapabilities,
    permissionsLoading,
    refetchPermissions,
  } = useScreenProtection();

  // 進入時 refresh（properties 一覧・field-survey-map・admin owner 詳細と同方針）: App Router の
  // layout は client navigation で保持されるため、provider の mount 時 1 回 fetch だけでは
  // dashboard 滞在中の権限付与・剥奪に追従できない。進入（mount）あたり最大 1 回だけ
  // refetchPermissions() を呼び、旧 page-local fetch が持っていた鮮度を復元する。
  // - 取得進行中（permissionsLoading）は呼ばない＝初回 fetch と重複させない。
  // - mount 時進行中だった取得が成功した場合はそのデータが最新なので追加 fetch しない。
  // - mount 時取得完了済み（stale 可能性）/ 進行中だった取得の失敗（復旧）は 1 回再取得。
  // - ref ガード＋provider 側 in-flight dedupe の二重防御で多重 fetch・無限リトライなし。
  const permissionsRefreshRequestedRef = useRef(false);
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  // 進入時 refresh 完了まで stale な権限・capability で編集/閲覧/自動取得 UI を出さない。
  // mount 時点で取得完了済み（= この後 refresh が走る）なら最初の描画から pending=true で開始。
  const [permissionsRefreshPending, setPermissionsRefreshPending] = useState(
    () => !permissionsLoading,
  );
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    if (permissionsLoading) return;
    if (permissionsLoadingAtMountRef.current === true && mePermissions !== null) {
      permissionsRefreshRequestedRef.current = true;
      return;
    }
    permissionsRefreshRequestedRef.current = true;
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, mePermissions, refetchPermissions]);

  // effectivePermissions / effectiveCapabilities による導出（純関数・context 値の派生）。
  // 進入時 refresh 中（pending）・provider 取得中（loading）は [] / false に倒す＝refresh
  // 完了後の最新値からのみ権限/capability 由来の UI を出す（stale 権限表示防止・fail-safe）。
  // 判定ロジック（granted / full|edit / 複合 owner:write && owner_note）は従来どおり（緩めない）。
  const {
    canWriteProperty,
    canDeleteProperty,
    canWriteOwner,
    canReadOwner,
    canCreateOwnerMemo,
    corporateLookupConfigured,
    canAutoFetchRegistry,
    registryLocationSearchConfigured,
    registryRecoverConfigured,
    registryPurchaseConfigured,
    ownerEditableFields,
  } = useMemo(() => {
    const effectivePermissions =
      permissionsRefreshPending || permissionsLoading
        ? []
        : (mePermissions ?? []);
    const collapseCapabilities = permissionsRefreshPending || permissionsLoading;
    const corporateLookupConfigured = collapseCapabilities
      ? false
      : meCapabilities?.corporateLookup === true;
    // ⚠謄本の取得の入口は「所在で謄本を検索」だけ（2026-08-15 に自動取得ボタンを撤去）。
    //   registryAutoFetch capability はここでは読まない（読み手が居ない派生値を置かない）。
    const registryLocationSearchConfigured = collapseCapabilities
      ? false
      : meCapabilities?.registryLocationSearch === true;
    // 【回収】購入済みの取り込みは**所在検索に依存しない**(@codex #394 R16 P2)。
    //   provider は資格情報だけで解決し、回収の口も持つ。所在検索の校正が外れて
    //   いても、買った書類は取り込めなければならない(期限があるため)。
    const registryRecoverConfigured = collapseCapabilities
      ? false
      : meCapabilities?.registryAutoFetch === true;
    // 段階②(2026-08-01): 有料取得はさらに厳しく、専用オプトイン
    // (REGISTRY_FETCH_PURCHASE_ENABLED)込みの capability(@codex #345 P1)。
    const registryPurchaseConfigured = collapseCapabilities
      ? false
      : meCapabilities?.registryPurchase === true;
    const canAutoFetchRegistry = effectivePermissions.some(
      (p) => p.resource === "registry" && p.action === "auto_fetch" && p.granted,
    );
    const canWriteProperty = effectivePermissions.some(
      (p) => p.resource === "property" && p.action === "write" && p.granted,
    );
    // 削除は DELETE /api/properties/[id] が property:delete を要求する（write では通らない）。
    const canDeleteProperty = effectivePermissions.some(
      (p) => p.resource === "property" && p.action === "delete" && p.granted,
    );
    const canWriteOwner = effectivePermissions.some(
      (p) => p.resource === "owner" && p.action === "write" && p.granted,
    );
    const canReadOwner = effectivePermissions.some(
      (p) => p.resource === "owner" && p.action === "read" && p.granted,
    );
    const hasFullPerm = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "full" && p.granted,
      );
    const hasEditPerm = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "edit" && p.granted,
      );
    const ownerEditableFields: OwnerEditableFields = {
      name: hasFullPerm("owner_name"),
      nameKana: hasFullPerm("owner_name_kana"),
      phone: hasFullPerm("owner_phone"),
      zip: hasFullPerm("owner_zip"),
      address: hasFullPerm("owner_address"),
      email: hasFullPerm("owner_email"),
      corporateNumber:
        hasFullPerm("owner_corporate_number") ||
        hasEditPerm("owner_corporate_number"),
    };
    // OwnerMemo 作成可否: owner:write かつ owner_note の full/edit を要求（API 側の
    // canCreateOwnerMemo と整合）。複合述語ゆえ verbatim 維持（緩めない）。
    const canCreateOwnerMemo =
      canWriteOwner && (hasFullPerm("owner_note") || hasEditPerm("owner_note"));
    return {
      canWriteProperty,
      canDeleteProperty,
      canWriteOwner,
      canReadOwner,
      canCreateOwnerMemo,
      corporateLookupConfigured,
      canAutoFetchRegistry,
      registryLocationSearchConfigured,
      registryRecoverConfigured,
      registryPurchaseConfigured,
      ownerEditableFields,
    };
  }, [permissionsRefreshPending, permissionsLoading, mePermissions, meCapabilities]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/40">
        <p className="text-sm text-red-700 dark:text-red-300">
          {error ?? "物件が見つかりません"}
        </p>
        <Link
          href="/properties"
          className="mt-3 inline-block text-sm text-indigo-600 hover:underline"
        >
          物件一覧に戻る
        </Link>
      </div>
    );
  }

  // 販売図面テンプレの対応種別（土地/区分マンション/戸建/一棟）。対応外は null。
  const salesSheetKind = salesSheetTemplateKindFor(property.propertyType);

  return (
    <div data-pii-protected data-pii-surface="property">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Link
            href="/properties"
            className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ArrowLeft className="h-4 w-4" />
            物件一覧
          </Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">
            {property.address}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* DM 送付履歴ページ(/properties/[id]/dm-logs)への導線。route 新設なし・既存ページへのリンク。
              dm-logs ページは property:read + owner:read + record-scope を要するため、既存導出済みの
              canReadOwner でゲートして 403 dead-end を避ける（新ロジック追加なし・既存 state 利用）。 */}
          {canReadOwner && (
            <Link
              href={`/properties/${property.id}/dm-logs`}
              aria-label="DM送付履歴を見る"
              title="この物件の DM 送付履歴"
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Mail className="h-4 w-4" />
              DM送付履歴
            </Link>
          )}
          {salesSheetKind && (
            <SalesSheetCreateButton
              propertyId={property.id}
              canWrite={canWriteProperty}
              kind={salesSheetKind}
            />
          )}
          <button
            onClick={() => setShowEditForm(true)}
            aria-label="物件を編集"
            title="物件情報を編集"
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Edit className="h-4 w-4" />
            物件を編集
          </button>
          {canDeleteProperty && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              aria-label="物件を削除"
              title="この物件を削除"
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              物件を削除
            </button>
          )}
        </div>
      </div>

      {/* 保存済み販売図面の一覧（再オープン導線・対応種別のみ・保存図面が無ければ非表示） */}
      {salesSheetKind && <SalesSheetList propertyId={property.id} />}

      {/* Action bar */}
      <ActionBar
        propertyId={property.id}
        registryStatus={property.registryStatus}
        dmStatus={property.dmStatus}
        investigationConfirmedAt={property.investigationConfirmedAt}
        onActionComplete={fetchProperty}
      />

      {/* ⚠「謄本を自動取得」(不動産番号で引く導線)は 2026-08-15 に撤去した。番号取得は
          実サイトへ未配線・本番の不動産番号は0件・発注者判断で今後も入れない運用のため、
          押しても必ず失敗する導線だった。取得の入口は下の「所在で謄本を検索」に一本化。 */}

      {/* 謄本 所在検索（PR-2b-3・番号無し物件を所在で検索→候補選択→取得。所在検索対応 provider のときのみ有効） */}
      <RegistryLocationSearchButton
        propertyId={property.id}
        canAutoFetch={canAutoFetchRegistry}
        providerConfigured={registryLocationSearchConfigured}
        purchaseEnabled={registryPurchaseConfigured}
        recoverConfigured={registryRecoverConfigured}
        propertyAddress={property.address}
        // 候補なしの回収で「土地/建物」どちらを取り込むか選ばせるために渡す
        // (両方登録されている物件は放っておくと家屋番号が優先される)。
        propertyLotNumber={property.lotNumber}
        propertyBuildingNumber={property.buildingNumber}
        // ⚠地番の保存に要る。保存後は fetchProperty で取り直す
        //   （同じ画面で2回保存すると2回目が必ず 409 になるため）。
        propertyVersion={property.version}
        canWriteProperty={canWriteProperty}
        // ⚠土地だと分かっている種別以外は建物の道も見せる（@codex #373 R10 P2）。
        //   駐車場・その他・不明は土地とも建物とも決まっていない。
        offerBuildingPath={!isLandPropertyType(property.propertyType)}
        onPropertyRefresh={fetchProperty}
      />

      {/* Warning badge */}
      {!property.investigationConfirmedAt && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-800 dark:bg-amber-950/40">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm text-amber-800 dark:text-amber-300">
            調査情報が未確認です。最新の情報を取得してください。
          </span>
        </div>
      )}

      {/* 品質警告セクション (§8-6): 一覧から外した警告を詳細で表示。ゼロ件=非表示。 */}
      {qualityIssues.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {qualityIssues.map((issue, idx) => (
            <div
              key={idx}
              className={`flex items-start gap-2 rounded-md border px-4 py-2 text-sm ${
                issue.severity === "error"
                  ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                  : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              }`}
            >
              <AlertTriangle
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  issue.severity === "error"
                    ? "text-red-500 dark:text-red-400"
                    : "text-amber-500 dark:text-amber-400"
                }`}
              />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 border-b border-gray-200 dark:border-gray-800">
        <nav className="-mb-px flex gap-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-700 dark:hover:text-gray-200"
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
      <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        {activeTab === "basic" && <BasicTab property={property} onRefresh={fetchProperty} canWrite={canWriteProperty} />}
        {activeTab === "owner" && (
          <OwnerTab
            owners={property.propertyOwners}
            propertyId={property.id}
            canRead={canReadOwner}
            canWrite={canWriteOwner}
            editableFields={ownerEditableFields}
            canCreateMemo={canCreateOwnerMemo}
            corporateLookupConfigured={corporateLookupConfigured}
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
  // 現況ラベルは shared 定数 (src/lib/property-types.ts) から参照
  const OCCUPANCY_LABELS = OCCUPANCY_STATUS_LABELS;

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
          <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            所属マンション
          </dt>
          <dd>
            <Link
              href={`/buildings/${property.building.id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
            >
              <Building2 className="h-4 w-4" />
              {property.building.name}
            </Link>
          </dd>
        </div>
      )}

      <Field label="物件住所" value={property.address} />
      {/* 物件名は集合住宅の種別でのみ入る (任意)。値があるときだけ出す＝
          土地や戸建の詳細に空欄が増えない。 */}
      {property.buildingName && (
        <Field label="物件名" value={property.buildingName} />
      )}
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
        <dt className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
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
  propertyId,
  canRead,
  canWrite,
  editableFields,
  canCreateMemo,
  corporateLookupConfigured,
  onRefresh,
}: {
  owners: ApiPropertyOwner[];
  propertyId: string;
  canRead: boolean;
  canWrite: boolean;
  editableFields: OwnerEditableFields;
  canCreateMemo: boolean;
  corporateLookupConfigured: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  // owner:read がない場合、API は owner を { id } のみで返すため詳細表示・編集は不可。
  // 編集ボタンも出さない（OwnerCard 側の canEditOwner でも防御するが、ここで早期に閉じる）。
  if (!canRead) {
    return (
      <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        所有者情報を閲覧する権限がありません
      </p>
    );
  }

  // 追加導線（既存紐付け / 新規作成して紐付け）は owner:write がある場合のみ。
  // owner:write が無いユーザー（field_staff 等）には導線を一切出さない（canShowAddOwner）。
  const showAdd = canShowAddOwner(canRead, canWrite);
  const isShared = owners.length > 1;

  return (
    <div className="space-y-4">
      {/* 追加導線: 0 件時も既存所有者がいる時も常設（共有名義の追加に対応） */}
      {showAdd && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setLinkModalOpen(true)}
            aria-label="所有者を追加（既存の所有者を紐付け / 新規作成して紐付け）"
            title="この物件に所有者を追加（既存紐付け / 新規作成）"
            className="flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          >
            <UserPlus className="h-3.5 w-3.5" />
            所有者を追加
          </button>
        </div>
      )}

      {owners.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">所有者が紐付けされていません</p>
          {showAdd ? (
            <button
              type="button"
              onClick={() => setLinkModalOpen(true)}
              aria-label="所有者を追加（既存の所有者を紐付け / 新規作成して紐付け）"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <UserPlus className="h-4 w-4" />
              所有者を追加
            </button>
          ) : (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              所有者を追加するには所有者の編集権限（owner:write）が必要です。
            </p>
          )}
        </div>
      ) : (
        <>
          {isShared && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              共有名義: {owners.length} 名（メモは所有者ごと・物件単位で保持されます）
            </p>
          )}
          {owners.map((po, idx) => (
            <OwnerCard
              key={po.id}
              po={po}
              propertyId={propertyId}
              idx={idx}
              total={owners.length}
              canRead={canRead}
              canWrite={canWrite}
              editableFields={editableFields}
              canCreateMemo={canCreateMemo}
              corporateLookupConfigured={corporateLookupConfigured}
              onRefresh={onRefresh}
            />
          ))}
        </>
      )}

      {/* 追加モーダル（owner:write がある時のみ開ける） */}
      {showAdd && linkModalOpen && (
        <OwnerLinkModal
          propertyId={propertyId}
          existingOwnerIds={owners.map((po) => po.ownerId)}
          onClose={() => setLinkModalOpen(false)}
          onLinked={onRefresh}
        />
      )}
    </div>
  );
}

// ---------- Owner card (表示 + インライン編集) ----------

function OwnerCard({
  po,
  propertyId,
  idx,
  total,
  canRead,
  canWrite,
  editableFields,
  canCreateMemo,
  corporateLookupConfigured,
  onRefresh,
}: {
  po: ApiPropertyOwner;
  propertyId: string;
  idx: number;
  total: number;
  canRead: boolean;
  canWrite: boolean;
  editableFields: OwnerEditableFields;
  canCreateMemo: boolean;
  corporateLookupConfigured: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 住所補完の user-edit signal（Codex P2-G）。住所 input をユーザーが直接編集した時だけ
  // true。編集開始（handleEdit）の保存値ロードや候補 apply では立てない＝開いただけで
  // provider へ住所 PII を送らない。
  const [addressEdited, setAddressEdited] = useState(false);
  // 誤紐づき修正モーダル（Phase 2-C）。owner:write 権限がない場合は出さない。
  const [mislinkOpen, setMislinkOpen] = useState(false);

  // email が API レスポンスに含まれているか（hidden の場合キーが存在しない）
  const emailReturned = "email" in po.owner;

  // 少なくとも1項目でも full 編集可能かどうか
  const hasAnyEditable =
    editableFields.name ||
    editableFields.nameKana ||
    editableFields.phone ||
    editableFields.zip ||
    editableFields.address ||
    editableFields.email ||
    editableFields.corporateNumber;

  // 編集ボタン表示条件: canEditOwner pure helper を使用。
  // owner:read がない場合は API レスポンスが { id } のみで version も undefined になるため編集不可。
  const editAllowed = canEditOwner(canRead, canWrite, hasAnyEditable, po.owner.version);

  const [form, setForm] = useState({
    name: po.owner.name ?? "",
    nameKana: po.owner.nameKana ?? "",
    phone: po.owner.phone ?? "",
    zip: po.owner.zip ?? "",
    address: po.owner.address ?? "",
    // ⚠API が返した値で初期化する。返っていない（select 漏れ）と空で初期化され、
    //   そのまま保存して登録済みの現住所を消す。
    currentAddress: po.owner.currentAddress ?? "",
    currentZip: po.owner.currentZip ?? "",
    email: po.owner.email ?? "",
    corporateNumber: po.owner.corporateNumber ?? "",
    companyRegistryNumber: po.owner.companyRegistryNumber ?? "",
  });

  /**
   * 現住所を「登記上住所」と分けて表示しているか。
   *
   * ⚠**既に現住所が入っている所有者は、最初から分けた状態で開く**。
   * 1段（登記上だけ）で開くと、フォームの現住所が空のまま保存され、
   * **登録済みの現住所を消す**。
   */
  const [addressSplit, setAddressSplit] = useState(
    (po.owner.currentAddress ?? "").trim() !== "",
  );

  /**
   * ⚠現住所を「分けて編集」できるのは、住所と郵便番号の**両方**を編集できる人だけ。
   * 現住所を書くことは郵便番号を決め直すこと（空にする場合を含む）でもあるため。
   *
   * ⚠住所しか編集できない人から**登記上の住所の編集を奪わない**。
   * 奪うと、今まで住所を直せていた担当者が何も直せなくなる（この欄は登記上と現住所を
   * 1つの入力で切り替える作りなので、欄ごと隠すと登記上も消える）。
   * その人には**分ける導線だけ出さない**。
   */
  const canSplitCurrentAddress = editableFields.address && editableFields.zip;
  const splitActive = addressSplit && canSplitCurrentAddress;

  const handleEdit = () => {
    setForm({
      name: po.owner.name ?? "",
      nameKana: po.owner.nameKana ?? "",
      phone: po.owner.phone ?? "",
      zip: po.owner.zip ?? "",
      address: po.owner.address ?? "",
      // ⚠編集を開くたびに API の値で組み直す。ここを落とすと、開いて保存しただけで
      //   登録済みの現住所が消える。
      currentAddress: po.owner.currentAddress ?? "",
      currentZip: po.owner.currentZip ?? "",
      email: po.owner.email ?? "",
      corporateNumber: po.owner.corporateNumber ?? "",
      companyRegistryNumber: po.owner.companyRegistryNumber ?? "",
    });
    // ⚠開き直すたびに「分けているか」も現在値から作り直す（現住所があれば分けて開く）。
    setAddressSplit((po.owner.currentAddress ?? "").trim() !== "");
    // 保存値ロードは user-edit ではない＝signal をリセット（開いただけでは検索しない）。
    setAddressEdited(false);
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
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      {/* 見出し: 番号 + 氏名 + バッジ */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-gray-100 pb-3 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          所有者 {idx + 1}
          {total > 1 ? ` / ${total}` : ""}
        </span>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {po.owner.name ?? "（氏名未登録）"}
        </h3>
        {po.isPrimary && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
            主所有者
          </span>
        )}
        {po.relationship && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-200">
            {po.relationship}
          </span>
        )}
        {/* 編集ボタンは canEditOwner (owner:read + owner:write + 編集可能項目あり + version 取得済み) のみ表示 */}
        {editAllowed && !editing && (
          <button
            type="button"
            onClick={handleEdit}
            aria-label={`所有者${idx + 1}/${total} ${po.owner.name ?? "（氏名未登録）"}の所有者情報を編集`}
            title="所有者情報を編集"
            className="ml-auto flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Edit className="h-3 w-3" />
            所有者情報を編集
          </button>
        )}
        {/* 誤紐づき修正ボタン (Phase 2-C): owner:write がある場合のみ表示。
            execute 側で property:write も再検証するため UI 表示条件はゆるく
            owner:write のみ。 */}
        {canWrite && !editing && (
          <button
            type="button"
            onClick={() => setMislinkOpen(true)}
            title="この物件と所有者の紐づきを修正"
            aria-label={`所有者${idx + 1}/${total} ${po.owner.name ?? "（氏名未登録）"}の紐づきを修正`}
            className={`${editAllowed ? "" : "ml-auto"} flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/40`}
          >
            誤紐づき修正
          </button>
        )}
      </div>

      {mislinkOpen && (
        <OwnerMislinkModal
          propertyId={propertyId}
          propertyOwnerId={po.id}
          currentOwnerId={po.ownerId}
          currentOwnerLabel={po.owner.name ?? po.ownerId.slice(0, 8) + "…"}
          onClose={() => setMislinkOpen(false)}
          onExecuted={() => {
            setMislinkOpen(false);
            void onRefresh();
          }}
        />
      )}

      {editing ? (
        /* ── 編集フォーム（full 権限のある項目のみ input を表示） ── */
        <div className="space-y-4">
          {/* 複数物件紐づき警告 */}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              所有者情報の変更は、この所有者が紐付けられているすべての物件に反映されます。
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {editableFields.name && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  所有者名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                />
              </div>
            )}
            {editableFields.nameKana && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  氏名カナ（任意）
                </label>
                <input
                  type="text"
                  value={form.nameKana}
                  onChange={(e) => setForm((f) => ({ ...f, nameKana: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            {editableFields.phone && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">電話番号</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            {editableFields.zip && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  {splitActive ? "郵便番号（現住所）" : "郵便番号"}
                </label>
                <input
                  type="text"
                  value={splitActive ? form.currentZip : form.zip}
                  onChange={(e) =>
                    setForm((f) =>
                      splitActive
                        ? { ...f, currentZip: e.target.value }
                        : { ...f, zip: e.target.value },
                    )
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                {splitActive && (
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500 dark:text-gray-400">
                      郵便番号（登記上）
                    </label>
                    <input
                      type="text"
                      value={form.zip}
                      readOnly
                      className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400"
                    />
                  </div>
                )}
              </div>
            )}
            {editableFields.address && (
              <div className="space-y-1 md:col-span-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-gray-700 dark:text-gray-200">現住所</label>
                  {canSplitCurrentAddress && !splitActive && (
                    <button
                      type="button"
                      // ⚠ホバーで理由を出す（発注者指定の文言）。
                      title="登記上の住所と現在の所在が違う場合はクリックしてください"
                      onClick={() => {
                        // ⚠登記上の住所と郵便番号を**ペアでコピー**して開始する。
                        // 郵便番号をコピーしないと、住所を直さずに保存した時点で
                        // 「宛先は変わっていないのに郵便番号だけ消える」状態になる。
                        setForm((f) => ({
                          ...f,
                          currentAddress: f.address,
                          currentZip: f.zip,
                        }));
                        setAddressSplit(true);
                      }}
                      className="rounded-md border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      ⇅ 現住所を分ける
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={splitActive ? form.currentAddress : form.address}
                  onChange={(e) => {
                    // ユーザーの直接編集＝user-edit signal を立てる（住所検索のトリガー）。
                    setAddressEdited(true);
                    setForm((f) =>
                      splitActive
                        ? {
                            ...f,
                            currentAddress: e.target.value,
                            // ⚠住所を編集した時点で現住所の郵便番号を空にする。
                            // 前の住所に対応した番号を残すと、宛先の解決が
                            // 「新しい住所＋古い郵便番号」というズレたペアを採用する。
                            currentZip: "",
                          }
                        : { ...f, address: e.target.value },
                    );
                  }}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                {addressSplit && !canSplitCurrentAddress && (
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500 dark:text-gray-400">
                      現住所（編集には郵便番号の編集権限が必要です）
                    </label>
                    <input
                      type="text"
                      value={form.currentAddress}
                      readOnly
                      className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400"
                    />
                  </div>
                )}
                {splitActive && (
                  <div className="space-y-1">
                    <label className="text-xs text-gray-500 dark:text-gray-400">登記上住所</label>
                    <input
                      type="text"
                      value={form.address}
                      readOnly
                      className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400"
                    />
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      登記上の住所は取込で入る値です（ここでは変更しません）。DMは現住所へ送ります。
                    </p>
                  </div>
                )}
                {/* 郵便番号⇄住所 補完。zip と address の双方が編集可能なときだけ表示
                    （候補確定で zip/address をペア反映するため）。onZipChange/onAddressChange は
                    form 更新のみ＝addressEdited は立てない（候補 apply で再検索しない）。
                    ⚠分けているときは**現住所側にだけ**効かせる。登記上の欄に効かせると、
                    郵便番号APIの正規化表記で登記の記載を書き換えてしまう。 */}
                {editableFields.zip && editableFields.address && (
                  <AddressLookupControls
                    zip={splitActive ? form.currentZip : form.zip}
                    address={splitActive ? form.currentAddress : form.address}
                    onZipChange={(z) =>
                      setForm((f) =>
                        splitActive ? { ...f, currentZip: z } : { ...f, zip: z },
                      )
                    }
                    onAddressChange={(a) =>
                      setForm((f) =>
                        splitActive
                          ? { ...f, currentAddress: a }
                          : { ...f, address: a },
                      )
                    }
                    addressEdited={addressEdited}
                    disabled={saving}
                    mode="both"
                  />
                )}
                {/* 保存を妨げない注意（番号が分からないまま登録できないと運用が止まるため）。 */}
                {splitActive &&
                  form.currentAddress.trim() !== "" &&
                  form.currentZip.trim() === "" && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      現住所の郵便番号が空です。分かる場合は入れてください（空のままでも保存できます）。
                    </p>
                  )}
              </div>
            )}
            {/* email は full 権限かつ API レスポンスに含まれる場合のみ入力フィールドを表示 */}
            {editableFields.email && emailReturned && (
              <div className="space-y-1 md:col-span-2">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">メールアドレス</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            {/* 法人番号（任意）。13桁数字のみ。クライアント検証: 空 or 13桁数字以外で送信不可。
                サーバ側でも updateOwnerSchema が再度検証する。
                ハイフン・空白・全角数字を含めた入力を許容するため maxLength は付けない
                （送信時に normalizeCorporateNumber が 13桁へ正規化する）。 */}
            {editableFields.corporateNumber && (
              <div className="space-y-1 md:col-span-2">
                <CorporateNumberCandidateBanner
                  owner={po.owner}
                  currentInput={form.corporateNumber}
                  onTransfer={(candidate) =>
                    setForm((f) => ({ ...f, corporateNumber: candidate }))
                  }
                />
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  法人番号（任意 / 13桁）
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.corporateNumber}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, corporateNumber: e.target.value }))
                  }
                  placeholder="例: 1234567890123"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                />
                {/* 赤エラーは「保存ガード/サーバ検証(normalizeCorporateNumber=13桁)で弾かれる入力」と
                    一致させる。13桁は CD 検証せず受理する既存仕様に揃え、有効な12桁(会社法人等番号)は
                    検索/専用欄へ誘導するため赤を出さない。 */}
                {form.corporateNumber.trim() !== "" &&
                  classifyCorporateIdentifier(form.corporateNumber) !==
                    "company_corporate_number_12" &&
                  normalizeCorporateNumber(form.corporateNumber) === null && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      法人番号は13桁の数字で入力してください（12桁の会社法人等番号は下の欄、または「法人情報を検索」をご利用ください）
                    </p>
                  )}
                {/* 法人情報を検索（国税庁 法人番号 Web-API / preview のみ）。
                    Owner.name / Owner.address への自動反映はしない（Phase B のスコープ）。
                    13桁正規化できない場合・lookup capability 無効時はボタンが disabled。 */}
                <CorporateLookupPanel
                  ownerId={po.ownerId}
                  rawCorporateNumber={form.corporateNumber}
                  configured={corporateLookupConfigured}
                  ownerVersion={po.owner.version}
                  fieldEditable={{
                    name: editableFields.name,
                    address: editableFields.address,
                    zip: editableFields.zip,
                    corporateNumber: editableFields.corporateNumber,
                  }}
                  onApplied={async () => {
                    // 反映成功 → 親側で owner を再フェッチし、最新値・version を反映する
                    await onRefresh();
                    setEditing(false);
                  }}
                />
              </div>
            )}

            {/* 会社法人等番号（12桁・登記の番号）。法人番号(13桁)とは別カラム。
                権限は corporateNumber と同じ owner_corporate_number を共用。 */}
            {editableFields.corporateNumber && (
              <div className="space-y-1 md:col-span-2">
                <CompanyRegistryNumberCandidateBanner
                  owner={po.owner}
                  currentRegistryInput={form.companyRegistryNumber}
                  currentSearchInput={form.corporateNumber}
                  onTransferRegistry={(candidate) =>
                    setForm((f) => ({ ...f, companyRegistryNumber: candidate }))
                  }
                  onTransferSearch={(candidate) =>
                    setForm((f) => ({ ...f, corporateNumber: candidate }))
                  }
                />
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  会社法人等番号（任意 / 12桁・登記の番号）
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.companyRegistryNumber}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      companyRegistryNumber: e.target.value,
                    }))
                  }
                  placeholder="例: 123456789012"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                />
                {form.companyRegistryNumber.trim() !== "" &&
                  normalizeCompanyRegistryNumber(form.companyRegistryNumber) ===
                    null && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      会社法人等番号は12桁の数字で入力してください（ハイフン・空白・全角数字は自動で除去されます）
                    </p>
                  )}
                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                  法人番号（13桁）とは別物です。不動産登記の12桁番号をそのまま入力してください。
                </p>
              </div>
            )}
          </div>

          {saveError && (
            <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={
                saving ||
                (editableFields.name && !form.name.trim()) ||
                (editableFields.corporateNumber &&
                  form.corporateNumber.trim() !== "" &&
                  normalizeCorporateNumber(form.corporateNumber) === null) ||
                (editableFields.corporateNumber &&
                  form.companyRegistryNumber.trim() !== "" &&
                  normalizeCompanyRegistryNumber(form.companyRegistryNumber) ===
                    null)
              }
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded-md border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
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
          {(po.owner.currentAddress ?? "").trim() === "" && (
            <OwnerField label="郵便番号" value={po.owner.zip} mono />
          )}
          {emailReturned && (
            <OwnerField label="メールアドレス" value={po.owner.email} />
          )}
          <div className="md:col-span-2">
            {/* ⚠現住所が入っていれば**それを主に出す**（DMはそちらへ送るため）。
                ⚠郵便番号と住所は**必ず組で**出す。現住所の隣に登記上の郵便番号を
                並べると、実際に刷られる宛先を読み違える。 */}
            {(po.owner.currentAddress ?? "").trim() !== "" ? (
              <>
                <OwnerField label="郵便番号（現住所）" value={po.owner.currentZip} mono />
                <OwnerField label="現住所" value={po.owner.currentAddress} />
                <OwnerField label="郵便番号（登記上）" value={po.owner.zip} mono />
                <OwnerField label="登記上住所" value={po.owner.address} />
              </>
            ) : (
              <OwnerField label="現住所" value={po.owner.address} />
            )}
          </div>
          {/* 法人番号: display-level に応じて null（hidden）/ masked / full のいずれかが返る。
              将来 (Phase B) に検索ボタンを置く場所として「現住所」直下に固定配置。 */}
          {po.owner.corporateNumber !== undefined && (
            <div className="md:col-span-2">
              <OwnerField label="法人番号" value={po.owner.corporateNumber ?? null} mono />
            </div>
          )}
          {/* 会社法人等番号(12桁): corporateNumber と同じ display-level でマスク/非表示。 */}
          {po.owner.companyRegistryNumber !== undefined && (
            <div className="md:col-span-2">
              <OwnerField
                label="会社法人等番号"
                value={po.owner.companyRegistryNumber ?? null}
                mono
              />
            </div>
          )}
          {/* 候補検出: corporateNumber 未設定 + name/address に法人番号らしき文字列が含まれる場合のみ表示。
              候補値そのものは表示せず「含まれている」事実のみ伝える（自動上書きはしない）。
              注: po.owner.name / address はマスク済の値が来る可能性があるが、本ヘルパーは
              13桁数字の完全一致パターンを見るのでマスク済値では誤検出しにくい。 */}
          <CorporateNumberSuspectBanner owner={po.owner} />
          {/* 会社法人等番号(12桁) の候補検出（ラベル付きのみ）。値は表示しない。 */}
          <CompanyRegistrySuspectBanner owner={po.owner} />
        </dl>
      )}

      {/* メモ: PropertyOwner 単位（常時表示） */}
      <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800">
        <PropertyOwnerNoteEditor po={po} />
      </div>

      {/* メモ履歴: Owner 単位（追記のみ） */}
      {canRead && (
        <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800">
          <OwnerMemoHistory
            ownerId={po.ownerId}
            propertyId={propertyId}
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
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        メモ（この物件における所有者メモ）
      </dt>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="例: 連絡時間帯、相続関係、現地でのやり取りなど"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => persist(value.trim() === "" ? null : value)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {saving ? "保存中..." : "保存"}
        </button>
        <button
          type="button"
          disabled={saving || (savedValue === "" && value === "")}
          onClick={() => persist(null)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          削除
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        {!error && savedAt && !dirty && !saving && (
          <span className="text-xs text-green-600 dark:text-green-400">保存しました</span>
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
        <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          案件ステータス
        </dt>
        <dd className="text-sm text-gray-900 dark:text-gray-100">{label}</dd>
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
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        案件ステータス
      </dt>
      <dd>
        <select
          value={property.caseStatus}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />}
        {error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
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
        <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          導入ルート
        </dt>
        <dd className="text-sm text-gray-900 dark:text-gray-100">{label}</dd>
      </div>
    );
  }

  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        導入ルート
      </dt>
      <dd>
        <select
          value={property.introductionRoute ?? ""}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">未設定</option>
          {INTRODUCTION_ROUTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {saving && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400 dark:text-gray-500" />}
        {error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span>}
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
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd className={`text-sm text-gray-900 dark:text-gray-100 ${mono ? "font-mono" : ""}`}>
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
      <dt className="mb-1 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd
        className={`text-sm ${hasValue ? "text-gray-900 dark:text-gray-100" : "text-gray-400 dark:text-gray-500"} ${
          mono ? "font-mono" : ""
        }`}
      >
        {hasValue ? value : "未登録"}
      </dd>
    </div>
  );
}

function CorporateNumberSuspectBanner({ owner }: { owner: ApiOwner }) {
  // 法人番号が未設定 + name/address に法人番号らしき文字列が含まれる場合のみ警告表示。
  // 候補値そのものは表示しない（自動上書きしないユーザー確定方針に従う）。
  if (owner.corporateNumber) return null;
  const detection = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  if (detection.candidates.length === 0) return null;
  return (
    <div className="md:col-span-2">
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          氏名・現住所・備考欄に法人番号らしき文字列が含まれています。
          編集モードで「法人番号」欄に転記してください（自動上書きはしません）。
        </div>
      </div>
    </div>
  );
}

/**
 * 編集モード内で、Owner の name/address/note から検出した法人番号候補を
 * ユーザー操作で input に転記するためのバナー。
 *
 * - 候補が無い → 描画しない
 * - owner 本体に法人番号がある → 描画しない（display 側と同方針）
 * - 入力欄に既に何らかの値がある → 描画しない（手入力した別法人番号を誤って上書きしないため）
 * - 候補は最大 3 件まで（dedup 済 / 13桁数字）。
 * - 押下時に form.corporateNumber を上書きするだけで、lookup は自動実行しない（明示性確保）。
 * - 自動保存もしない（保存はユーザーの「保存」操作）。
 */
function CorporateNumberCandidateBanner({
  owner,
  currentInput,
  onTransfer,
}: {
  owner: ApiOwner;
  currentInput: string;
  onTransfer: (candidate: string) => void;
}) {
  // 既に owner 本体に法人番号があるなら検出バナーは出さない（display 側と同方針）。
  if (owner.corporateNumber) return null;
  // 入力欄に何らかの値が入っている時点で候補バナーを完全に隠す。
  // 候補と一致しない別の13桁を手入力済みのケースで、誤って上書きする導線を残さないため
  // (Codex P3 / "Suppress candidate banner once any corporate number is typed")。
  if (currentInput.trim() !== "") return null;
  const detection = detectCorporateNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  const candidates = detection.candidates.slice(0, 3);
  if (candidates.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <div className="mb-1 flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          氏名・現住所・備考欄から法人番号らしき値を検出しました。
          下のボタンを押すと「法人番号」欄に転記します（自動上書き・自動保存・自動検索はしません）。
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onTransfer(c)}
            className="rounded-md border border-amber-300 bg-white px-2 py-0.5 font-mono text-[11px] text-amber-900 hover:bg-amber-100"
          >
            {c} を法人番号欄に転記
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 会社法人等番号(12桁) 検出の display バナー。
 * owner.companyRegistryNumber が未設定 + name/address/note にラベル付き12桁が含まれる場合のみ警告。
 * 候補値そのものは表示しない（自動上書きしないユーザー確定方針）。
 */
function CompanyRegistrySuspectBanner({ owner }: { owner: ApiOwner }) {
  if (owner.companyRegistryNumber) return null;
  const detection = detectCompanyRegistryNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  if (detection.candidates.length === 0) return null;
  return (
    <div className="md:col-span-2">
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          氏名・現住所・備考欄に会社法人等番号（12桁）らしき文字列が含まれています。
          編集モードで「会社法人等番号」欄に転記してください（自動上書きはしません）。
        </div>
      </div>
    </div>
  );
}

/**
 * 編集モード内で、Owner の name/address/note から検出した会社法人等番号(12桁)候補を
 * ユーザー操作で転記/検索するためのバナー（13桁バナーと同方針）。
 *
 * - 候補が無い / owner 本体に会社法人等番号がある / 入力欄に既に値がある → 描画しない。
 * - 候補は最大 3 件（ラベル付き12桁・dedup 済）。候補値そのものは表示する（編集者の確認用）。
 * - 「会社法人等番号欄に転記」: form.companyRegistryNumber を埋める（保存はユーザー操作）。
 * - 「この番号で検索」: 検索欄(form.corporateNumber)に渡す。12桁は lookup で 13桁算出→国税庁検索でき、
 *   反映時に会社法人等番号も保存される（案2）。自動 lookup/保存はしない。
 */
function CompanyRegistryNumberCandidateBanner({
  owner,
  currentRegistryInput,
  currentSearchInput,
  onTransferRegistry,
  onTransferSearch,
}: {
  owner: ApiOwner;
  currentRegistryInput: string;
  /** 検索欄(法人番号 input)の現在値。値があるときは「検索」転記で上書きしない。 */
  currentSearchInput: string;
  onTransferRegistry: (candidate: string) => void;
  onTransferSearch: (candidate: string) => void;
}) {
  if (owner.companyRegistryNumber) return null;
  if (currentRegistryInput.trim() !== "") return null;
  const detection = detectCompanyRegistryNumberInOwnerLike({
    name: owner.name,
    address: owner.address,
    note: owner.note,
  });
  const candidates = detection.candidates.slice(0, 3);
  if (candidates.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <div className="mb-1 flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          氏名・現住所・備考欄から会社法人等番号（12桁）らしき値を検出しました。
          「転記」で会社法人等番号欄へ、「検索」で法人情報の検索（12桁→法人番号13桁）に使えます
          （自動上書き・自動保存・自動検索はしません）。
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {candidates.map((c) => (
          <div key={c} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-amber-900">{c}</span>
            <button
              type="button"
              onClick={() => onTransferRegistry(c)}
              className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-900 hover:bg-amber-100"
            >
              会社法人等番号欄に転記
            </button>
            {currentSearchInput.trim() === "" && (
              <button
                type="button"
                onClick={() => onTransferSearch(c)}
                className="rounded-md border border-blue-300 bg-white px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100"
              >
                この番号で検索
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

