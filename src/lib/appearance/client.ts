import { DENSITY_OPTIONS, LAYOUT_OPTIONS, type AppearancePatch, type DensityPref, type LayoutPref } from "./options";
import { STORAGE_KEYS } from "./boot-script";

// 見た目の設定: 画面側で 文字サイズ・レイアウト を付け替える/保存する部品。
// html の data-density / data-layout が「今の値」の1か所(ヘッダーとメニューの選択欄は両方ここを見る)。
// 付け替えたら合図(イベント)を出し、表示中の選択欄すべてに知らせる。

export const APPEARANCE_CHANGE_EVENT = "pm-appearance-change";
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

export async function saveAppearance(patch: AppearancePatch): Promise<boolean> {
  try {
    const res = await fetch("/api/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}
