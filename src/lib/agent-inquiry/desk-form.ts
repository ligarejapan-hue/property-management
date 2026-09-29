import type {
  AgentHit, AgentInquiryCreateBody, AdMediumKey, AdValueKey, DeskProperty, InquiryChannelKey, InquiryKindKey,
  InquiryStatusKey, ViewingTypeKey,
} from "@/lib/api-client";

/** 受付の窓の登録フォーム(設計 §2.2)。並び順=業者→問い合わせ者→物件→用件→内見→入口→保存。 */
export interface DeskFormState {
  agentQuery: string;
  agent: AgentHit | null;
  contactName: string;
  contactMobile: string;
  contactEmail: string;
  propertyQuery: string;
  property: DeskProperty | null;
  kind: InquiryKindKey | null;
  viewingType: ViewingTypeKey | null;
  viewingDate: string;
  viewingTime: string;
  attendantId: string;
  channel: InquiryChannelKey;
  note: string;
}

export const EMPTY_DESK_FORM: DeskFormState = {
  agentQuery: "",
  agent: null,
  contactName: "",
  contactMobile: "",
  contactEmail: "",
  propertyQuery: "",
  property: null,
  kind: null,
  viewingType: null,
  viewingDate: "",
  viewingTime: "",
  attendantId: "",
  channel: "phone",
  note: "",
};

export type DeskFormAction =
  | { type: "agentQuery"; value: string }
  | { type: "agentSelected"; agent: AgentHit }
  | { type: "contact"; field: "contactName" | "contactMobile" | "contactEmail"; value: string }
  | { type: "propertyQuery"; value: string }
  | { type: "propertySelected"; property: DeskProperty }
  | { type: "kind"; value: InquiryKindKey }
  | { type: "viewing"; field: "viewingType" | "date" | "time" | "attendantId"; value: string }
  | { type: "channel"; value: InquiryChannelKey }
  | { type: "note"; value: string }
  | { type: "reset" };

export function deskFormReducer(s: DeskFormState, a: DeskFormAction): DeskFormState {
  switch (a.type) {
    case "agentQuery":
      // 選んだ後に打ち直したら選択を外す(画面の表示と保存される業者が食い違わないように)。
      return { ...s, agentQuery: a.value, agent: null };
    case "agentSelected": {
      // 携帯で当たったときは、その携帯の人の前回の名前・携帯・メールで埋める(書き換え可)。
      const c = a.agent.lastContact;
      return {
        ...s,
        agent: a.agent,
        agentQuery: a.agent.companyName,
        ...(c ? { contactName: c.name ?? "", contactMobile: c.mobile ?? "", contactEmail: c.email ?? "" } : {}),
      };
    }
    case "contact":
      return { ...s, [a.field]: a.value };
    case "propertyQuery":
      return { ...s, propertyQuery: a.value, property: null };
    case "propertySelected":
      return {
        ...s,
        property: a.property,
        propertyQuery: a.property.roomNo ? `${a.property.name} ${a.property.roomNo}` : a.property.name,
      };
    case "kind":
      return a.value === "viewing"
        ? { ...s, kind: a.value }
        : { ...s, kind: a.value, viewingType: null, viewingDate: "", viewingTime: "", attendantId: "" };
    case "viewing":
      if (a.field === "viewingType") return { ...s, viewingType: a.value === "preview" ? "preview" : "guided" };
      if (a.field === "date") return { ...s, viewingDate: a.value };
      if (a.field === "time") return { ...s, viewingTime: a.value };
      return { ...s, attendantId: a.value };
    case "channel":
      return { ...s, channel: a.value };
    case "note":
      return { ...s, note: a.value };
    case "reset":
      return EMPTY_DESK_FORM;
  }
}

export type DeskGuideStep = "agent" | "property" | "kind" | "viewingType" | "save";

export const DESK_GUIDE_TIPS: Record<DeskGuideStep, string> = {
  agent: "まず業者を探します。電話番号か会社名を打ってください",
  property: "次に物件を選びます。物件名・部屋番号・所在地で探せます",
  kind: "用件を選んでください",
  viewingType: "案内(お客様連れ)か下見(業者だけ)かを選んでください",
  save: "あとは保存するだけです",
};

/** 次に押す所(方針14)。 */
export function nextDeskGuideStep(s: DeskFormState): DeskGuideStep {
  if (!s.agent) return "agent";
  if (!s.property) return "property";
  if (!s.kind) return "kind";
  if (s.kind === "viewing" && !s.viewingType) return "viewingType";
  return "save";
}

export function validateDeskForm(s: DeskFormState) {
  const e: Partial<Record<"agent" | "property" | "kind" | "viewingType", string>> = {};
  if (!s.agent) e.agent = "業者を選んでください";
  if (!s.property) e.property = "物件を選んでください";
  if (!s.kind) e.kind = "用件を選んでください";
  if (s.kind === "viewing" && !s.viewingType) e.viewingType = "案内か下見かを選んでください";
  return e;
}

/** 資料請求でメールが空なら知らせる(保存は止めない=FAX で送る場合もある)。 */
export function materialEmailWarning(s: DeskFormState): string | null {
  return s.kind === "material_request" && s.contactEmail.trim() === "" ? "資料の送り先のメールが空です" : null;
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

/** 登録 API に送る形(validateDeskForm が通った前提)。 */
export function buildCreateBody(s: DeskFormState): AgentInquiryCreateBody {
  return {
    propertyId: s.property!.id,
    agentId: s.agent!.id,
    kind: s.kind!,
    channel: s.channel,
    contactName: orNull(s.contactName),
    contactMobile: orNull(s.contactMobile),
    contactEmail: orNull(s.contactEmail),
    note: orNull(s.note),
    ...(s.kind === "viewing" && s.viewingType
      ? {
          viewing: {
            viewingType: s.viewingType,
            scheduledAt: jstInputsToIso(s.viewingDate, s.viewingTime),
            attendantId: orNull(s.attendantId),
          },
        }
      : {}),
  };
}

const JST_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** 日付と時刻(JST)が揃ったときだけ UTC の ISO にする。片方だけ=日程調整中(null)。 */
export function jstInputsToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  // 2026-13-40 のような日付は繰り上がるので、戻して一致するかで弾く。
  return isoToJstInputs(d.toISOString()).date === date ? d.toISOString() : null;
}

export function isoToJstInputs(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const j = new Date(new Date(iso).getTime() + JST_MS);
  return {
    date: `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`,
    time: `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`,
  };
}

const WEEK = "日月火水木金土";
/** 表示用(JST・例「10/2(金) 14:00」)。null=日程調整中。 */
export function formatJst(iso: string | null): string {
  if (!iso) return "日程調整中";
  const j = new Date(new Date(iso).getTime() + JST_MS);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}(${WEEK[j.getUTCDay()]}) ${j.getUTCHours()}:${pad(j.getUTCMinutes())}`;
}

export const KIND_LABEL: Record<InquiryKindKey, string> = {
  viewing: "内見",
  ad_permission: "広告の許可",
  material_request: "資料請求",
};
export const STATUS_LABEL: Record<InquiryStatusKey, string> = { open: "未対応", in_progress: "対応中", done: "対応済み" };
export const CHANNEL_LABEL: Record<InquiryChannelKey, string> = { phone: "電話", email: "メール", fax: "FAX" };
export const VIEWING_TYPE_LABEL: Record<ViewingTypeKey, string> = { guided: "案内", preview: "下見" };
export const AD_MEDIA_ORDER: AdMediumKey[] = ["own_site", "athome", "suumo", "homes", "other_portal", "flyer"];
export const AD_MEDIUM_LABEL: Record<AdMediumKey, string> = {
  own_site: "自社HP",
  athome: "at home",
  suumo: "SUUMO",
  homes: "HOME'S",
  other_portal: "その他",
  flyer: "チラシ",
};
export const AD_VALUE_MARK: Record<AdValueKey, string> = { ok: "○", ng: "×", ask: "△" };
export const CONFLICT_MESSAGE = "他の人が先に更新しました。開き直してください。";

/**
 * 下書き(打ちかけ)を優先して表示する値。null=まだ触っていない=最新の値をそのまま出す。
 * 詳細を読み直しても(版が進んでも)打ちかけの入力を消さないため(最終レビュー I-1/I-2)。
 */
export function pickDraft(draft: string | null, server: string): string {
  return draft ?? server;
}
