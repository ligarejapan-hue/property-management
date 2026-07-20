/**
 * /field-survey/map UI (Phase 1-E) のソース静的検証。
 *
 * vitest が node 環境のため、コンポーネントの実 render は次フェーズ以降に
 * 委ねるが、PII 漏洩 / クラッシュ防止 / 権限境界が壊れていないことを
 * ソース文字列レベルで担保する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PAGE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/field-survey/map/page.tsx"),
  "utf8",
);
const CLIENT_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-map-client.tsx",
  ),
  "utf8",
);
const MAP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-map.tsx",
  ),
  "utf8",
);
const HISTORY_MAP_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/field-survey-history-map.tsx",
  ),
  "utf8",
);
const GESTURE_HOOK_SRC = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/field-survey/use-map-gesture-handling.ts",
  ),
  "utf8",
);
const SIDEBAR_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"),
  "utf8",
);
const ENV_EXAMPLE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), ".env.example"),
  "utf8",
);

describe(".env.example — Google Maps key", () => {
  it("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY のテンプレ行がある", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/^NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=/m);
  });

  it("HTTP referrer 制限の運用注意がコメントに含まれる", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/HTTP referrer/i);
  });

  it("実 API キー値 (AIza...) をコミットしていない", () => {
    expect(ENV_EXAMPLE_SRC).not.toMatch(/AIza[0-9A-Za-z-_]{20,}/);
  });

  it("本番運用前チェックリスト 5 項目が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/Cloud Billing/);
    expect(ENV_EXAMPLE_SRC).toMatch(/quota/i);
    expect(ENV_EXAMPLE_SRC).toMatch(/HTTP referrer/);
    expect(ENV_EXAMPLE_SRC).toMatch(/Maps JavaScript API/);
    expect(ENV_EXAMPLE_SRC).toMatch(/管理者|承認/);
  });

  it("Budget alert は通知のみ・quota で実停止する旨が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/Budget alert.*停止しない|通知のみ/);
    expect(ENV_EXAMPLE_SRC).toMatch(/quota.*上限|quota.*制限/);
  });

  it("NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED の opt-in 行がある", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(
      /^NEXT_PUBLIC_GOOGLE_MAPS_BILLING_ACKNOWLEDGED=/m,
    );
  });

  it("固定料金 (無料枠 / 単価) を env コメントにハードコードしていない", () => {
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\$\s*\d/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/28[,\s]?500/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(ENV_EXAMPLE_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
    // 「公式ページで確認」の方針宣言があること
    expect(ENV_EXAMPLE_SRC).toMatch(/公式.*料金|料金.*公式/);
  });

  it("NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID を optional / 任意 と書いていない", () => {
    // 行頭の env テンプレ自体は残るが、その上の説明 block 内で "(任意)" /
    // "optional" と記載しない (AdvancedMarker のため必須)。
    const mapIdBlock = ENV_EXAMPLE_SRC.match(
      /[\s\S]{0,400}NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=/,
    );
    expect(mapIdBlock).not.toBeNull();
    expect(mapIdBlock?.[0]).not.toMatch(/\(任意\)/);
    expect(mapIdBlock?.[0]).not.toMatch(/optional/i);
  });

  it("MAP_ID が AdvancedMarker に必須である旨が明記されている", () => {
    expect(ENV_EXAMPLE_SRC).toMatch(/AdvancedMarker.*必須|必須.*AdvancedMarker/);
    expect(ENV_EXAMPLE_SRC).toMatch(/壊れた\s*UI|マーカー.*表示されない/);
  });
});

describe("sidebar.tsx — nav entry", () => {
  it("/field-survey/map への nav item が追加されている", () => {
    expect(SIDEBAR_SRC).toMatch(/href:\s*"\/field-survey\/map"/);
  });

  it("ラベル 現地調査マップ がある", () => {
    expect(SIDEBAR_SRC).toMatch(/現地調査マップ/);
  });
});

describe("page.tsx — server-side permission gate (Codex Phase 1-E)", () => {
  it("server component である ('use client' を持たない)", () => {
    // permission gate を server side で行うため client directive を持たない
    expect(PAGE_SRC.trim().startsWith('"use client"')).toBe(false);
  });

  it("async server component (await getApiSession / getUserPermissions) である", () => {
    expect(PAGE_SRC).toMatch(/export default async function/);
    expect(PAGE_SRC).toMatch(/await\s+getApiSession\(\)/);
    expect(PAGE_SRC).toMatch(/await\s+getUserPermissions\(/);
  });

  it("field_survey:read を hasPermission で確認している", () => {
    expect(PAGE_SRC).toMatch(
      /hasPermission\([^)]*,\s*["']field_survey["']\s*,\s*["']read["']/,
    );
  });

  it("権限不足時は FieldSurveyMapClient を render しない", () => {
    expect(PAGE_SRC).toMatch(/PermissionDeniedNotice/);
    // Phase 1-F-1 で currentUserId guard が追加されたため、
    // canRead && currentUserId ? <FieldSurveyMapClient ...> : <PermissionDeniedNotice>
    // のパターンも許容する。
    expect(PAGE_SRC).toMatch(
      /canRead\s*(?:&&\s*currentUserId\s*)?\?\s*\(?\s*<FieldSurveyMapClient[\s\S]*?\/>\s*\)?\s*:\s*\(?\s*<PermissionDeniedNotice/,
    );
  });

  it("FieldSurveyMapClient の render 経路は page.tsx 内で 1 箇所のみ", () => {
    const matches = PAGE_SRC.match(/<FieldSurveyMapClient\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("page.tsx は Maps JS API loader を直接 import しない", () => {
    expect(PAGE_SRC).not.toMatch(/from\s+["']@vis\.gl\/react-google-maps["']/);
    expect(PAGE_SRC).not.toMatch(
      /from\s+["']@\/components\/field-survey\/field-survey-map["']/,
    );
  });

  it("PermissionDeniedNotice に APIキー / mapId / env 値を含まない", () => {
    const denialRegion = PAGE_SRC.match(
      /function PermissionDeniedNotice[\s\S]*?^\}/m,
    );
    expect(denialRegion).not.toBeNull();
    expect(denialRegion?.[0]).not.toMatch(/apiKey/);
    expect(denialRegion?.[0]).not.toMatch(/mapId/);
    expect(denialRegion?.[0]).not.toMatch(/NEXT_PUBLIC_GOOGLE_MAPS/);
  });

  it("permission check の失敗を catch して canRead=false に倒している", () => {
    expect(PAGE_SRC).toMatch(/try\s*\{/);
    expect(PAGE_SRC).toMatch(/catch\b/);
  });

  it("page.tsx に固定料金 (無料枠 / 単価) をハードコードしていない (継続ガード)", () => {
    expect(PAGE_SRC).not.toMatch(/\$\s*\d/);
    expect(PAGE_SRC).not.toMatch(/28[,\s]?500/);
    expect(PAGE_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(PAGE_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
  });
});

describe("field-survey-map-client.tsx — env-based gating", () => {
  it("'use client' で始まる", () => {
    expect(CLIENT_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("APIキー未設定時の案内文を持つ", () => {
    expect(CLIENT_SRC).toMatch(/Google Maps APIキーが未設定/);
  });

  it("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY を直接参照する", () => {
    expect(CLIENT_SRC).toMatch(/process\.env\.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/);
  });

  it("isGoogleMapsKeyConfigured を介してクラッシュ防御している", () => {
    expect(CLIENT_SRC).toMatch(/isGoogleMapsKeyConfigured/);
  });

  it("APIキーをそのまま画面 body に表示していない (露出防止)", () => {
    expect(CLIENT_SRC).not.toMatch(/\{apiKey\}/);
  });

  it("APIキーが入っていても billing 未確認なら FieldSurveyMap を mount しない (Codex P1)", () => {
    expect(CLIENT_SRC).toMatch(/isGoogleMapsBillingAcknowledged/);
    expect(CLIENT_SRC).toMatch(/BillingNotAcknowledgedFallback/);
    // 早期 return: if (!billingAcknowledged) return <BillingNotAcknowledgedFallback />
    expect(CLIENT_SRC).toMatch(
      /if\s*\(\s*!billingAcknowledged\s*\)\s*return\s*<BillingNotAcknowledgedFallback/,
    );
    // FieldSurveyMap の render は 1 箇所のみ (重複 mount 経路がない)
    const matches = CLIENT_SRC.match(/<FieldSurveyMap\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("fallback UI に 5 項目チェックリストが含まれる", () => {
    expect(CLIENT_SRC).toMatch(/Cloud Billing/);
    expect(CLIENT_SRC).toMatch(/quota/i);
    expect(CLIENT_SRC).toMatch(/referrer/i);
    expect(CLIENT_SRC).toMatch(/Maps JavaScript API/);
    expect(CLIENT_SRC).toMatch(/管理者.*承認|本番利用承認/);
  });

  it("fallback UI で Budget alert ≠ 課金停止 を明記している", () => {
    expect(CLIENT_SRC).toMatch(
      /通知のみで課金を停止しません|Budget alert.*通知/,
    );
    expect(CLIENT_SRC).toMatch(/quota.*必要/);
  });

  it("APIキー + 課金承認済でも MAP_ID 未設定なら FieldSurveyMap を mount しない (Codex Phase 1-E)", () => {
    expect(CLIENT_SRC).toMatch(/isGoogleMapsMapIdConfigured/);
    expect(CLIENT_SRC).toMatch(/MissingMapIdFallback/);
    expect(CLIENT_SRC).toMatch(
      /if\s*\(\s*!hasMapId\s*\)\s*return\s*<MissingMapIdFallback/,
    );
    const matches = CLIENT_SRC.match(/<FieldSurveyMap\b/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("MissingMapIdFallback に MAP_ID 設定指示と壊れた UI 注意がある", () => {
    expect(CLIENT_SRC).toMatch(/NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID/);
    expect(CLIENT_SRC).toMatch(/AdvancedMarker/);
    expect(CLIENT_SRC).toMatch(/壊れた\s*UI|表示されない/);
    expect(CLIENT_SRC).toMatch(/build\s*\/\s*restart|build.*restart/i);
  });

  it("FieldSurveyMap の mapId prop に as string を明示 (mapId 必須宣言)", () => {
    expect(CLIENT_SRC).toMatch(/mapId=\{mapId\s+as\s+string\}/);
  });

  it("FieldSurveyMapProps の mapId は optional ではない (必須)", () => {
    const propsDecl = MAP_SRC.match(
      /interface FieldSurveyMapProps[\s\S]*?^\}/m,
    );
    expect(propsDecl).not.toBeNull();
    expect(propsDecl?.[0]).not.toMatch(/\bmapId\?:/);
    expect(propsDecl?.[0]).toMatch(/\bmapId:\s*string/);
  });

  it("client component に固定料金 (無料枠 / 単価) をハードコードしていない", () => {
    expect(CLIENT_SRC).not.toMatch(/\$\s*\d/);
    expect(CLIENT_SRC).not.toMatch(/28[,\s]?500/);
    expect(CLIENT_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(CLIENT_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
  });
});

describe("field-survey-map.tsx — PII / API 境界", () => {
  it("'use client' で始まる", () => {
    expect(MAP_SRC.trim().startsWith('"use client"')).toBe(true);
  });

  it("既存 Property map API を叩く", () => {
    expect(MAP_SRC).toMatch(/\/api\/field-survey\/map\/properties/);
  });

  it("既存 Pin list API を叩く", () => {
    expect(MAP_SRC).toMatch(/\/api\/field-survey\/pins/);
  });

  it("owner 氏名・住所・電話などの PII field を参照していない", () => {
    expect(MAP_SRC).not.toMatch(/\bownerName\b/);
    expect(MAP_SRC).not.toMatch(/\bownerPhone\b/);
    expect(MAP_SRC).not.toMatch(/\bownerAddress\b/);
    expect(MAP_SRC).not.toMatch(/propertyOwners/);
    expect(MAP_SRC).not.toMatch(/\bowner\.\w+/);
  });

  it("rawData / rawPayloadJson / memo 本文を地図 row に持ち込まない (Property)", () => {
    // PropertyRow interface に rawPayloadJson を入れていない
    expect(MAP_SRC).not.toMatch(/rawPayloadJson/);
    expect(MAP_SRC).not.toMatch(/rawData/);
  });

  it("HTTP error ハンドリングが 401 / 403 / 422 に対応", () => {
    expect(MAP_SRC).toMatch(/status === 401/);
    expect(MAP_SRC).toMatch(/status === 403/);
    expect(MAP_SRC).toMatch(/status === 422/);
  });

  it("AbortController で stale request を中断する", () => {
    expect(MAP_SRC).toMatch(/AbortController/);
  });

  it("debounce を fetch に挟んでいる", () => {
    expect(MAP_SRC).toMatch(/debounce\(/);
  });

  it("Pin InfoWindow に memo 本文を表示しない (Codex P2)", () => {
    // PinInfo 関数内で row.memo を直接 render しない
    const pinInfo = MAP_SRC.match(/function PinInfo[\s\S]*?^\}/m);
    expect(pinInfo).not.toBeNull();
    expect(pinInfo?.[0]).not.toMatch(/row\.memo/);
    expect(pinInfo?.[0]).not.toMatch(/\{[^}]*memo[^}]*\}/);
    // hasMemo の boolean のみで「あり」「—」を切り替える
    expect(pinInfo?.[0]).toMatch(/hasMemo/);
  });

  it("PinRow 型 / state に memo 本文を持ち回らない", () => {
    // PinRow interface に memo 本文 field を含めない (hasMemo のみ)
    const pinRowDecl = MAP_SRC.match(/interface PinRow[\s\S]*?^\}/m);
    expect(pinRowDecl).not.toBeNull();
    // "memo:" 単独 field がない (hasMemo は別語)
    expect(pinRowDecl?.[0]).not.toMatch(/\bmemo:\s*string/);
    expect(pinRowDecl?.[0]).toMatch(/hasMemo/);
  });

  it("API レスポンス受け取りに client side strip (stripPinMemo) を使わない", () => {
    // view=map projection で API 側が memo を返さなくなったため、client strip は不要。
    // 過去 helper の再混入で「生 memo が一度 client メモリに乗る」状態に
    // 退行しないことを構造的にガード。
    expect(MAP_SRC).not.toMatch(/stripPinMemo/);
  });

  it("Pin fetch URL に bbox (north/south/east/west) + view=map が含まれる (Codex Phase 1-E)", () => {
    // pin fetch 経路で URLSearchParams に bbox 4 値 + view=map が積まれる
    const pinFetchRegion = MAP_SRC.match(
      /api\/field-survey\/pins[\s\S]{0,400}/,
    );
    expect(pinFetchRegion).not.toBeNull();
    // URLSearchParams object literal shorthand の key を検出
    expect(MAP_SRC).toMatch(/\bview:\s*["']map["']/);
    expect(MAP_SRC).toMatch(/\bnorth:\s*String\(/);
    expect(MAP_SRC).toMatch(/\bsouth:\s*String\(/);
    expect(MAP_SRC).toMatch(/\beast:\s*String\(/);
    expect(MAP_SRC).toMatch(/\bwest:\s*String\(/);
    // 単純な ?limit のみのリクエストになっていないこと
    expect(MAP_SRC).not.toMatch(
      /\/api\/field-survey\/pins\?limit=\$\{[^}]+\}["'`]/,
    );
  });

  it("Phase 1-F-2 で位置記録 UI + polyline を統合 (現在位置 placeholder は撤去)", () => {
    // Phase 1-F-1 までの disabled placeholder は撤去済。
    expect(MAP_SRC).not.toMatch(/現在位置\s*\(準備中\)/);
    expect(MAP_SRC).toMatch(/LocationRecorderControls/);
    expect(MAP_SRC).toMatch(/RoutePolyline/);
    expect(MAP_SRC).toMatch(/useFieldSurveyLocationRecorder/);
  });

  it("API キーを fetch URL / query / log に流していない", () => {
    expect(MAP_SRC).not.toMatch(/apiKey=\$\{apiKey\}/);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*apiKey/);
  });

  it("lat / lng / bbox を console に出さない", () => {
    // 防御的: コードに console.* で lat/lng/bbox を出すパターンが無いこと
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lat/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*lng/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*bbox/i);
  });

  it("map component にも固定料金をハードコードしていない", () => {
    expect(MAP_SRC).not.toMatch(/\$\s*\d/);
    expect(MAP_SRC).not.toMatch(/28[,\s]?500/);
    expect(MAP_SRC).not.toMatch(/\b\d{2,3}\s*円\b/);
    expect(MAP_SRC).not.toMatch(/\bper\s*1[,\s]?000\b/i);
  });

  it("marker filter で coerceLat / coerceLng を使い numeric string も拾える (Codex P1)", () => {
    // typeof === "number" 単独依存の filter が再混入しないように構造ガード
    expect(MAP_SRC).toMatch(/coerceLat/);
    expect(MAP_SRC).toMatch(/coerceLng/);
    // filterValidGps / filterValidPinGps 関数で typeof === "number" だけに
    // 依存していた旧 pattern を捨てて、coerce 経由で number 化していること
    const filterRegion = MAP_SRC.match(
      /function filterValidGps[\s\S]*?function filterValidPinGps[\s\S]*?\n\}/,
    );
    expect(filterRegion).not.toBeNull();
    expect(filterRegion?.[0]).not.toMatch(/typeof\s+\w+\.gpsLat\s*===\s*"number"/);
    expect(filterRegion?.[0]).not.toMatch(/typeof\s+\w+\.lat\s*===\s*"number"/);
  });

  it("共有フック useMapGestureHandling がタッチ端末検出で cooperative / greedy を返す", () => {
    // 地図が画面を占有して周囲 UI に触れなくなる問題の対策。タッチ入力検出は
    // useSyncExternalStore + matchMedia("(any-pointer: coarse)")。
    // ハイブリッド機(タッチPC+マウス)でも再発しないよう any-pointer を使う。
    expect(GESTURE_HOOK_SRC).toMatch(/useSyncExternalStore/);
    expect(GESTURE_HOOK_SRC).toMatch(/\(any-pointer:\s*coarse\)/);
    expect(GESTURE_HOOK_SRC).not.toMatch(/matchMedia\(["']\(pointer:\s*coarse\)["']\)/);
    expect(GESTURE_HOOK_SRC).toMatch(
      /isCoarsePointer\s*\?\s*["']cooperative["']\s*:\s*["']greedy["']/,
    );
    expect(GESTURE_HOOK_SRC).toMatch(/export function useMapGestureHandling/);
  });

  it("現地調査マップ本体と履歴マップの両方が共有フックで gestureHandling を切替える(greedy 固定にしない)", () => {
    for (const src of [MAP_SRC, HISTORY_MAP_SRC]) {
      expect(src).toMatch(/useMapGestureHandling\(\)/);
      expect(src).toMatch(/gestureHandling=\{mapGestureHandling\}/);
      expect(src).not.toMatch(/gestureHandling="greedy"/);
    }
  });

  it("地図ページの高さは dvh(実表示高)で スマホの 100vh はみ出しを避ける", () => {
    expect(PAGE_SRC).toMatch(/h-\[calc\(100dvh-3\.5rem\)\]/);
    expect(PAGE_SRC).not.toMatch(/h-\[calc\(100vh-3\.5rem\)\]/);
  });

  it("表示切替パネルは地図エリアの実高に固定+内部スクロールでスマホでも下部が切れない", () => {
    // 地図エリア(flex-1 overflow-hidden)にパネルが絶対配置され、内容が地図高より
    // 高くなると下部が overflow-hidden で切れる(スマホで発生)。viewport 固定値の
    // 上限だとバナー/ヘッダ折返し等の可変高で狂うため、コンテナを地図エリアの実高
    // (top-3〜bottom-3)に固定し、その中でパネルをスクロールさせる。
    expect(MAP_SRC).toMatch(/pointer-events-none absolute bottom-3 right-3 top-3/);
    expect(MAP_SRC).toMatch(/overflow-y-auto/);
    expect(MAP_SRC).toMatch(/overscroll-contain/);
    // 空き領域は地図操作を透過し、パネル/ボタンのみ操作可能にする。
    expect(MAP_SRC).toMatch(/pointer-events-auto/);
    // viewport 固定値のマジックナンバーには戻さない。
    expect(MAP_SRC).not.toMatch(/max-h-\[calc\(100dvh/);
  });

  it("map component / page から料金関連内部設定値を console / error に流さない", () => {
    // billing / budget / quota の内部値を出力に混ぜないこと
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*billing/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*quota/i);
    expect(MAP_SRC).not.toMatch(/console\.\w+\([^)]*budget/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*billing/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*quota/i);
    expect(PAGE_SRC).not.toMatch(/console\.\w+\([^)]*budget/i);
  });
});
