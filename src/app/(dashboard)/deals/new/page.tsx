"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Save } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import { dealsApi, errorText, type DealOptions } from "@/lib/deals/client";
import { DEAL_BUSINESS_TYPE_LABELS, DEAL_TRADE_SIDE_LABELS } from "@/lib/deals/constants";

/**
 * 新しい取引(設計 §5)。?propertyId= があれば物件から作る(写しと種別はサーバーが物件から入れる)。
 * 無ければ手入力の物件(物件の中身は作ったあと「物件」タブで入れる)。
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
  const propertyId = useSearchParams().get("propertyId");
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
        description={propertyId ? "選んだ物件の情報を写して作ります。" : "物件は手で入力します(物件の一覧には登録しません)。"}
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="space-y-4">
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
      <Button onClick={save} disabled={saving || !name.trim()} loading={saving} loadingLabel="作成中">
        <Save className="h-4 w-4" />
        作成
      </Button>
    </div>
  );
}
