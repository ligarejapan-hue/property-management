import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/**
 * S1b-2: 画面保護（透かし）の純ロジック。UI から切り離し node 環境で単体テストする。
 *
 * 注意: これは「抑止＋事後追跡」であって「防止」ではない。
 * DevTools で透かし要素は削除可能であり、OS スクリーンショット / 画面録画 / 外部カメラ撮影は
 * Web からは検知も禁止もできない（後続 PR でも同様）。
 */

/**
 * screen_protection:bypass を持つユーザーは画面保護（透かし）を免除される。
 * 未付与時は default-deny（= 保護対象 = 透かし表示）。hasPermission がそのまま使える。
 */
export function isScreenProtectionBypassed(
  permissions: PermissionEntry[],
): boolean {
  return hasPermission(permissions, "screen_protection", "bypass");
}

export interface WatermarkParts {
  name?: string | null;
  email?: string | null;
  role?: string | null;
  /** ページ表示時刻（フォレンジック用に mount 時刻を一度だけ確定して渡す） */
  now: Date;
}

/**
 * 透かし表示文字列を組み立てる。
 * 例: "山田太郎 <yamada@example.com> [admin] 2026-06-03 14:30"
 *
 * Codex P2-2: traceability の無い汎用透かしを出さない。
 * - name / email / role の識別情報が 1 つも無い場合は **null** を返す
 *   （= 呼び出し側は透かしを描画しない。汎用の代替文言にフォールバックしない）。
 * - 取得できた識別情報のみを連結する（name 欠損でも email / role があれば生成する）。
 * 表示するのは「閲覧者自身の身元」であり、所有者等の第三者 PII ではない。
 */
export function buildWatermarkText({
  name,
  email,
  role,
  now,
}: WatermarkParts): string | null {
  const safeName = (name ?? "").trim();
  const safeEmail = (email ?? "").trim();
  const safeRole = (role ?? "").trim();

  // 識別情報が一切無ければ汎用透かしを出さない（fail-safe より traceability を優先）。
  if (!safeName && !safeEmail && !safeRole) return null;

  const parts: string[] = [];
  if (safeName) parts.push(safeName);
  if (safeEmail) parts.push(`<${safeEmail}>`);
  if (safeRole) parts.push(`[${safeRole}]`);
  parts.push(formatTimestamp(now));
  return parts.join(" ");
}

function formatTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/**
 * Codex P2-1: viewport 全体を覆う透かし背景を生成する。
 *
 * 固定個数のタイル要素ではなく、回転した透かしテキストを 1 タイルに描いた SVG を
 * `background-repeat: repeat` で敷き詰める。これにより wide / tall / 4K でも
 * 下端・右端に無透かし領域を残さず全面を覆える（DOM ノード数も一定）。
 *
 * テキストは XML エスケープしてから encodeURIComponent するため、
 * "<email>" の山括弧が SVG タグとして解釈される（インジェクション）ことはない。
 *
 * 戻り値は CSS `background-image` にそのまま渡せる `url("data:image/svg+xml,...")`。
 */
export function watermarkSvgDataUri(text: string): string {
  const safe = xmlEscape(text);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='180'>` +
    `<text x='12' y='96' fill='#111827' font-family='sans-serif' font-size='13' ` +
    `font-weight='600' transform='rotate(-30 170 96)'>${safe}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// S1b-3: copy / cut / contextmenu / print 抑止＋client 監査の純ロジック。
// detail は非PII enum のみ。URL / path / 選択テキスト / 所有者名は一切扱わない。
// ============================================================

/** client が送る操作イベント種別（厳格 enum）。 */
export const SCREEN_PROTECTION_EVENT_TYPES = [
  "copy",
  "cut",
  "contextmenu",
  "print",
  "print_shortcut",
] as const;
export type ScreenProtectionEventType =
  (typeof SCREEN_PROTECTION_EVENT_TYPES)[number];

/** PII 画面の粗いラベル（ID を含まない非PII enum）。 */
export const SCREEN_PROTECTION_SURFACES = [
  "owner",
  "property",
  "history",
  "import",
  "registry",
  "dashboard",
] as const;
export type ScreenProtectionSurface =
  (typeof SCREEN_PROTECTION_SURFACES)[number];

export type ScreenProtectionAuditAction =
  | "pii_copy_attempt"
  | "pii_cut_attempt"
  | "pii_contextmenu_attempt"
  | "pii_print_attempt";

/** detail.trigger（操作の発生源。非PII enum）。 */
export type ScreenProtectionTrigger =
  | "clipboard"
  | "menu"
  | "print_dialog"
  | "keyboard";

export function isScreenProtectionEventType(
  v: unknown,
): v is ScreenProtectionEventType {
  return (
    typeof v === "string" &&
    (SCREEN_PROTECTION_EVENT_TYPES as readonly string[]).includes(v)
  );
}

export function isScreenProtectionSurface(
  v: unknown,
): v is ScreenProtectionSurface {
  return (
    typeof v === "string" &&
    (SCREEN_PROTECTION_SURFACES as readonly string[]).includes(v)
  );
}

/**
 * eventType → AuditLog action。
 * print と print_shortcut は同一 action(pii_print_attempt) に統合し、trigger で区別する。
 */
export function eventTypeToAuditAction(
  eventType: ScreenProtectionEventType,
): ScreenProtectionAuditAction {
  switch (eventType) {
    case "copy":
      return "pii_copy_attempt";
    case "cut":
      return "pii_cut_attempt";
    case "contextmenu":
      return "pii_contextmenu_attempt";
    case "print":
    case "print_shortcut":
      return "pii_print_attempt";
  }
}

/** eventType → detail.trigger（非PII enum、サーバ側で決定し client を信用しない）。 */
export function eventTypeToTrigger(
  eventType: ScreenProtectionEventType,
): ScreenProtectionTrigger {
  switch (eventType) {
    case "copy":
    case "cut":
      return "clipboard";
    case "contextmenu":
      return "menu";
    case "print":
      return "print_dialog";
    case "print_shortcut":
      return "keyboard";
  }
}

export interface ScreenProtectionAuditDetail {
  surface: ScreenProtectionSurface;
  trigger: ScreenProtectionTrigger;
}

/** 監査 detail を非PII enum のみで構築する（PII は構造的に混入できない）。 */
export function buildScreenProtectionAuditDetail(
  eventType: ScreenProtectionEventType,
  surface: ScreenProtectionSurface,
): ScreenProtectionAuditDetail {
  return { surface, trigger: eventTypeToTrigger(eventType) };
}

// ------------------------------------------------------------
// S1b-3 / Codex P1: PII 保護領域の selection-aware 判定。
// copy/cut では event.target だけでなく選択範囲(range)も見る必要がある
// （非editable text を選択して Ctrl/Cmd+C すると target が body / focused element に
//  なり、[data-pii-protected] 内の選択を取りこぼす抜け道があるため）。
//
// 実 DOM の Element / Node / Range は下記の構造的 interface を満たすので、guard 側で
// そのまま渡せる。DOM を直接持たない純関数にして node 環境でモック単体テストする。
// ------------------------------------------------------------

export interface DomElementLike {
  getAttribute(name: string): string | null;
  closest(selector: string): DomElementLike | null;
}
export interface DomNodeLike {
  nodeType: number;
  parentElement: DomElementLike | null;
}
export interface DomRangeLike {
  commonAncestorContainer: DomNodeLike;
  startContainer: DomNodeLike;
  endContainer: DomNodeLike;
  /** Codex P2: 選択範囲が node と交差するか（protected panel をまたぐ選択の検知）。非対応環境では省略可。 */
  intersectsNode?(node: DomNodeLike): boolean;
}
export interface ProtectedRegionOpts {
  /** PII 保護領域セレクタ（例: [data-pii-protected]）。 */
  piiSelector: string;
  /**
   * 常に抑止しない「編集系」要素セレクタ（input/textarea/select/contenteditable）。
   * ここに button / a は含めない（編集領域のみ）。
   */
  editableSelector: string;
  /**
   * interactive wrapper セレクタ（button / a）。これら自体・配下の通常 control は、
   * 広い [data-pii-protected] container の中にあるだけなら抑止しない（contextmenu 等の
   * UX を壊さない）。ただし button / a より内側に明示的な PII fragment（小さな
   * data-pii-protected。例: owner/phone search suggestions の owner span）がある場合は、
   * その fragment を保護対象にする。
   */
  interactiveSelector: string;
  /** surface を読む属性名（例: data-pii-surface）。 */
  surfaceAttr: string;
}

const DOM_ELEMENT_NODE = 1;

function nodeToElement(node: DomNodeLike | null): DomElementLike | null {
  if (!node) return null;
  // element node は自身が DomElementLike（closest / getAttribute を持つ）。
  if (node.nodeType === DOM_ELEMENT_NODE) {
    return node as unknown as DomElementLike;
  }
  // text node 等は親要素から辿る。
  return node.parentElement;
}

/**
 * node が PII 保護領域内（piiSelector）かつ次の除外条件に当たらなければ surface を返す。
 *  1. 編集系(editableSelector: input/textarea/select/contenteditable)内 → 常に除外。
 *  2. button / a の扱いは region との位置関係で 2 分する:
 *     - 広い PII container 内にあるだけの button / a（最近接 PII 祖先が region と同一）
 *       → 通常 control として除外（contextmenu 等の UX を壊さない）。
 *     - button / a より内側に明示的な PII fragment がある（最近接 PII 祖先が region と異なる、
 *       = region が button/a の内側。例: suggestions の owner span）→ 保護する。
 * plain な button/link は pii 領域外なので region=null となり、従来どおり surface は返らない。
 */
export function resolveProtectedSurfaceForNode(
  node: DomNodeLike | null,
  opts: ProtectedRegionOpts,
): string | null {
  const el = nodeToElement(node);
  if (!el) return null;
  const region = el.closest(opts.piiSelector);
  if (!region) return null;
  // 1. 編集系は常に除外（編集操作・a11y 維持）。
  if (el.closest(opts.editableSelector)) return null;
  // 2. button / a が広い PII container の内側にあるだけ（最近接 PII 祖先が region と同一）なら
  //    通常 control として除外。region が button/a より内側（明示的 PII fragment）なら保護する。
  const interactive = el.closest(opts.interactiveSelector);
  if (interactive && interactive.closest(opts.piiSelector) === region) {
    return null;
  }
  return region.getAttribute(opts.surfaceAttr) ?? "dashboard";
}

/**
 * 選択範囲が PII 保護領域に関係するなら surface を返す（copy/cut の selection 判定）。
 *
 * 判定段階:
 *  - editable 除外維持: 選択範囲全体が編集系要素(input/textarea/select/contenteditable)内
 *    （commonAncestor が editable 配下）なら抑止しない。
 *  - button / a の「広い container 内 control は除外／内側の明示 PII fragment は保護」判定は
 *    per-container の resolveProtectedSurfaceForNode に委譲する。
 *  - P1: commonAncestorContainer / startContainer / endContainer のいずれかが保護領域内
 *    （copy event の target が body でも検知）。
 *  - P2(Codex): start/end/commonAncestor がすべて保護領域外でも、選択が protected panel を
 *    またぐ場合は range.intersectsNode(protectedElement) で交差を検知する
 *    （panel 内の PII が選択に含まれるため）。protectedElements は呼び出し側が
 *    document.querySelectorAll([data-pii-protected]) 相当で渡す。ただし選択全体が button / a 内に
 *    閉じている場合は、その button / a 内の明示的 PII fragment との交差のみ抑止し、外側の broad
 *    container との交差では抑止しない（broad container 内の通常 button/link ラベルの copy を壊さない）。
 */
export function resolveProtectedSurfaceForRanges(
  ranges: readonly DomRangeLike[],
  protectedElements: readonly DomElementLike[],
  opts: ProtectedRegionOpts,
): string | null {
  for (const range of ranges) {
    // editable 除外: 選択範囲全体が編集系要素(input/textarea/select/contenteditable)内なら
    // 抑止しない。button / a の扱いは P1 の resolveProtectedSurfaceForNode に委譲する。
    const commonEl = nodeToElement(range.commonAncestorContainer);
    if (commonEl && commonEl.closest(opts.editableSelector)) continue;

    // P1: container の ancestor 判定。
    for (const node of [
      range.commonAncestorContainer,
      range.startContainer,
      range.endContainer,
    ]) {
      const surface = resolveProtectedSurfaceForNode(node, opts);
      if (surface) return surface;
    }

    // P2: protected panel をまたぐ mixed selection を intersectsNode で検知。
    // ただし選択全体が button / a 内に閉じている（commonAncestor が interactive 配下）場合は、
    // その button / a 内にある明示的 PII fragment との交差のみ抑止し、外側の broad container との
    // 交差では抑止しない（broad container 内の通常 button/link ラベルの copy を壊さない）。
    if (typeof range.intersectsNode === "function") {
      const interactiveEl = commonEl
        ? commonEl.closest(opts.interactiveSelector)
        : null;
      for (const el of protectedElements) {
        // 選択が button / a 内に閉じているなら、最近接 interactive 祖先が同じ button / a である
        // 明示的 PII fragment 以外（= 外側 broad container）は無視する。
        if (
          interactiveEl &&
          el.closest(opts.interactiveSelector) !== interactiveEl
        ) {
          continue;
        }
        let hit = false;
        try {
          hit = range.intersectsNode(el as unknown as DomNodeLike);
        } catch {
          // intersectsNode 非対応ブラウザ等では container 判定のみで fallback。
          hit = false;
        }
        if (hit) {
          return el.getAttribute(opts.surfaceAttr) ?? "dashboard";
        }
      }
    }
  }
  return null;
}
