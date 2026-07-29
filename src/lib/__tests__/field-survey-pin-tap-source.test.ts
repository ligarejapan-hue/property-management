/**
 * ピンの位置は**必ず地図タップ**で決める（2026-07-29 業務判断）。
 *
 * 【背景】撮影すると GPS の現在地に自動でピンが刺さっていた。GPS が返すのは
 * 「立っている場所」＝道路なので、**ピンが道路に立ち、どの家の写真か分から
 * なくなる**。発注者の指摘そのもの。
 *
 * 【決定】
 *  1. 位置は全件、地図タップで指定する（GPS 自動配置をやめる）
 *  2. 写真を撮らずにピンだけ立てる操作は無くす → ピン追加モード廃止
 *  3. ドラッグで動かす機能は作らない（最初から家の上に置くので不要）
 *  4. GPS 精度の警告はピン作成から外す（タップで置くので無関係）
 *
 * ⚠**順序が大事**。従来 `awaiting-map-tap` に入るのは GPS が失敗した時だけ
 * だった。ピン追加モードを先に消すと、GPS が成功する端末では**タップで置く
 * ことすらできない**退行を通過する。撮影＝必ずタップ待ち を先に倒すこと。
 *
 * vitest は env=node（jsdom 無）のためソース文字列で形を固定する。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const LIB_SRC = read("src/lib/field-survey-camera-first.ts");
const BANNER_SRC = read("src/components/field-survey/camera-first-banner.tsx");
const MODAL_SRC = read("src/components/field-survey/pin-create-modal.tsx");

describe("1. 撮影したら必ず地図タップ待ちになる", () => {
  it("撮影の処理が現在地を取りに行かない", () => {
    const fn =
      MAP_SRC.match(
        /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    expect(fn).not.toBe("");
    // GPS を待つ経路が残っていると、取れた端末ではタップできないまま
    // 道路にピンが立つ（この改修の目的そのものが達成されない）。
    expect(fn).not.toMatch(/getCurrentPosition|watchPosition/);
    expect(fn).not.toMatch(/prefetch/i);
    expect(fn).toContain('setCameraFirstPhase("awaiting-map-tap")');
  });

  it("写真は分岐より先に保持する（撮った写真を失わない）", () => {
    const fn =
      MAP_SRC.match(
        /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    const store = fn.indexOf("cameraPhotoFileRef.current = file");
    const phase = fn.indexOf('setCameraFirstPhase("awaiting-map-tap")');
    expect(store).toBeGreaterThan(-1);
    expect(store).toBeLessThan(phase);
  });

  it("状態から locating が消えている（GPS 待ちの段が無い）", () => {
    expect(LIB_SRC).toMatch(
      /export type CameraFirstPhase = "idle" \| "awaiting-map-tap";/,
    );
    expect(MAP_SRC).not.toMatch(/"locating"/);
  });

  it("GPS からピン座標を作る関数を残さない", () => {
    // 残すと「いつの間にか自動配置に戻す」経路になる。
    expect(LIB_SRC).not.toMatch(/cameraFirstCandidateFromPosition/);
    expect(MAP_SRC).not.toMatch(/cameraFirstCandidateFromPosition/);
  });

  it("地図タップを拾う条件がタップ待ちだけになる", () => {
    expect(MAP_SRC).toMatch(
      /captureMapClick=\{cameraFirstPhase === "awaiting-map-tap"\}/,
    );
  });
});

describe("1-b. 撮影ボタンの配線（旧 prefetch テストから移設）", () => {
  it("撮影ボタンは巡回中と巡回外の2箇所に配線されている", () => {
    // 巡回外撮影 (quick_capture) を落とさないための配線チェック。
    const n = (MAP_SRC.match(/onPhotoCaptured=\{handleCameraPhotoCaptured\}/g) ?? [])
      .length;
    expect(n).toBe(2);
  });

  it("撮影まわりで console を使わない", () => {
    const fn =
      MAP_SRC.match(
        /const handleCameraPhotoCaptured = useCallback\([\s\S]*?\n  \}, \[\]\);/,
      )?.[0] ?? "";
    expect(fn).not.toMatch(/console\./);
  });

  it("写真のプレビュー URL は render 外で作り、閉じる時に解放する", () => {
    // 解放を落とすとメモリを掴んだままになる（現地で何十枚も撮る）。
    expect(MAP_SRC).toMatch(/URL\.createObjectURL/);
    expect(MAP_SRC).toMatch(/URL\.revokeObjectURL/);
  });
});

describe("2. 案内は「家の上をタップ」と言う", () => {
  it("失敗理由ではなく行動を書く（固定文）", () => {
    // 従来は「現在地を取得できませんでした」等の失敗理由だった。
    // これからは失敗ではなく通常の手順なので、理由を出さない。
    expect(BANNER_SRC).not.toMatch(/notice/);
    expect(BANNER_SRC).toMatch(/家の上をタップ/);
  });

  it("撮り直す導線がある（写真を捨てる操作だと分かる言葉）", () => {
    expect(BANNER_SRC).toMatch(/data-testid="camera-first-cancel"/);
    expect(BANNER_SRC).toMatch(/撮り直す/);
  });

  it("座標・技術用語を文言に出さない", () => {
    // ⚠className の -translate-x に "lat" が含まれるので、表示される文字列
    // （JSX のテキストノード）だけを見る。
    const texts = (BANNER_SRC.match(/>[^<>{}]+</g) ?? []).join(" ");
    expect(texts).not.toMatch(/GPS|geolocation|緯度|経度/i);
  });
});

describe("3. タップし直せる（間違えても写真を捨てない）", () => {
  it("作成モーダルに「置き直す」がある", () => {
    // これが無いと、タップ位置を間違えたときの直し方が
    // 「キャンセル＝写真ごと破棄」しか無くなる。
    expect(MODAL_SRC).toMatch(/data-testid="pin-create-replace-location"/);
    expect(MODAL_SRC).toMatch(/置き直す/);
  });

  it("置き直しても写真を保持したままタップ待ちへ戻る", () => {
    const handler =
      MAP_SRC.match(
        /const handleReplaceLocation = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    expect(handler).not.toBe("");
    expect(handler).toContain('setCameraFirstPhase("awaiting-map-tap")');
    // 写真を捨てる後始末を呼ばない（写真を持ち帰ってタップ待ちへ戻る）
    expect(handler).not.toContain("resetCameraFirst()");
  });

  it("保持するのはモーダル内で差し替えた「現在の」写真（@codex #336 P2）", () => {
    // 開いた時点の写真 (candidate.cameraPhoto) に戻すと、モーダル内で
    // 撮り直した写真が黙って元に戻り、次のタップで**別の家の写真**が付く。
    const handler =
      MAP_SRC.match(
        /const handleReplaceLocation = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    expect(handler).toContain("(currentPhoto: File | null)");
    expect(handler).toContain("cameraPhotoFileRef.current = currentPhoto");
    expect(handler).not.toContain("c?.cameraPhoto ?? null");
    // モーダル側は現在の photoFile を渡す
    expect(MODAL_SRC).toContain("onReplaceLocation(photoFile)");
  });

  it("写真の送信に失敗した後は「置き直す」を出さない（@codex #336 P2）", () => {
    // pin は既に元の座標で作成済み。置き直してタップしても既存 pin の位置は
    // 変わらず、同じ写真でもう1本の重複 pin を作ってしまう。
    expect(MODAL_SRC).toMatch(
      /\{!photoUploadFailed && \([\s\S]{0,700}?pin-create-replace-location/,
    );
  });
});

describe("3-b. 写真必須（写真なしピンをこの画面から作らせない・@codex #336 P2）", () => {
  it("保存には写真が要る（canSubmit が photoFile を要求）", () => {
    const canSubmit = MODAL_SRC.match(/const canSubmit =[\s\S]*?;/)?.[0] ?? "";
    expect(canSubmit).toContain("photoFile !== null");
  });

  it("「写真を取り消す」を置かない（撮り直し/選び直しの差し替えのみ許す）", () => {
    // 外して保存できると、廃止したはずの写真なしピンがこの画面から作れて
    // しまう（全てのピンが写真とセット = 2026-07-29 業務判断）。
    expect(MODAL_SRC).not.toContain("写真を取り消す");
    expect(MODAL_SRC).not.toContain("pin-create-photo-clear");
    expect(MODAL_SRC).toContain("写真（必須）");
  });
});

describe("3-d. タップ待ち中は既存マーカーがタップを奪わない（@codex #336 P2）", () => {
  it("タップ待ち中は物件/ピンの marker に onClick を渡さない（素通しで map click へ）", () => {
    // 撮影した家に既存 marker が乗っていると、家の上へのタップが marker に
    // 奪われて吹き出しが開き、唯一の作成経路である地図タップが永久に成立しない。
    // onClick を渡さなければ AdvancedMarker は clickable にならず、タップは
    // 地図まで落ちて実座標が使える。
    const matches = MAP_SRC.match(
      /onClick=\{\s*captureMapClick\s*\?\s*undefined\s*:/g,
    );
    expect(matches?.length).toBe(2); // 物件 marker + ピン marker
  });

  it("focusPin の強調マーカー (zIndex 1000) も同様に素通しにする", () => {
    // 完成待ち一覧の「地図で見る」で開いた地図で撮影した場合、前面の強調
    // マーカーが撮影した家を覆っていると、通常マーカー以上に確実にタップを
    // 奪う (@codex #336 P2 R3)。
    const matches = MAP_SRC.match(
      /onClick=\{\s*cameraFirstPhase === "awaiting-map-tap"\s*\?\s*undefined\s*:/g,
    );
    expect(matches?.length).toBe(1); // focusPin 強調マーカー
  });

  it("タップ待ち中は吹き出しを描かない（撮影した家を覆わない）", () => {
    // 総点検P3でレイヤー OFF 条件 (layers.properties / layers.pins) も加わった。
    // ここでは「!captureMapClick が条件に入っている」ことだけを表明する
    // (レイヤー条件の表明は field-survey-map-ui-source.test.ts 側)。
    expect(MAP_SRC).toMatch(
      /selected &&\s*\n\s*!captureMapClick &&\s*\n\s*layers\.properties &&\s*\n\s*selected\.kind === "property"/,
    );
    expect(MAP_SRC).toMatch(
      /selected &&\s*\n\s*!captureMapClick &&\s*\n\s*layers\.pins &&\s*\n\s*selected\.kind === "pin"/,
    );
  });

  it("タップで開いていた吹き出しを閉じてから作成へ進む（モーダル背後に残さない）", () => {
    const listener =
      MAP_SRC.match(/if \(!captureMapClick\) return;[\s\S]*?listener\.remove/)?.[0] ?? "";
    expect(listener).toContain("setSelected(null)");
  });
});

describe("3-c. タップ待ち中に巡回が終了しても詰まない（@codex #336 P2）", () => {
  it("quick_capture の無い利用者にはタップ時に巡回開始を案内する", () => {
    // 保存が必ず 403 になる状態でモーダルを開かせない。写真は保持したまま。
    const handler =
      MAP_SRC.match(/const handleMapClick = useCallback\([\s\S]*?\n  \);/)?.[0] ?? "";
    expect(handler).toContain("!activeSession && !canQuickCapture");
    expect(handler).toContain("巡回を開始");
  });

  it("モーダル表示中に巡回が終了した場合は POST の前に直し方つきで止める", () => {
    // 12h放置確認/24h自動終了・別端末からの終了でモーダル中に session が
    // 消える経路が残る。サーバの「権限がありません」では直し方が分からない。
    const submit =
      MAP_SRC.match(/const handlePinCreateSubmit = useCallback\([\s\S]*?\n  \);/)?.[0] ?? "";
    expect(submit).toContain("!activeSession?.id && !canQuickCapture");
    expect(submit).toContain("setClientCreateError(");
    expect(submit).toContain("地図で置き直す");
    // client 側の理由はモーダルの serverError と同じ場所に出す
    expect(MAP_SRC).toContain("serverError={clientCreateError ?? pinMutations.createError}");
  });
});

describe("4. 巡回が切り替わっても撮った写真を失わない", () => {
  it("タップ待ちの間は巡回の終了で後始末しない", () => {
    // ⚠タップ必須になって待ち時間が「GPS 数秒」から「家を探してタップ
    // するまで数十秒」へ伸びた。この間に巡回終了/切替が挟まると、
    // 従来の後始末では撮った写真が無言で消える。
    const h =
      MAP_SRC.match(
        /const handleActiveSessionChange = useCallback\([\s\S]*?\n  \);/,
      )?.[0] ?? "";
    expect(h).toMatch(/cameraFirstPhaseRef\.current !== "awaiting-map-tap"/);
  });
});

describe("5. ピン追加モードを廃止した", () => {
  it("モードの状態も切替も残っていない", () => {
    expect(MAP_SRC).not.toMatch(/pinAddMode|setPinAddMode|PinAddModeToggle/);
  });

  it("スマホの折りたたみボタンから「・ピン追加」が消えている", () => {
    expect(MAP_SRC).not.toMatch(/・ピン追加/);
  });
});

describe("6. GPS 精度の警告をピン作成から外した", () => {
  it("作成モーダルに精度表示・低精度警告が無い", () => {
    expect(MODAL_SRC).not.toMatch(/pin-create-accuracy/);
    expect(MODAL_SRC).not.toMatch(/pin-create-low-accuracy-warning/);
  });

  it("位置記録側の現在地表示は残す（別用途なので消さない）", () => {
    const status = read("src/components/field-survey/current-location-status.tsx");
    expect(status).toMatch(/field-survey-current-location-util/);
  });
});

describe("7. 継続して守ること", () => {
  it("座標を console に出さない", () => {
    expect(BANNER_SRC).not.toMatch(/console\./);
    expect(LIB_SRC).not.toMatch(/console\./);
  });

  it("権限が無ければ撮影ボタンを押せない（判定不能は API へ委譲）", () => {
    expect(LIB_SRC).toMatch(/input\.canWrite === false/);
  });

  it("タップ待ちの間はカメラボタンを出さない（二重起動防止）", () => {
    expect(LIB_SRC).toMatch(/input\.phase !== "awaiting-map-tap"/);
  });
});
