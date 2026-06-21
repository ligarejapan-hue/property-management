"use client";

/**
 * dev限定 テーマ調整パネル（Option B）。
 *
 * 実際のアプリ画面の上にフローティング表示し、スライダー/カラーピッカーで
 * :root の CSS 変数（--background / --foreground / --color-gray-* / --spacing /
 * --radius-* / font-size）を実行時に上書きする。Tailwind v4 はこれらを :root の
 * CSS 変数として出力するため、既存クラス（bg-gray-*, rounded-*, p-* 等）が
 * その場でライブに変化する。
 *
 * 安全装置:
 *  - 本コンポーネントは development でのみ描画（先頭ガード）。
 *  - layout.tsx 側も NODE_ENV ゲートでマウントするため、本番ビルドからは
 *    コードごと除去される（バンドル非同梱）。
 *  - パネル自身の見た目は固定値（pmtt-* / インラインstyle）で、調整対象トークンに
 *    依存しない＝スライダーを動かしてもパネルは歪まない。
 */

import { useCallback, useEffect, useState } from "react";

import {
  buildCssVariables,
  buildExportCss,
  buildGrayScale,
  DEFAULT_TUNER_STATE,
  GRAY_STOPS,
  normalizeHexColor,
  type RadiusKey,
  type TunerState,
} from "./theme-tokens";

const STORAGE_KEY = "pm-dev-theme-tuner-v1";
const RADIUS_KEYS: RadiusKey[] = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"];

type Mode = "light" | "dark";

/** documentElement に流し込んだ上書きを全て除去（アンマウント/クリア用）。 */
function clearOverrides() {
  const root = document.documentElement;
  ["--background", "--foreground", "--spacing"].forEach((k) =>
    root.style.removeProperty(k),
  );
  GRAY_STOPS.forEach((s) => root.style.removeProperty(`--color-gray-${s}`));
  RADIUS_KEYS.forEach((k) => root.style.removeProperty(`--radius-${k}`));
  root.style.removeProperty("font-size");
}

/** localStorage から初期 state を読む（SSR では既定値）。 */
function loadInitialState(): TunerState {
  if (typeof window === "undefined") return DEFAULT_TUNER_STATE;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.state) return { ...DEFAULT_TUNER_STATE, ...saved.state };
  } catch {
    /* 破損データは既定値で無視 */
  }
  return DEFAULT_TUNER_STATE;
}

/** 保存モード → 無ければ OS のカラースキーム（SSR では light）。 */
function loadInitialMode(): Mode {
  if (typeof window === "undefined") return "light";
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.mode === "light" || saved?.mode === "dark") return saved.mode;
  } catch {
    /* 破損データは無視 */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export default function ThemeTunerPanel() {
  const [open, setOpen] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<Mode>(loadInitialMode);
  const [state, setState] = useState<TunerState>(loadInitialState);

  // 反映 + 保存（state/mode 変化のたびに :root の CSS 変数を上書き）
  useEffect(() => {
    const root = document.documentElement;
    const vars = buildCssVariables(state, mode);
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    // font-size も既定(16px)から変えた時だけ上書き。既定では root font-size を
    // 設定せず、ブラウザ既定（アクセシビリティ設定）を尊重する（export と一致）。
    if (state.fontSize !== DEFAULT_TUNER_STATE.fontSize) {
      root.style.fontSize = `${state.fontSize}px`;
    } else {
      root.style.removeProperty("font-size");
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, mode }));
    } catch {
      /* quota 等は無視 */
    }
  }, [state, mode]);

  // アンマウント時に上書きを除去（dev では基本マウントしっぱなし）
  useEffect(() => clearOverrides, []);

  const patch = useCallback((p: Partial<TunerState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const patchColor = useCallback(
    (key: "bg" | "fg", value: string) => {
      setState((prev) => ({ ...prev, [mode]: { ...prev[mode], [key]: value } }));
    },
    [mode],
  );

  const reset = useCallback(() => {
    setState(DEFAULT_TUNER_STATE);
    setMode(
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    );
  }, []);

  const copy = useCallback(async () => {
    const text = buildExportCss(state);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard 不可環境では textarea から手動コピー */
    }
  }, [state]);

  if (process.env.NODE_ENV !== "development") return null;

  const colors = state[mode];
  const swatches = buildGrayScale(state.grayHueShift, state.grayChromaScale);

  return (
    <div className="pmtt-root">
      <style>{PANEL_CSS}</style>

      {!open && (
        <button
          className="pmtt-launcher"
          title="テーマ調整 (dev)"
          onClick={() => setOpen(true)}
        >
          🎨
        </button>
      )}

      {open && (
        <section className="pmtt-panel" aria-label="テーマ調整パネル (dev)">
          <header className="pmtt-head">
            <strong>🎨 テーマ調整</strong>
            <span className="pmtt-tag">dev</span>
            <div className="pmtt-spacer" />
            <div className="pmtt-seg">
              <button
                aria-pressed={mode === "light"}
                onClick={() => setMode("light")}
              >
                ☀
              </button>
              <button
                aria-pressed={mode === "dark"}
                onClick={() => setMode("dark")}
              >
                🌙
              </button>
            </div>
            <button
              className="pmtt-icon"
              title="閉じる"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </header>

          <div className="pmtt-body">
            <div className="pmtt-section">
              <h4>色（{mode === "dark" ? "ダーク" : "ライト"}）</h4>
              <ColorRow
                label="背景"
                value={colors.bg}
                onChange={(v) => patchColor("bg", v)}
              />
              <ColorRow
                label="文字"
                value={colors.fg}
                onChange={(v) => patchColor("fg", v)}
              />
            </div>

            <div className="pmtt-section">
              <h4>グレー階調</h4>
              <Slider
                label="色相"
                min={-40}
                max={40}
                step={1}
                value={state.grayHueShift}
                fmt={(v) => `${v > 0 ? "+" : ""}${v}°`}
                onChange={(v) => patch({ grayHueShift: v })}
              />
              <Slider
                label="彩度"
                min={0}
                max={2}
                step={0.05}
                value={state.grayChromaScale}
                fmt={(v) => `×${v.toFixed(2)}`}
                onChange={(v) => patch({ grayChromaScale: v })}
              />
              <div className="pmtt-swatches">
                {swatches.map((c, i) => (
                  <span
                    key={GRAY_STOPS[i]}
                    style={{ background: c }}
                    title={`gray-${GRAY_STOPS[i]}: ${c}`}
                  />
                ))}
              </div>
            </div>

            <div className="pmtt-section">
              <h4>形・余白・文字</h4>
              <Slider
                label="角丸"
                min={0}
                max={3}
                step={0.1}
                value={state.radiusScale}
                fmt={(v) => `×${v.toFixed(1)}`}
                onChange={(v) => patch({ radiusScale: v })}
              />
              <p className="pmtt-hint">
                ※ 素の rounded（0.25rem固定）は対象外 / rounded-md・lg 等は反映
              </p>
              <Slider
                label="余白"
                min={0.18}
                max={0.34}
                step={0.005}
                value={state.spacing}
                fmt={(v) => `${v.toFixed(3)}rem`}
                onChange={(v) => patch({ spacing: v })}
              />
              <Slider
                label="文字"
                min={13}
                max={18}
                step={0.5}
                value={state.fontSize}
                fmt={(v) => `${v}px`}
                onChange={(v) => patch({ fontSize: v })}
              />
            </div>
          </div>

          <footer className="pmtt-foot">
            <button className="pmtt-btn" onClick={reset}>
              ↺ 現在値に戻す
            </button>
            <button
              className="pmtt-btn pmtt-primary"
              onClick={() => setShowExport(true)}
            >
              ⤓ CSSを出力
            </button>
          </footer>
        </section>
      )}

      {showExport && (
        <div className="pmtt-overlay" onClick={() => setShowExport(false)}>
          <div className="pmtt-modal" onClick={(e) => e.stopPropagation()}>
            <header className="pmtt-head">
              <strong>出力：globals.css に貼り付け</strong>
              <div className="pmtt-spacer" />
              <button
                className="pmtt-icon"
                onClick={() => setShowExport(false)}
              >
                ✕
              </button>
            </header>
            <div className="pmtt-modal-body">
              <p className="pmtt-note">
                <code>src/app/globals.css</code>{" "}
                の該当ブロックを置き換えてください（自動反映なし）。
              </p>
              <textarea
                className="pmtt-textarea"
                readOnly
                spellCheck={false}
                value={buildExportCss(state)}
              />
            </div>
            <footer className="pmtt-foot">
              {copied && <span className="pmtt-copied">✓ コピーしました</span>}
              <button className="pmtt-btn pmtt-primary" onClick={copy}>
                クリップボードにコピー
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // 入力途中（#fff など不完全な値）も打てるよう下書きを別管理し、完全な HEX に
  // なった時だけ親へ確定する。value が外部要因（モード切替/リセット/カラーピッカー）
  // で変わったら下書きを同期する（render 中で同期＝effect は使わない）。
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }
  return (
    <label className="pmtt-colorrow">
      <span>{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          // 入力中は 6 桁完成時のみ即反映する。3桁を途中で展開すると 6桁入力の
          // 打鍵途中（#abc→#abcdef）でカーソルが乱れるため、展開は blur で行う。
          if (/^#[0-9a-fA-F]{6}$/.test(next.trim())) {
            onChange(next.trim().toLowerCase());
          }
        }}
        onBlur={() => {
          // 確定時に正規化（3桁ショートハンド→6桁へ展開）。color input は #rrggbb のみ
          // 受理するため確定値は常に 6桁。無効な打ちかけは直近の確定値へ戻す。
          const normalized = normalizeHexColor(draft);
          if (normalized) {
            onChange(normalized);
            setDraft(normalized);
          } else {
            setDraft(value);
          }
        }}
      />
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  fmt,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="pmtt-row">
      <span className="pmtt-label">{label}</span>
      <input
        className="pmtt-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="pmtt-val">{fmt(value)}</span>
    </div>
  );
}

/** パネル自身の固定スタイル（調整対象トークンに非依存）。 */
const PANEL_CSS = `
.pmtt-root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.pmtt-launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 44px; height: 44px; border-radius: 999px; border: 1px solid #d6d3d1;
  background: #ffffff; box-shadow: 0 6px 20px rgba(0,0,0,.18); cursor: pointer; font-size: 20px;
}
.pmtt-launcher:hover { background: #f5f5f4; }
.pmtt-panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 320px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  background: #ffffff; color: #1c1917; border: 1px solid #e7e5e4; border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0,0,0,.28); overflow: hidden; font-size: 13px;
}
.pmtt-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e7e5e4; }
.pmtt-head strong { font-size: 13px; }
.pmtt-tag { font-size: 10px; font-weight: 700; color: #6d28d9; background: #ede9fe; padding: 1px 6px; border-radius: 6px; }
.pmtt-spacer { flex: 1; }
.pmtt-seg { display: inline-flex; border: 1px solid #e7e5e4; border-radius: 8px; overflow: hidden; }
.pmtt-seg button { border: 0; background: #fff; padding: 4px 9px; cursor: pointer; font-size: 13px; }
.pmtt-seg button[aria-pressed="true"] { background: #4f46e5; color: #fff; }
.pmtt-icon { border: 0; background: transparent; cursor: pointer; font-size: 14px; color: #78716c; padding: 4px 6px; }
.pmtt-icon:hover { color: #1c1917; }
.pmtt-body { overflow-y: auto; padding: 4px 0; }
.pmtt-section { padding: 10px 12px; border-bottom: 1px solid #f0eeed; }
.pmtt-section h4 { margin: 0 0 8px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #78716c; font-weight: 700; }
.pmtt-row { display: grid; grid-template-columns: 40px 1fr 64px; align-items: center; gap: 8px; margin: 7px 0; }
.pmtt-label { font-size: 12px; }
.pmtt-val { font-variant-numeric: tabular-nums; font-size: 11px; color: #78716c; text-align: right; }
.pmtt-range { width: 100%; accent-color: #4f46e5; }
.pmtt-colorrow { display: grid; grid-template-columns: 40px 34px 1fr; align-items: center; gap: 8px; margin: 7px 0; font-size: 12px; }
.pmtt-colorrow input[type="color"] { width: 34px; height: 26px; padding: 0; border: 1px solid #e7e5e4; border-radius: 6px; background: none; cursor: pointer; }
.pmtt-colorrow input[type="text"] { width: 100%; border: 1px solid #e7e5e4; border-radius: 6px; padding: 5px 7px; font-family: ui-monospace, monospace; font-size: 12px; }
.pmtt-swatches { display: grid; grid-template-columns: repeat(11, 1fr); gap: 2px; margin-top: 8px; }
.pmtt-swatches span { height: 22px; border-radius: 4px; border: 1px solid rgba(0,0,0,.06); }
.pmtt-foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e7e5e4; align-items: center; }
.pmtt-btn { flex: 1; border: 1px solid #e7e5e4; background: #fff; color: #1c1917; padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; }
.pmtt-btn:hover { background: #f5f5f4; }
.pmtt-primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
/* :hover の指定は .pmtt-btn:hover と同特異度なので、後勝ちで background を上書きする
   （filter だけだと .pmtt-btn:hover の薄灰背景が残り、白文字が見えなくなる） */
.pmtt-primary:hover { background: #4338ca; border-color: #4338ca; }
.pmtt-note { font-size: 11px; color: #57534e; margin: 0 0 8px; }
.pmtt-hint { font-size: 10px; color: #a8a29e; margin: -2px 0 8px; }
.pmtt-overlay { position: fixed; inset: 0; z-index: 2147483001; background: rgba(28,25,23,.45); display: flex; align-items: center; justify-content: center; padding: 24px; }
.pmtt-modal { background: #fff; color: #1c1917; border-radius: 12px; width: min(680px, 100%); max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 24px 64px rgba(0,0,0,.3); overflow: hidden; }
.pmtt-modal-body { padding: 12px; overflow: auto; }
.pmtt-textarea { width: 100%; height: 340px; resize: vertical; border: 1px solid #e7e5e4; border-radius: 8px; padding: 10px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.5; background: #faf9f8; white-space: pre; }
.pmtt-copied { color: #16a34a; font-size: 12px; margin-right: auto; }
`;
