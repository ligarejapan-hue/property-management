/**
 * 権限の鮮度パターン(3点セット)の横断ガード。
 *
 * ScreenProtectionProvider は dashboard layout に居座り client navigation で再 mount
 * されないため、provider の mount 時 1 回 fetch だけでは滞在中の権限付与・剥奪に追従
 * できない。そこで **provider から permissions を受け取って UI を出し分ける画面**は
 * 以下の3点をセットで持つ規約になっている(17-C F12-2 の @codex 3巡の教訓):
 *
 *   (1) refetchPermissions を進入(mount)あたり最大1回だけ呼ぶ(鮮度の再確認+復旧導線)
 *   (2) permissionsRefreshPending を `useState(() => !permissionsLoading)` で開始する
 *       (再訪時は最初の描画から pending=true=stale 権限でボタンを出さない)
 *   (3) 権限の導出時に pending / loading を false 側へ倒す(fail-safe)
 *
 * ⚠(1)だけを流用すると「再確認が終わるまで stale な granted でボタンが見える」窓が
 * 再発する(@codex round3 の指摘そのもの)。
 *
 * このテストは**画面を名指しせずソースを走査**する。名指し方式だと新しい画面が
 * 追加されたときに素通りするため(DM送付履歴の画面で実際に素通りした)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const ROOT = process.cwd();

/** src 配下の .tsx を再帰列挙(node_modules/.next は対象外)。 */
function listTsx(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listTsx(full, acc);
    else if (name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

const FILES = listTsx(path.join(ROOT, "src")).map((full) => ({
  rel: path.relative(ROOT, full).replace(/\\/g, "/"),
  src: readFileSync(full, "utf8").replace(/\r\n/g, "\n"),
}));

/**
 * useScreenProtection() の分割代入から permissions を受け取っている＝
 * 権限で UI を出し分けている画面(capabilities / bypass だけの画面は対象外)。
 * provider 本体は定義元なので除外する。
 */
const PERMISSION_CONSUMERS = FILES.filter(({ rel, src }) => {
  if (rel.includes("screen-protection-provider")) return false;
  if (!src.includes("useScreenProtection")) return false;
  // useScreenProtection() の呼び出しに紐づく分割代入(複数行可)を取り出す
  const destructures = [...src.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*useScreenProtection\(\)/g)];
  return destructures.some((m) => /(^|[\s,{])permissions\s*[,:}]/.test(m[1]));
});

describe("権限の鮮度パターン(3点セット)", () => {
  it("走査対象が空でない(検出ロジックが壊れていない)", () => {
    expect(PERMISSION_CONSUMERS.length).toBeGreaterThanOrEqual(5);
  });

  it("permissions で UI を出し分ける全画面が (1)進入時の再確認 を持つ", () => {
    const missing = PERMISSION_CONSUMERS.filter(
      ({ src }) => !src.includes("refetchPermissions"),
    ).map((f) => f.rel);
    expect(missing, `refetchPermissions が無い: ${missing.join(", ")}`).toEqual([]);
  });

  it("全画面が (2)pending を mount 時 true 側で開始する(再訪時の一瞬表示の防止)", () => {
    // 正しい形は2つある。どちらも「再訪時に stale 権限でボタンを出さない」を満たす:
    //   a) useState(() => !permissionsLoading) … provider が取得済みなら pending で開始
    //   b) useState(true)                       … 常に pending で開始(より厳格)
    // 弾きたいのは `useState(false)` 等で pending を最初から解除している形。
    // 改行・末尾カンマを許す(prettier の折り返し形が既定)。
    const OK =
      /useState\(\s*(?:\(\)\s*=>\s*!permissionsLoading|true)\s*,?\s*\)/;
    const missing = PERMISSION_CONSUMERS.filter(
      ({ src }) => !OK.test(src),
    ).map((f) => f.rel);
    expect(
      missing,
      `pending が mount 時 true 側で開始していない: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("全画面が (3)権限導出で pending / loading を false 側へ倒す", () => {
    const missing = PERMISSION_CONSUMERS.filter(
      ({ src }) => !src.includes("permissionsRefreshPending"),
    ).map((f) => f.rel);
    expect(missing, `pending を導出に反映していない: ${missing.join(", ")}`).toEqual([]);
  });

  it("進入時の再確認は ref ガードつき(無限リトライ・多重 fetch を作らない)", () => {
    const missing = PERMISSION_CONSUMERS.filter(
      ({ src }) => !src.includes("permissionsRefreshRequestedRef"),
    ).map((f) => f.rel);
    expect(missing, `ref ガードが無い: ${missing.join(", ")}`).toEqual([]);
  });

  it("画面は /api/me/permissions を直接 fetch しない(provider 経由に一本化)", () => {
    const direct = PERMISSION_CONSUMERS.filter(({ src }) =>
      /fetch\(\s*["'`]\/api\/me\/permissions/.test(src),
    ).map((f) => f.rel);
    expect(direct, `直接 fetch が残っている: ${direct.join(", ")}`).toEqual([]);
  });

  it("DM送付履歴の画面が走査対象に入っている(今回の抜けの回帰ピン)", () => {
    const rels = PERMISSION_CONSUMERS.map((f) => f.rel);
    expect(rels).toContain("src/components/properties/dm-logs-view.tsx");
  });
});
