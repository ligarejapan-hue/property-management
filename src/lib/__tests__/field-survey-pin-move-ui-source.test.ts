/**
 * ピンの位置直し(発注者決定 2026-07-28 決定8)の配線を固定する。
 *
 * 決めごと:
 *  - 動かせるのは**保存直後のそのピンだけ**。常時ドラッグ可にはしない
 *    (歩きながら地図を動かすつもりでピンを掴むため。1本指パンにした今はなおさら)。
 *  - 離した瞬間に保存(「位置を直す」を押してから、の段取りは置かない)。
 *  - 直さないなら手数ゼロ=次の操作を始めれば黙って解除。
 *  - ⚠決定9: 位置の変更は**記録に残さない**(監査側は route テストで固定)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP = read("src/components/field-survey/field-survey-map.tsx");
const ROUTE = read("src/app/api/field-survey/pins/[id]/route.ts");

describe("動かせるのは保存直後の1本だけ", () => {
  it("保存に成功したピンを、その場で動かせる状態にする", () => {
    // ⚠同じ代入は他にもあるので、作成完了ハンドラ固有の並びでアンカーする。
    const at = MAP.indexOf("const fromCamera = createdFromCameraRef.current;");
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 400)).toContain("setMovablePinId(pinId);");
  });

  it("マーカーのドラッグ可否は movablePinId との一致だけで決まる", () => {
    expect(MAP).toContain(
      "draggable={!captureMapClick && !movingPin && pin.id === movablePinId}",
    );
    // 他のマーカー(物件・まとめ・focusPin 強調)は draggable を持たない。
    const draggables = MAP.match(/draggable=\{/g) ?? [];
    expect(draggables.length).toBe(1);
  });

  it("まとめ表示に飲まれない(掴めないのに『ドラッグして直せます』と出さない)", () => {
    // 引いた倍率ではピンがまとまりに束ねられ単独マーカーが描かれない。
    // 位置直し中のピンを束ねると、案内は出るのに掴めない状態になる。
    const at = MAP.indexOf("const alwaysSingle = new Set<string>();");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at, at + 900);
    expect(body).toContain("if (movablePinId) alwaysSingle.add(movablePinId);");
    expect(body).toContain(".filter((p) => !alwaysSingle.has(p.id))");
    // 除いたぶんは単独として必ず描き直す(まとめからも単独からも消えない)。
    expect(body).toContain("for (const row of singleRows) {");
    expect(MAP).toContain("visiblePins, zoom, focusPinId, movablePinId]");
  });

  it("タップ待ち中と保存中は掴ませない(内部レビューP2)", () => {
    // ⚠保存中に2本目のドラッグを許すと、位置の更新が2本飛ぶ。サーバーの
    //   楽観ロックは種類と紐付けしか見ないためどちらも成功し、**到達順**が
    //   最終値を決める(画面は新しい位置なのに DB は古い位置)。1本に限れば
    //   競合そのものが起きない。
    const at = MAP.indexOf("draggable={!captureMapClick");
    const block = MAP.slice(at, at + 1400);
    const cond = "!captureMapClick && !movingPin && pin.id === movablePinId";
    expect(block).toContain(`draggable={${cond}}`);
    // onDragEnd 側も**同じ判定**を通る(片方だけ有効、が起きない)。
    const guards = block.match(
      /!captureMapClick && !movingPin && pin\.id === movablePinId/g,
    ) ?? [];
    expect(guards.length).toBe(2);
    // 保存中かどうかは親から渡る(描画側で別の判断をしない)。
    expect(MAP).toContain("movingPin={movingPin}");
  });

  it("巡回の開始/終了でも解除する(内部レビューP2)", () => {
    // 終えたあともバナーが出続け、前のピンが掴めるまま残っていた。
    const at = MAP.indexOf("prevActiveSessionIdRef.current = nextId;");
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 200)).toContain("setMovablePinId(null);");
  });

  it("⚠手元の位置を守るのは**保存中だけ**(@codex #410 R2 P2)", () => {
    // 保存の応答前に復帰などで再取得が走ると、サーバーはまだ古い位置を返す。
    // そのまま流し込むと「直したのに戻った」に見える(実際は保存済み)。
    // ⚠ただし守り続けると、保存が終わったあとに**他の人が動かした結果**まで
    //   打ち消してしまう。守るのは飛んでいる1件だけにする。
    const at = MAP.indexOf("const pending = pendingMoveRef.current;");
    expect(at).toBeGreaterThan(-1);
    const body = MAP.slice(at - 300, at + 400);
    expect(body).toContain("if (!pending) return next;");
    expect(body).toContain("lat: pending.lat, lng: pending.lng");
    // 保存の開始で同期に立て(state だと反映が1描画遅れて隙ができる)、
    const drag = MAP.indexOf("pendingMoveRef.current = { id: pin.id, lat, lng };");
    expect(drag).toBeGreaterThan(-1);
    const dragBody = MAP.slice(drag, drag + 1200);
    // 先に画面へ反映するより前に守りを立てる。
    expect(dragBody.indexOf("setPins((cur) =>")).toBeGreaterThan(-1);
    // 成否どちらでも解く(自分が立てた1件だけを消す)。
    expect(dragBody).toContain("pendingMoveRef.current?.id === pin.id");
    expect(dragBody).toContain("pendingMoveRef.current = null;");
    // 守りは ref(再取得の関数の依存に入れない=リスナー再登録と中断を招かない)。
    expect(MAP).toContain("const pendingMoveRef = useRef<{");
    expect(MAP).not.toContain("movablePinIdRef");
  });
});

describe("離した瞬間に保存し、失敗したら元へ戻す", () => {
  it("画面へ先に反映してから保存する(指を離した位置に留まる)", () => {
    const at = MAP.indexOf("const before = { lat: pin.lat, lng: pin.lng };");
    expect(at).toBeGreaterThan(-1);
    // 窓は 1600: 保存中の守り(@codex R2)が入り、ハンドラが伸びたため。
    const body = MAP.slice(at, at + 1600);
    const optimistic = body.indexOf("setPins((cur) =>");
    const save = body.indexOf("onPinMoved(pin.id, lat, lng)");
    expect(optimistic).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(optimistic);
    // 保存できなければ元の位置へ戻す(保存された、と誤解させない)。
    expect(body).toContain("if (!ok) {");
    expect(body).toContain("...before");
  });

  it("壊れた座標は送らない(純関数と同じ規則をクライアントでも通す)", () => {
    expect(MAP).toContain('from "@/lib/field-survey-pin-util"');
    const at = MAP.indexOf("const handlePinMoved");
    expect(at).toBeGreaterThan(-1);
    const fn = MAP.slice(at, at + 900);
    expect(fn).toContain("buildPinMovePatch(lat, lng)");
    expect(fn).toContain("if (!patch)");
    expect(fn).toContain("pinMutations.updatePin(pinId, patch)");
    // 失敗は黙らせない。
    expect(fn).toContain("setError(");
  });
});

describe("直さないなら手数ゼロ(次の操作で解除)", () => {
  it("撮影のタップ待ち・作成・詳細を開く の全経路で解除する", () => {
    // 「次の操作」を1つでも取りこぼすと、前のピンが掴めるまま残る。
    const clears = MAP.match(/setMovablePinId\(null\)/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(6);
    // 撮影のタップ待ちに入る全箇所。
    const phases = MAP.match(
      /setCameraFirstPhase\("awaiting-map-tap"\);\n\s*setMovablePinId\(null\);/g,
    ) ?? [];
    expect(phases.length).toBe(3);
    // 作成モーダルを開く全箇所。
    const creates = MAP.match(
      /setMovablePinId\(null\);[^\n]*\n\s*setCreateCandidate\(\{/g,
    ) ?? [];
    expect(creates.length).toBe(2);
    // 詳細を開く唯一の口。
    const so = MAP.indexOf("const openPinDetailSafe");
    expect(MAP.slice(so, so + 400)).toContain("setMovablePinId(null);");
  });

  it("取り消したピンは動かせない", () => {
    const at = MAP.indexOf("const handleUndoCreatedPin");
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 800)).toContain(
      "setMovablePinId((cur) => (cur === pinId ? null : cur));",
    );
  });
});

describe("使えない状況では位置直しを出さない(@codex #410 R1 P2)", () => {
  it("詳細シートを開いている間と、ピンのレイヤーが OFF のときは出さない", () => {
    // ⚠panelOpen は「表示切替パネル」であって詳細シートではない(取り違えていた)。
    //   写真なしの保存は保存直後にそのまま詳細を開くので、必ずこの経路を通る。
    //   レイヤー OFF ではマーカー自体を描いていないため、案内だけ出ると嘘になる。
    expect(MAP).toContain(
      "detailPinId !== null || !layers.pins ? null : movablePinId",
    );
    // 判定は1か所で作り、案内も描画も**同じ値**を使う(食い違わない)。
    expect(MAP).toContain("movablePinId={activeMovablePinId}");
    const at = MAP.indexOf('data-testid="pin-move-banner"');
    expect(MAP.slice(at - 400, at)).toContain("activeMovablePinId &&");
    // 状態そのものは保つ(閉じれば戻る・レイヤーを戻せば使える)。
    expect(MAP).toContain("const [movablePinId, setMovablePinId]");
  });
});

describe("案内は保存直後だけ出る", () => {
  it("「家の上へドラッグ」と「完了」が出て、完了で解除する", () => {
    const at = MAP.indexOf('data-testid="pin-move-banner"');
    expect(at).toBeGreaterThan(-1);
    const before = MAP.slice(at - 400, at);
    // 保存直後のときだけ。詳細シートやタップ待ちの案内とは重ねない。
    expect(before).toContain("activeMovablePinId &&");
    expect(before).toContain("!panelOpen");
    expect(before).toContain('cameraFirstPhase !== "awaiting-map-tap"');
    const block = MAP.slice(at, at + 1200);
    expect(block).toContain("ピンを家の上へドラッグして直せます");
    expect(block).toContain("位置を保存しています…");
    const done = MAP.indexOf('data-testid="pin-move-done"');
    expect(done).toBeGreaterThan(-1);
    expect(MAP.slice(done, done + 260)).toContain("onClick={clearPinMove}");
    expect(MAP.slice(done, done + 260)).toContain("disabled={movingPin}");
  });
});

describe("⚠位置の変更は記録に残さない(決定9)", () => {
  it("route が座標を changedFields に入れていない", () => {
    // 入れると監査へ自動的に載り、発注者判断と食い違う。
    const at = ROUTE.indexOf("const changedFields: string[] = [];");
    expect(at).toBeGreaterThan(-1);
    const block = ROUTE.slice(at, ROUTE.indexOf("if (changedFields.length > 0)"));
    expect(block).not.toContain('changedFields.push("lat")');
    expect(block).not.toContain('changedFields.push("lng")');
    // なぜ入れないかがコードに書いてある(将来「抜け」と誤解して足さないため)。
    expect(ROUTE).toContain("決定9");
  });

  it("座標は保存される(記録に残さないだけで、更新は効く)", () => {
    expect(ROUTE).toContain("...(patch.lat !== undefined && { lat: patch.lat })");
    expect(ROUTE).toContain("...(patch.lng !== undefined && { lng: patch.lng })");
  });
});
