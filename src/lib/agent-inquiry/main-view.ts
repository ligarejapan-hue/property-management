import type { AdValueKey, AgentDetail, InquiryCounts, PropertyTimelineEntry } from "@/lib/api-client";
import { KIND_LABEL, VIEWING_TYPE_LABEL, draftStale, editDraft, type Draft } from "./desk-form";

/** メイン画面側(物件の反響欄・業者の名簿・ホーム)の判定と表示(設計 2026-09-28 §2.3)。純関数だけ。 */

const AD_CYCLE: (AdValueKey | null)[] = ["ok", "ng", "ask", null];
/** 広告の可否を押したときの次の値。○→×→△→未設定→○。 */
export function nextAdValue(v: AdValueKey | null): AdValueKey | null {
  return AD_CYCLE[(AD_CYCLE.indexOf(v) + 1) % AD_CYCLE.length];
}
/** 読み上げ・説明用の言葉(記号だけでは伝わらないため)。 */
export const AD_VALUE_WORD: Record<AdValueKey | "none", string> = {
  ok: "可",
  ng: "不可",
  ask: "担当者に確認",
  none: "未設定",
};

const JST_MS = 9 * 60 * 60 * 1000;
const WEEK = "日月火水木金土";
const jst = (iso: string) => new Date(new Date(iso).getTime() + JST_MS);
/** 年つきの日付(JST・例「2026/10/2」)。履歴は年をまたぐ。 */
export function formatJstDate(iso: string): string {
  const j = jst(iso);
  return `${j.getUTCFullYear()}/${j.getUTCMonth() + 1}/${j.getUTCDate()}`;
}
/** 年つきの日時(JST・例「2026/10/2(金) 14:00」)。 */
export function formatJstFull(iso: string): string {
  const j = jst(iso);
  return `${formatJstDate(iso)}(${WEEK[j.getUTCDay()]}) ${j.getUTCHours()}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
}

/** 時系列の1行の種類。内見の予定は案内/下見、それ以外は用件の名前。 */
export function timelineKindLabel(e: Pick<PropertyTimelineEntry, "kind" | "viewingType">): string {
  return e.viewingType ? VIEWING_TYPE_LABEL[e.viewingType] : KIND_LABEL[e.kind];
}
/** 時系列の1行の日時。日程未定の内見は受けた日時の位置に並ぶので、その旨を出す。 */
export function timelineWhen(e: Pick<PropertyTimelineEntry, "at" | "unscheduled">): string {
  return e.unscheduled ? `日程調整中(受付 ${formatJstFull(e.at)})` : formatJstFull(e.at);
}

/** 名簿の会社情報の欄(並びは画面の並び)。 */
export const AGENT_EDIT_FIELDS = [
  { key: "companyName", label: "商号(必須)" },
  { key: "companyKana", label: "ふりがな" },
  { key: "branchName", label: "支店名" },
  { key: "phone", label: "代表電話(必須)", phone: true },
  { key: "fax", label: "FAX", phone: true },
  { key: "email", label: "メール" },
  { key: "licenseNo", label: "免許番号" },
  { key: "address", label: "所在地" },
  { key: "note", label: "メモ", multiline: true },
] as const satisfies readonly { key: keyof AgentDetail; label: string; phone?: true; multiline?: true }[];
export type AgentEditKey = (typeof AGENT_EDIT_FIELDS)[number]["key"];
/**
 * 触った欄だけを持つ(触っていない欄は最新の値をそのまま出す)。欄ごとに、打った値と
 * 書き始めたときの最新の値(base)を覚える=その後に他の人が同じ欄を変えたら気付ける。
 */
export type AgentEdits = Partial<Record<AgentEditKey, Draft>>;
const REQUIRED: readonly AgentEditKey[] = ["companyName", "phone"];

export function agentFieldValue(agent: AgentDetail, edits: AgentEdits, key: AgentEditKey): string {
  return edits[key]?.value ?? agent[key] ?? "";
}
/** 欄に打った値を下書きへ(書き始めたときの値は最初の1回だけ覚える)。 */
export function editAgentField(agent: AgentDetail, edits: AgentEdits, key: AgentEditKey, value: string): AgentEdits {
  return { ...edits, [key]: editDraft(edits[key] ?? null, value, agent[key] ?? "") };
}
/**
 * 自分が打っている欄のうち、書き始めた後に他の人が変えた欄(相手の今の値つき)。
 * 「触った欄だけ送る」は別の欄しか守れない。同じ欄がぶつかったら、黙って上書きせず相手の値を見せる。
 */
export function agentStaleFields(agent: AgentDetail, edits: AgentEdits): { key: AgentEditKey; label: string; current: string }[] {
  return AGENT_EDIT_FIELDS.filter((f) => draftStale(edits[f.key] ?? null, agent[f.key] ?? "")).map((f) => ({
    key: f.key,
    label: f.label.replace("(必須)", ""),
    current: agent[f.key] || "(空)",
  }));
}
/** 相手の値を見せた後、今の値を基準にし直す(もう一度保存を押せば自分の内容で保存する)。 */
export function rebaseAgentEdits(agent: AgentDetail, edits: AgentEdits): AgentEdits {
  const next: AgentEdits = {};
  for (const { key } of AGENT_EDIT_FIELDS) {
    const d = edits[key];
    if (d) next[key] = { value: d.value, base: agent[key] ?? "" };
  }
  return next;
}
/**
 * 保存が通った後の手元の値(送った値と新しい版番号を写す)。続く読み直しに失敗しても、
 * 保存前の値を見せない・古い版番号で次の保存を送らない。
 */
/** 保存で送る変更の形。商号・代表電話は空(null)にしない。 */
export type AgentPatch = { companyName?: string; phone?: string } & Partial<
  Record<Exclude<AgentEditKey, "companyName" | "phone">, string | null>
>;

export function agentAfterSave(
  agent: AgentDetail,
  sent: AgentPatch & { isArchived?: boolean },
  version: number,
): AgentDetail {
  return { ...agent, ...(sent as Partial<AgentDetail>), version };
}
export function agentEditError(agent: AgentDetail, edits: AgentEdits): string | null {
  return REQUIRED.some((k) => agentFieldValue(agent, edits, k).trim() === "") ? "商号と代表電話を入れてください" : null;
}
/**
 * 保存で送る変更。**触った欄のうち、今の値と違うものだけ**=読み直した後に他の人が直した別の欄を、
 * 古い値で上書きしない。任意の欄を空にしたら null(消す)。何も無ければ null(送らない)。
 */
export function agentEditPatch(agent: AgentDetail, edits: AgentEdits): AgentPatch | null {
  const patch: Partial<Record<AgentEditKey, string | null>> = {};
  for (const { key } of AGENT_EDIT_FIELDS) {
    const typed = edits[key];
    if (typed === undefined) continue;
    const next = typed.value.trim();
    if (next === (agent[key] ?? "").trim()) continue;
    patch[key] = next === "" && !REQUIRED.includes(key) ? null : next;
  }
  // 必須の欄(商号・代表電話)は上で空なら文字のまま=null にはならない(空は agentEditError が先に止める)。
  return Object.keys(patch).length > 0 ? (patch as AgentPatch) : null;
}

/** ホームに出す2つの件数(設計 方針9)。0件でも出す=受付の窓の入口を兼ねる。 */
export function homeInquiryChips(c: InquiryCounts) {
  return [
    { key: "open" as const, label: "未対応の反響", count: c.open, tone: c.open > 0 ? ("alert" as const) : ("quiet" as const) },
    {
      key: "viewings" as const,
      label: "今日・明日の内見",
      count: c.upcomingViewings,
      tone: c.upcomingViewings > 0 ? ("info" as const) : ("quiet" as const),
    },
  ];
}

export const MAIN_WINDOW_NAME = "pm-main";
export const DESK_WINDOW_NAME = "pm-inquiry-desk";
/**
 * この窓が名乗るべき名前(null=変えない)。名前が空の窓だけ名乗る=リンクの target から開いた窓
 * (すでに名前がある)を別の名前に付け替えない。
 */
export function windowNameFor(current: string, wanted: string): string | null {
  return current === "" ? wanted : null;
}
