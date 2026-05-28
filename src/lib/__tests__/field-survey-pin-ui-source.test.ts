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

  it("sessionId が無いと submit を disable する (canSubmit に sessionId 条件)", () => {
    expect(CREATE_SRC).toMatch(/canSubmit\s*=[\s\S]*?!!sessionId/);
  });

  it("sessionId が無い時の説明文を出す", () => {
    expect(CREATE_SRC).toMatch(/巡回 session が無いため保存できません/);
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

  it("own pin のみ編集 UI を出す (isOwn ゲート + isFresh)", () => {
    // Codex P2 fix 2: isOwn は isFresh かつ own staff のみ true。
    expect(DETAIL_SRC).toMatch(
      /isOwn\s*=\s*isFresh\s*&&\s*detail!\.staffUserId\s*===\s*currentUserId/,
    );
    // ReadOnlyView の編集ボタンと EditView render が isOwn 条件付き
    expect(DETAIL_SRC).toMatch(/\{isOwn\s*&&\s*\(/);
    expect(DETAIL_SRC).toMatch(/editing\s*&&\s*isOwn/);
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

  it("createCandidate + activeSession の両方が揃った時のみ create modal を mount", () => {
    expect(MAP_SRC).toMatch(/createCandidate\s*&&\s*activeSession\s*&&\s*\(?\s*<PinCreateModal/);
  });

  it("detailPinId がある時のみ PinDetailPanel を mount", () => {
    expect(MAP_SRC).toMatch(/detailPinId\s*&&\s*\(?\s*<PinDetailPanel/);
  });

  it("/api/me/permissions で field_survey:write を判定する", () => {
    expect(MAP_SRC).toMatch(/\/api\/me\/permissions/);
    expect(MAP_SRC).toMatch(/"field_survey"[\s\S]*?"write"/);
    expect(MAP_SRC).toMatch(/setCanWritePin/);
  });

  it("map.addListener('click', ...) は pinAddMode の時のみ effect が走る", () => {
    expect(MAP_SRC).toMatch(/addListener\(\s*"click"/);
    // useEffect 内で if (!pinAddMode) return;
    const clickEffect = MAP_SRC.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(!pinAddMode\)\s*return;[\s\S]*?addListener\(\s*"click"[\s\S]*?\}\,\s*\[map,\s*pinAddMode,\s*onMapClick\]/,
    );
    expect(clickEffect).not.toBeNull();
  });

  it("map click 座標を console / error UI に出さない", () => {
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*latLng/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*click/i);
  });

  it("作成成功で pin 追加モードを OFF + refetchNonce bump (誤タップ防止)", () => {
    expect(MAP_SRC).toMatch(/setPinAddMode\(false\)/);
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
describe("Codex P2 fix 1 — honor granted entries in /api/me/permissions", () => {
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

  it("permissions が配列で無い / 空 / malformed なら canWritePin=false (安全側)", () => {
    expect(MAP_SRC).toMatch(/setCanWritePin\(false\)/);
    // permissions 配列 typeguard
    expect(MAP_SRC).toMatch(/Array\.isArray\(body\?\.permissions\)/);
  });

  it("permissions response 全文 / granted 値を console に出さない", () => {
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
      /\{isFresh\s*&&\s*editing\s*&&\s*isOwn\s*&&\s*\(?\s*<EditView/,
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

  it("manage 権限でも他人 pin 編集 UI を出さない方針を維持 (isOwn 単独 gate)", () => {
    // EditView は isOwn === true のみ render。manage 等の追加 prop が無いこと
    expect(DETAIL_SRC).not.toMatch(/canManage/);
    expect(DETAIL_SRC).not.toMatch(/hasManage/);
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

  it("他人 pin 編集 UI を出さない方針を維持 (manage 持ちでも非表示)", () => {
    // 既存テストと重複するが本 fix で挙動が変わっていないことを再確認
    expect(DETAIL_SRC).not.toMatch(/canManage/);
    expect(DETAIL_SRC).not.toMatch(/hasManage/);
    expect(DETAIL_SRC).toMatch(
      /isOwn\s*=\s*isFresh\s*&&\s*detail!\.staffUserId\s*===\s*currentUserId/,
    );
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
    expect(sb).toMatch(
      /if\s*\(activeSessionIdRef\.current\s*!==\s*requestSessionId\)\s*return/,
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
      /if\s*\(activeSessionIdRef\.current\s*!==\s*requestSessionId\)\s*return/,
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
    expect(MAP_SRC).toMatch(/巡回 session が無いため現在地を取得できません/);
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
      /canEdit=\{isOwn\s*&&\s*detail!\.status\s*!==\s*"archived"\}/,
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

  it("AbortController を list/upload/delete 別に持ち unmount で abort", () => {
    expect(PHOTO_HOOK_SRC).toMatch(/listAbortRef/);
    expect(PHOTO_HOOK_SRC).toMatch(/uploadAbortRef/);
    expect(PHOTO_HOOK_SRC).toMatch(/deleteAbortRef/);
    expect(PHOTO_HOOK_SRC).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?mountedRef\.current\s*=\s*false[\s\S]*?abort\(\)/,
    );
  });

  it("console に画像情報 / response 全文を出さない / Storage を使わない", () => {
    expect(PHOTO_HOOK_SRC).not.toMatch(/console\.\w+\(/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/localStorage\s*\.\s*(setItem|getItem)/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/sessionStorage\s*\.\s*(setItem|getItem)/);
    expect(PHOTO_HOOK_SRC).not.toMatch(/\bindexedDB\s*\.\s*open/);
  });
});
