import {
  DENSITY_OPTIONS,
  LAYOUT_OPTIONS,
  type Appearance,
  type AppearancePatch,
  type DensityPref,
  type LayoutPref,
  type ThemePref,
} from "./options";
import { STORAGE_KEYS } from "./boot-script";

// 見た目の設定: 画面側で 文字サイズ・レイアウト を付け替える/保存する部品。
// html の data-density / data-layout が「今の値」の1か所(ヘッダーとメニューの選択欄は両方ここを見る)。
// 付け替えたら合図(イベント)を出し、表示中の選択欄すべてに知らせる。

export const APPEARANCE_CHANGE_EVENT = "pm-appearance-change";
/**
 * 新しい中身が届いたときの合図(detail=中身)。保存できたとき・読み直したとき(管理者が会社の標準を変えた直後など)に出す。
 * 設定 > 表示・スマホのメニューが、別の場所での保存や選べる色の変更に追随する(@codex #623)。
 */
export const PREFERENCES_SAVED_EVENT = "pm-preferences-saved";
/** ルートの layout が「この人の設定で描いた」印に付ける html の属性(ログイン中の人の id)。 */
export const APPEARANCE_USER_ATTR = "data-appearance-user";

const isDensity = (v: string | null): v is DensityPref => DENSITY_OPTIONS.some((o) => o.value === v);
const isLayout = (v: string | null): v is LayoutPref => LAYOUT_OPTIONS.some((o) => o.value === v);

function setAttrAndRemember(attr: "data-density" | "data-layout", key: string, value: string) {
  document.documentElement.setAttribute(attr, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 端末に覚えられなくても、画面には反映済み(正は DB)
  }
  window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
}

export function applyDensity(value: DensityPref) {
  setAttrAndRemember("data-density", STORAGE_KEYS.density, value);
}

export function applyLayout(value: LayoutPref) {
  setAttrAndRemember("data-layout", STORAGE_KEYS.layout, value);
}

export function readDensity(): DensityPref {
  const d = document.documentElement.getAttribute("data-density");
  return isDensity(d) ? d : "normal";
}

export function readLayout(): LayoutPref {
  const l = document.documentElement.getAttribute("data-layout");
  return isLayout(l) ? l : "side";
}

/** useSyncExternalStore 用: 付け替えの合図を購読する。 */
export function subscribeAppearance(onChange: () => void): () => void {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
}

/** GET/PATCH /api/me/preferences の中身(段階4)。user の null=会社の標準を使う。 */
export type PreferencesData = {
  user: { theme: string | null; density: string | null; layout: string | null };
  company: { theme?: string; density?: string; layout?: string };
  allowedThemes: ThemePref[];
  effective: Appearance;
  canEditCompany: boolean;
};

// 設定 > 表示・利用者メニュー・スマホのメニューで共有する読み込み(画面を開いている間に何度も読みにいかない)。
let cached: Promise<PreferencesData | null> | null = null;
// 読み込み・保存の通し番号。返事は届く順がばらばらなので、後から始めたものの結果をすでに使っていたら古い返事は使わない
// (開いたときの読み込みが保存より遅れて届き、「会社の標準を使用中」に戻って見えた・@codex #623)。
let requestSeq = 0;
let appliedSeq = 0;
let latest: PreferencesData | null = null;

/** 新しい中身を使う(より新しい返事をもう使っていれば false=使わない)。 */
function accept(seq: number, data: PreferencesData): boolean {
  if (seq < appliedSeq) return false;
  appliedSeq = seq;
  latest = data;
  cached = Promise.resolve(data);
  window.dispatchEvent(new CustomEvent(PREFERENCES_SAVED_EVENT, { detail: data }));
  return true;
}

async function requestPreferences(init?: RequestInit): Promise<PreferencesData | null> {
  try {
    const res = await fetch("/api/me/preferences", { cache: "no-store", ...init });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: PreferencesData }).data ?? null;
  } catch {
    return null;
  }
}

/** 個人・会社の標準・選べる色テーマ。読めなければ null(次の呼び出しで読み直す)。force=必ず読み直す。 */
export function loadPreferences(force = false): Promise<PreferencesData | null> {
  if (!cached || force) {
    const seq = ++requestSeq;
    const p = requestPreferences().then((d) => {
      if (d === null) {
        if (cached === p) cached = null;
        return null;
      }
      // 後から始めた読み込み・保存の結果をもう使っていたら、そちら(新しい方)を返す
      return accept(seq, d) ? d : latest;
    });
    cached = p;
  }
  return cached;
}

/** 保存して、保存後の中身を返す(失敗=null)。成功した中身を読み込み済みの値にする。 */
export async function savePreferences(patch: AppearancePatch): Promise<PreferencesData | null> {
  const seq = ++requestSeq;
  const data = await requestPreferences({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  // 保存そのものは成功(呼び出し側の「保存しました」用に返す)。共有の値と合図は、より新しい返事が無いときだけ
  if (data) accept(seq, data);
  return data;
}

export async function saveAppearance(patch: AppearancePatch): Promise<boolean> {
  return (await savePreferences(patch)) !== null;
}
