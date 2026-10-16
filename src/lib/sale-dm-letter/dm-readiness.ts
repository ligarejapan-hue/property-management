/**
 * DMメニューの「準備チェック」(画面すっきり化 第4回 E・発注者決定 2026-10-16)。
 *
 * 売却DMを作る前に揃っているべきものを ✓/× で並べる(純関数・env/DB非依存)。
 * - 売却DM設定の4項目(判定は print-ready.ts の1本=作成ボタンが出るかと同じ)
 * - DMの種類ごとの手紙・LPの登録(判定は scenario-copy.ts の isLetterReady / isLpReady)
 * ⚠設定の値そのもの(URL・差出人)はここにも応答にも載せない。足りない項目の名前だけ。
 */

export interface DmReadinessScenario {
  id: string;
  name: string;
  letterReady: boolean;
  lpReady: boolean;
}

export interface DmReadinessItem {
  key: string;
  label: string;
  /** false=このままでは作れない(または作れない物件がある)。 */
  ok: boolean;
  /** ok=そろっている / warn=作れるが足りないものがある / ng=作れない。 */
  level: "ok" | "warn" | "ng";
  detail: string;
  /** 直す画面(管理者向け)。 */
  fixHref: string;
}

export interface DmReadiness {
  allOk: boolean;
  items: DmReadinessItem[];
}

const SETTINGS_HREF = "/admin/sale-dm-settings";
const SCENARIOS_HREF = "/admin/dm-scenarios";

export function buildDmReadiness(input: {
  settingsMissing: ReadonlyArray<string>;
  scenarios: ReadonlyArray<DmReadinessScenario>;
}): DmReadiness {
  const items: DmReadinessItem[] = [];
  const settingsOk = input.settingsMissing.length === 0;
  items.push({
    key: "settings",
    label: "売却DM設定(差出人・案内先)",
    ok: settingsOk,
    level: settingsOk ? "ok" : "ng",
    detail: settingsOk ? "設定済み" : `未設定: ${input.settingsMissing.join("・")}`,
    fixHref: SETTINGS_HREF,
  });

  if (input.scenarios.length === 0) {
    items.push({
      key: "scenarios",
      label: "DMの種類",
      ok: false,
      level: "ng",
      detail: "使える種類がありません",
      fixHref: SCENARIOS_HREF,
    });
  }
  for (const s of input.scenarios) {
    const level = !s.letterReady ? "ng" : s.lpReady ? "ok" : "warn";
    items.push({
      key: `scenario:${s.id}`,
      label: `DMの種類「${s.name}」`,
      ok: s.letterReady,
      level,
      detail: !s.letterReady
        ? "手紙が未登録(この種類の物件を含む発送は作れません)"
        : s.lpReady
          ? "手紙・LPとも登録済み"
          : "手紙は登録済み・LPが未登録(QRは会社のホームページへ)",
      fixHref: SCENARIOS_HREF,
    });
  }

  return { allOk: items.every((i) => i.ok), items };
}
