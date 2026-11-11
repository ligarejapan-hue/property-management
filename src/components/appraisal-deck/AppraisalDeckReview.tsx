"use client";

/**
 * 「査定のご報告」の下書きの確認画面(2026-11-10・発注者承認の画面イメージ B)。
 * 読み取った数字を見て、違えば直して「保存」→ 資料の見た目を確かめて「確認済みにする」。
 * ⚠直した内容は API(PATCH)で項目を絞って検証する。ここでは読み取り値と違う項目だけを送る。
 * ⚠依頼者の氏名・番地は扱わない(所在地は町丁目まで)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Eye, Map as MapIcon, RefreshCw } from "lucide-react";
import StatusBadge from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/ui/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { mergeAppraisal, type AppraisalOverrides } from "@/lib/appraisal-deck/overrides";
import { defaultHeadlines, type HeadlineKey } from "@/lib/appraisal-deck/headlines";
import type { AppraisalExtract, AppraisalPlanName, AppraisalValue } from "@/lib/appraisal-deck/parse";
import { appraisalDeckViewUrl, formatAppraisedOn } from "./AppraisalDeckCard";

interface DeckDetail {
  id: string;
  status: string;
  sourceAttachmentId: string | null;
  extracted: AppraisalExtract;
  overrides: AppraisalOverrides;
  updatedAt: string;
  /** 周辺地図があるか(2026-11-11)。 */
  hasMap?: boolean;
  /** 物件に GPS 座標があるか(値は持たない)。 */
  hasLocation?: boolean;
  /** 物件に住所があるか(GPS 座標がなくても住所から地図を作れる・値は持たない)。 */
  hasAddress?: boolean;
}

const WARN: Record<string, string> = {
  not_sre: "対応している査定報告書の書式ではないかもしれません。数字をよく確かめてください。",
  unknown_kind: "物件の種類（戸建・マンション・土地）を読み取れませんでした。",
  missing_expected: "成約想定価格を読み取れませんでした。入れてください。",
  missing_ai: "AI査定価格を読み取れませんでした。",
  missing_plans: "売出し価格（3案または価格の幅）を読み取れませんでした。入れてください。",
  plan_order: "売出しの3案の順番が逆です（スタンダードがスピードより安い、など）。査定報告書の転記ミスでないか確かめてください。",
};
const KIND: Record<string, string> = { house: "戸建", mansion: "マンション", land: "土地" };
const PLAN_LABEL: Record<AppraisalPlanName, string> = { speed: "スピード", standard: "スタンダード", challenge: "チャレンジ" };
const PLAN_NAMES: AppraisalPlanName[] = ["speed", "standard", "challenge"];
const VALUE_KEYS: Array<keyof AppraisalValue> = ["total", "land", "landTsubo", "building", "tsubo"];
/** 画面に欄は無いが、資料に使う値(既にある修正を保存のたびに消さないよう、フォームに持って回す・@codex #694)。 */
const ALL_VALUE_KEYS: Array<keyof AppraisalValue> = [...VALUE_KEYS, "buildingTsubo"];
const ADJ_KEYS = [
  ["landPercent", "土地の補正"],
  ["landAmount", "土地の評価の金額"],
  ["liquidityPercent", "流通性比率"],
] as const;
const VALUE_LABEL: Record<keyof AppraisalValue, string> = {
  total: "総額",
  land: "土地",
  landTsubo: "土地の坪単価",
  building: "建物",
  buildingTsubo: "建物の坪単価",
  tsubo: "坪単価",
};
const HEAD_LABEL: Record<HeadlineKey, string> = {
  result: "査定結果",
  basis: "査定の根拠",
  plans: "売出し",
  fund: "お住み替えの資金",
};

/** 「1,304」「１３０４」→ 1304。空は null、数字でなければ NaN。 */
export function parseNum(s: string): number | null {
  const t = s
    .replace(/[０-９．－]/g, (c) => (c === "．" ? "." : c === "－" ? "-" : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    .replace(/[,，\s]/g, "")
    .replace(/^[−–]/, "-");
  if (t === "") return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}
const show = (n: number | null | undefined) => (n == null ? "" : Number.isInteger(n) ? n.toLocaleString("ja-JP") : String(n));

type Form = Record<string, string>;

function formFrom(merged: ReturnType<typeof mergeAppraisal>, rangeMode: boolean): Form {
  const f: Form = {
    area: merged.area ?? "",
    station: merged.station ?? "",
    walkMinutes: show(merged.walkMinutes),
    landSqm: show(merged.landSqm),
    landTsubo: show(merged.landTsubo),
  };
  for (const [k] of ADJ_KEYS) f[`adjustment.${k}`] = show(merged.adjustment[k]);
  for (const k of ALL_VALUE_KEYS) {
    f[`expected.${k}`] = show(merged.expected[k]);
    f[`ai.${k}`] = show(merged.ai[k]);
  }
  if (rangeMode) {
    f["range.min"] = show(merged.range?.min);
    f["range.max"] = show(merged.range?.max);
  } else {
    for (const n of PLAN_NAMES) f[`plan.${n}`] = show(merged.plans?.find((p) => p.name === n)?.price);
  }
  for (const k of Object.keys(HEAD_LABEL) as HeadlineKey[]) f[`h.${k}`] = (merged.headlines as Record<string, string>)[k] ?? "";
  // 載せない周辺施設の番号(カンマ区切り)
  f["fac.hidden"] = merged.facilities
    .map((x, i) => (x.hidden ? String(i) : null))
    .filter((v): v is string => v !== null)
    .join(",");
  return f;
}

/** フォームから、読み取り値と違う項目だけの修正を作る。数字でない欄はエラー。 */
export function buildOverrides(
  form: Form,
  extracted: AppraisalExtract,
  rangeMode: boolean,
): { overrides: AppraisalOverrides; errors: string[] } {
  const o: Record<string, unknown> = {};
  const errors: string[] = [];
  const n = (key: string, label: string) => {
    const v = parseNum(form[key] ?? "");
    if (v != null && Number.isNaN(v)) {
      errors.push(`${label}は数字で入れてください`);
      return undefined;
    }
    return v;
  };
  const text = (key: "area" | "station") => {
    const v = (form[key] ?? "").trim() || null;
    if (v !== (extracted[key] ?? null)) o[key] = v;
  };
  text("area");
  text("station");
  for (const [key, label] of [
    ["walkMinutes", "徒歩分数"],
    ["landSqm", "土地面積"],
    ["landTsubo", "土地の坪数"],
  ] as const) {
    const v = n(key, label);
    if (v !== undefined && v !== extracted[key]) o[key] = v;
  }
  for (const which of ["expected", "ai"] as const) {
    const part: Record<string, number | null> = {};
    for (const k of ALL_VALUE_KEYS) {
      const v = n(`${which}.${k}`, `${which === "expected" ? "成約想定価格" : "AI査定価格"}の${VALUE_LABEL[k]}`);
      if (v !== undefined && v !== extracted[which][k]) part[k] = v;
    }
    if (Object.keys(part).length) o[which] = part;
  }
  const adj: Record<string, number | null> = {};
  for (const [k, label] of ADJ_KEYS) {
    const v = n(`adjustment.${k}`, label);
    if (v !== undefined && v !== extracted.adjustment[k]) adj[k] = v;
  }
  if (Object.keys(adj).length) o.adjustment = adj;
  if (rangeMode) {
    const lo = n("range.min", "価格の幅の下限");
    const hi = n("range.max", "価格の幅の上限");
    if (lo !== undefined && hi !== undefined) {
      const ex = extracted.range;
      if (lo == null || hi == null) {
        if (lo != null || hi != null) errors.push("価格の幅は下限と上限の両方を入れてください");
        else if (ex) o.range = null;
      } else if (!ex || ex.min !== lo || ex.max !== hi) {
        o.range = { min: lo, max: hi, minTsubo: ex?.min === lo ? ex.minTsubo : null, maxTsubo: ex?.max === hi ? ex.maxTsubo : null };
      }
    }
  } else {
    const plans: { name: AppraisalPlanName; price: number; tsubo: number | null }[] = [];
    let bad = false;
    for (const name of PLAN_NAMES) {
      const v = n(`plan.${name}`, `${PLAN_LABEL[name]}の価格`);
      if (v === undefined) bad = true;
      else if (v != null) {
        const ex = extracted.plans.find((p) => p.name === name);
        plans.push({ name, price: v, tsubo: ex && ex.price === v ? ex.tsubo : null });
      }
    }
    const same =
      plans.length === extracted.plans.length &&
      plans.every((p) => extracted.plans.some((e) => e.name === p.name && e.price === p.price));
    if (!bad && !same) o.plans = plans;
  }
  const heads: Record<string, string> = {};
  for (const k of Object.keys(HEAD_LABEL) as HeadlineKey[]) {
    const v = (form[`h.${k}`] ?? "").trim();
    if (v) heads[k] = v;
  }
  if (Object.keys(heads).length) o.headlines = heads;
  const hidden = (form["fac.hidden"] ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((v) => Number.isInteger(v) && v >= 0 && v < (extracted.facilities?.length ?? 0));
  if (hidden.length) o.hiddenFacilities = [...new Set(hidden)].sort((a, b) => a - b);
  return { overrides: o as AppraisalOverrides, errors };
}

const inputCls =
  "w-full min-w-0 rounded-md border px-2.5 py-1.5 text-sm text-gray-900 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 dark:bg-gray-900 dark:text-gray-100";
const card = "mb-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800";

export function AppraisalDeckReview({ propertyId, deckId, canWrite }: { propertyId: string; deckId: string; canWrite: boolean }) {
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [form, setForm] = useState<Form>({});
  const [saved, setSaved] = useState<Form>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const base = `/api/properties/${propertyId}/appraisal-decks`;
  const rangeMode = !!deck && deck.extracted.plans.length === 0 && (!!deck.extracted.range || deck.extracted.kind === "land");

  const apply = useCallback((d: DeckDetail) => {
    const rm = d.extracted.plans.length === 0 && (!!d.extracted.range || d.extracted.kind === "land");
    const merged = mergeAppraisal(d.extracted, d.overrides);
    const f = formFrom(merged, rm);
    setDeck(d);
    setForm(f);
    setSaved(f);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`${base}/${deckId}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.message ?? "資料を読み込めませんでした");
        return j.deck as DeckDetail;
      })
      .then((d) => active && apply(d))
      .catch((e: Error) => active && setLoadErr(e.message));
    return () => {
      active = false;
    };
  }, [base, deckId, apply]);

  const dirty = useMemo(() => Object.keys(form).some((k) => form[k] !== saved[k]), [form, saved]);
  const preview = useMemo(() => {
    if (!deck) return null;
    const { overrides } = buildOverrides(form, deck.extracted, rangeMode);
    const parsed = mergeAppraisal(deck.extracted, overrides);
    return defaultHeadlines({ ...parsed, headlines: {} });
  }, [deck, form, rangeMode]);

  if (loadErr) {
    return (
      <div className="p-6">
        <BackLink href={`/properties/${propertyId}`} to="物件" />
        <p className="mt-4 text-sm text-red-700 dark:text-red-300">{loadErr}</p>
      </div>
    );
  }
  if (!deck) return <div className="p-6 text-sm text-gray-500">読み込み中…</div>;

  const ex = deck.extracted;
  const confirmed = deck.status === "confirmed";
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const exVal = (k: string): string => {
    const [a, b] = k.split(".");
    if (a === "expected" || a === "ai") return show(ex[a][b as keyof AppraisalValue]);
    if (a === "adjustment") return show(ex.adjustment[b as "landPercent" | "landAmount" | "liquidityPercent"]);
    if (a === "plan") return show(ex.plans.find((p) => p.name === b)?.price);
    if (a === "range") return show(ex.range?.[b as "min" | "max"]);
    const v = (ex as unknown as Record<string, unknown>)[k];
    return typeof v === "number" ? show(v) : ((v as string | null) ?? "");
  };
  const field = (k: string, label: string, unit?: string, wide = false) => {
    const edited = (form[k] ?? "") !== exVal(k);
    return (
      <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
        <span className="mb-0.5 block text-xs text-gray-600 dark:text-gray-400">{label}</span>
        <span className="flex items-center gap-1.5">
          <input
            value={form[k] ?? ""}
            onChange={set(k)}
            disabled={!canWrite}
            inputMode={unit ? "decimal" : undefined}
            className={`${inputCls} ${unit ? "text-right" : ""} ${edited ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-500/20" : "border-gray-300 dark:border-gray-600"}`}
          />
          {unit ? <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{unit}</span> : null}
        </span>
        <span className={`mt-0.5 block text-[11px] ${edited ? "text-indigo-700 dark:text-indigo-300" : "text-gray-400 dark:text-gray-500"}`}>
          {edited ? `直しました（読み取りは ${exVal(k) || "なし"}）` : "読み取った値"}
        </span>
      </label>
    );
  };

  const call = async (url: string, init: RequestInit, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? "うまくいきませんでした");
      setMsg({ kind: "ok", text: ok });
      return j;
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    const r = await fetch(`${base}/${deckId}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) apply(j.deck as DeckDetail);
  };
  const save = async () => {
    const { overrides, errors } = buildOverrides(form, ex, rangeMode);
    if (errors.length) {
      setMsg({ kind: "err", text: errors.join("。") });
      return;
    }
    const j = await call(`${base}/${deckId}`, { method: "PATCH", body: JSON.stringify({ overrides }) }, "保存しました。資料の見た目を確かめてから「確認済みにする」を押してください");
    if (j?.deck) apply(j.deck as DeckDetail);
  };
  const confirm = async () => {
    const j = await call(
      `${base}/${deckId}/confirm`,
      { method: "POST", body: JSON.stringify({ reviewedUpdatedAt: deck.updatedAt }) },
      "確認済みにしました。資料を見る・ダウンロードができます",
    );
    if (j) await reload();
  };
  const reread = async () => {
    if (!deck.sourceAttachmentId) return;
    if (!window.confirm("査定報告書をもう一度読み取ります。直した内容はそのまま残ります。よろしいですか？")) return;
    const j = await call(base, { method: "POST", body: JSON.stringify({ attachmentId: deck.sourceAttachmentId }) }, "査定報告書を読み直しました");
    if (j) await reload();
  };

  const rebuildMap = async () => {
    if (dirty) {
      setMsg({ kind: "err", text: "直した内容を先に保存してください" });
      return;
    }
    if (confirmed && !window.confirm("周辺地図を作り直すと、資料は確認待ちに戻ります。よろしいですか？")) return;
    const j = await call(`${base}/${deckId}/map`, { method: "POST" }, "周辺地図を作りました。資料の見た目を確かめてください");
    if (j) await reload();
  };

  const warnings = ex.warnings.filter((w) => WARN[w]);

  return (
    <div className="mx-auto max-w-5xl p-4 pb-28 sm:p-6 sm:pb-28">
      <BackLink href={`/properties/${propertyId}`} to="物件" />
      <div className="mt-2">
        <PageHeader
          title={`査定のご報告（${formatAppraisedOn(ex.appraisedOn)}）`}
          actions={confirmed ? <StatusBadge intent="success">確認済み</StatusBadge> : <StatusBadge intent="warning">確認待ち</StatusBadge>}
        />
      </div>

      {warnings.length > 0 && (
        <div role="alert" className="mb-3 flex gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">読み取りで気になった点</p>
            <ul className="mt-1 list-disc pl-4">
              {warnings.map((w) => (
                <li key={w}>{WARN[w]}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          物件の概要 <span className="ml-1 text-xs font-normal text-gray-400">資料の1ページ目に出ます。所在地は町丁目までです</span>
        </h2>
        <p className="mb-2 text-sm text-gray-700 dark:text-gray-300">種類：{(ex.kind && KIND[ex.kind]) || "読み取れませんでした"}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {field("area", "所在地（町丁目まで）")}
          {field("station", "最寄り駅")}
          {field("walkMinutes", "徒歩", "分")}
          {field(ex.kind === "mansion" ? "landSqm" : "landTsubo", ex.kind === "mansion" ? "土地面積" : "土地の坪数", ex.kind === "mansion" ? "㎡" : "坪")}
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          査定の数字 <span className="ml-1 text-xs font-normal text-gray-400">単位は万円。直した欄は色が付き、下に読み取った値が出ます</span>
        </h2>
        {(["expected", "ai"] as const).map((w) => (
          <div key={w} className="mb-3">
            <p className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-300">{w === "expected" ? "成約想定価格" : "AI査定価格"}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {VALUE_KEYS.map((k) => (
                <div key={k}>{field(`${w}.${k}`, VALUE_LABEL[k], k.endsWith("subo") || k === "tsubo" ? "万円/坪" : "万円")}</div>
              ))}
            </div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {field("adjustment.landPercent", `土地の補正${ex.adjustment.landReason ? `（${ex.adjustment.landReason}）` : ""}`, "%")}
          {field("adjustment.liquidityPercent", "流通性比率", "%")}
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          {rangeMode ? "売出しの価格の幅" : "売出しの3案"}
          <span className="ml-1 text-xs font-normal text-gray-400">万円</span>
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {rangeMode ? (
            <>
              {field("range.min", "下限", "万円")}
              {field("range.max", "上限", "万円")}
            </>
          ) : (
            PLAN_NAMES.map((n) => <div key={n}>{field(`plan.${n}`, PLAN_LABEL[n], "万円")}</div>)
          )}
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          各ページの見出し <span className="ml-1 text-xs font-normal text-gray-400">空のままなら数字から自動で作った文になります（薄い字）。120文字まで</span>
        </h2>
        <div className="grid grid-cols-1 gap-3">
          {(Object.keys(HEAD_LABEL) as HeadlineKey[]).map((k) => (
            <label key={k} className="block">
              <span className="mb-0.5 block text-xs text-gray-600 dark:text-gray-400">{HEAD_LABEL[k]}</span>
              <textarea
                rows={2}
                maxLength={120}
                value={form[`h.${k}`] ?? ""}
                onChange={set(`h.${k}`)}
                disabled={!canWrite}
                placeholder={preview?.[k] ?? ""}
                className={`${inputCls} border-gray-300 dark:border-gray-600 ${form[`h.${k}`] ? "border-indigo-500" : ""}`}
              />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">⚠ 依頼者のお名前や番地は書かないでください。</p>
      </section>

      {ex.facilities?.length ? (
        <section className={card}>
          <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            周辺施設 <span className="ml-1 text-xs font-normal text-gray-400">査定書の周辺施設情報から読みました。チェックを外すと資料に載せません</span>
          </h2>
          <ul className="grid gap-1 sm:grid-cols-2">
            {ex.facilities.map((f, i) => {
              const hiddenSet = new Set((form["fac.hidden"] ?? "").split(",").filter(Boolean));
              const on = !hiddenSet.has(String(i));
              return (
                <li key={i}>
                  <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!canWrite}
                      onChange={() =>
                        setForm((fm) => {
                          const s = new Set((fm["fac.hidden"] ?? "").split(",").filter(Boolean));
                          if (s.has(String(i))) s.delete(String(i));
                          else s.add(String(i));
                          return { ...fm, "fac.hidden": [...s].join(",") };
                        })
                      }
                    />
                    <span className="font-semibold">{f.cat}</span>
                    <span className="truncate text-gray-500 dark:text-gray-400">{f.name}</span>
                    <span className="ml-auto whitespace-nowrap text-xs text-gray-500">
                      徒歩{f.min}分{f.x == null ? "（地図には出ません）" : ""}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          周辺地図 <span className="ml-1 text-xs font-normal text-gray-400">資料の1ページ目に、物件の位置の地図（3Dの街並み＋平面の地図）を入れます</span>
        </h2>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {deck.hasMap
            ? "地図が入っています。物件の位置に印が立ちます（お客様にも位置がわかります）。"
            : deck.hasLocation
              ? "まだ地図がありません。「地図を作る」で作れます。"
              : deck.hasAddress
                ? "物件の GPS 座標がないため、「地図を作る」で住所から位置を求めて作ります（位置は目安です）。"
                : "物件の GPS 座標も住所もないため、地図を作れません（地図のページなしで表示します）。"}
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          国土地理院の地図データ（無料）から作ります。建物の高さはイメージです。作り直すと資料は確認待ちに戻ります。
        </p>
        {canWrite && (deck.hasLocation || deck.hasAddress) ? (
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={rebuildMap} disabled={busy}>
              <MapIcon className="h-4 w-4" aria-hidden />
              {deck.hasMap ? "地図を作り直す" : "地図を作る"}
            </Button>
          </div>
        ) : null}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-2">
          <span
            role="status"
            className={`mr-auto text-xs ${msg?.kind === "err" ? "text-red-700 dark:text-red-300" : "text-gray-500 dark:text-gray-400"}`}
          >
            {msg?.text ?? (dirty ? "直した内容はまだ保存していません" : "直したら「保存」→ 資料の見た目を確かめてから「確認済みにする」")}
          </span>
          {canWrite && deck.sourceAttachmentId && !confirmed ? (
            <Button variant="ghost" size="sm" onClick={reread} disabled={busy}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              査定書から読み直す
            </Button>
          ) : null}
          <a
            href={appraisalDeckViewUrl(propertyId, deckId)}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            <Eye className="h-4 w-4" aria-hidden />
            {confirmed ? "資料を見る" : "資料を見る（確認前）"}
          </a>
          {confirmed ? (
            <a
              href={appraisalDeckViewUrl(propertyId, deckId, true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              <Download className="h-4 w-4" aria-hidden />
              ダウンロード
            </a>
          ) : null}
          {canWrite ? (
            <>
              <Button variant="secondary" size="sm" onClick={save} disabled={busy || !dirty}>
                保存
              </Button>
              {!confirmed ? (
                <Button size="sm" onClick={confirm} disabled={busy || dirty}>
                  確認済みにする
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
