"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight, Loader2, Plus, Trash2, AlertTriangle, RotateCcw, Download } from "lucide-react";
import { fetchProperties as apiFetchProperties, bulkUpdateProperties, deleteProperty, fetchQualityCheck, fetchUsers, fetchPropertySuggestions, createSaleDmCampaign, clearSaleDmUndeliverable } from "@/lib/api-client";
import { canCreateSaleDm } from "@/lib/sale-dm-letter/list-ui";
import { debounce } from "@/lib/debounce";
import { EXPORT_COLUMNS } from "@/lib/property-export-columns";
import NewPropertyModal from "@/components/properties/new-property-modal";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import StatusBadge, {
  badgeIntentClass,
  REGISTRY_STATUS_INTENT,
  DM_STATUS_INTENT,
} from "@/components/ui/status-badge";

// ---------- Label maps ----------

import {
  PROPERTY_TYPE_LABELS,
  PROPERTY_TYPE_OPTIONS,
  CASE_STATUS_LABELS,
  CASE_STATUS_OPTIONS,
  INTRODUCTION_ROUTE_LABELS,
  INTRODUCTION_ROUTE_OPTIONS,
  REGISTRY_STATUS_LABELS,
  DM_STATUS_LABELS,
} from "@/lib/property-types";

// v2: バッジ色は共通レシピ(status-badge.tsx)の intent に集約。
// scheduled は yellow → amber(warning)に統一。
// 一覧テーブルのセルは <StatusBadge>(dot 付き)を直接使用。
// サジェストのミニバッジ(独自サイズ)のみ色クラスを参照する。
const dmStatusStyles: Record<string, string> = {
  send: badgeIntentClass(DM_STATUS_INTENT.send),
  no_send: badgeIntentClass(DM_STATUS_INTENT.no_send),
  hold: badgeIntentClass(DM_STATUS_INTENT.hold),
};

// ---------- Types ----------

interface ApiProperty {
  id: string;
  propertyType: string;
  address: string;
  lotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
  registryStatus: string;
  dmStatus: string;
  dmUndeliverableAt?: string | null;
  caseStatus: string;
  introductionRoute?: string | null;
  isArchived: boolean;
  updatedAt: string;
  assignedTo: string | null;
  assignee: { id: string; name: string } | null;
  ownerNames?: string[];
}

interface SuggestResult {
  id: string;
  address: string;
  dmStatus: string;
  importSource: string | null;
  owners: Array<{
    name: string | null;
    address: string | null;
    phone: string | null;
    zip: string | null;
  }>;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------- Component ----------

// Next.js 16 では useSearchParams を使うクライアントコンポーネントを Suspense で
// 包む必要がある。インナーに本体を置き、default export 側で Suspense ラップする。
export default function PropertiesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500 dark:text-gray-400">読み込み中...</div>}>
      <PropertiesPageInner />
    </Suspense>
  );
}

function PropertiesPageInner() {
  const [properties, setProperties] = useState<ApiProperty[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // URL query params (state の初期値とブラウザ更新後の復元に使う)
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Filters — URL から初期化することでブックマーク・更新・共有が可能。
  // searchText: 一覧検索語（/api/properties keyword・URL query に流す）。URL keyword から復元する。
  // searchInput: 候補検索専用の入力中文字列（/api/properties/suggest のみに送る）。
  //   URL keyword は /api/properties 用の確定語なので searchInput には入れない。
  //   入力中の所有者名・電話番号が property_list audit の raw keyword に残らないよう分離する。
  const [searchText, setSearchText] = useState(() => sp.get("keyword") ?? "");
  const [mgmtIdText, setMgmtIdText] = useState(() => sp.get("mgmtId") ?? "");
  // 一覧検索の入力中文字列（即時反映で入力レスポンスを維持）。300ms debounce 後に
  // 確定値 searchText / mgmtIdText へコミットし、/api/properties 再取得・URL同期は
  // その確定値だけで動く（毎キーストロークの再取得＝property_list audit 量産を防ぐ）。
  // URL からの復元値で初期化する。
  const [searchDraft, setSearchDraft] = useState(() => sp.get("keyword") ?? "");
  const [mgmtIdDraft, setMgmtIdDraft] = useState(() => sp.get("mgmtId") ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter, setTypeFilter] = useState(() => sp.get("propertyType") ?? "");
  const [registryFilter, setRegistryFilter] = useState(() => sp.get("registryStatus") ?? "");
  const [dmFilter, setDmFilter] = useState(() => sp.get("dmStatus") ?? "");
  const [caseFilter, setCaseFilter] = useState(() => sp.get("caseStatus") ?? "");
  const [introductionRouteFilter, setIntroductionRouteFilter] = useState(() => sp.get("introductionRoute") ?? "");
  const [assigneeFilter, setAssigneeFilter] = useState(() => sp.get("assignedTo") ?? "");
  const [updatedFromFilter, setUpdatedFromFilter] = useState(() => sp.get("updatedFrom") ?? "");
  const [updatedToFilter, setUpdatedToFilter] = useState(() => sp.get("updatedTo") ?? "");
  const [warningOnly, setWarningOnly] = useState(() => sp.get("hasWarning") === "true");
  const [undeliverableOnly, setUndeliverableOnly] = useState(() => sp.get("undeliverable") === "1");
  // 並び替え。 "<sortBy>:<sortOrder>" を1つの値として保持する。
  const [sort, setSort] = useState<string>(() => sp.get("sort") ?? "updatedAt:desc");
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get("page") ?? "1") || 1));

  // モバイル用フィルタ折りたたみ
  const [showFilters, setShowFilters] = useState(false);

  // CSVエクスポートの列ピッカー。既定=全列選択。ゼロ列選択時は出力ボタンを無効化する。
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [selectedExportColumns, setSelectedExportColumns] = useState<Set<string>>(
    () => new Set(EXPORT_COLUMNS.map((c) => c.key)),
  );

  // 担当者プルダウン用ユーザー一覧
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

  // F12-2(17-C): /api/me/permissions は ScreenProtectionProvider（dashboard 全体を覆う）
  // が mount 時に 1 回取得して context 配布するため、ページ独自の重複 fetch は撤去し
  // provider 配布値から導出する。未取得・取得失敗時は permissions=null → 全て false の
  // まま＝ボタン非表示（従来の「取得失敗時は false」と同じ fail-safe・緩めない）。
  const {
    permissions: mePermissions,
    permissionsLoading,
    refetchPermissions,
    capabilities,
  } = useScreenProtection();

  // F12-2 Codex 対応(2): 権限鮮度の再確認。App Router の layout は client navigation で
  // 保持されるため、provider の mount 時 1 回 fetch だけでは dashboard 滞在中の
  // 権限付与・剥奪に追従できない（旧実装はこのページが mount 毎に独自 fetch して
  // いたため、properties に戻ったタイミングで最新権限を拾えていた）。その鮮度を
  // provider 経由で復元する: このページ進入（mount）あたり最大 1 回だけ
  // refetchPermissions() を呼ぶ。初回の transient 失敗からの復旧導線も兼ねる。
  // - provider の取得が進行中（permissionsLoading）の間は呼ばない＝初回 dashboard
  //   mount 時の fetch と重複させない（同時 2 本に戻さない）。
  // - mount 時に進行中だった取得が成功した場合は、その結果がこのページ進入分の
  //   鮮度を満たすため追加 fetch しない。失敗した場合（permissions===null）は
  //   復旧として 1 回だけ再取得する。
  // - mount 時点で取得完了済みだった場合（client navigation での再訪）は stale の
  //   可能性があるため 1 回だけ再確認する。
  // - ref ガード＋provider 側 in-flight dedupe の二重防御で多重 fetch・無限リトライなし。
  // 再取得失敗時は permissions=null のまま（fail-safe＝ボタン非表示・広げない）。
  // ページは /api/me/permissions を直接 fetch しない（provider 経由のみ）。
  const permissionsRefreshRequestedRef = useRef(false);
  // mount 時点で provider 取得が進行中だったか（初回 render で一度だけ確定する）。
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  // F12-2 Codex 対応(3): 進入時 refresh が完了するまで stale な granted permissions で
  // CSV/DM ボタンを出さない（一瞬表示・クリック可能の回帰防止）。mount 時点で取得
  // 完了済み（= この後 entry refresh が走る）の場合は最初の描画から pending=true で
  // 開始し、旧 page-local fetch 時代の「mount 時は hidden から開始」と同じ挙動にする。
  // refresh 完了（finally）で解除し、最新 permissions からのみ導出する。
  const [permissionsRefreshPending, setPermissionsRefreshPending] = useState(
    () => !permissionsLoading,
  );
  useEffect(() => {
    if (permissionsRefreshRequestedRef.current) return;
    // 進行中は完了を待つ（追加 fetch しない・ref はまだ立てない）。
    if (permissionsLoading) return;
    if (permissionsLoadingAtMountRef.current === true && mePermissions !== null) {
      // mount 時に進行中だった取得が成功 → このページが見ているデータは最新。
      permissionsRefreshRequestedRef.current = true;
      return;
    }
    // mount 時点で取得完了済みだった（stale の可能性）、または mount 時に進行中
    // だった取得が失敗した（permissions===null・復旧）→ 1 回だけ再確認する。
    permissionsRefreshRequestedRef.current = true;
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, mePermissions, refetchPermissions]);

  // CSV 出力可否。export API が csv_export:read と csv_export_personal:read の
  // 両方を必須にしているため、UI 側も同条件で判定し、権限がなければボタンを非表示にする。
  // DM差込CSV の出力可否。dm-export API は csv_export:read / csv_export_personal:read に
  // 加えて owner:read（所有者個人情報を含むため）を必須にする。UI も同条件で判定する。
  const { canExportCsv, canExportDm, canCreateDm, canWriteProperty } = useMemo(() => {
    // F12-2 Codex 対応(3): 進入時 refresh 中（pending）・provider 取得中（loading）は
    // stale な granted permissions を使わず空配列に倒す＝ボタン非表示（fail-safe 側）。
    // refresh 完了後の最新 permissions からのみ true になり得る。
    const effectivePermissions =
      permissionsRefreshPending || permissionsLoading
        ? []
        : (mePermissions ?? []);
    const has = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "read" && p.granted,
      );
    const hasWrite = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "write" && p.granted,
      );
    const canCsv = has("csv_export") && has("csv_export_personal");
    return {
      canExportCsv: canCsv,
      canExportDm: canCsv && has("owner"),
      // 売却DM作成の表示可否(csv_export + csv_export_personal + owner=canExportDm と同条件)。
      canCreateDm: canCreateSaleDm(effectivePermissions),
      // 宛先不明の手動解除は物件を書き換えるため property:write 必須(server も 403 で要求)。
      canWriteProperty: hasWrite("property"),
    };
  }, [permissionsRefreshPending, permissionsLoading, mePermissions]);

  // 入力中候補表示
  const [suggestResults, setSuggestResults] = useState<SuggestResult[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最後に発行した suggest query を記録する。in-flight の古いレスポンスを弾くために使う。
  const suggestQueryRef = useRef<string>("");

  // 警告 (quality-check) を propertyId 単位で集計。
  // /api/properties/quality-check の scoped モード（propertyIds=表示中の物件）を使う（17-C F2）。
  // severity = "info" は粒度が細かいため一覧ではバッジ対象外 (error / warning のみ)。
  const [warningsByProperty, setWarningsByProperty] = useState<
    Map<string, { severity: "error" | "warning"; messages: string[] }>
  >(new Map());
  // 「警告ありのみ」チップに出す全体件数（warningPropertiesTotal=警告あり物件の実数）。
  const [warningPropertyCount, setWarningPropertyCount] = useState(0);

  // モバイルカード: 所有者展開状態（property.id の Set）
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // 一括削除の結果サマリ。null のときは表示しない。
  const [bulkDeleteResult, setBulkDeleteResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; address: string; reason: string }>;
  } | null>(null);

  // 一覧 API / CSV export に渡す検索条件パラメータ（page/limit を除く）。
  // 一覧と export で条件ズレが起きないよう、組み立てを単一関数に集約する。
  // sort ("<sortBy>:<sortOrder>") は API 形式の sortBy / sortOrder に展開する。
  const buildFilterParams = useCallback(() => {
    const params: Record<string, string> = {};
    if (searchText) params.keyword = searchText;
    if (mgmtIdText) params.mgmtId = mgmtIdText;
    if (typeFilter) params.propertyType = typeFilter;
    if (registryFilter) params.registryStatus = registryFilter;
    if (dmFilter) params.dmStatus = dmFilter;
    if (caseFilter) params.caseStatus = caseFilter;
    if (introductionRouteFilter) params.introductionRoute = introductionRouteFilter;
    if (assigneeFilter) params.assignedTo = assigneeFilter;
    if (updatedFromFilter) params.updatedFrom = updatedFromFilter;
    if (updatedToFilter) params.updatedTo = updatedToFilter;
    if (warningOnly) params.hasWarning = "true";
    if (undeliverableOnly) params.undeliverable = "1";
    const [sortBy, sortOrder] = sort.split(":");
    if (sortBy) params.sortBy = sortBy;
    if (sortOrder) params.sortOrder = sortOrder;
    return params;
  }, [searchText, mgmtIdText, typeFilter, registryFilter, dmFilter, caseFilter, introductionRouteFilter, assigneeFilter, updatedFromFilter, updatedToFilter, warningOnly, undeliverableOnly, sort]);

  // 売却促進DM: 現在の検索条件で「送付可」物件から下書きを作成し、作業画面へ遷移する。
  // 差出人は env 既定を route が補完(初版・調整は作業画面)。集計・型は variant 基準。
  const [creatingDm, setCreatingDm] = useState(false);
  const handleCreateSaleDm = async () => {
    if (creatingDm) return;
    // 課金確認: 現在の絞り込み対象の宛先ごとに AI が手紙を生成し、AI利用料金が発生する(オーナー情報を
    // AI提供元へ送信)。実行前に明示確認を取り、サーバーへ confirmed:true を送る(サーバー側でも必須)。
    if (!window.confirm("現在の絞り込み対象に、AIで宛先ごとの手紙を生成します。\nAI利用料金が発生し、オーナー情報がAI提供元へ送信されます。\n続けますか？")) return;
    setCreatingDm(true);
    setError(null);
    try {
      const res = await createSaleDmCampaign({
        name: `売却DM ${new Date().toLocaleDateString("ja-JP")}`,
        options: {
          designTemplate: "formal",
          tone: "formal",
          length: "medium",
          appeal: "price",
          strength: "low",
        },
        filters: buildFilterParams(),
        confirmed: true,
      });
      router.push(`/properties/sale-dm/${res.campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "売却DMの作成に失敗しました");
    } finally {
      setCreatingDm(false);
    }
  };

  // 宛先不明(dmUndeliverableAt)の手動解除。任意で DM 状態を「送付可」に戻す(差し戻し)。物件を書き換えるため
  // property:write 必須(server も 403 で要求)。実行後に一覧を再取得して反映する。
  const [clearingUndelivId, setClearingUndelivId] = useState<string | null>(null);
  const handleClearUndeliverable = async (propertyId: string) => {
    if (clearingUndelivId) return;
    if (!window.confirm("この物件の「宛先不明」を解除しますか？")) return;
    // 解除後の DM 状態は選択式。backend は restoreDmStatus 省略時に dmStatus を据え置く(現状維持)。
    // send を渡したときだけ「送付可」に戻す(再送可能にする)。
    const restore = window.confirm(
      "解除後、この物件のDM状態を「送付可」に戻しますか？\nOK = 送付可に戻す / キャンセル = 現状(送付しない)のまま解除",
    );
    setClearingUndelivId(propertyId);
    setError(null);
    try {
      await clearSaleDmUndeliverable(propertyId, restore ? { restoreDmStatus: "send" } : undefined);
      await fetchProperties();
    } catch (err) {
      setError(err instanceof Error ? err.message : "宛先不明の解除に失敗しました");
    } finally {
      setClearingUndelivId(null);
    }
  };

  const fetchProperties = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params: Record<string, string> = {
      page: String(page),
      limit: "50",
      ...buildFilterParams(),
    };

    try {
      const json = await apiFetchProperties(params);
      setProperties(json.data);
      setPagination(json.pagination as Pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "データ取得に失敗しました");
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }, [page, buildFilterParams]);

  // CSV 出力: 現在の検索条件（buildFilterParams）+ 選択列を引き継いで export API を開く。
  // page/limit は付けないため、条件一致の全件が対象になる。
  // 全列選択時は columns を省略（無指定=全列の後方互換）。1列も無い場合は何もしない
  //（呼び出し側で出力ボタンを無効化済み・防御）。
  const handleExportCsv = () => {
    const selectedKeys = EXPORT_COLUMNS.filter((c) =>
      selectedExportColumns.has(c.key),
    ).map((c) => c.key);
    if (selectedKeys.length === 0) return;

    const params = new URLSearchParams(buildFilterParams());
    if (selectedKeys.length < EXPORT_COLUMNS.length) {
      params.set("columns", selectedKeys.join(","));
    }
    const qs = params.toString();
    setShowColumnPicker(false);
    window.location.href = `/api/properties/export${qs ? `?${qs}` : ""}`;
  };

  const toggleExportColumn = (key: string) => {
    setSelectedExportColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // DM差込CSV の出力: 現在の検索条件を引き継いで dm-export API を開く。
  // サーバ側で dmStatus=send / isArchived=false を強制するため、
  // 画面の dmStatus フィルタが hold/no_send でもそのまま渡してよい。
  const handleExportDm = () => {
    const qs = new URLSearchParams(buildFilterParams()).toString();
    window.location.href = `/api/properties/dm-export${qs ? `?${qs}` : ""}`;
  };

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  // CSV/DM 出力権限の取得は ScreenProtectionProvider の context 配布に集約した
  // （F12-2・上の useMemo を参照）。ページ独自の /api/me/permissions fetch は持たない。

  // 担当者プルダウン用にユーザー一覧を初回のみ取得（失敗時はサイレントに無視）
  useEffect(() => {
    fetchUsers()
      .then((res) => {
        const data = (res as { data?: { id: string; name: string }[] }).data ?? [];
        setUsers(data);
      })
      .catch(() => {});
  }, []);

  // state を URL query params に同期（router.replace なのでページ遷移なし）
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchText) params.set("keyword", searchText);
    if (mgmtIdText) params.set("mgmtId", mgmtIdText);
    if (typeFilter) params.set("propertyType", typeFilter);
    if (registryFilter) params.set("registryStatus", registryFilter);
    if (dmFilter) params.set("dmStatus", dmFilter);
    if (caseFilter) params.set("caseStatus", caseFilter);
    if (introductionRouteFilter) params.set("introductionRoute", introductionRouteFilter);
    if (assigneeFilter) params.set("assignedTo", assigneeFilter);
    if (updatedFromFilter) params.set("updatedFrom", updatedFromFilter);
    if (updatedToFilter) params.set("updatedTo", updatedToFilter);
    if (warningOnly) params.set("hasWarning", "true");
    if (undeliverableOnly) params.set("undeliverable", "1");
    if (sort !== "updatedAt:desc") params.set("sort", sort);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchText, mgmtIdText, typeFilter, registryFilter, dmFilter, caseFilter, introductionRouteFilter, assigneeFilter, updatedFromFilter, updatedToFilter, warningOnly, undeliverableOnly, sort, page, pathname, router]);

  // 警告バッジは「現在ページに表示中の物件」だけに scope して取得する（17-C F2）。
  // properties が変わるたび（page/filter/sort 変更・mutation 後の再取得）に追従するため、
  // 旧 mount 時 1 回方式と違いバッジが stale にならず、ページを跨いだ取りこぼしも起きない
  // （scope 内は常に全件判定＝旧「残りの警告を読み込む」補完は不要になり撤去）。
  // 「警告ありのみ」チップの件数は warningPropertiesTotal（警告あり物件の全体実数）を使う。
  // 失敗してもバッジが出ないだけで一覧本体は表示できる設計（best-effort）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchQualityCheck({
          propertyIds: properties.map((p) => p.id),
        });
        if (cancelled) return;
        const data = (json as {
          data?: Array<{
            propertyId: string;
            severity: "error" | "warning" | "info";
            message: string;
          }>;
        }).data ?? [];
        const next = new Map<
          string,
          { severity: "error" | "warning"; messages: string[] }
        >();
        for (const issue of data) {
          if (issue.severity === "info") continue;
          const cur = next.get(issue.propertyId);
          if (cur) {
            cur.messages.push(issue.message);
            // error が混ざれば error に昇格
            if (issue.severity === "error") cur.severity = "error";
          } else {
            next.set(issue.propertyId, {
              severity: issue.severity,
              messages: [issue.message],
            });
          }
        }
        setWarningsByProperty(next);
        setWarningPropertyCount(
          (json as { warningPropertiesTotal?: number }).warningPropertiesTotal ??
            0,
        );
      } catch {
        // best-effort: 失敗しても無視
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [properties]);

  // 入力中候補: searchInput に 300ms debounce をかけて suggest API を呼ぶ。
  // searchInput は確定検索（/api/properties keyword）には流れないため、
  // 入力中の Owner PII が property_list audit に残らない。
  // stale 対策: レスポンス反映前に query が最新と一致するか確認する。
  // debounce 後に複数リクエストが in-flight になった場合、古いレスポンスで
  // dropdown を上書きしないようにする。
  useEffect(() => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestQueryRef.current = searchInput;
    if (searchInput.length < 2) {
      setSuggestResults([]);
      setSuggestOpen(false);
      return;
    }
    const query = searchInput;
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetchPropertySuggestions(query);
        if (query !== suggestQueryRef.current) return;
        setSuggestResults(res.data);
        setSuggestOpen(res.data.length > 0);
      } catch {
        if (query !== suggestQueryRef.current) return;
        setSuggestResults([]);
        setSuggestOpen(false);
      }
    }, 300);
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, [searchInput]);

  // 一覧検索 (keyword / 管理ID) の確定コミットを 300ms debounce する。
  // 入力ドラフト (searchDraft / mgmtIdDraft) は即時更新し、確定値への反映と
  // page リセットだけを遅延させる。suggest (searchInput) の debounce とは別インスタンス
  // なので互いに干渉しない。setState の identity は安定なので deps は空でよい。
  const commitKeyword = useMemo(
    () =>
      debounce((value: string) => {
        setSearchText(value);
        setPage(1);
      }, 300),
    [],
  );
  const commitMgmtId = useMemo(
    () =>
      debounce((value: string) => {
        setMgmtIdText(value);
        setPage(1);
      }, 300),
    [],
  );
  // アンマウント時に保留中の確定コミットを破棄する。
  useEffect(() => {
    return () => {
      commitKeyword.cancel();
      commitMgmtId.cancel();
    };
  }, [commitKeyword, commitMgmtId]);

  // Debounce search: reset page on filter change
  const handleFilterChange = (setter: (v: string) => void) => (
    e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>,
  ) => {
    setter(e.target.value);
    setPage(1);
  };

  // 全フィルタを一括リセット（並び順は既定に戻し、page=1）
  const handleResetFilters = () => {
    // 保留中の検索 debounce を破棄してからリセットする
    // （後から確定コミットが走って検索語が復活しないように）。
    commitKeyword.cancel();
    commitMgmtId.cancel();
    setSuggestOpen(false);
    setSuggestResults([]);
    setSearchInput("");
    setSearchDraft("");
    setMgmtIdDraft("");
    setSearchText("");
    setMgmtIdText("");
    setTypeFilter("");
    setRegistryFilter("");
    setDmFilter("");
    setCaseFilter("");
    setIntroductionRouteFilter("");
    setAssigneeFilter("");
    setUpdatedFromFilter("");
    setUpdatedToFilter("");
    setWarningOnly(false);
    setUndeliverableOnly(false);
    setSort("updatedAt:desc");
    setPage(1);
  };

  // 何らかのフィルタが効いているか（リセットボタン活性化用）
  const hasActiveFilter =
    !!searchInput || !!searchText || !!searchDraft || !!mgmtIdText || !!mgmtIdDraft || !!typeFilter || !!registryFilter || !!dmFilter ||
    !!caseFilter || !!introductionRouteFilter || !!assigneeFilter || !!updatedFromFilter || !!updatedToFilter ||
    warningOnly || undeliverableOnly || sort !== "updatedAt:desc";

  // アクティブなフィルタ条件数（モバイルトグルバッジ用）
  const activeFilterCount = [
    searchText, mgmtIdText, typeFilter, registryFilter, dmFilter, caseFilter,
    introductionRouteFilter, assigneeFilter, updatedFromFilter, updatedToFilter,
  ].filter(Boolean).length + (warningOnly ? 1 : 0) + (sort !== "updatedAt:desc" ? 1 : 0);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 警告フィルタはサーバ側 (hasWarning=true) で適用する。
  // ここではバッジ表示用に warningsByProperty を併用するだけで、行は filter しない。
  const visibleProperties = properties;

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleProperties.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleProperties.map((p) => p.id)));
    }
  };

  // 物件を一覧から削除する。誤操作防止のため confirm を必須にし、
  // サーバ側の権限制御 + Cascade を踏襲（詳細ページの削除と同じ deleteProperty を再利用）。
  const handleDelete = async (id: string, address: string) => {
    if (deletingId) return;
    if (
      !window.confirm(
        `物件「${address}」を削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      await deleteProperty(id);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await fetchProperties();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeletingId(null);
    }
  };

  // 選択中の物件を一括削除する。既存の単体 deleteProperty を直列ループで再利用し、
  // サーバ側の権限制御 / Cascade をそのまま踏襲する。
  // - 0件選択時はボタン無効
  // - confirm 必須（誤操作防止）
  // - 失敗は ID と住所と日本語メッセージで集計表示
  // - 成功・失敗どちらでも最後に一覧再取得
  const handleBulkDelete = async () => {
    if (bulkDeleting || selectedIds.size === 0) return;
    const targets = properties.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `選択した ${targets.length} 件の物件を削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setError(null);
    setBulkDeleteResult(null);

    let successCount = 0;
    const failures: Array<{ id: string; address: string; reason: string }> = [];

    // 1件ずつ直列で実行（権限・Cascade を個別に評価し、片方の失敗で残りを止めない）
    for (const p of targets) {
      try {
        await deleteProperty(p.id);
        successCount++;
      } catch (err) {
        failures.push({
          id: p.id,
          address: p.address,
          reason: err instanceof Error ? err.message : "削除に失敗しました",
        });
      }
    }

    // 成功した分は選択から外す（失敗したIDだけ残す）
    setSelectedIds(new Set(failures.map((f) => f.id)));
    setBulkDeleteResult({
      successCount,
      failureCount: failures.length,
      failures,
    });

    await fetchProperties();
    setBulkDeleting(false);
  };

  const handleBulkUpdate = async (updates: Record<string, unknown>) => {
    if (selectedIds.size === 0) return;
    setBulkUpdating(true);
    try {
      await bulkUpdateProperties(Array.from(selectedIds), updates);
      setSelectedIds(new Set());
      fetchProperties();
    } catch (err) {
      setError(err instanceof Error ? err.message : "一括更新に失敗しました");
    } finally {
      setBulkUpdating(false);
    }
  };

  return (
    <div className="pt-2">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">物件一覧</h2>
      </div>

      {/* Action row */}
      <div className="mb-4 flex justify-end gap-2">
        {canExportCsv && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColumnPicker((v) => !v)}
              aria-haspopup="true"
              aria-expanded={showColumnPicker}
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
              title="出力する列を選んでCSV出力"
            >
              <Download className="h-4 w-4" />
              CSV出力
            </button>
            {showColumnPicker && (
              <div
                className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-800 dark:bg-gray-900"
                role="dialog"
                aria-label="CSV出力する列の選択"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300">出力する列</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs text-indigo-600 hover:underline"
                      onClick={() =>
                        setSelectedExportColumns(
                          new Set(EXPORT_COLUMNS.map((c) => c.key)),
                        )
                      }
                    >
                      全選択
                    </button>
                    <button
                      type="button"
                      className="text-xs text-gray-500 hover:underline"
                      onClick={() => setSelectedExportColumns(new Set())}
                    >
                      全解除
                    </button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {EXPORT_COLUMNS.map((c) => (
                    <label
                      key={c.key}
                      className="flex cursor-pointer items-center gap-2 py-1 text-sm text-gray-700 dark:text-gray-200"
                    >
                      <input
                        type="checkbox"
                        checked={selectedExportColumns.has(c.key)}
                        onChange={() => toggleExportColumn(c.key)}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                      />
                      {c.header}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={selectedExportColumns.size === 0}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    selectedExportColumns.size === 0
                      ? "1列以上選択してください"
                      : "現在の検索条件で選択列をCSV出力"
                  }
                >
                  <Download className="h-4 w-4" />
                  CSV出力
                </button>
              </div>
            )}
          </div>
        )}
        {canExportDm && (
          <button
            type="button"
            onClick={handleExportDm}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            title="現在の検索条件で送付可の物件をDM差込CSV出力"
          >
            <Download className="h-4 w-4" />
            DM差込CSV出力
          </button>
        )}
        {/* 権限(canCreateDm)に加え、文面生成が設定済み(capabilities.saleDmLetter)のときだけ出す。
            未設定だと押しても 503 になるため導線自体を隠す。 */}
        {canCreateDm && capabilities?.saleDmLetter && (
          <button
            type="button"
            onClick={handleCreateSaleDm}
            disabled={creatingDm}
            className="inline-flex items-center gap-2 rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-400 dark:bg-gray-900 dark:text-indigo-400 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            title="現在の検索条件で送付可の物件から売却DM下書きを作成"
          >
            {creatingDm ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            売却DMを作成
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowNewModal(true)}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          新規物件登録
        </button>
      </div>

      {showNewModal && (
        <NewPropertyModal onClose={() => setShowNewModal(false)} />
      )}

      {/* Filter toggle (mobile only) */}
      <div className="mb-2 md:hidden">
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          絞り込み{activeFilterCount > 0 ? `（${activeFilterCount}）` : ""}
          {showFilters ? " ▴" : " ▾"}
        </button>
      </div>

      {/* Filter bar */}
      <div className={`mb-4 flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 ${showFilters ? "flex" : "hidden"} md:flex`}>
        <select
          value={typeFilter}
          onChange={handleFilterChange(setTypeFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">種別: すべて</option>
          {PROPERTY_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={registryFilter}
          onChange={handleFilterChange(setRegistryFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">登記状況: すべて</option>
          <option value="obtained">取得済</option>
          <option value="unconfirmed">未取得</option>
          <option value="scheduled">取得中</option>
        </select>

        <select
          value={dmFilter}
          onChange={handleFilterChange(setDmFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">DM判断: すべて</option>
          <option value="send">送付可</option>
          <option value="no_send">送付不可</option>
          <option value="hold">未判断</option>
        </select>

        <div className="relative min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="物件住所・地番・家屋番号で一覧検索"
            value={searchDraft}
            onChange={(e) => {
              const value = e.target.value;
              setSearchDraft(value);
              commitKeyword(value);
            }}
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>

        <div className="relative min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="管理IDで検索（例: 受付帳.xlsx:120行 / 120行）"
            value={mgmtIdDraft}
            onChange={(e) => {
              const value = e.target.value;
              setMgmtIdDraft(value);
              commitMgmtId(value);
            }}
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>

        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="所有者名・電話番号で候補を選択して物件を開く"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestOpen && suggestResults.length > 0) {
                  setSuggestOpen(false);
                  router.push(`/properties/${suggestResults[0].id}`);
                } else {
                  setSuggestOpen(false);
                }
              }
            }}
            onBlur={() => setSuggestOpen(false)}
            onFocus={() => { if (suggestResults.length > 0) setSuggestOpen(true); }}
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          {suggestOpen && suggestResults.length > 0 && (
            <ul className="absolute left-0 top-full z-50 mt-1 w-full min-w-[320px] rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900">
              {suggestResults.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSuggestOpen(false);
                      router.push(`/properties/${item.id}`);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-indigo-50 dark:hover:bg-gray-800"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-medium text-gray-800 truncate dark:text-gray-100">{item.address}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${dmStatusStyles[item.dmStatus] ?? badgeIntentClass("neutral")}`}>
                        {DM_STATUS_LABELS[item.dmStatus] ?? item.dmStatus}
                      </span>
                    </div>
                    {item.importSource && (
                      <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500">{item.importSource}</span>
                    )}
                    {item.owners.filter((o) => o.name || o.phone || o.address).map((o, i) => (
                      // 17-A/Codex P2: suggestion 内の所有者PII(name/phone/address)を owner surface に。
                      // button 全体ではなく PII 行(div)のみを最小限で保護する（guard 側で button 祖先でも有効）。
                      <div
                        key={i}
                        className="flex flex-wrap gap-x-2 text-[11px] text-gray-500 dark:text-gray-400"
                        data-pii-protected
                        data-pii-surface="owner"
                      >
                        {o.name && <span>{o.name}</span>}
                        {o.phone && <span>{o.phone}</span>}
                        {o.address && <span className="truncate">{o.address}</span>}
                      </div>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <input
            type="checkbox"
            checked={warningOnly}
            onChange={(e) => {
              setWarningOnly(e.target.checked);
              setPage(1);
            }}
            className="rounded border-amber-300"
          />
          <AlertTriangle className="h-3.5 w-3.5" />
          警告ありのみ
          {warningPropertyCount > 0 && (
            <span className="rounded-full bg-amber-200 px-1.5 text-xs font-semibold">
              {warningPropertyCount}
            </span>
          )}
        </label>

        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          <input
            type="checkbox"
            checked={undeliverableOnly}
            onChange={(e) => {
              setUndeliverableOnly(e.target.checked);
              setPage(1);
            }}
            className="rounded border-red-300"
          />
          宛先不明のみ
        </label>

        <select
          value={caseFilter}
          onChange={handleFilterChange(setCaseFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">案件ステータス: すべて</option>
          {CASE_STATUS_OPTIONS.map(({ value: v, label }) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={introductionRouteFilter}
          onChange={handleFilterChange(setIntroductionRouteFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">導入ルート: すべて</option>
          {INTRODUCTION_ROUTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          title="並び替え"
        >
          <option value="updatedAt:desc">更新日 新しい順</option>
          <option value="updatedAt:asc">更新日 古い順</option>
          <option value="caseStatus:asc">案件ステータス順</option>
          <option value="address:asc">住所昇順</option>
        </select>

        <select
          value={assigneeFilter}
          onChange={handleFilterChange(setAssigneeFilter)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          title="担当者"
        >
          <option value="">担当者: すべて</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
          更新日:
          <input
            type="date"
            value={updatedFromFilter}
            onChange={handleFilterChange(setUpdatedFromFilter)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            title="更新日（開始）"
          />
          <span className="text-gray-400 dark:text-gray-500">〜</span>
          <input
            type="date"
            value={updatedToFilter}
            onChange={handleFilterChange(setUpdatedToFilter)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            title="更新日（終了）"
          />
        </label>

        <button
          type="button"
          onClick={handleResetFilters}
          disabled={!hasActiveFilter}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          title="全フィルタをリセット"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          リセット
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button
            onClick={fetchProperties}
            className="ml-2 text-red-800 underline hover:no-underline"
          >
            再試行
          </button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <span className="text-sm font-medium text-blue-800">
            {selectedIds.size} 件選択中
          </span>
          <select
            disabled={bulkUpdating}
            onChange={(e) => {
              if (e.target.value) {
                handleBulkUpdate({ caseStatus: e.target.value });
                e.target.value = "";
              }
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="">案件ステータス変更...</option>
            {CASE_STATUS_OPTIONS.map(({ value: v, label }) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <select
            disabled={bulkUpdating}
            onChange={(e) => {
              if (e.target.value) {
                handleBulkUpdate({ dmStatus: e.target.value });
                e.target.value = "";
              }
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="">DM判断変更...</option>
            <option value="send">送付可</option>
            <option value="no_send">送付不可</option>
            <option value="hold">未判断</option>
          </select>
          <button
            type="button"
            disabled={bulkDeleting || bulkUpdating}
            onClick={handleBulkDelete}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {bulkDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            選択した物件を削除
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkDeleting}
            className="ml-auto text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            選択解除
          </button>
        </div>
      )}

      {/* Bulk delete result */}
      {bulkDeleteResult && (
        <div
          className={`mb-4 rounded-lg border p-3 text-sm ${
            bulkDeleteResult.failureCount === 0
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              一括削除結果: 成功 <b>{bulkDeleteResult.successCount}</b> 件 / 失敗{" "}
              <b>{bulkDeleteResult.failureCount}</b> 件
            </div>
            <button
              onClick={() => setBulkDeleteResult(null)}
              className="text-xs underline hover:no-underline"
            >
              閉じる
            </button>
          </div>
          {bulkDeleteResult.failures.length > 0 && (
            <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-xs">
              {bulkDeleteResult.failures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.address}</span>
                  <span className="ml-2 text-amber-700">{f.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Table (PC のみ: md: 以上) */}
      <div className="hidden md:block overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
              <tr>
                <th className="whitespace-nowrap px-2 py-3">
                  <input
                    type="checkbox"
                    checked={
                      properties.length > 0 &&
                      selectedIds.size === properties.length
                    }
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  種別
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  所有者
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  住所
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  地番
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  登記状況
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  DM判断
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  案件状況
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  担当者
                </th>
                <th className="whitespace-nowrap px-4 py-3 font-medium text-gray-600 dark:text-gray-300">
                  更新日
                </th>
                <th className="whitespace-nowrap px-2 py-3 font-medium text-gray-600 dark:text-gray-300">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {visibleProperties.map((property) => {
                const warning = warningsByProperty.get(property.id);
                return (
                <tr
                  key={property.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                  onClick={(e) => {
                    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    if ((e.target as HTMLElement).closest("a, button, input, label, select, textarea")) return;
                    router.push(`/properties/${property.id}`);
                  }}
                >
                  <td className="whitespace-nowrap px-2 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(property.id)}
                      onChange={() => toggleSelect(property.id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link
                      href={`/properties/${property.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      {PROPERTY_TYPE_LABELS[property.propertyType] ??
                        property.propertyType}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
                    {/* 17-A: 所有者名 PII を copy/cut/contextmenu 抑止＋監査の対象に含める。
                        行全体ではなく所有者名セルの表示範囲のみ最小限で囲む。 */}
                    <span data-pii-protected data-pii-surface="owner">
                      {(property.ownerNames ?? []).length > 0
                        ? (property.ownerNames ?? []).join("、")
                        : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {warning && (
                      <span
                        title={warning.messages.join("\n")}
                        className={`mr-2 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold align-middle ${
                          warning.severity === "error"
                            ? badgeIntentClass("error")
                            : badgeIntentClass("warning")
                        }`}
                      >
                        <AlertTriangle className="h-3 w-3" />
                        {warning.severity === "error" ? "要対応" : "警告"}
                        {warning.messages.length > 1 && (
                          <span>×{warning.messages.length}</span>
                        )}
                      </span>
                    )}
                    <Link
                      href={`/properties/${property.id}`}
                      className="hover:text-indigo-600"
                    >
                      {property.address}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {property.lotNumber ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <StatusBadge
                      intent={REGISTRY_STATUS_INTENT[property.registryStatus] ?? "neutral"}
                    >
                      {REGISTRY_STATUS_LABELS[property.registryStatus] ??
                        property.registryStatus}
                    </StatusBadge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <StatusBadge
                      intent={DM_STATUS_INTENT[property.dmStatus] ?? "neutral"}
                    >
                      {DM_STATUS_LABELS[property.dmStatus] ??
                        property.dmStatus}
                    </StatusBadge>
                    {/* 返送(宛先不明)連動で立った dmUndeliverableAt の可視化 + 手動解除(write 権限時) */}
                    {property.dmUndeliverableAt && (
                      <span className="ml-1 inline-flex items-center gap-1">
                        <span className="inline-block rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                          宛先不明
                        </span>
                        {canWriteProperty && (
                          <button
                            type="button"
                            onClick={() => handleClearUndeliverable(property.id)}
                            disabled={clearingUndelivId === property.id}
                            aria-label="宛先不明を解除"
                            className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                          >
                            解除
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="text-xs text-gray-600 dark:text-gray-300">
                      {CASE_STATUS_LABELS[property.caseStatus] ??
                        property.caseStatus}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {property.assignee?.name ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500 dark:text-gray-400">
                    {new Date(property.updatedAt).toLocaleDateString("ja-JP")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      title="この物件を削除"
                      disabled={deletingId === property.id}
                      onClick={() => handleDelete(property.id, property.address)}
                      className="inline-flex items-center justify-center rounded-md p-1.5 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingId === property.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                </tr>
                );
              })}
              {visibleProperties.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-4 py-8 text-center text-gray-500 dark:text-gray-400"
                  >
                    {warningOnly
                      ? "警告ありの物件はありません"
                      : "該当する物件が見つかりません"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Card list (モバイル専用: md: 未満) */}
      <div className="md:hidden mt-2 flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">読み込み中...</span>
          </div>
        ) : visibleProperties.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 px-4 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
            {warningOnly
              ? "警告ありの物件はありません"
              : "該当する物件が見つかりません"}
          </div>
        ) : (
          visibleProperties.map((property) => {
            const owners = property.ownerNames ?? [];
            const OWNER_PREVIEW = 3;
            const hasMore = owners.length > OWNER_PREVIEW;
            const isExpanded = expandedOwners.has(property.id);
            const visibleOwners = isExpanded ? owners : owners.slice(0, OWNER_PREVIEW);
            return (
              <div
                key={property.id}
                className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                onClick={(e) => {
                  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  if ((e.target as HTMLElement).closest("a, button, input, label, select, textarea")) return;
                  router.push(`/properties/${property.id}`);
                }}
              >
                {/* カード上部: チェックボックス + 種別 + 住所 */}
                <div className="flex items-start gap-3 px-4 pt-4 pb-2">
                  <div
                    className="mt-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(property.id)}
                      onChange={() => toggleSelect(property.id)}
                      className="rounded border-gray-300"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <Link href={`/properties/${property.id}`} className="block">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-indigo-600">
                          {PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType}
                        </span>
                      </div>
                      <p className="text-sm text-gray-900 dark:text-gray-100 break-all">
                        {property.address}
                      </p>
                    </Link>
                  </div>
                </div>

                {/* 所有者 */}
                <div className="px-4 pb-2">
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">所有者</p>
                  <div
                    data-pii-protected
                    data-pii-surface="owner"
                  >
                    {owners.length === 0 ? (
                      <span className="text-sm text-gray-500 dark:text-gray-400">—</span>
                    ) : (
                      <>
                        {visibleOwners.map((name, i) => (
                          <p key={i} className="text-sm text-gray-900 dark:text-gray-100">
                            {name}
                          </p>
                        ))}
                        {hasMore && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedOwners((prev) => {
                                const next = new Set(prev);
                                if (next.has(property.id)) next.delete(property.id);
                                else next.add(property.id);
                                return next;
                              });
                            }}
                            className="mt-1 inline-flex items-center min-h-[44px] py-2 text-xs text-indigo-600 hover:underline"
                          >
                            {isExpanded
                              ? "▴ 折りたたむ"
                              : `他${owners.length - OWNER_PREVIEW}名 ▾`}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* 状況: 登記 / DM / 案件 */}
                <div className="px-4 pb-4 flex flex-wrap items-center gap-2">
                  <StatusBadge
                    intent={REGISTRY_STATUS_INTENT[property.registryStatus] ?? "neutral"}
                  >
                    {REGISTRY_STATUS_LABELS[property.registryStatus] ?? property.registryStatus}
                  </StatusBadge>
                  <StatusBadge
                    intent={DM_STATUS_INTENT[property.dmStatus] ?? "neutral"}
                  >
                    {DM_STATUS_LABELS[property.dmStatus] ?? property.dmStatus}
                  </StatusBadge>
                  {/* 宛先不明バッジ + 手動解除(モバイルカードでも表示・write 権限時にボタン) */}
                  {property.dmUndeliverableAt && (
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        宛先不明
                      </span>
                      {canWriteProperty && (
                        <button
                          type="button"
                          onClick={() => handleClearUndeliverable(property.id)}
                          disabled={clearingUndelivId === property.id}
                          aria-label="宛先不明を解除"
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          解除
                        </button>
                      )}
                    </span>
                  )}
                  <span className="text-xs text-gray-600 dark:text-gray-300">
                    {CASE_STATUS_LABELS[property.caseStatus] ?? property.caseStatus}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 w-full flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-8">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {pagination.total} 件中{" "}
          {pagination.total > 0
            ? `${(pagination.page - 1) * pagination.limit + 1}〜${Math.min(pagination.page * pagination.limit, pagination.total)}`
            : "0"}{" "}
          件表示
        </p>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className={`flex min-h-[44px] items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 ${
              page <= 1
                ? "text-gray-400 cursor-not-allowed dark:text-gray-500"
                : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
            }`}
          >
            <ChevronLeft className="h-4 w-4" />
            前へ
          </button>
          <span className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">
            {page}
          </span>
          {pagination.totalPages > 1 && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              / {pagination.totalPages}
            </span>
          )}
          <button
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className={`flex min-h-[44px] items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700 ${
              page >= pagination.totalPages
                ? "text-gray-400 cursor-not-allowed dark:text-gray-500"
                : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
            }`}
          >
            次へ
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
