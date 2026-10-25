"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Save, Search, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, errorText, type DealOptions } from "@/lib/deals/client";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_TRADE_SIDE_LABELS } from "@/lib/deals/constants";
import { searchProperties } from "@/lib/api-client";
import { CASE_STATUS_LABELS, PROPERTY_TYPE_LABELS } from "@/lib/property-types";

/**
 * 新しい取引(設計 §5)。物件は「物件の一覧から選ぶ」か「手で入力する」を選ぶ。
 * 一覧から選んだとき(?propertyId= で来たときも)は物件から作る(写しと種別はサーバーが物件から入れる)。
 * 手で入力するときは物件の中身を作ったあと「物件」タブで入れる。
 * useSearchParams を使うため、中身は Suspense の内側に置く(build の静的生成で必要)。
 */
export default function NewDealPage() {
  return (
    <Suspense>
      <NewDealForm />
    </Suspense>
  );
}

function NewDealForm() {
  const router = useRouter();
  const initialPropertyId = useSearchParams().get("propertyId");
  const [source, setSource] = useState<"list" | "manual">("list");
  const [picked, setPicked] = useState<PickedProperty | null>(
    initialPropertyId ? { id: initialPropertyId, label: "物件の画面から選んだ物件" } : null,
  );
  const propertyId = source === "list" ? picked?.id ?? null : null;
  const [options, setOptions] = useState<DealOptions | null>(null);
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("brokerage");
  const [tradeSide, setTradeSide] = useState("");
  const [propertyKind, setPropertyKind] = useState("");
  const [hasOc, setHasOc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dealsApi.options().then(setOptions).catch((e) => setError(errorText(e)));
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await dealsApi.create({
        name, businessType, hasOc,
        tradeSide: businessType === "brokerage" && tradeSide ? tradeSide : null,
        propertyKind: propertyKind || null,
        ...(propertyId ? { propertyId } : {}),
      });
      router.push(`/deals/${res.id}`);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="新しい取引"
        back={{ href: "/deals", to: "取引" }}
        description={
          source === "list"
            ? "選んだ物件の情報を写して作ります。"
            : "物件は手で入力します(物件の一覧には登録しません)。"
        }
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">物件</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="property-source" checked={source === "list"} onChange={() => setSource("list")} />
              物件の一覧から選ぶ
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="property-source" checked={source === "manual"} onChange={() => setSource("manual")} />
              手で入力する
            </label>
          </div>
          {source === "list" &&
            (picked ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
                <span className="text-gray-900 dark:text-gray-100">{picked.label}</span>
                <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                  <X className="h-4 w-4" />
                  選び直す
                </Button>
              </div>
            ) : (
              <PropertyPicker onPick={setPicked} />
            ))}
        </fieldset>
        <Field label="取引名">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="取引名" className={inputCls} />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={businessType} onChange={setBusinessType} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} />
        </Field>
        {businessType === "brokerage" && (
          <Field label="取引態様">
            <SelectBox label="取引態様" value={tradeSide} onChange={setTradeSide} options={optionsOf(DEAL_TRADE_SIDE_LABELS)} allowEmpty />
          </Field>
        )}
        <Field label="物件種別" hint={propertyId ? "空欄なら物件の種類から自動で選びます" : undefined}>
          <SelectBox
            label="物件種別" value={propertyKind} onChange={setPropertyKind} allowEmpty
            options={(options?.propertyKinds ?? []).map((k) => ({ value: k.key, label: k.label }))}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hasOc} onChange={(e) => setHasOc(e.target.checked)} />
          オーナーチェンジ(賃貸中のまま売買)
        </label>
      </div>
      <Button
        onClick={save}
        disabled={saving || !name.trim() || (source === "list" && !picked)}
        loading={saving}
        loadingLabel="作成中"
      >
        <Save className="h-4 w-4" />
        作成
      </Button>
    </div>
  );
}

type PickedProperty = { id: string; label: string };
type PropertyHit = {
  id: string;
  address: string;
  lotNumber: string | null;
  propertyType: string;
  buildingName?: string | null;
  roomNo?: string | null;
  caseStatus?: string;
};

function propertyLabel(p: PropertyHit): string {
  const building = [p.buildingName, p.roomNo].filter(Boolean).join(" ");
  return [p.address, p.lotNumber, building].filter(Boolean).join(" ");
}

/**
 * 物件の一覧から 1 件選ぶ。何も打っていないときは「契約予定」の物件を出す。
 * 打ったときは住所・地番・建物名などで探す(2 文字から)。担当者スコープなどはサーバー側で効く。
 */
function PropertyPicker({ onPick }: { onPick: (p: PickedProperty) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PropertyHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const query = q.trim();

  useEffect(() => {
    if (query.length === 1) return; // 打ちかけ(2 文字から探す)。表示側で結果を出さない。
    let alive = true;
    const t = setTimeout(() => {
      setLoading(true);
      setFailed(false);
      // 空のときは契約予定だけ、打ったときは全部の案件状況から探す。
      searchProperties(query, query ? {} : { caseStatus: "contract_planned" })
        .then((res) => alive && setHits(res.data))
        .catch(() => alive && (setHits([]), setFailed(true)))
        .finally(() => alive && setLoading(false));
    }, query ? 300 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="住所・地番・建物名・不動産番号で探す"
          aria-label="物件を探す"
          className={`${inputCls} pl-8`}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {query ? (query.length === 1 ? "2文字以上で探します。" : "検索結果") : "契約予定の物件"}
      </p>
      {query.length === 1 ? null : loading ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : failed ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">物件を読み込めませんでした。</p>
      ) : hits.length === 0 ? (
        <p className="text-sm text-gray-500">
          {query ? "見つかりませんでした。" : "契約予定の物件はありません。上の欄で探してください。"}
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
          {hits.map((p) => (
            <li key={p.id}>
              <Button
                variant="ghost"
                onClick={() => onPick({ id: p.id, label: propertyLabel(p) })}
                className="w-full justify-between text-left"
              >
                <span className="text-gray-900 dark:text-gray-100">{propertyLabel(p)}</span>
                <span className="shrink-0 text-xs text-gray-500">
                  {PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType}
                  {p.caseStatus ? ` ・ ${CASE_STATUS_LABELS[p.caseStatus] ?? p.caseStatus}` : ""}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
