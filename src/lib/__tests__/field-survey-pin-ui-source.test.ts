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

  it("own pin のみ編集 UI を出す (isOwn ゲート)", () => {
    expect(DETAIL_SRC).toMatch(/isOwn\s*=\s*detail\?\.staffUserId\s*===\s*currentUserId/);
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

  it("archived を「削除」と表記しない", () => {
    expect(DETAIL_SRC).not.toMatch(/削除/);
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
    const submitBlock = MAP_SRC.match(
      /handlePinCreateSubmit[\s\S]*?\}\,\s*\[activeSession,\s*pinMutations,\s*bumpRefetch\]/,
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
// util: archived label の継続ガード
// =======================================================================
describe("field-survey-pin-util.ts — archived を「削除」と表記しない (継続)", () => {
  it("util ファイル全体で archived ラベルに「削除」を含めない", () => {
    expect(UTIL_SRC).not.toMatch(/archived[\s\S]{0,40}削除/);
    expect(UTIL_SRC).not.toMatch(/削除[\s\S]{0,40}archived/);
  });
});
