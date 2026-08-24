/**
 * 地図操作性 第3弾「軽さと賢さ」(発注者承認 2026-08-24) の固定。
 *
 * B4 無駄な取り直しをやめる+色と線が点滅しない / 更新ボタンと再試行 /
 * 復帰時の自動反映 / 履歴地図の往復半減+並列化+再試行 / まとめ表示 /
 * 物件マーカーの種別表示 / 死にボタンの撤去。
 * ⚠存在チェックだけの空当たりを避け、**配線(呼び出し・結線・順序)**まで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP = read("src/components/field-survey/field-survey-map.tsx");
const HISTORY = read("src/components/field-survey/field-survey-history-map.tsx");
const LEGEND = read("src/components/field-survey/pin-marker-legend.tsx");
const CONVERT = read("src/components/field-survey/convert-pin-to-property-modal.tsx");

describe("B4: 取り直しの計画を1か所で作る", () => {
  it("取得の可否は純関数の計画に従う(レイヤーの生の値で分岐しない)", () => {
    expect(MAP).toContain("planMapFetch(prevFetchInputsRef.current, next)");
    for (const key of ["properties", "pins", "coverage", "tracks"]) {
      expect(MAP, key).toContain(`plan.fetch.${key}`);
    }
    // 旧: レイヤーの値そのもので取得を決めていた形が残っていない。
    expect(MAP).not.toContain("if (layers.properties) {");
    expect(MAP).not.toContain("if (layers.pins) {");
    expect(MAP).not.toContain("const coveragePromise = layers.coverage");
    expect(MAP).not.toContain("const tracksPromise = layers.tracks");
  });

  it("計画を作る口は1つ(idle 経路とレイヤー変更経路が同じ判断を通る)", () => {
    const calls = MAP.match(/planMapFetch\(/g) ?? [];
    expect(calls.length).toBe(1);
    // 呼び出し口は idle 経路とレイヤー変更経路の2つだけ(定義は useCallback)。
    expect(MAP).toContain("const runFetch = useCallback(");
    const runs = MAP.match(/(?<!const )runFetch\(/g) ?? [];
    expect(runs.length).toBe(2);
    // 取得の実体を直接叩く経路は残っていない(計画を通らない抜け道を作らない)。
    expect(MAP).toContain("void fetchForBbox(b, plan);");
    // 実際に叩く箇所は runFetch の中だけ(定義は useCallback なので数に入らない)。
    const raw = MAP.match(/(?<!const )fetchForBbox\(/g) ?? [];
    expect(raw.length).toBe(1);
  });

  it("取らなかった層を消さない(消すのは計画が消せと言ったときだけ)", () => {
    expect(MAP).toContain("} else if (plan.clear.properties) {");
    expect(MAP).toContain("} else if (plan.clear.pins) {");
    expect(MAP).toContain("} else if (plan.clear.coverage) {");
    expect(MAP).toContain("} else if (plan.clear.tracks) {");
  });

  it("取らなかった層の「表示しきれていない」は持ち越す(毎回消さない)", () => {
    expect(MAP).toContain(
      "let propertiesTruncatedNext = truncationRef.current.properties;",
    );
    expect(MAP).toContain("let pinsTruncatedNext = truncationRef.current.pins;");
    // 消す判断も計画に従う。
    expect(MAP).toContain("if (plan.clear.properties) propertiesTruncatedNext = false;");
    expect(MAP).toContain("if (plan.clear.pins) pinsTruncatedNext = false;");
  });

  it("失敗しても、今回の計画に無い層は消さない(@codex #409 R1 P2)", () => {
    // ピンだけ取り直して失敗したときに、無関係な踏破の色や線まで消えると
    // 層別取得の意味が失われる。片付けるのは今回取りに行った層だけ。
    // ⚠内側(面・線それぞれの .catch)にも同じ AbortError 判定があるため、
    //   外側の catch 固有の目印でアンカーする。
    const at = MAP.indexOf("**今回の計画に入っていた層だけ**を片付ける");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at, at + 2000);
    expect(body).toContain("if (plan.fetch.coverage) {");
    expect(body).toContain("if (plan.fetch.tracks) {");
    expect(body).toContain("if (plan.fetch.properties || plan.clear.properties) {");
    expect(body).toContain("if (plan.fetch.pins || plan.clear.pins) {");
    // 断りも層ごと(両方まとめて false にしない)。
    expect(body).not.toContain("truncationRef.current = { pins: false, properties: false };");
  });

  it("面・線が飛んでいる間は「読み込み中」を解除しない(@codex #409 R1 P2)", () => {
    // 期間変更やレイヤーONで面・線だけを取る計画になると tasks が空になり、
    // Promise.all([]) が即解決して「更新」が押せる状態に戻っていた
    // (次の操作が進行中の取得を中断する)。
    expect(MAP).toContain("let coverageChain: Promise<void> | null = null;");
    expect(MAP).toContain("let tracksChain: Promise<void> | null = null;");
    expect(MAP).toContain("coverageChain = coveragePromise");
    expect(MAP).toContain("tracksChain = tracksPromise");
    const fin = MAP.indexOf("      } finally {");
    expect(fin).toBeGreaterThan(-1);
    const body = MAP.slice(fin, fin + 900);
    expect(body).toContain("const detached = [coverageChain, tracksChain].filter(");
    // 失敗しても必ず解除される(解除漏れで固まらない)。
    expect(body).toContain("Promise.allSettled(detached)");
    // 解除はいずれの経路でも「最新の取得だけ」。
    const guards = body.match(/abortRef\.current === ac/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it("何も変わらない再評価では1本も通信しない", () => {
    const at = MAP.indexOf("何もすることが無い");
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 120)).toContain("return;");
  });
});

describe("B4: 取得中に色と線が消えない(残すと嘘になるときだけ消す)", () => {
  it("残すかどうかは純関数で決め、サーバーと同じ規則で次の粗さを予測する", () => {
    expect(MAP).toContain("keepCoverageWhileLoading(coverageRenderedRef.current, {");
    expect(MAP).toContain("const nextSize = resolveCoverageCellSize(b);");
    expect(MAP).toContain("const nextStep = COVERAGE_CELL_STEPS[nextSize];");
    expect(MAP).toContain("keepCoverageRef.current = keep;");
  });

  it("開始時のクリアは keep が false のときだけ", () => {
    expect(MAP).toContain("if (!keepCoverageRef.current) {");
    expect(MAP).toContain("if (!keepTracksRef.current) setTrackLines([]);");
  });

  it("失敗・打ち切り・OFF・範囲外では素性を捨てる=次は必ず消す側へ倒す", () => {
    const drops = MAP.match(/coverageRenderedRef\.current = null;/g) ?? [];
    // 打ち切り(三項) + HTTPエラー + catch + OFF + 範囲外 + 外側catch
    expect(drops.length).toBeGreaterThanOrEqual(5);
    const trackDrops = MAP.match(/tracksRenderedDaysRef\.current = null;/g) ?? [];
    expect(trackDrops.length).toBeGreaterThanOrEqual(5);
    // 描けたときだけ素性を残す。
    expect(MAP).toContain("tracksRenderedDaysRef.current = coverageDays;");
  });
});

describe("更新と再試行(やり直す手が画面にある)", () => {
  it("地図: パネルの「最新に更新」とエラー帯の「再試行」が取り直しへ結線", () => {
    const at = MAP.indexOf('data-testid="map-refresh"');
    expect(at).toBeGreaterThan(-1);
    const btn = MAP.slice(at, at + 300);
    expect(btn).toContain("onClick={onRefresh}");
    expect(btn).toContain("disabled={mapLoading}");
    expect(MAP).toContain("onRefresh={bumpRefetch}");
    const retry = MAP.indexOf('data-testid="map-error-retry"');
    expect(retry).toBeGreaterThan(-1);
    expect(MAP.slice(retry, retry + 260)).toContain("bumpRefetch()");
  });

  it("履歴地図: 「更新」と「再試行」が同じ巡回を読み直す", () => {
    for (const id of ["history-reload", "history-retry"]) {
      const at = HISTORY.indexOf(`data-testid="${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      expect(HISTORY.slice(at, at + 260), id).toContain("setReloadNonce((n) => n + 1)");
    }
    // 読み直しの合図が読み込み関数の依存に入っている(押しても何も起きない、を防ぐ)。
    expect(HISTORY).toContain("clearHistorySessionState, reloadNonce]");
  });
});

describe("同僚のピンが自動で出る(戻ってきたとき)", () => {
  it("画面へ戻った合図で取り直す。定期問い合わせ(ポーリング)は置かない", () => {
    const at = MAP.indexOf('document.addEventListener("visibilitychange", onVisible)');
    expect(at).toBeGreaterThan(-1);
    expect(MAP).toContain('window.addEventListener("focus", onVisible)');
    const fn = MAP.indexOf("const onVisible = () => {");
    const body = MAP.slice(fn, fn + 240);
    expect(body).toContain('document.visibilityState !== "visible"');
    expect(body).toContain("bumpRefetchRef.current?.()");
    // 後片付け(離れたときに聞き続けない)。
    expect(MAP).toContain('document.removeEventListener("visibilitychange", onVisible)');
    expect(MAP).toContain('window.removeEventListener("focus", onVisible)');
    // 電池と通信を食うので置かない。
    expect(MAP).not.toContain("setInterval");
  });
});

describe("履歴地図: 往復を半分に+線とピンを同時に", () => {
  it("1回の取得数を上限まで使い、取れる総数は据え置き", () => {
    expect(HISTORY).toContain("const TRACK_PAGE_LIMIT = 1000;");
    expect(HISTORY).toContain("const TRACK_PAGE_MAX = 25;");
  });

  it("線とピンを同時に走らせ、両方そろってから描く", () => {
    expect(HISTORY).toContain("const loadTrackPoints = async () => {");
    expect(HISTORY).toContain("const loadPins = async () => {");
    const at = HISTORY.indexOf("await Promise.all([");
    expect(at).toBeGreaterThan(-1);
    const block = HISTORY.slice(at, at + 200);
    expect(block).toContain("loadTrackPoints()");
    expect(block).toContain("loadPins()");
    // 片方でも途中で無効(stale)なら何も描かない。
    expect(HISTORY).toContain(
      "if (pointsResult === null || pinsResult === null) return;",
    );
  });
});

describe("まとめ表示(クラスタリング)", () => {
  it("外部部品を足さず純関数でまとめる", () => {
    expect(MAP).toContain('from "@/lib/field-survey-map-cluster"');
    expect(MAP).not.toContain("markerclusterer");
    expect(MAP).toContain("clusterByGrid(");
  });

  it("ピンと物件を別々にまとめ、単独は元のマーカーのまま描く", () => {
    expect(MAP).toContain("pinClusters.clusters.map((c) =>");
    expect(MAP).toContain("pinClusters.singles.map((sp) =>");
    expect(MAP).toContain("propertyClusters.clusters.map((c) =>");
    expect(MAP).toContain("propertyClusters.singles.map((sp) =>");
    // 「対応済みを隠す」は従来どおり描画時のフィルタ(取得条件は変えない)。
    expect(MAP).toContain('hideClosedPins ? pins.filter((p) => p.status !== "closed") : pins');
  });

  it("まとめた印は撮影のタップ待ち中に押せない(唯一の作成経路を塞がない)", () => {
    const hits = MAP.match(
      /onClick=\{captureMapClick \? undefined : \(\) => zoomIntoCluster\(c\)\}/g,
    ) ?? [];
    expect(hits.length).toBe(2); // ピンと物件
  });

  it("一覧から見に来たピンはまとめに入れない(種別の色が見える)", () => {
    // 提出前レビュー: 既定の倍率(14)はまとめ表示が効く倍率。飲まれると
    // ★は出るが「何のピンか」が分からず、往復導線の用が足りない。
    expect(MAP).toContain("focusPinId={focusPinId}");
    const at = MAP.indexOf("const pinClusters = useMemo");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at, at + 1400);
    expect(body).toContain(".filter((p) => p.id !== focusPinId)");
    // 除いたぶんは単独として必ず描く(消してしまわない)。
    expect(body).toContain("r.singles.push({");
    expect(body).toContain("visiblePins, zoom, focusPinId]");
  });

  it("押すと寄って中身がほどける", () => {
    const at = MAP.indexOf("const zoomIntoCluster");
    expect(at).toBeGreaterThan(-1);
    const fn = MAP.slice(at, at + 400);
    expect(fn).toContain("map.panTo(");
    expect(fn).toContain("map.setZoom(");
  });
});

describe("物件マーカー: 赤は据え置き・種別は1文字", () => {
  it("色の決定は純関数で、凡例と同じものを使う", () => {
    expect(MAP).toContain('from "@/lib/field-survey-property-marker"');
    expect(MAP).toContain("propertyMarkerStyle({");
    expect(LEGEND).toContain('from "@/lib/field-survey-property-marker"');
    expect(LEGEND).toContain('data-testid="pin-legend-property"');
  });

  it("種別と案件の状態を渡す(見た目の判断を画面側で分岐しない)", () => {
    const at = MAP.indexOf("{...propertyMarkerStyle({");
    expect(at).toBeGreaterThan(-1);
    const call = MAP.slice(at, at + 200);
    expect(call).toContain("propertyType: p.propertyType");
    expect(call).toContain("caseStatus: p.caseStatus");
  });
});

describe("死にボタンの撤去", () => {
  it("物件化フォームは郵便番号欄が無いので、郵便番号→住所のボタンを出さない", () => {
    expect(CONVERT).toContain('mode="search"');
    expect(CONVERT).not.toContain('mode="both"');
    // 郵便番号の入力欄はやはり無い(あるなら "both" に戻すべき)。
    expect(CONVERT).not.toContain("value={postalCode}");
  });
});
