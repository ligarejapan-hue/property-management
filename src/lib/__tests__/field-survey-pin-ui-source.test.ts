/**
 * Phase 1-G Pin UI のソース静的検証。
 *
 * 主目的:
 * - active session が無い時に pin 追加 toggle / create modal が出ない構造
 * - field_survey:write 不所持の判定経路（canWritePin: boolean | null）
 * - pinType 4 種 (candidate / interesting / blocked / followup) を使う
 * - memo maxLength が FIELD_SURVEY_MEMO_MAX_LEN
 * - getCurrentPosition は単発で、watchPosition / wakeLock を使わない
 * - 詳細パネルは GET /api/field-survey/pins/[id]
 * - memo 表示に dangerouslySetInnerHTML を使わない
 * - own pin のみ編集 UI が出る
 * - lat / lng / raw position / memo / raw API response / env / API key を
 *   console に出さない
 * - localStorage / sessionStorage / IndexedDB を使わない
 * - archived を「削除」と表記しない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const TOGGLE_SRC = readSrc(
  "src/components/field-survey/pin-add-mode-toggle.tsx",
);
const CREATE_SRC = readSrc(
  "src/components/field-survey/pin-create-modal.tsx",
);
const DETAIL_SRC = readSrc(
  "src/components/field-survey/pin-detail-panel.tsx",
);
const HOOK_SRC = readSrc(
  "src/components/field-survey/use-field-survey-pin-mutations.ts",
);
const MAP_SRC = readSrc(
  "src/components/field-survey/field-survey-map.tsx",
);
const UTIL_SRC = readSrc("src/lib/field-survey-pin-util.ts");

// =======================================================================
// pin-add-mode-toggle
// =======================================================================
describe("pin-add-mode-toggle.tsx", () => {
  it("'use client' で始まる", () => {
    expect(TOGGLE_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("data-testid と aria-pressed を持つ", () => {
    expect(TOGGLE_SRC).toMatch(/data-testid="pin-add-mode-toggle"/);
    expect(TOGGLE_SRC).toMatch(/aria-pressed=\{active\}/);
  });

  it("canWrite === false で disabled", () => {
    expect(TOGGLE_SRC).toMatch(/canWrite\s*===\s*false/);
    expect(TOGGLE_SRC).toMatch(/disabled=\{disabled\}/);
  });

  it("権限不足文言「ピン追加の権限がありません」を持つ", () => {
    expect(TOGGLE_SRC).toMatch(/ピン追加の権限がありません/);
  });

  it("console / lat / lng / API key を出さない", () => {
    expect(TOGGLE_SRC).not.toMatch(/console\.\w+\(/);
    expect(TOGGLE_SRC).not.toMatch(/lat|lng|AIza/);
  });
});

// =======================================================================
// pin-create-modal
// =======================================================================
describe("pin-create-modal.tsx", () => {
  it("'use client' で始まる", () => {
    expect(CREATE_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("data-testid を持つ", () => {
    expect(CREATE_SRC).toMatch(/data-testid="pin-create-modal"/);
    expect(CREATE_SRC).toMatch(/data-testid="pin-create-submit"/);
  });

  it("pinType 4 種 (candidate / interesting / blocked / followup) の radio を render", () => {
    expect(CREATE_SRC).toMatch(/FIELD_SURVEY_PIN_TYPES/);
    expect(CREATE_SRC).toMatch(/data-testid=\{`pin-create-type-\$\{t\}`\}/);
    // 旧候補名を持ち込んでいない
    expect(CREATE_SRC).not.toMatch(/vacant_house_candidate/);
    expect(CREATE_SRC).not.toMatch(/registry_request_candidate/);
    expect(CREATE_SRC).not.toMatch(/follow_up\b/);
    expect(CREATE_SRC).not.toMatch(/\botherType\b/);
  });

  it("memo textarea に FIELD_SURVEY_MEMO_MAX_LEN の maxLength", () => {
    expect(CREATE_SRC).toMatch(/maxLength=\{FIELD_SURVEY_MEMO_MAX_LEN\}/);
    expect(CREATE_SRC).toMatch(/data-testid="pin-create-memo"/);
  });

  it("巡回の有無は submit の条件にしない (巡回なし撮影の正常系)", () => {
    // sessionId=null は field_survey:quick_capture での正常系。保存可否は
    // 座標と busy だけで決め、権限判定はサーバー (POST /pins) に委ねる。
    expect(CREATE_SRC).toMatch(/canSubmit\s*=\s*\n?\s*!busy\s*&&/);
    expect(CREATE_SRC).not.toMatch(/canSubmit\s*=[\s\S]{0,80}?!!sessionId/);
  });

  it("巡回外で保存するときは軌跡が残らないことを説明する", () => {
    expect(CREATE_SRC).toMatch(/巡回外の撮影として保存します/);
    expect(CREATE_SRC).toMatch(/移動ルートは記録されません/);
    // 「保存できません」と誤解させる旧文言を残さない
    expect(CREATE_SRC).not.toMatch(/巡回中でないため保存できません/);
    // 技術用語「session」を利用者向け文言に出さない (平易語ルール)
    expect(CREATE_SRC).not.toMatch(/巡回 session/);
  });

  it("watchPosition / wakeLock / IndexedDB / Storage を使わない", () => {
    expect(CREATE_SRC).not.toMatch(/watchPosition\s*\(/);
    expect(CREATE_SRC).not.toMatch(/wakeLock/);
    expect(CREATE_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(CREATE_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(CREATE_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });

  it("console に lat / lng / position / response を出さない", () => {
    expect(CREATE_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(CREATE_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(CREATE_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
    expect(CREATE_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(CREATE_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("Property 新規作成 / propertyId 入力欄を出さない (Phase 1-G スコープ外)", () => {
    expect(CREATE_SRC).not.toMatch(/propertyId/);
    expect(CREATE_SRC).not.toMatch(/property 新規/);
  });
});

// =======================================================================
// pin-detail-panel
// =======================================================================
describe("pin-detail-panel.tsx", () => {
  it("'use client' で始まる", () => {
    expect(DETAIL_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("data-testid を持つ", () => {
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-panel"/);
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-memo"/);
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-edit-button"/);
  });

  it("fetchPinDetail (= GET /api/field-survey/pins/[id]) を呼ぶ", () => {
    expect(DETAIL_SRC).toMatch(/fetchPinDetail\(pinId\)/);
    // 直接 URL を書かず hook 経由だが、hook 側を併せて URL チェック
    expect(HOOK_SRC).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(pinId\)\}/,
    );
  });

  it("memo 表示に dangerouslySetInnerHTML を使わない", () => {
    expect(DETAIL_SRC).not.toMatch(/dangerouslySetInnerHTML/);
    // whitespace-pre-wrap で出す
    expect(DETAIL_SRC).toMatch(/whitespace-pre-wrap/);
  });

  it("own pin のみ編集 UI を出す (canEditOwn ゲート + isFresh)", () => {
    // Codex P2 fix 2: isOwn は isFresh かつ own staff のみ true。
    expect(DETAIL_SRC).toMatch(
      /isOwn\s*=\s*isFresh\s*&&\s*detail!\.staffUserId\s*===\s*currentUserId/,
    );
    // Phase 1-J: 編集 UI は canEditOwn (= !readOnly && isOwn) で gate する。
    expect(DETAIL_SRC).toMatch(/canEditOwn\s*=\s*!readOnly\s*&&\s*isOwn/);
    // ReadOnlyView の編集ボタンと EditView render が canEditOwn 条件付き
    expect(DETAIL_SRC).toMatch(/\{canEdit\s*&&\s*\(/);
    expect(DETAIL_SRC).toMatch(/editing\s*&&\s*canEditOwn/);
  });

  it("作成者は own=「あなた」 / 他人=「他スタッフ」を出し、staffUserId 生値を出さない", () => {
    expect(DETAIL_SRC).toMatch(/isOwn \? "あなた" : "他スタッフ"/);
    // staffUserId 生値を出力しない (UI 側で個人特定可能な ID を出さない)
    expect(DETAIL_SRC).not.toMatch(/\{detail\.staffUserId\}/);
  });

  it("optimistic update しない (保存後に setDetail を server 結果で更新)", () => {
    // r.data で詳細を再代入する pattern
    expect(DETAIL_SRC).toMatch(/r\.data[\s\S]*?setDetail\(r\.data\)/);
  });

  it("保存中は二重送信を防ぐ (button disabled)", () => {
    expect(DETAIL_SRC).toMatch(/disabled=\{saving\}/);
  });

  it("buildPinPatch === null なら PATCH を打たず編集モード終了 (空 patch 防止)", () => {
    expect(DETAIL_SRC).toMatch(/buildPinPatch\(/);
    expect(DETAIL_SRC).toMatch(/if\s*\(!patch\)/);
  });

  it("pin status の archived を「削除」と表記しない (写真削除ボタンとは別物)", () => {
    // Phase 1-H: 写真削除ボタン (「写真を削除」) は許可。pin status の archived を
    // 「削除」とラベルしないことだけを担保する。status 表示は formatPinStatus 経由。
    expect(DETAIL_SRC).toMatch(/formatPinStatus\(/);
    expect(DETAIL_SRC).not.toMatch(/archived[\s\S]{0,40}削除/);
    expect(DETAIL_SRC).not.toMatch(/削除[\s\S]{0,40}archived/);
  });

  it("localStorage / sessionStorage / IndexedDB / wakeLock を使わない", () => {
    expect(DETAIL_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(DETAIL_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(DETAIL_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(DETAIL_SRC).not.toMatch(/wakeLock/);
  });

  it("console に lat / lng / memo / response を出さない", () => {
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*memo/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("desktop は右側パネル / mobile は bottom sheet 風", () => {
    // tailwind class で md: の inset-y-0 right-0 を含む
    expect(DETAIL_SRC).toMatch(/md:inset-y-0/);
    expect(DETAIL_SRC).toMatch(/md:right-0/);
    // mobile: bottom 0
    expect(DETAIL_SRC).toMatch(/bottom-0/);
  });
});

// =======================================================================
// use-field-survey-pin-mutations
// =======================================================================
describe("use-field-survey-pin-mutations.ts", () => {
  it("'use client' で始まる", () => {
    expect(HOOK_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("既存 API path POST /api/field-survey/pins / PATCH/GET /[id] を使う", () => {
    expect(HOOK_SRC).toMatch(/fetch\("\/api\/field-survey\/pins",\s*\{[\s\S]*?method:\s*"POST"/);
    expect(HOOK_SRC).toMatch(/method:\s*"PATCH"/);
    expect(HOOK_SRC).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(pinId\)\}/,
    );
  });

  it("AbortController を create / update / detail 別に持つ", () => {
    expect(HOOK_SRC).toMatch(/createAbortRef/);
    expect(HOOK_SRC).toMatch(/updateAbortRef/);
    expect(HOOK_SRC).toMatch(/detailAbortRef/);
  });

  it("unmount cleanup で abort + mountedRef = false", () => {
    expect(HOOK_SRC).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?mountedRef\.current\s*=\s*false[\s\S]*?abort\(\)/,
    );
  });

  it("propertyId は POST body に含めない (Phase 1-G)", () => {
    // buildCreateBody 内で propertyId を一切書かない
    const fn = HOOK_SRC.match(/function buildCreateBody[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn?.[0]).not.toMatch(/propertyId/);
  });

  it("console に lat / lng / response 全文 / api key を出さない", () => {
    expect(HOOK_SRC).not.toMatch(/console\.\w+\(/);
  });

  it("空 patch は実 PATCH を打たず ok を返す (二重防衛)", () => {
    expect(HOOK_SRC).toMatch(
      /Object\.keys\(patch\)\.length\s*===\s*0[\s\S]*?return\s*\{\s*ok:\s*true/,
    );
  });

  it("汎用エラー文言は pinApiErrorMessage(status) 経由", () => {
    expect(HOOK_SRC).toMatch(/pinApiErrorMessage\(res\.status\)/);
  });

  it("AuditLog を UI から直接書かない", () => {
    expect(HOOK_SRC).not.toMatch(/audit/i);
  });
});

// =======================================================================
// field-survey-map.tsx (Phase 1-G 統合)
// =======================================================================
describe("field-survey-map.tsx — Phase 1-G 統合", () => {
  it("PinAddModeToggle / PinCreateModal / PinDetailPanel を import", () => {
    expect(MAP_SRC).toMatch(/import PinAddModeToggle/);
    expect(MAP_SRC).toMatch(/import PinCreateModal/);
    expect(MAP_SRC).toMatch(/import PinDetailPanel/);
  });

  it("active session 中のみ PinAddModeToggle を render", () => {
    expect(MAP_SRC).toMatch(/hasActiveSession\s*&&\s*\(?\s*<PinAddModeToggle/);
  });

  it("createCandidate があるときに create modal を mount し、巡回の有無で sessionId を出し分ける", () => {
    // 巡回なし撮影 (quick_capture) では activeSession が無い状態で開くのが正常系。
    expect(MAP_SRC).toMatch(/createCandidate\s*&&\s*\(?\s*<PinCreateModal/);
    // 巡回中は必ず session に紐づけ、巡回外は null を渡す。
    expect(MAP_SRC).toMatch(/sessionId=\{activeSession\?\.id \?\? null\}/);
    // 巡回外は種類を候補に固定する (完成待ち一覧に出ない孤児ピンを作らない)。
    expect(MAP_SRC).toMatch(
      /initialPinType=\{activeSession \? lastPinType : "candidate"\}/,
    );
  });

  it("detailPinId がある時のみ PinDetailPanel を mount", () => {
    expect(MAP_SRC).toMatch(/detailPinId\s*&&\s*\(?\s*<PinDetailPanel/);
  });

  it("permissions は ScreenProtectionProvider 経由（useScreenProtection）で取得し field_survey:write を判定する", () => {
    // F12 展開(19-A): ページ独自の /api/me/permissions fetch を撤去し、
    // provider 配布値（permissions）から導出する。直接 fetch は持たない。
    expect(MAP_SRC).toMatch(/useScreenProtection\(\)/);
    expect(MAP_SRC).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(MAP_SRC).toMatch(/"field_survey"[\s\S]*?"write"/);
  });

  it("map.addListener('click', ...) は captureMapClick の時のみ effect が走る", () => {
    expect(MAP_SRC).toMatch(/addListener\(\s*"click"/);
    // useEffect 内で if (!captureMapClick) return;
    // (captureMapClick = pinAddMode || カメラファーストの地図タップ待ち。
    //  カメラファースト導入で pinAddMode 単独ゲートから統合フラグへ変更)
    const clickEffect = MAP_SRC.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(!captureMapClick\)\s*return;[\s\S]*?addListener\(\s*"click"[\s\S]*?\}\,\s*\[map,\s*captureMapClick,\s*onMapClick\]/,
    );
    expect(clickEffect).not.toBeNull();
    // 親からは pinAddMode とカメラファースト待ちの OR で渡す
    expect(MAP_SRC).toMatch(
      /captureMapClick=\{pinAddMode\s*\|\|\s*cameraFirstPhase\s*===\s*"awaiting-map-tap"\}/,
    );
  });

  it("map click 座標を console / error UI に出さない", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*latLng/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*click/i);
  });

  it("作成成功でも pin 追加モードを維持 (連続ピンモード) + refetchNonce bump", () => {
    // 旧仕様「保存のたびに自動 OFF (誤タップ防止)」は、連続してピンを立てる
    // 巡回で毎回モードを入れ直す 2 タップの摩擦になっていたため撤回。
    // 誤タップは作成 modal のキャンセルで防げる (保存なしでは何も起きない)。
    // ※巡回の終了/切替での解除 (handleActiveSessionChange 内) は別途あるため、
    //   不在チェックは finalizePinCreate ブロックにスコープ限定する。
    const finalize = MAP_SRC.match(
      /const finalizePinCreate\s*=\s*useCallback\([\s\S]*?\}\,\s*\[[\s\S]*?\],?\s*\);/,
    );
    expect(finalize).not.toBeNull();
    expect(finalize?.[0] ?? "").not.toMatch(/setPinAddMode\(false\)/);
    expect(MAP_SRC).toMatch(/bumpRefetch\(\)/);
  });

  it("layer / refetchNonce で marker 再 fetch を発火する", () => {
    // useEffect deps に refetchNonce を含める
    expect(MAP_SRC).toMatch(/\[layers\.properties,\s*layers\.pins,\s*refetchNonce\]/);
  });

  it("getCurrentPosition は単発のみ。watchPosition / wakeLock は使わない", () => {
    expect(MAP_SRC).toMatch(/navigator\.geolocation\.getCurrentPosition/);
    expect(MAP_SRC).not.toMatch(/navigator\.geolocation\.watchPosition/);
    expect(MAP_SRC).not.toMatch(/wakeLock/);
  });

  it("RouteRecorder hook を pin 作成に流用しない (専用 state)", () => {
    // recorder.start / stop を pin 作成経路で呼ばないことを構造的に確認:
    // useCurrentLocationForCreate / handlePinCreateSubmit 内に recorder. が出ない
    const useCurrentBlock = MAP_SRC.match(
      /useCurrentLocationForCreate[\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(useCurrentBlock).not.toBeNull();
    expect(useCurrentBlock?.[0]).not.toMatch(/recorder\./);
    // handlePinCreateSubmit の useCallback 本体内で recorder.* を呼ばない
    // (deps list は revision で変化しうるので body のみ捕捉)。
    const submitBlock = MAP_SRC.match(
      /handlePinCreateSubmit\s*=\s*useCallback\(\s*async[\s\S]*?\}\,\s*\[/,
    );
    expect(submitBlock).not.toBeNull();
    expect(submitBlock?.[0]).not.toMatch(/recorder\./);
  });

  it("InfoWindow の PinInfo に「詳細を見る」リンク + onOpenPinDetail", () => {
    expect(MAP_SRC).toMatch(/data-testid="pin-info-open-detail"/);
    expect(MAP_SRC).toMatch(/詳細を見る/);
    expect(MAP_SRC).toMatch(/onOpenPinDetail\(id\)/);
  });

  it("pinType / status を生 enum でなくラベル化して表示", () => {
    // PinInfo で formatPinType / formatPinStatus を使う
    expect(MAP_SRC).toMatch(/formatPinType\(row\.pinType\)/);
    expect(MAP_SRC).toMatch(/formatPinStatus\(row\.status\)/);
  });

  it("Phase 1-G で localStorage / sessionStorage / IndexedDB / wakeLock を新規に使わない", () => {
    expect(MAP_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(MAP_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(MAP_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
    expect(MAP_SRC).not.toMatch(/wakeLock/);
  });
});

// =======================================================================
// Codex P2 fix 1: granted===true を要求
// =======================================================================
describe("Codex P2 fix 1 — honor granted entries (provider permissions)", () => {
  it("permissions の判定で p.granted === true を必須にしている", () => {
    // resource + action だけでなく granted の検査を含むこと
    expect(MAP_SRC).toMatch(
      /resource\s*===\s*"field_survey"[\s\S]{0,80}action\s*===\s*"write"[\s\S]{0,80}granted\s*===\s*true/,
    );
  });

  it("旧パターン (granted を見ない some(...)) が残っていないこと", () => {
    // resource/action のみで判定する古い形が無いこと
    expect(MAP_SRC).not.toMatch(
      /\.some\(\s*\(p\)\s*=>\s*p\?\.resource\s*===\s*"field_survey"\s*&&\s*p\?\.action\s*===\s*"write"\s*\)/,
    );
  });

  it("provider 未取得/取得失敗（permissions=null）・取得中・進入時 refresh 中は canWritePin を判定不能 null に倒す（API 403 委譲・disable 文言を誤表示しない）", () => {
    // tristate: null=判定不能(委譲) / true|false=確定。配列 typeguard は provider
    // 側（permissions: PermissionEntry[] | null）が担保するため、消費側は null と
    // loading/error を見て従来の「fetch 未完了/失敗時は null 据え置き」を再現する。
    expect(MAP_SRC).toMatch(/mePermissions === null/);
    expect(MAP_SRC).toMatch(/permissionsLoading/);
    expect(MAP_SRC).toMatch(/permissionsError/);
    expect(MAP_SRC).toMatch(/canWritePin:\s*null/);
    // loaded array なら .some(...granted===true) が空/未付与で false（安全側）を返す。
    // 旧 fetch-parse 経路（setter / 配列 typeguard）は撤去済み。
    expect(MAP_SRC).not.toMatch(/setCanWritePin\(false\)/);
    expect(MAP_SRC).not.toMatch(/Array\.isArray\(body\?\.permissions\)/);
  });

  it("permissions response 全文 / granted 値を console に出さない", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*permissions/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*granted/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });
});

// =======================================================================
// F12 展開(19-A): permissions を ScreenProtectionProvider 経由へ移行する。
//   - ページ独自 /api/me/permissions fetch を撤去し provider 配布値を消費する
//   - 進入時 refresh + pending lazy init + effectivePermissions(tristate)
//   - 取得中 / 取得失敗 / 進入時 refresh 中 / 未取得は判定不能 null(API 403 委譲)
//     に倒す（[] や false へ collapse すると「権限がありません」を誤表示するため）
// 参照実装は properties 一覧（permissions-provider-distribution.test.ts がロック）。
// =======================================================================
describe("F12 展開(19-A) — field-survey-map は provider 経由で権限を取得", () => {
  it("useScreenProtection() から permissions/permissionsLoading/permissionsError/refetchPermissions を取得する", () => {
    expect(MAP_SRC).toMatch(/useScreenProtection/);
    expect(MAP_SRC).toMatch(/permissions:\s*mePermissions/);
    expect(MAP_SRC).toMatch(/permissionsLoading/);
    expect(MAP_SRC).toMatch(/permissionsError/);
    expect(MAP_SRC).toMatch(/refetchPermissions/);
  });

  it("ページ独自の /api/me/permissions 直接 fetch を持たない（provider 経由のみ・旧 fetch 痕跡なし）", () => {
    expect(MAP_SRC).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(MAP_SRC).not.toMatch(/setCanWritePin/);
    expect(MAP_SRC).not.toMatch(/setCanManagePin/);
    expect(MAP_SRC).not.toMatch(/Array\.isArray\(body\?\.permissions\)/);
  });

  it("進入時 refresh: 進入(mount)あたり最大1回 refetchPermissions を呼び finally で pending を解除する", () => {
    expect(MAP_SRC).toMatch(/permissionsRefreshRequestedRef\.current/);
    expect(MAP_SRC).toMatch(
      /refetchPermissions\(\)\.finally\(\(\) => \{\s*setPermissionsRefreshPending\(false\);\s*\}\)/,
    );
  });

  it("進入時 refresh: provider 取得進行中は呼ばない（初回 fetch と重複させない）", () => {
    expect(MAP_SRC).toMatch(/if \(permissionsLoading\) return;/);
  });

  it("進入時 refresh: mount 時進行中だった取得が成功した場合は追加 fetch しない", () => {
    expect(MAP_SRC).toMatch(
      /permissionsLoadingAtMountRef\.current === true && mePermissions !== null/,
    );
  });

  it("pending lazy init: mount 時に取得完了済み（stale 可能性）なら最初の描画から pending=true で開始", () => {
    expect(MAP_SRC).toMatch(
      /useState\(\s*\n?\s*\(\) => !permissionsLoading,?\s*\n?\s*\)/,
    );
  });

  it("effectivePermissions(tristate): 取得中/取得失敗/進入時 refresh 中/未取得は判定不能 null に倒す（[] でも false でもない・stale 権限表示防止）", () => {
    expect(MAP_SRC).toMatch(
      /permissionsRefreshPending \|\|\s*\n?\s*permissionsLoading \|\|\s*\n?\s*permissionsError \|\|\s*\n?\s*mePermissions === null/,
    );
    // 導出値は増えるが、権限系の tristate null への倒し込みは維持されている
    // (canSeeOtherPins は凡例ヒント用の boolean なので false 固定)。
    expect(MAP_SRC).toMatch(
      /return \{\s*canWritePin: null,\s*canManagePin: null,\s*canWriteProperty: null,\s*canSeeOtherPins: false,\s*canQuickCapture: null,\s*\}/,
    );
  });

  it("導出は useMemo の純関数で context 値の派生（setter / state 持ち越しなし）", () => {
    // 導出キーは増えるため、必須キーの並びだけを緩く固定する
    // (複数行の分割代入・後続キー追加に耐える)。
    expect(MAP_SRC).toMatch(
      /const \{[\s\S]*?canWritePin,\s*canManagePin,\s*canWriteProperty,\s*canSeeOtherPins[\s\S]*?\} =\s*\n?\s*useMemo/,
    );
    expect(MAP_SRC).toMatch(
      /\[permissionsRefreshPending,\s*permissionsLoading,\s*permissionsError,\s*mePermissions\]/,
    );
  });

  it("provider 経由でも console に permissions / granted / response 全文を出さない（継続）", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*permissions/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*granted/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });
});

// =======================================================================
// Codex P2 fix 2: pinId 切替時に stale detail / editing を reset
// =======================================================================
describe("Codex P2 fix 2 — reset stale pin detail when switching pins", () => {
  it("pinId effect で detail / editing / draft を同期 reset する", () => {
    // useEffect の dep に pinId、本体で setDetail(null) + setEditing(false) +
    // setDraftMemo("") + loadDetail() の順を含む
    const resetBlock = DETAIL_SRC.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setDetail\(null\)[\s\S]*?setEditing\(false\)[\s\S]*?setDraftMemo\(""\)[\s\S]*?loadDetail\(\)[\s\S]*?\}\,\s*\[pinId\]/,
    );
    expect(resetBlock).not.toBeNull();
  });

  it("isFresh = detail && detail.id === pinId を gate に使う", () => {
    expect(DETAIL_SRC).toMatch(
      /const\s+isFresh\s*=\s*!!detail\s*&&\s*detail\.id\s*===\s*pinId/,
    );
  });

  it("isOwn は isFresh かつ staffUserId === currentUserId のみ true", () => {
    expect(DETAIL_SRC).toMatch(
      /const\s+isOwn\s*=\s*isFresh\s*&&\s*detail!\.staffUserId\s*===\s*currentUserId/,
    );
  });

  it("ReadOnlyView / EditView は isFresh で gate される", () => {
    expect(DETAIL_SRC).toMatch(/\{isFresh\s*&&\s*!editing\s*&&\s*\(?\s*<ReadOnlyView/);
    expect(DETAIL_SRC).toMatch(
      /\{isFresh\s*&&\s*editing\s*&&\s*canEditOwn\s*&&\s*\(?\s*<EditView/,
    );
  });

  it("loadDetail 完了時に pinId 不一致なら state を汚さない", () => {
    // r.data.id !== pinId なら return
    expect(DETAIL_SRC).toMatch(/r\.data\.id\s*!==\s*pinId/);
  });

  it("handleSave は PATCH 直前に saveTargetPinId / own を再確認する", () => {
    const fn = DETAIL_SRC.match(/const handleSave\s*=[\s\S]*?\}\;/);
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    // saveTargetPinId を snapshot (= 開始時点の props.pinId) し、detail と再照合
    expect(m).toMatch(/const\s+saveTargetPinId\s*=\s*pinId/);
    expect(m).toMatch(/detail\.id\s*!==\s*saveTargetPinId/);
    expect(m).toMatch(/detail\.staffUserId\s*!==\s*currentUserId/);
    // PATCH 引数も saveTargetPinId を使う (stale closure ガード)
    expect(m).toMatch(/mutations\.updatePin\(saveTargetPinId,\s*patch\)/);
  });

  it("manage 権限でも他人 pin 編集 UI を出さない方針を維持 (EditView は isOwn gate)", () => {
    // Phase 1-I: canManage は削除ボタン用に追加されたが、EditView は依然 isOwn gate。
    // 編集 UI に manage を絡めない (EditView の render 条件に canManage を含めない)。
    expect(DETAIL_SRC).toMatch(/\{isFresh\s*&&\s*editing\s*&&\s*canEditOwn\s*&&\s*\(?\s*<EditView/);
    expect(DETAIL_SRC).not.toMatch(/hasManage/);
    expect(DETAIL_SRC).not.toMatch(/editing\s*&&\s*\(isOwn\s*\|\|\s*canManage\)/);
  });

  it("dangerouslySetInnerHTML 不使用を継続", () => {
    expect(DETAIL_SRC).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("memo / lat / lng / response を console に出さない (継続)", () => {
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*memo/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });
});

// =======================================================================
// Codex P2: recheck latest pin before applying save results
// =======================================================================
describe("Codex P2 — recheck latest pin before applying save results", () => {
  it("latestPinIdRef を持ち、毎 render で pinId を同期する", () => {
    expect(DETAIL_SRC).toMatch(
      /const\s+latestPinIdRef\s*=\s*useRef\(pinId\)/,
    );
    expect(DETAIL_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*latestPinIdRef\.current\s*=\s*pinId;[\s\S]*?\}\,\s*\[pinId\]/,
    );
  });

  it("handleSave 開始時に saveTargetPinId を snapshot する", () => {
    const fn = DETAIL_SRC.match(/const handleSave\s*=[\s\S]*?\}\;/);
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/const\s+saveTargetPinId\s*=\s*pinId/);
  });

  it("PATCH レスポンス適用前に latestPinIdRef との 3 段ガードを行う", () => {
    const fn = DETAIL_SRC.match(/const handleSave\s*=[\s\S]*?\}\;/);
    const m = fn?.[0] ?? "";
    // 1) ref が捕捉 target のまま
    expect(m).toMatch(
      /latestPinIdRef\.current\s*!==\s*saveTargetPinId/,
    );
    // 2) サーバ応答 id が ref と一致
    expect(m).toMatch(
      /r\.data\.id\s*!==\s*latestPinIdRef\.current/,
    );
    // 3) サーバ応答 id が捕捉 target と一致
    expect(m).toMatch(/r\.data\.id\s*!==\s*saveTargetPinId/);
  });

  it("stale 判定時は setDetail / setEditing(false) / onUpdated を呼ばずに return する", () => {
    const fn = DETAIL_SRC.match(/const handleSave\s*=[\s\S]*?\}\;/);
    const m = fn?.[0] ?? "";
    // 3 段ガードの直後に setDetail / setEditing / onUpdated がある構造
    expect(m).toMatch(
      /latestPinIdRef\.current\s*!==\s*saveTargetPinId[\s\S]*?return[\s\S]*?setDetail\(r\.data\)/,
    );
    expect(m).toMatch(
      /r\.data\.id\s*!==\s*latestPinIdRef\.current[\s\S]*?return[\s\S]*?setDetail\(r\.data\)/,
    );
    // setDetail / setEditing(false) / onUpdated が並んで呼ばれる
    expect(m).toMatch(/setDetail\(r\.data\)[\s\S]*?setEditing\(false\)[\s\S]*?onUpdated/);
  });

  it("古い `r.data.id === pinId` 単独パターン (stale closure) が残っていない", () => {
    // props.pinId を直接 PATCH レスポンス判定に使う形は撤去済
    const fn = DETAIL_SRC.match(/const handleSave\s*=[\s\S]*?\}\;/);
    const m = fn?.[0] ?? "";
    // saveTargetPinId / latestPinIdRef のいずれも経由しない裸の `pinId` 直比較が無い
    // (PATCH 完了後の比較で `=== pinId` または `!== pinId` が裸で残らない)
    const afterUpdate = m.match(/mutations\.updatePin[\s\S]*$/);
    expect(afterUpdate).not.toBeNull();
    expect(afterUpdate?.[0]).not.toMatch(/r\.data\.id\s*!==\s*pinId\b/);
    expect(afterUpdate?.[0]).not.toMatch(/r\.data\.id\s*===\s*pinId\b/);
  });

  it("他人 pin 編集 UI を出さない方針を維持 (manage 持ちでも編集は非表示)", () => {
    // Phase 1-I/1-J: canManage は削除専用。編集 (EditView) は canEditOwn gate。
    expect(DETAIL_SRC).not.toMatch(/hasManage/);
    expect(DETAIL_SRC).toMatch(
      /isOwn\s*=\s*isFresh\s*&&\s*detail!\.staffUserId\s*===\s*currentUserId/,
    );
    expect(DETAIL_SRC).toMatch(/\{isFresh\s*&&\s*editing\s*&&\s*canEditOwn\s*&&\s*\(?\s*<EditView/);
  });

  it("pinId 切替時の reset (detail / editing / draft) は維持されている", () => {
    const resetBlock = DETAIL_SRC.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setDetail\(null\)[\s\S]*?setEditing\(false\)[\s\S]*?setDraftMemo\(""\)[\s\S]*?loadDetail\(\)[\s\S]*?\}\,\s*\[pinId\]/,
    );
    expect(resetBlock).not.toBeNull();
  });

  it("memo / lat / lng / API response 全文 / env / API key を console に出さない (継続)", () => {
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*memo/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*response/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/i);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("dangerouslySetInnerHTML 不使用 (継続)", () => {
    expect(DETAIL_SRC).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

// =======================================================================
// Codex P2: guard late geolocation callbacks after cancel / session change
// =======================================================================
describe("Codex P2 — ignore stale geolocation callbacks", () => {
  it("currentLocationRequestIdRef / activeSessionIdRef / fsMapMountedRef を持つ", () => {
    expect(MAP_SRC).toMatch(/currentLocationRequestIdRef/);
    expect(MAP_SRC).toMatch(/activeSessionIdRef/);
    expect(MAP_SRC).toMatch(/fsMapMountedRef/);
  });

  it("invalidateCurrentLocationRequest が token を bump する helper として存在", () => {
    expect(MAP_SRC).toMatch(/const\s+invalidateCurrentLocationRequest\s*=\s*useCallback/);
    expect(MAP_SRC).toMatch(
      /invalidateCurrentLocationRequest[\s\S]*?currentLocationRequestIdRef\.current\s*\+=\s*1/,
    );
  });

  it("useCurrentLocationForCreate 実行時に新 token を発行し、requestSessionId を捕捉", () => {
    const fn = MAP_SRC.match(
      /const useCurrentLocationForCreate\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/currentLocationRequestIdRef\.current\s*\+=\s*1/);
    expect(m).toMatch(/const requestId\s*=\s*currentLocationRequestIdRef\.current/);
    expect(m).toMatch(
      /const requestSessionId\s*=\s*activeSessionIdRef\.current/,
    );
  });

  it("success / error callback の冒頭で 3 段ガード (mounted / requestId / sessionId) を確認", () => {
    const fn = MAP_SRC.match(
      /const useCurrentLocationForCreate\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    const m = fn?.[0] ?? "";
    // success callback
    const successBlock = m.match(/\(pos\)\s*=>\s*\{[\s\S]*?\}\,\s*\(err\)/);
    expect(successBlock).not.toBeNull();
    const sb = successBlock?.[0] ?? "";
    expect(sb).toMatch(/if\s*\(!fsMapMountedRef\.current\)\s*return/);
    expect(sb).toMatch(
      /if\s*\(currentLocationRequestIdRef\.current\s*!==\s*requestId\)\s*return/,
    );
    // 巡回なし撮影 (quick_capture) の再取得を捨てないため、session ガードは
    // 「巡回中に始めた取得」に限定する (requestSessionId !== null)。
    expect(sb).toMatch(
      /requestSessionId !== null &&\s*\n?\s*activeSessionIdRef\.current !== requestSessionId/,
    );
    // error callback
    const errBlock = m.match(/\(err\)\s*=>\s*\{[\s\S]*?\}\,\s*\{[\s\S]*?enableHighAccuracy/);
    expect(errBlock).not.toBeNull();
    const eb = errBlock?.[0] ?? "";
    expect(eb).toMatch(/if\s*\(!fsMapMountedRef\.current\)\s*return/);
    expect(eb).toMatch(
      /if\s*\(currentLocationRequestIdRef\.current\s*!==\s*requestId\)\s*return/,
    );
    expect(eb).toMatch(
      /requestSessionId !== null &&\s*\n?\s*activeSessionIdRef\.current !== requestSessionId/,
    );
  });

  it("modal cancel で invalidateCurrentLocationRequest を呼ぶ", () => {
    expect(MAP_SRC).toMatch(
      /onCancel=\{\s*\(\)\s*=>\s*\{[\s\S]*?invalidateCurrentLocationRequest\(\)/,
    );
  });

  it("active session 変更で useEffect が invalidateCurrentLocationRequest を呼ぶ", () => {
    expect(MAP_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?invalidateCurrentLocationRequest\(\)[\s\S]*?\}\,\s*\[activeSession,\s*invalidateCurrentLocationRequest\]/,
    );
  });

  it("unmount 時に fsMapMountedRef=false + token を bump する", () => {
    expect(MAP_SRC).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?fsMapMountedRef\.current\s*=\s*false[\s\S]*?currentLocationRequestIdRef\.current\s*\+=\s*1/,
    );
  });

  it("activeSessionIdRef は activeSession 変化時に同期される (stale closure 回避)", () => {
    expect(MAP_SRC).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?activeSessionIdRef\.current\s*=\s*activeSession\?\.id\s*\?\?\s*null[\s\S]*?\}\,\s*\[activeSession\]/,
    );
  });

  it("単発取得のままで watchPosition を使わない / RouteRecorder hook を流用しない (継続)", () => {
    expect(MAP_SRC).toMatch(/navigator\.geolocation\.getCurrentPosition/);
    expect(MAP_SRC).not.toMatch(/navigator\.geolocation\.watchPosition/);
    // useCurrentLocationForCreate 経路で recorder を呼ばない
    const fn = MAP_SRC.match(
      /const useCurrentLocationForCreate\s*=\s*useCallback\([\s\S]*?\}\,\s*\[\]\s*\);/,
    );
    expect(fn?.[0]).not.toMatch(/recorder\./);
  });

  it("active session 無しで「現在地を使う」を押した場合は早期 return (汎用文言)", () => {
    expect(MAP_SRC).toMatch(/巡回を開始してから現在地を取得してください/);
  });

  it("pin 作成成功時にも pending callback を invalidate する", () => {
    expect(MAP_SRC).toMatch(
      /handlePinCreateSubmit[\s\S]*?r\.ok[\s\S]*?invalidateCurrentLocationRequest\(\)[\s\S]*?setCreateCandidate\(null\)/,
    );
  });

  it("token / session id / position を console に出さない (継続ガード)", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*requestId/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*requestSessionId/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*position/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\(JSON\.stringify\(/);
  });

  it("localStorage / sessionStorage / IndexedDB を使わない (継続)", () => {
    expect(MAP_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(MAP_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem|removeItem)/);
    expect(MAP_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });
});

// =======================================================================
// util: archived label の継続ガード
// =======================================================================
describe("field-survey-pin-util.ts — archived を「削除」と表記しない (継続)", () => {
  it("util ファイル全体で archived ラベルに「削除」を含めない", () => {
    expect(UTIL_SRC).not.toMatch(/archived[\s\S]{0,40}削除/);
    expect(UTIL_SRC).not.toMatch(/削除[\s\S]{0,40}archived/);
  });
});

// =======================================================================
// Phase 1-H: 調査ピン写真追加 (create modal / detail panel / map 統合)
// =======================================================================
const PHOTO_HOOK_SRC = readSrc(
  "src/components/field-survey/use-field-survey-pin-photo-mutations.ts",
);

describe("Phase 1-H — pin-create-modal 写真 UI", () => {
  it("「写真を撮る」「写真を追加」ボタンがあり「撮影開始」は使わない", () => {
    expect(CREATE_SRC).toMatch(/写真を撮る/);
    expect(CREATE_SRC).toMatch(/写真を追加/);
    expect(CREATE_SRC).not.toMatch(/撮影開始/);
  });

  it("capture=environment と accept=image/* を使う", () => {
    expect(CREATE_SRC).toMatch(/capture="environment"/);
    expect(CREATE_SRC).toMatch(/accept="image\/\*"/);
  });

  it("選択後のサムネイル表示がある", () => {
    expect(CREATE_SRC).toMatch(/data-testid="pin-create-photo-thumb"/);
  });

  it("objectURL を createObjectURL し revokeObjectURL する導線がある", () => {
    expect(CREATE_SRC).toMatch(/URL\.createObjectURL/);
    expect(CREATE_SRC).toMatch(/URL\.revokeObjectURL/);
  });

  it("保存ボタンは 1 つ (pin-create-submit) のまま一体 UX", () => {
    expect(CREATE_SRC).toMatch(/data-testid="pin-create-submit"/);
    // onSubmit に file を渡す (pin create → photo upload 一体)
    expect(CREATE_SRC).toMatch(/onSubmit\(\s*\{[\s\S]*?\},\s*photoFile/);
  });

  it("写真アップロード失敗時の 4 文言 / ボタンを出す", () => {
    expect(CREATE_SRC).toMatch(/ピンは保存されました/);
    expect(CREATE_SRC).toMatch(/写真の保存に失敗しました/);
    expect(CREATE_SRC).toMatch(/写真だけ再試行/);
    expect(CREATE_SRC).toMatch(/写真なしで完了/);
  });

  it("storageKey を UI に出さない / base64 を持たない / console に画像情報を出さない", () => {
    expect(CREATE_SRC).not.toMatch(/storageKey/);
    expect(CREATE_SRC).not.toMatch(/toDataURL|base64/);
    expect(CREATE_SRC).not.toMatch(/console\.\w+\(/);
  });
});

describe("Phase 1-H — pin-detail-panel 写真 UI", () => {
  it("写真一覧 / サムネイル / プレビューがある", () => {
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-photos"/);
    expect(DETAIL_SRC).toMatch(/data-testid="pin-photo-thumb"/);
    expect(DETAIL_SRC).toMatch(/data-testid="pin-photo-preview"/);
  });

  it("own + archived 以外でのみ追加/削除 UI を出す (canEdit)", () => {
    expect(DETAIL_SRC).toMatch(
      /canEdit=\{canEditOwn\s*&&\s*detail!\.status\s*!==\s*"archived"\}/,
    );
    expect(DETAIL_SRC).toMatch(/\{canEdit\s*&&\s*\(/);
  });

  it("「写真を撮る」「写真を追加」「写真を削除」がある", () => {
    expect(DETAIL_SRC).toMatch(/写真を撮る/);
    expect(DETAIL_SRC).toMatch(/写真を追加/);
    expect(DETAIL_SRC).toMatch(/写真を削除/);
    expect(DETAIL_SRC).not.toMatch(/撮影開始/);
  });

  it("HEIC 等で表示できない場合の代替表示がある (onError fallback)", () => {
    expect(DETAIL_SRC).toMatch(/onError=/);
    expect(DETAIL_SRC).toMatch(/プレビューを表示できません/);
  });

  it("storageKey を UI に出さない / console に画像情報を出さない / dangerouslySetInnerHTML 不使用", () => {
    expect(DETAIL_SRC).not.toMatch(/storageKey/);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\(/);
    expect(DETAIL_SRC).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe("Phase 1-H — field-survey-map create 後の挙動", () => {
  it("pin 作成成功後に detail panel を開く (setDetailPinId)", () => {
    expect(MAP_SRC).toMatch(/setDetailPinId\(/);
    // finalizePinCreate 内で detail を開く
    expect(MAP_SRC).toMatch(/finalizePinCreate/);
  });

  it("写真 upload は二段階 (pin create → uploadPhoto) で marker refetch を維持", () => {
    expect(MAP_SRC).toMatch(/useFieldSurveyPinPhotoMutations/);
    expect(MAP_SRC).toMatch(/photoMutations\.uploadPhoto/);
    expect(MAP_SRC).toMatch(/bumpRefetch\(\)/);
  });

  it("写真失敗時に再試行 / 写真なし完了の handler を渡す", () => {
    expect(MAP_SRC).toMatch(/onRetryPhoto=/);
    expect(MAP_SRC).toMatch(/onFinishWithoutPhoto=/);
    expect(MAP_SRC).toMatch(/setPhotoUploadFailed\(true\)/);
  });
});

describe("Phase 1-H — use-field-survey-pin-photo-mutations", () => {
  it("'use client' で始まる", () => {
    expect(PHOTO_HOOK_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("photos API path を使う (GET/POST list+upload, DELETE)", () => {
    expect(PHOTO_HOOK_SRC).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(pinId\)\}\/photos/,
    );
    expect(PHOTO_HOOK_SRC).toMatch(/method:\s*"POST"/);
    expect(PHOTO_HOOK_SRC).toMatch(/method:\s*"DELETE"/);
    expect(PHOTO_HOOK_SRC).toMatch(/FormData/);
  });

  it("unmount で中断するのは list(GET) だけ (総点検 2026-07-27)", () => {
    // ⚠upload(POST)/delete(DELETE) も abort していた頃は、詳細パネルの × か
    // 編集ボタンを押すだけで写真セクションが unmount し、**送信中の写真が
    // 黙って消えていた**。現地で撮った写真は端末にしか無いことがあり
    // 取り返しがつかない。unmount 後の setState 抑止は mountedRef が担うので
    // abort は不要だった。
    expect(PHOTO_HOOK_SRC).toMatch(/listAbortRef/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/uploadAbortRef/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/deleteAbortRef/);
    // cleanup は mountedRef を倒し、list だけ abort する
    expect(PHOTO_HOOK_SRC).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?mountedRef\.current\s*=\s*false[\s\S]*?listAbortRef\.current\.abort\(\)/,
    );
    // abort 呼び出しは 1 箇所 (list の stale guard 兼 cleanup) のみ
    expect(PHOTO_HOOK_SRC.match(/\.abort\(\)/g)?.length).toBe(2);
  });

  it("POST / DELETE に signal を渡さない (中断できない = 送信を守る)", () => {
    const upload = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const uploadPhoto"),
      PHOTO_HOOK_SRC.indexOf("const deletePhoto"),
    );
    const del = PHOTO_HOOK_SRC.slice(PHOTO_HOOK_SRC.indexOf("const deletePhoto"));
    expect(upload).not.toMatch(/signal:/);
    expect(del).not.toMatch(/signal:/);
    // list(GET) は従来どおり signal を渡す (読み取りなので中断して良い)
    const list = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const listPhotos"),
      PHOTO_HOOK_SRC.indexOf("const uploadPhoto"),
    );
    expect(list).toMatch(/signal:\s*ac\.signal/);
  });

  it("端末内変換の途中でも捨てない (mountedRef は setState 抑止だけに使う)", () => {
    // ⚠signal を外しただけでは「fetch まで到達した upload」しか守れない
    // (@codex #331 R1)。旧実装は HEIC→JPEG / 8MB 超の縮小の**直後**に
    // `if (!mountedRef.current) return` を置いていたため、変換中に × や編集を
    // 押すと POST に到達する前に写真が捨てられていた。変換は数秒かかり得る。
    const upload = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const uploadPhoto"),
      PHOTO_HOOK_SRC.indexOf("const deletePhoto"),
    );
    const del = PHOTO_HOOK_SRC.slice(PHOTO_HOOK_SRC.indexOf("const deletePhoto"));
    // 途中で打ち切る early return が無いこと
    expect(upload).not.toMatch(/if \(!mountedRef\.current\)\s*return/);
    expect(del).not.toMatch(/if \(!mountedRef\.current\)\s*return/);
    // mountedRef は setState を包むヘルパの中だけで使う
    expect(upload).toMatch(/setUploadStateIfMounted/);
    expect(del).toMatch(/setDeleteStateIfMounted/);
    // 変換 → POST の順序が保たれている (変換結果を必ず送る)
    expect(upload.indexOf("prepareFieldSurveyPhotoForUpload")).toBeLessThan(
      upload.indexOf('method: "POST"'),
    );
  });

  it("list(GET) だけは従来どおり途中で打ち切れる (読み取りなので安全)", () => {
    const list = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const listPhotos"),
      PHOTO_HOOK_SRC.indexOf("const uploadPhoto"),
    );
    expect(list).toMatch(/if \(!mountedRef\.current\)\s*return/);
    expect(list).toMatch(/signal:\s*ac\.signal/);
  });

  it("unmount を跨いだ upload の完了を再マウント側へ伝える (@codex #331 R1)", () => {
    // ⚠abort をやめただけでは足りない。閉じてすぐ開き直すと、新しい一覧の初回 GET が
    // upload の commit より先に終わり、保存された写真が次の再読込まで見えない。
    // 利用者は消えたと思って同じ写真をもう一度送る (= 重複)。
    // 進行中件数と完了通知を hook インスタンスの外 (module スコープ) に置く。
    expect(PHOTO_HOOK_SRC).toMatch(/const inFlightUploads = new Map/);
    expect(PHOTO_HOOK_SRC).toMatch(/export function hasInFlightPhotoUpload/);
    expect(PHOTO_HOOK_SRC).toMatch(/export function subscribePhotoMutationSettled/);
    // 成功・失敗・early return のいずれでも通知する = finally
    const upload = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const uploadPhoto"),
      PHOTO_HOOK_SRC.indexOf("const deletePhoto"),
    );
    expect(upload).toMatch(/markUploadStarted\(pinId\)/);
    // 通知には**結果**を載せる (成否が無いと、失敗しても「送信中」表示が消えて
    // 一覧を読み直すだけになり、利用者は失敗に気づけない)。
    expect(upload).toMatch(/finally \{[\s\S]*?markUploadSettled\(pinId, outcome\)/);
    expect(upload).toMatch(/outcome = \{ kind: "upload", ok: true \}/);
    expect(upload).toMatch(/outcome = \{ kind: "upload", ok: false, error: msg \}/);
  });

  it("保持するのは pinId と件数だけ (PII を持たない)", () => {
    const registry = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("const inFlightUploads"),
      PHOTO_HOOK_SRC.indexOf("export function useFieldSurveyPinPhotoMutations"),
    );
    for (const forbidden of ["fileName", "fileUrl", "storageKey", "File", "gps"]) {
      expect(registry).not.toContain(forbidden);
    }
  });

  it("console に画像情報 / response 全文を出さない / Storage を使わない", () => {
    expect(PHOTO_HOOK_SRC).not.toMatch(/console\.\w+\(/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });
});

// =======================================================================
// Phase 1-I: 調査ピン削除 (論理削除 / archived)
// =======================================================================
describe("Phase 1-I — pin-detail-panel 削除UI", () => {
  it("削除ボタン (pin-detail-delete-button) がある", () => {
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-delete-button"/);
  });

  it("own または manage、かつ archived 以外でのみ削除ボタンを出す (canDelete)", () => {
    expect(DETAIL_SRC).toMatch(
      /canDelete\s*=\s*[\s\S]*?\(isOwn\s*\|\|\s*canManage\)\s*&&\s*detail!\.status\s*!==\s*"archived"/,
    );
    expect(DETAIL_SRC).toMatch(/\{canDelete\s*&&/);
  });

  it("read_all だけでは削除ボタンが出ない (canManage prop 経由のみ)", () => {
    // 他人 pin 削除可否は親が算出した canManage prop のみで判断する。
    // パネル内で permission 文字列 ("read_all" 等) を直接判定しない。
    expect(DETAIL_SRC).toMatch(/canDelete\s*=[\s\S]*?canManage/);
    expect(DETAIL_SRC).not.toMatch(/"read_all"/);
  });

  it("削除前に確認ダイアログを出す (確認文言 + 確認ボタン)", () => {
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-delete-confirm"/);
    expect(DETAIL_SRC).toMatch(/data-testid="pin-detail-delete-confirm-button"/);
    expect(DETAIL_SRC).toMatch(/この調査ピンを削除しますか/);
    expect(DETAIL_SRC).toMatch(/地図上の通常表示から非表示になります/);
    expect(DETAIL_SRC).toMatch(/削除する/);
    expect(DETAIL_SRC).toMatch(/キャンセル/);
  });

  it("削除は deletePin を呼び、成功後に onDeleted を呼ぶ (panel を閉じる導線)", () => {
    expect(DETAIL_SRC).toMatch(/mutations\.deletePin\(/);
    expect(DETAIL_SRC).toMatch(/onDeleted\?\.\(/);
  });

  it("権限エラー時は「このピンを削除する権限がありません」を出す", () => {
    expect(DETAIL_SRC).toMatch(/このピンを削除する権限がありません/);
  });

  it("dangerouslySetInnerHTML 不使用 / console に情報を出さない / Storage を使わない", () => {
    expect(DETAIL_SRC).not.toMatch(/dangerouslySetInnerHTML/);
    expect(DETAIL_SRC).not.toMatch(/console\.\w+\(/);
    expect(DETAIL_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(DETAIL_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(DETAIL_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });
});

describe("Phase 1-I — use-field-survey-pin-mutations deletePin", () => {
  it("deletePin が DELETE /api/field-survey/pins/[id] を呼ぶ", () => {
    expect(HOOK_SRC).toMatch(/const deletePin\s*=\s*useCallback/);
    expect(HOOK_SRC).toMatch(/method:\s*"DELETE"/);
    expect(HOOK_SRC).toMatch(
      /\/api\/field-survey\/pins\/\$\{encodeURIComponent\(pinId\)\}/,
    );
  });

  it("console に情報を出さない (継続)", () => {
    expect(HOOK_SRC).not.toMatch(/console\.\w+\(/);
  });
});

describe("Phase 1-I — field-survey-map 削除連携", () => {
  it("PinDetailPanel に canManage と onDeleted を渡す", () => {
    expect(MAP_SRC).toMatch(/canManage=\{canManagePin\s*===\s*true\}/);
    expect(MAP_SRC).toMatch(/onDeleted=\{/);
  });

  it("onDeleted で detail panel を閉じ marker refetch する", () => {
    expect(MAP_SRC).toMatch(
      /onDeleted=\{[\s\S]*?setDetailPinId\(null\)[\s\S]*?bumpRefetch\(\)/,
    );
  });

  it("canManagePin は field_survey:manage の granted===true で判定する（provider 配布値から導出）", () => {
    expect(MAP_SRC).toMatch(/canManagePin/);
    expect(MAP_SRC).toMatch(
      /action\s*===\s*"manage"[\s\S]{0,80}granted\s*===\s*true/,
    );
  });
});

describe("再マウント後も送信中の写真を取りこぼさない (@codex #331 R1)", () => {
  const PANEL_SRC = readSrc("src/components/field-survey/pin-detail-panel.tsx");

  it("完了通知を購読して自動で読み直す", () => {
    expect(PANEL_SRC).toMatch(/subscribePhotoMutationSettled\(/);
    // 自分の pin 以外の通知では読み直さない
    expect(PANEL_SRC).toMatch(/settledPinId !== pinId/);
    expect(PANEL_SRC).toMatch(/void reload\(\)/);
  });

  it("購読は解除される (unmount でリスナーが残らない)", () => {
    // subscribe の戻り値をそのまま useEffect の cleanup として返す形
    expect(PANEL_SRC).toMatch(/return subscribePhotoMutationSettled\(/);
  });

  it("削除の完了も通知される (削除済み写真が残って 404 にならない)", () => {
    // ⚠通知が無いと、閉じてすぐ開き直したとき初回 GET が DELETE の commit より
    // 先に終わり、削除済みの写真が一覧に残る。もう一度消そうとすると 404。
    const del = PHOTO_HOOK_SRC.slice(PHOTO_HOOK_SRC.indexOf("const deletePhoto"));
    expect(del).toMatch(
      /finally \{[\s\S]*?notifyPhotoMutationSettled\(pinId, outcome\)/,
    );
    expect(del).toMatch(/outcome = \{ kind: "delete", ok: true \}/);
  });

  it("離れている間の失敗を画面に出す (@codex #331 R1)", () => {
    // ⚠通知に成否が無いと、「出ますのでお待ちください」と案内したまま
    // 何も出ず・エラーも出ない状態になる。写真が端末のピッカーにしか無い
    // 場面なので、必ず気づける形にする。
    expect(PANEL_SRC).toMatch(/setDetachedError\(/);
    expect(PANEL_SRC).toMatch(/outcome\.ok \? null : \(outcome\.error \?\? null\)/);
    expect(PANEL_SRC).toContain('data-testid="pin-photo-detached-error"');
    expect(PANEL_SRC).toContain('role="alert"');
    expect(PANEL_SRC).toContain("もう一度お試しください");
  });

  it("案内に載せるのは汎用文言だけ (PII / 生レスポンスを出さない)", () => {
    // outcome.error は pinApiErrorMessage 由来 (status → 固定文言) のみ。
    const registry = PHOTO_HOOK_SRC.slice(
      PHOTO_HOOK_SRC.indexOf("export interface PhotoMutationOutcome"),
      PHOTO_HOOK_SRC.indexOf("export function useFieldSurveyPinPhotoMutations"),
    );
    for (const forbidden of ["fileName", "fileUrl", "storageKey", "res.text", "gps"]) {
      expect(registry).not.toContain(forbidden);
    }
  });

  it("送信中がある間は「もう一度送らずに待って」と案内する", () => {
    expect(PANEL_SRC).toMatch(/hasInFlightPhotoUpload\(pinId\)/);
    expect(PANEL_SRC).toContain('data-testid="pin-photo-detached-uploading"');
    expect(PANEL_SRC).toContain("もう一度送らずにお待ちください");
  });
});
