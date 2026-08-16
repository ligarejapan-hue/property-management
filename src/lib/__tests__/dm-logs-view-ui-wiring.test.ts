/**
 * DM送付履歴の表示強化(PR-A・設計書§2.6)の配線。
 *  - GET が dmType/sequence(表示時導出の何通目)を返す
 *  - view は日本語ラベル(dmMethodLabel/dmTypeLabel)を使い生値の英字を出さない
 *  - 個別記録の追加フォーム・取消ボタン(sale_dm 行は出さない)・write 権限ゲート
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTE = read("src/app/api/properties/[id]/dm-logs/route.ts");
const VIEW = read("src/components/properties/dm-logs-view.tsx");

describe("GET /dm-logs: 何通目の表示時導出(§2.2・R26)", () => {
  it("sentAt,createdAt,id の昇順全件から連番 Map を作り data に載せる", () => {
    expect(ROUTE).toMatch(
      /orderBy: \[\{ sentAt: "asc" \}, \{ createdAt: "asc" \}, \{ id: "asc" \}\]/,
    );
    expect(ROUTE).toMatch(/sequenceById = new Map\(allIdsAsc\.map\(\(row, i\) => \[row\.id, i \+ 1\]\)\)/);
    expect(ROUTE).toMatch(/sequence: sequenceById\.get\(log\.id\)/);
    expect(ROUTE).toMatch(/dmType: log\.dmType/);
  });

  it("sequence 列(採番)は使わない", () => {
    expect(ROUTE).not.toMatch(/sequence:\s*\{\s*increment/);
    expect(ROUTE).not.toMatch(/MAX\(sequence\)/i);
  });
});

describe("dm-logs-view: 表示強化と個別記録UI", () => {
  it("method/dmType は日本語ラベル関数を通す(生値の英字を出さない)", () => {
    expect(VIEW).toMatch(/dmMethodLabel\(log\.method\)/);
    expect(VIEW).toMatch(/dmTypeLabel\(log\.dmType\)/);
    expect(VIEW).not.toMatch(/\{log\.method \?\?/);
  });

  it("「何通目」「種別」列がある", () => {
    expect(VIEW).toContain("何通目");
    expect(VIEW).toContain("種別");
    expect(VIEW).toMatch(/\$\{log\.sequence\}通目/);
  });

  it("追加/取消は api-client 経由+property:write ゲート", () => {
    expect(VIEW).toMatch(/createPropertyDmLog\(propertyId,/);
    expect(VIEW).toMatch(/deletePropertyDmLog\(propertyId, logId\)/);
    expect(VIEW).toMatch(/action === "write" && p\.granted/);
    expect(VIEW).toMatch(/\{canWrite && \(/);
  });

  it("ページ最後の1件を取り消したら前のページへ戻る(#364 R4)", () => {
    expect(VIEW).toMatch(/logs\.length === 1 && page > 1/);
    expect(VIEW).toMatch(/setPage\(\(p\) => Math\.max\(1, p - 1\)\)/);
  });

  it("取消は confirm を挟み、取消不可の行(売却DM/一括確定由来)にはボタンを出さない", () => {
    expect(VIEW).toContain("この送付記録を取り消しますか？");
    expect(VIEW).toMatch(/\{log\.deletable && \(/);
    // 取消可否の判定はサーバ側(GET が deletable を返す)
    expect(ROUTE).toContain('log.method !== "sale_dm"');
    expect(ROUTE).toContain("log.batchId == null");
    // 拒否付きの取消は管理者のみ(発注者指示 2026-08-17)。DELETE 側の 403 と対で、
    // deletable の計算にも同じ条件を織り込む(押しても必ず失敗するボタンを出さない)。
    // 退避(shadow)された拒否も守るため isRefusalProtected に一本化(@codex #385 R2 P1)。
    expect(ROUTE).toContain("!isRefusalProtected(log) || session.role === \"admin\"");
    // UI施錠用に refusalLocked も返す(見えている status だけでは旧データを守れない)。
    expect(ROUTE).toContain("refusalLocked: isRefusalProtected(log)");
  });

  it("投函日は今日既定・max=今日(未来はUIでも選べない)", () => {
    expect(VIEW).toMatch(/useState\(todayJst\(\)\)/);
    expect(VIEW).toMatch(/max=\{todayJst\(\)\}/);
  });
});

describe("dm-logs-view: 反響の表示と入力(PR-B・設計§3)", () => {
  it("GET が反響4項目を返し view の型に載っている", () => {
    expect(ROUTE).toMatch(/reactionStatus: log\.reactionStatus/);
    expect(ROUTE).toMatch(/reactionSource: log\.reactionSource/);
    // reactionNote は note と同じ表示レベルでマスク
    expect(ROUTE).toMatch(
      /reactionNote: maskValue\(log\.reactionNote, ownerDisplayConfig\.note\)/,
    );
    expect(VIEW).toMatch(/reactionStatus: string/);
  });

  it("「反響」列があり REACTION_LABELS の日本語ラベルで表示(生値の英字を出さない)", () => {
    expect(VIEW).toContain("反響");
    expect(VIEW).toMatch(/REACTION_LABELS/);
  });

  it("編集は api-client(updatePropertyDmLogReaction)経由+canWrite ゲート", () => {
    expect(VIEW).toMatch(/updatePropertyDmLogReaction\(propertyId,/);
  });

  it("売却DM由来(ブリッジ行)も編集可・同期由来は(自動)表示", () => {
    // 反響編集ボタンは log.deletable でなく canWrite で出す(サーバが優先規則で解決)
    expect(VIEW).toMatch(/sale_dm_sync/);
    expect(VIEW).toContain("(自動)");
  });

  it("宛先不明の影響を平易な日本語で説明している", () => {
    expect(VIEW).toContain("宛先不明");
    expect(VIEW).toMatch(/対象から外/);
  });
});

describe("dm-logs-view: メモのマスク往復防止(#366 R2/R3)", () => {
  it("メモは空で開始+「メモを消す」明示チェック(note: null 送信)", () => {
    // マスク表示値をフォームに流し込まない(実メモをマスク値で潰さない)
    expect(VIEW).not.toMatch(/useState\(log\.reactionNote/);
    expect(VIEW).toContain("メモを消す");
    // #367 P2 で noteFields へ切り出した際に型注釈が付いた(送る値は null のまま)
    expect(VIEW).toMatch(/\{ note: null as string \| null \}/);
  });
});

describe("dm-logs-view: 反響メモのフィールドレベル権限(#366 R10)", () => {
  it("owner_note の edit/full が無いユーザーにはメモ入力を出さない(サーバも403)", () => {
    expect(VIEW).toMatch(/owner_note/);
    expect(VIEW).toMatch(/canWriteNote/);
    expect(VIEW).toMatch(/\{canWriteNote && \(/);
  });
});

describe("dm-logs-view: 権限が画面滞在中に変わった場合(#367 P2)", () => {
  it("開いたままの追加フォーム・反響エディタは権限剥奪で隠れる(送信できない)", () => {
    // 復帰時の再検証で権限が変わり得るため、開いていたUIが残ると押せて403になる。
    // effect で state を消すのではなく描画条件を権限から導出する(eslint規約+取りこぼし防止)。
    expect(VIEW).toMatch(/const formOpen = canWrite && showForm;/);
    expect(VIEW).toMatch(/const editingLogId = canWrite \? editingReactionId : null;/);
    expect(VIEW).toMatch(/\{formOpen && \(/);
    expect(VIEW).toMatch(/\{editingLogId === log\.id \? \(/);
    // 生の state を描画条件に直接使わない(導出を迂回しない)
    expect(VIEW).not.toMatch(/\{showForm && \(/);
    expect(VIEW).not.toMatch(/\{editingReactionId === log\.id \? \(/);
  });

  it("メモ権限が編集中に外れたらメモを送らない(反響本体の保存を巻き添えにしない)", () => {
    expect(VIEW).toMatch(/const noteFields = !canWriteNote/);
    expect(VIEW).toMatch(/\.\.\.noteFields,/);
  });
});

// 「拒否」の二段確認と管理者施錠(発注者指示 2026-08-17)。
describe("拒否の確認ボタンと管理者ロック(UI配線)", () => {
  it("拒否への変更は1回目=予告のみ・2回目で保存(2回押しの作法)", () => {
    expect(VIEW).toContain("refusalArmed");
    // 予告文: 影響(全DMから外れる・戻せるのは管理者)を先に伝える。
    expect(VIEW).toContain("宛名CSV・売却DMの両方から自動で外れます");
    expect(VIEW).toContain("取り消し・変更は管理者のみになります");
    // 1回目の押下では onSave せず予告を立てるだけ。
    expect(VIEW).toMatch(/status === "refused" && log\.reactionStatus !== "refused" && !refusalArmed/);
    expect(VIEW).toContain("拒否として保存（確定）");
    // 種別を変えたら予告は解除(別種別で確定される事故を防ぐ)。
    expect(VIEW).toContain("setRefusalArmed(false)");
  });

  it("既に拒否の記録は、管理者以外は**種別だけ**固定(日付・メモ訂正は許す=@codex #385 ③)", () => {
    // 当初はフォーム全体を早期returnで塞いだが、サーバは status:"refused" のままの
    // 日付・メモ訂正を意図的に許している=塞ぎすぎだった。selectのみ disabled。
    // サーバ計算の refusalLocked(退避=shadow の拒否も含む)を正とする(@codex #385 R2 P1)。
    expect(VIEW).toMatch(/log\.refusalLocked \?\? log\.reactionStatus === "refused"/);
    expect(VIEW).toContain("disabled={refusedLocked}");
    expect(VIEW).toContain("日付・メモは訂正できます。別の反響への変更・取消は管理者のみです");
    // isAdmin は useSession の role 由来(F12 permissions 配列に role は無い)。
    expect(VIEW).toContain('useSession');
    expect(VIEW).toMatch(/role === "admin"/);
  });

  it("孤児DM訂正の編集フォームにも同じ二段確認と種別固定がある(@codex #385 ④)", () => {
    const ORPHAN = read("src/app/(dashboard)/admin/orphan-dm-logs/page.tsx");
    expect(ORPHAN).toContain("refusalArmed");
    expect(ORPHAN).toContain("拒否として保存（確定）");
    expect(ORPHAN).toContain("disabled={refusedLocked}");
    // 取消ボタンだけを隠す(訂正ボタンは出す=許可された訂正を塞がない)。
    expect(ORPHAN).toContain("取消は管理者のみ");
  });
});
