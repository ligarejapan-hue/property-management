"use client";

// Phase F: 単一 Owner の法人番号補正ページ。
//
// /admin/owners/[id] — Phase E の法人番号候補一覧の detailUrl 遷移先。
// 目的: 1 Owner ずつ確認のうえ補正できる導線を提供。
//
// 設計上の不変条件:
// - 一括補正・自動 lookup・自動 apply は実装しない
// - 候補法人番号を URL query で渡さない（ページ側で再検出 API を叩く）
// - 法人番号は display-level に従い、full のみ生値、edit/read/masked/partial はマスク
// - owner_corporate_number=hidden の場合は API が 403 を返す → セクション非表示
// - 既存 CorporateLookupPanel を再利用し、lookup → preview → apply の Phase B/C
//   フローに誘導する。Panel 自体は変更しない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, Loader2 } from "lucide-react";
import {
  fetchAdminOwnerCorporateCandidate,
  fetchProperties,
  type AdminOwnerCorporateCandidateResponse,
} from "@/lib/api-client";
import CorporateLookupPanel from "@/components/owners/corporate-lookup-panel";
import CorporateCleanupPanel from "@/components/owners/corporate-cleanup-panel";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";
import { ownerFilteredPropertyListHref } from "@/lib/owner-property-link";

type FieldEditable = {
  name: boolean;
  address: boolean;
  zip: boolean;
  corporateNumber: boolean;
};

const TYPE_LABEL: Record<string, string> = {
  missing: "未登録（候補1件）",
  conflict: "既存値と競合",
  multi: "複数候補（自動転記不可）",
  same: "一致（登録済 / 参考）",
};

const TYPE_BADGE: Record<string, string> = {
  missing: "bg-yellow-100 text-yellow-800 border-yellow-300",
  conflict: "bg-red-100 text-red-700 border-red-300",
  multi: "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700",
  same: "bg-green-100 text-green-700 border-green-300",
};

const DETECTED_IN_LABEL: Record<string, string> = {
  name: "氏名",
  address: "登記上住所",
  note: "メモ",
};

export default function AdminOwnerDetailPage() {
  const params = useParams<{ id: string }>();
  const ownerId = params?.id ?? "";

  const [data, setData] =
    useState<AdminOwnerCorporateCandidateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // permissions / lookup capability は ScreenProtectionProvider（dashboard 全体を覆う）が
  // mount 時に 1 回取得して context 配布するため、本ページ独自の /api/me/permissions
  // fetch は撤去し、provider 配布値（permissions / capabilities）から導出する
  // （properties 一覧 F12-2・field-survey-map 19-A と同方針）。
  // fail-safe: 未取得・取得失敗（permissions=null / capabilities=null）は「権限なし・
  // 機能なし」扱いに倒す（owner full/edit は全 false＝編集・照会 UI 非表示、
  // corporateLookup は false）。緩めない。owner full/edit は boolean ゲートのため
  // field-survey の tristate null ではなく properties 一覧型の制限的 collapse を使う。
  const {
    permissions: mePermissions,
    capabilities: meCapabilities,
    permissionsLoading,
    refetchPermissions,
  } = useScreenProtection();

  // 進入時 refresh（properties 一覧・field-survey-map と同方針）: App Router の layout は
  // client navigation で保持されるため、provider の mount 時 1 回 fetch だけでは dashboard
  // 滞在中の権限付与・剥奪に追従できない。進入（mount）あたり最大 1 回だけ
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
  // 進入時 refresh 完了まで stale な権限・capability で編集/照会 UI を出さない。mount 時点で
  // 取得完了済み（= この後 refresh が走る）なら最初の描画から pending=true で開始する。
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
  // 進入時 refresh 中（pending）・provider 取得中（loading）は空配列 / false に倒す
  // ＝refresh 完了後の最新値からのみ編集/照会 UI を出す（stale 権限表示防止・fail-safe 側）。
  // owner full/edit と corporateLookup の判定ロジック自体は従来どおり（緩めない）。
  const { fieldEditable, corporateLookupConfigured } = useMemo<{
    fieldEditable: FieldEditable;
    corporateLookupConfigured: boolean;
  }>(() => {
    const effectivePermissions =
      permissionsRefreshPending || permissionsLoading
        ? []
        : (mePermissions ?? []);
    const effectiveCorporateLookup =
      permissionsRefreshPending || permissionsLoading
        ? false
        : meCapabilities?.corporateLookup === true;
    const hasFullPerm = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "full" && p.granted,
      );
    const hasEditPerm = (resource: string) =>
      effectivePermissions.some(
        (p) => p.resource === resource && p.action === "edit" && p.granted,
      );
    return {
      fieldEditable: {
        name: hasFullPerm("owner_name"),
        address: hasFullPerm("owner_address"),
        zip: hasFullPerm("owner_zip"),
        corporateNumber:
          hasFullPerm("owner_corporate_number") ||
          hasEditPerm("owner_corporate_number"),
      },
      corporateLookupConfigured: effectiveCorporateLookup,
    };
  }, [permissionsRefreshPending, permissionsLoading, mePermissions, meCapabilities]);
  // 法人番号入力欄（CorporateLookupPanel に渡す）
  // 初期値は existing 法人番号 → なければ missing 候補値（共にマスク済）
  const [corporateInput, setCorporateInput] = useState("");

  // Codex P2 流の stale guard（Phase E 法人番号タブと同じ防御）
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const myReqId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetchAdminOwnerCorporateCandidate(ownerId);
      if (!mountedRef.current || myReqId !== requestIdRef.current) return;
      setData(res);
      // Codex P1: 別 Owner 詳細へ遷移したり reload した際に、前 Owner の
      // corporateInput が残って CorporateLookupPanel で誤適用されるのを防ぐ。
      // 最新リクエストでない場合は上の return で抜けているため、ここでの
      // 初期化は常に「現 Owner の load 結果」に対してのみ行われる。
      //
      // 入力欄初期値: existing が full 権限で生値返ってきた場合のみ採用。
      // マスク値 (XXXX*** 形式) や null は normalizeCorporateNumber で 13桁化
      // できないので絶対に入れない。candidate の missing も同様。
      setCorporateInput("");
      const existing = res.owner.existingCorporateNumberMasked;
      if (existing && /^\d{13}$/.test(existing)) {
        setCorporateInput(existing);
      } else if (
        res.candidate?.type === "missing" &&
        res.candidate.candidateCorporateNumberMasked &&
        /^\d{13}$/.test(res.candidate.candidateCorporateNumberMasked)
      ) {
        setCorporateInput(res.candidate.candidateCorporateNumberMasked);
      }
    } catch (e) {
      if (!mountedRef.current || myReqId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      setData(null);
    } finally {
      if (mountedRef.current && myReqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [ownerId]);

  useEffect(() => {
    load();
  }, [load]);

  // 紐づく物件。専用APIは作らず物件一覧APIを所有者で絞って呼ぶ＝
  // 担当者スコープと権限をそのまま継承する(見えない物件がここだけ見える、を防ぐ)。
  //
  // ⚠取得結果は「どの ownerId に対する結果か」を一緒に保持する(loadedForOwnerId)。
  // App Router は動的セグメントが変わるだけではこのコンポーネントを再マウントしない
  // ので、owner→owner の client 遷移では旧 ownerId の結果が state に残ったまま
  // 次の owner の画面に見えてしまう(stale)。effect の先頭で同期的に state を
  // クリアする直し方は react-hooks/set-state-in-effect に触れるため使わない。
  // 代わりに「今の ownerId と結果の loadedForOwnerId が一致するときだけ結果とみなす」
  // 形にし、setState は非同期コールバック内で1回だけ行う。
  const [linkedResult, setLinkedResult] = useState<{
    loadedForOwnerId: string;
    properties: Array<{ id: string; address: string; lotNumber: string | null }>;
    total: number;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchProperties({ ownerId, limit: "20" });
        if (cancelled) return;
        setLinkedResult({
          loadedForOwnerId: ownerId,
          properties:
            (res.data as Array<{ id: string; address: string; lotNumber: string | null }>) ??
            [],
          total: (res.pagination as { total?: number } | undefined)?.total ?? 0,
          failed: false,
        });
      } catch {
        // 一覧が出ないだけで所有者詳細そのものは使える(best-effort)。
        // ただし「0件です」と偽らないよう failed を別途持つ(Finding 3)。
        if (!cancelled) {
          setLinkedResult({
            loadedForOwnerId: ownerId,
            properties: [],
            total: 0,
            failed: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  // 今の ownerId 宛ての結果でなければ「未取得(読み込み中)」として扱う。
  // これにより owner 切り替え直後は前 owner の一覧が一瞬たりとも見えない。
  const linkedLoaded = linkedResult?.loadedForOwnerId === ownerId;
  const linkedProperties = linkedLoaded ? linkedResult!.properties : [];
  const linkedTotal = linkedLoaded ? linkedResult!.total : 0;
  const linkedFailed = linkedLoaded ? linkedResult!.failed : false;

  const owner = data?.owner;
  const candidate = data?.candidate;

  return (
    <div className="p-6">
      {/* Header(第2弾⑧⑩: PageHeader+「← ◯◯一覧へ戻る」に統一) */}
      <PageHeader
        back={{
          href: "/admin/owners/correction?tab=corporate_number",
          to: "補正候補一覧",
        }}
        title={
          <>
            所有者詳細
            {owner && (
              <span className="ml-2 align-middle font-mono text-[11px] font-normal text-gray-400 dark:text-gray-500">
                {owner.ownerId.slice(0, 8)}…
              </span>
            )}
          </>
        }
      />

      {loading && (
        <p className="flex items-center gap-2 py-8 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          読み込み中...
        </p>
      )}

      {error && !loading && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && owner && (
        <div className="space-y-6">
          {/* 所有者概要カード */}
          <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              所有者概要
            </h2>
            {/* 17-A: masked 値であっても所有者 PII 面として copy/cut/contextmenu 抑止＋監査の対象にする。 */}
            <dl
              className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2"
              data-pii-protected
              data-pii-surface="owner"
            >
              <Field label="氏名" value={owner.ownerNameMasked} />
              <Field
                label="既存法人番号"
                value={owner.existingCorporateNumberMasked}
                mono
              />
              {/* ⚠「現住所」は引っ越し先の住所を指す言葉になった。登記上の住所を
                  そう呼ぶと、どちらを直しているのか分からなくなる。 */}
              <div className="md:col-span-2">
                <Field label="登記上住所" value={owner.ownerAddressMasked} />
              </div>
              <div className="md:col-span-2">
                <Field
                  label="現住所"
                  value={owner.ownerCurrentAddressMasked ?? "（未設定＝登記上へ送る）"}
                />
              </div>
              <Field label="バージョン" value={String(owner.version)} mono />
              <Field
                label="紐づき物件数"
                value={String(owner.propertyOwnerCount)}
                mono
              />
            </dl>
            <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
              <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
                紐づく物件
              </h3>
              {!linkedLoaded ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  読み込んでいます…
                </p>
              ) : linkedFailed ? (
                // Finding 3: 取得失敗を「0件です」と偽らない。物件が無い所有者と
                // 一覧が読めなかった所有者は、統合判断の材料として意味が違う。
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  物件一覧を読み込めませんでした
                </p>
              ) : linkedProperties.length === 0 && owner.propertyOwnerCount > 0 ? (
                // P2 (外部レビュー): 上の「紐づき物件数」は可視範囲スコープ対象外の
                // 件数なので、担当外の物件しか無い所有者ではここが0件のまま
                // 「紐づく物件はありません」と出て件数表示と矛盾していた。
                // 件数>0なのに一覧が空のときは「無い」ではなく「見えない」と伝える。
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  紐づく物件はありますが、担当範囲外のため表示できません
                </p>
              ) : linkedProperties.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  紐づく物件はありません
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {linkedProperties.map((p) => (
                    <li key={p.id} className="text-xs">
                      <Link
                        href={`/properties/${p.id}`}
                        className="text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
                      >
                        {/* 住所は行(a)が button 同様に screen-protection の container
                            方式から除外されるため、明示 span で保護する
                            (SalesSheetPropertyPicker と同方式)。所有者面ではなく
                            物件面: ここに載るのは物件住所であって所有者住所ではない。 */}
                        <span data-pii-protected data-pii-surface="property">
                          {p.address}
                          {p.lotNumber ? ` ${p.lotNumber}` : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {linkedLoaded && !linkedFailed && linkedTotal > linkedProperties.length && (
                <Link
                  href={ownerFilteredPropertyListHref(ownerId)}
                  className="mt-2 inline-block text-xs text-blue-700 underline underline-offset-2 dark:text-blue-300"
                >
                  すべて見る（{linkedTotal}件）
                </Link>
              )}
            </div>
          </section>

          {/* 法人番号補正セクション */}
          <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              法人番号補正
            </h2>

            {/* 候補バナー */}
            {candidate ? (
              <div
                data-testid="corporate-candidate-banner"
                className={`mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                  TYPE_BADGE[candidate.type] ?? "bg-gray-50 border-gray-200"
                }`}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="space-y-1">
                  <div className="font-medium">
                    {TYPE_LABEL[candidate.type] ?? candidate.type}
                  </div>
                  <div className="font-mono text-[11px]">
                    検出候補:{" "}
                    {candidate.candidateCorporateNumberMasked ?? (
                      candidate.candidateCount === "many" ? "複数" : "—"
                    )}
                  </div>
                  <div className="text-[11px]">
                    検出箇所:{" "}
                    {candidate.detectedIn
                      .map((f) => DETECTED_IN_LABEL[f] ?? f)
                      .join(" / ")}
                  </div>
                  {candidate.type === "missing" &&
                    candidate.candidateCorporateNumberMasked &&
                    /^\d{13}$/.test(
                      candidate.candidateCorporateNumberMasked,
                    ) && (
                      <button
                        type="button"
                        onClick={() =>
                          setCorporateInput(
                            candidate.candidateCorporateNumberMasked ?? "",
                          )
                        }
                        className="mt-1 inline-flex rounded-md border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
                      >
                        法人番号欄に転記
                      </button>
                    )}
                  {candidate.type === "conflict" && (
                    <div className="text-[11px] text-red-700">
                      既存値と異なるため、手動で確認してください（自動上書きしません）。
                    </div>
                  )}
                  {candidate.type === "multi" && (
                    <div className="text-[11px] text-gray-700 dark:text-gray-200">
                      複数候補が検出されたため、自動転記できません。
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                法人番号候補は検出されませんでした。
              </p>
            )}

            {/* 法人番号入力欄 + CorporateLookupPanel */}
            {fieldEditable.corporateNumber ? (
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  法人番号（13桁）
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={corporateInput}
                  onChange={(e) => setCorporateInput(e.target.value)}
                  placeholder="例: 1234567890123"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 md:w-80 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 dark:placeholder:text-gray-500"
                />
                <CorporateLookupPanel
                  ownerId={owner.ownerId}
                  rawCorporateNumber={corporateInput}
                  configured={corporateLookupConfigured}
                  ownerVersion={owner.version}
                  fieldEditable={fieldEditable}
                  onApplied={async () => {
                    await load();
                  }}
                />
                <CorporateCleanupPanel
                  ownerId={owner.ownerId}
                  onApplied={async () => {
                    await load();
                  }}
                />
              </div>
            ) : (
              <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                法人番号の編集権限がありません。
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd
        className={mono ? "font-mono text-gray-900 dark:text-gray-100" : "text-gray-900 dark:text-gray-100"}
        data-field={label}
      >
        {value ?? <span className="text-gray-400 dark:text-gray-500">—</span>}
      </dd>
    </div>
  );
}
