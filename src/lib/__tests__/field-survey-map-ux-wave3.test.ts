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
    // 呼び出しは複数行(未達の層も渡すため)。引数の並びで固定する。
    const pm = MAP.indexOf("const plan = planMapFetch(");
    expect(pm).toBeGreaterThan(-1);
    const pmCall = MAP.slice(pm, pm + 200);
    expect(pmCall).toContain("prevFetchInputsRef.current,");
    expect(pmCall).toContain("next,");
    expect(pmCall).toContain("pendingLayersRef.current,");
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

  it("中断・失敗した層は次の計画で取り直す(@codex #409 R2 P2)", () => {
    // 取得中にレイヤーや期間を切り替えると前の取得は中断される。計画が
    // 「取った」と記録しただけでは、その層は空のまま残る(地図を動かすまで直らない)。
    expect(MAP).toContain("pendingLayersRef.current,");
    const at = MAP.indexOf("for (const key of [\"properties\", \"pins\", \"coverage\", \"tracks\"] as const) {");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at, at + 300);
    expect(body).toContain("if (plan.fetch[key]) pendingLayersRef.current.add(key);");
    expect(body).toContain("else if (plan.clear[key]) pendingLayersRef.current.delete(key);");
    // 外すのは**実際に描けたとき**だけ(中断・失敗では残す=自己修復する)。
    for (const layer of ["properties", "pins", "coverage", "tracks"]) {
      expect(MAP, layer).toContain(`pendingLayersRef.current.delete("${layer}")`);
    }
    // 範囲過大は取りに行かないので持ち越さない(無駄な取得を積まない)。
    expect(MAP).toContain("pendingLayersRef.current.clear();");
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
    // ⚠成功して描けた層は消さない(@codex #409 R4 P2)。面・線は別の待ち行列で
    //   走るので、物件/ピンが失敗する前に描き終わっていることがある。
    expect(body).toContain(
      'if (plan.fetch.coverage && pendingLayersRef.current.has("coverage")) {',
    );
    expect(body).toContain(
      'if (plan.fetch.tracks && pendingLayersRef.current.has("tracks")) {',
    );
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
    expect(MAP).toContain('document.addEventListener("visibilitychange", onVisibility)');
    expect(MAP).toContain('window.addEventListener("focus", markBack)');
    expect(MAP).toContain('window.addEventListener("blur", markAway)');
    // 後片付け(離れたときに聞き続けない)。
    expect(MAP).toContain('document.removeEventListener("visibilitychange", onVisibility)');
    expect(MAP).toContain('window.removeEventListener("focus", markBack)');
    expect(MAP).toContain('window.removeEventListener("blur", markAway)');
    // 電池と通信を食うので置かない。
    expect(MAP).not.toContain("setInterval");
  });

  it("1回の復帰で2回取りに行かない(@codex #409 R3 P2)", () => {
    // visibilitychange と focus の両方が飛ぶ端末がある。素直に数えると
    // 後の取得が前の取得を中断する。「離れた→戻った」の変化だけ1回数える。
    const at = MAP.indexOf("const markBack = () => {");
    expect(at).toBeGreaterThan(-1);
    // 窓は 900: R6 で「重い層まで取り直すか」の分岐が入り関数が伸びた。
    const body = MAP.slice(at, at + 900);
    expect(body).toContain('document.visibilityState !== "visible"');
    const guard = body.indexOf("if (!awayRef.current) return;");
    const reset = body.indexOf("awayRef.current = false;");
    const bump = body.indexOf("setResumeNonce((n) => n + 1)");
    expect(guard).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(guard);
    expect(bump).toBeGreaterThan(reset);
  });

  it("復帰時: 短い間隔なら軽い層だけ・間隔が空いたら重い層も取り直す(@codex #409 R3/R6 P2)", () => {
    // ⚠踏破の面と軌跡の線は**全社合計**で、同僚が巡回を終えれば内容が変わる
    //   (発注者決定 2026-07-28)。古いままだと二度歩きを防ぐ目的が崩れるので、
    //   復帰でも取り直す。ただし撮影のたびの復帰で重い集計を繰り返さないよう、
    //   前回から一定時間あいたときだけ全層(refetchNonce)にする。
    const at = MAP.indexOf("const markBack = () => {");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at, at + 900);
    const decide = body.indexOf("shouldRefreshHeavyOnResume(Date.now(), lastHeavyFetchAtRef.current)");
    const heavy = body.indexOf("bumpRefetchRef.current?.()");
    const light = body.indexOf("setResumeNonce((n) => n + 1)");
    expect(decide).toBeGreaterThan(-1);
    expect(heavy).toBeGreaterThan(decide);
    expect(light).toBeGreaterThan(heavy); // 重い側は早期 return、軽い側は既定
    // 重い層を取りに行ったことを親が控える(次の復帰の判断材料)。
    expect(MAP).toContain("if (plan.fetch.coverage || plan.fetch.tracks) onHeavyFetch();");
    expect(MAP).toContain("onHeavyFetch={markHeavyFetched}");
    expect(MAP).toContain("lastHeavyFetchAtRef.current = Date.now();");
    expect(MAP).toContain("resumeNonce={resumeNonce}");
    // 計画の入力に復帰の合図が載っている(両方の nonce が別物として渡る)。
    const inputsAt = MAP.indexOf("bboxKey: `${b.north}");
    expect(inputsAt).toBeGreaterThan(-1);
    const inputs = MAP.slice(inputsAt, inputsAt + 200);
    expect(inputs).toContain("refetchNonce,");
    expect(inputs).toContain("resumeNonce,");
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
    // ⚠片方が失敗したら、もう片方の取得も止める(@codex #409 R4 P2)。
    //   止めないと失敗表示の後も残りのページを取り続け、位置情報の通信を
    //   無駄に流す(最大25回/20回)。
    const stop = HISTORY.indexOf("const stopSibling = (e: unknown) => {");
    expect(stop).toBeGreaterThan(-1);
    const stopBody = HISTORY.slice(stop, stop + 160);
    expect(stopBody).toContain("ac.abort();");
    expect(stopBody).toContain("throw e;");
    expect(HISTORY).toContain("loadTrackPoints().catch(stopSibling)");
    expect(HISTORY).toContain("loadPins().catch(stopSibling)");
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

  it("中身が全部済みのまとまりは灰色で出す(@codex #409 R5 P2)", () => {
    // 単独の印は灰+✓なのに、まとまると現役の色に見える食い違いを防ぐ。
    // 判定(allDone)は純関数側で検証済み。ここは配線を固定する。
    const at = MAP.indexOf("function clusterPinStyle(");
    expect(at).toBeGreaterThan(-1);
    const fn = MAP.slice(at, at + 900);
    expect(fn).toContain("allDone: boolean,");
    const branch = fn.indexOf("if (allDone) {");
    expect(branch).toBeGreaterThan(-1);
    // 灰は単独の「済み」と同じ色(凡例の語彙をそろえる)。
    expect(fn.slice(branch, branch + 220)).toContain('"#6B7280"');
    expect(MAP).toContain('clusterPinStyle(c.count, "property", c.allDone)');
    expect(MAP).toContain('clusterPinStyle(c.count, "pin", c.allDone)');
    // 「済み」の判断は物件・ピンとも1か所の規則から取る。
    expect(MAP).toContain("done: isPropertyCaseDone(p.caseStatus)");
    expect(MAP).toContain('done: p.status === "closed"');
    // 凡例にも灰色のまとまりの意味を書く。
    expect(LEGEND).toContain("灰色は中身がすべて済みのまとまりです");
  });

  it("押すと必ずほどける倍率まで寄る(@codex #409 R4 P2)", () => {
    // 2段ずつ上げる方式だと、広く引いた状態(13以下)から押しても閾値に
    // 届かず、また別のまとまりになって「押したのに開かない」。
    const at = MAP.indexOf("const zoomIntoCluster");
    expect(at).toBeGreaterThan(-1);
    const fn = MAP.slice(at, at + 600);
    expect(fn).toContain("map.panTo(");
    expect(fn).toContain("map.setZoom(Math.max(z, CLUSTER_MIN_ZOOM))");
    // 「今より2段」式の残骸が無い(閾値に届かない可能性を残さない)。
    expect(fn).not.toContain("z + 2");
  });
});

describe("凡例は出している層だけを説明する(@codex #409 R2 P2)", () => {
  it("ピン・物件それぞれの層に合わせて行を出し分ける", () => {
    // ピンを消して物件だけ出しているとき、新しい物件マーカーの説明が
    // どこにも無くなる/逆に隠れている層の説明が並ぶ、を防ぐ。
    expect(MAP).toContain("{(layers.pins || layers.properties) && (");
    expect(MAP).toContain("showPins={layers.pins}");
    expect(MAP).toContain("showProperties={layers.properties}");
    expect(LEGEND).toContain("{showPins &&");
    expect(LEGEND).toContain("{showProperties && (");
    // まとめ表示の説明はどちらか出ていれば出す。
    expect(LEGEND).toContain("{(showPins || showProperties) && (");
  });
});

describe("物件マーカー: 赤は据え置き・種別は1文字", () => {
  it("色の決定は純関数で、凡例と同じものを使う", () => {
    expect(MAP).toContain('from "@/lib/field-survey-property-marker"');
    expect(MAP).toContain("propertyMarkerStyle({");
    expect(LEGEND).toContain('from "@/lib/field-survey-property-marker"');
    expect(LEGEND).toContain('data-testid="pin-legend-property"');
  });

  it("旧ステータス done も終わった案件として灰色にする(@codex #409 R2 P2)", () => {
    // done は廃止値だが既存データに残っており、地図APIは生値を返す。
    const MARKER = read("src/lib/field-survey-property-marker.ts");
    expect(MARKER).toContain('new Set(["sold", "closed", "done"])');
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
