"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { fetchProperties } from "@/lib/api-client";
import { debounce } from "@/lib/debounce";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { SalesSheetPropertyPicker } from "@/components/sales-sheet/SalesSheetPropertyPicker";
import { SalesSheetCreateDialog } from "@/components/sales-sheet/SalesSheetCreateButton";
import NewPropertyModal from "@/components/properties/new-property-modal";
import {
  buildPickerListParams,
  buildPickerRows,
  SALES_SHEET_REGISTRABLE_PROPERTY_TYPES,
  type PickerRow,
} from "@/lib/sales-sheet/picker";
import {
  salesSheetTemplateKindFor,
  type SalesSheetTemplateKind,
} from "@/lib/sales-sheet/template-kind";

/** fetchProperties の pagination は API 経路では unknown 型（api-client 側の型付けの都合）。
 *  properties/page.tsx の `json.pagination as Pagination` と同方針でローカルにキャストする
 *  （lib 側は変更しない）。 */
interface PickerPagination {
  total?: number;
  totalPages?: number;
}

/**
 * 販売図面ピッカー（メニュー「販売図面を作成」の入口）。
 * 図面対応種別の物件を検索して選ぶ → 既存の作成ダイアログ → エディタ。
 * 未登録物件は「新しい物件を登録して作成」→ 登録後そのまま作成ダイアログ。
 */
export default function SalesSheetNewEntryPage() {
  // F12 展開: permissions は ScreenProtectionProvider の配布値から導出し、
  // 本ページ独自の permissions 取得 fetch はしない（properties/[id] と同方針）。
  const {
    permissions: mePermissions,
    permissionsLoading,
    refetchPermissions,
  } = useScreenProtection();

  // 進入時 refresh（mount あたり最大1回・ref ガード＋provider 側 in-flight dedupe の二重防御）。
  const permissionsRefreshRequestedRef = useRef(false);
  const permissionsLoadingAtMountRef = useRef<boolean | null>(null);
  if (permissionsLoadingAtMountRef.current === null) {
    permissionsLoadingAtMountRef.current = permissionsLoading;
  }
  // 進入時 refresh 完了まで stale な権限で作成導線を出さない（fail-safe collapse）。
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: F12 プロバイダ3点セット（進入時 refresh）。properties/[id]/page.tsx と同一パターンで、stale な権限を即座に fail-safe collapse するために必要な同期 setState。
    setPermissionsRefreshPending(true);
    refetchPermissions().finally(() => {
      setPermissionsRefreshPending(false);
    });
  }, [permissionsLoading, mePermissions, refetchPermissions]);

  const canWriteProperty = useMemo(() => {
    const effectivePermissions =
      permissionsRefreshPending || permissionsLoading ? [] : (mePermissions ?? []);
    return effectivePermissions.some(
      (p) => p.resource === "property" && p.action === "write" && p.granted,
    );
  }, [permissionsRefreshPending, permissionsLoading, mePermissions]);

  // 一覧状態
  const [keywordInput, setKeywordInput] = useState("");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const commitKeyword = useMemo(
    () =>
      debounce((value: string) => {
        setSearchText(value);
        setPage(1);
      }, 300),
    [],
  );

  // 応答順の入れ替わりで古い結果が勝たないよう seq でガード。
  const requestSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: 一覧データ取得エフェクトの標準形（properties/page.tsx と同様）。取得開始時に loading/error をリセットする同期 setState。
    setLoading(true);
    setError(null);
    fetchProperties(buildPickerListParams({ keyword: searchText, page }))
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        setRows(buildPickerRows(res.data ?? []));
        const pagination = res.pagination as PickerPagination | undefined;
        setTotal(pagination?.total ?? 0);
        setTotalPages(pagination?.totalPages ?? 1);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return;
        setRows([]);
        // 失敗時は前回成功時の件数/ページ数も破棄する（古いページ送りを出さない・@codex P3）。
        setTotal(0);
        setTotalPages(1);
        setError(err instanceof Error ? err.message : "物件一覧の取得に失敗しました");
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return;
        setLoading(false);
      });
  }, [searchText, page, refreshTick]);

  // 作成ダイアログ / 登録モーダル
  const [selected, setSelected] = useState<{
    id: string;
    kind: SalesSheetTemplateKind;
  } | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const handleSelect = (row: PickerRow) => {
    if (!row.kind) return;
    setSelected({ id: row.id, kind: row.kind });
  };

  // 登録成功 → モーダルを閉じ、一覧を更新し、そのまま作成ダイアログを開く。
  const handleCreated = (id: string, propertyType: string) => {
    setShowRegister(false);
    setRefreshTick((t) => t + 1);
    const kind = salesSheetTemplateKindFor(propertyType);
    if (kind) setSelected({ id, kind });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="販売図面を作成"
        description="販売図面(マイソク)を作る物件を選んでください。"
      />
      <SalesSheetPropertyPicker
        rows={rows}
        canWrite={canWriteProperty}
        keywordInput={keywordInput}
        onKeywordInputChange={(v) => {
          setKeywordInput(v);
          commitKeyword(v);
        }}
        loading={loading}
        error={error}
        page={page}
        totalPages={totalPages}
        total={total}
        onPageChange={setPage}
        onSelect={handleSelect}
        onOpenRegister={() => setShowRegister(true)}
      />

      {selected && (
        <SalesSheetCreateDialog
          key={selected.id}
          propertyId={selected.id}
          kind={selected.kind}
          open
          onClose={() => setSelected(null)}
        />
      )}

      {showRegister && (
        <NewPropertyModal
          onClose={() => setShowRegister(false)}
          typeFilter={[...SALES_SHEET_REGISTRABLE_PROPERTY_TYPES]}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
