/**
 * 地番を人が確認して入れるポップアップ（設計 §3.2 / §3.3 / §4.1 / §4.3）。
 *
 * jsdom が無いので、純関数は直接呼び、画面はソース走査で固定する
 * （このリポの UI テストの主流。registry-location-search-button.test.ts と同型）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chibanMapUrl } from "@/components/properties/registry-chiban-popup";

const src = readFileSync(
  join(process.cwd(), "src/components/properties/registry-chiban-popup.tsx"),
  "utf8",
);

const LOC = readFileSync(
  join(
    process.cwd(),
    "src/components/properties/registry-location-search-button.tsx",
  ),
  "utf8",
);

// 物件詳細ページ（どの種別で「2つの道」を出すかを決めている側）。
const PAGE = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
);

describe("地図サービスのURL（設計 §3.2）", () => {
  it("座標があればその位置をズーム18で開く", () => {
    // ⚠18 は筆界と地番が見える倍率（#15 では筆界が出ない・実機で確認済み）。
    expect(chibanMapUrl(35.430368, 139.601094)).toBe(
      "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/#18/35.430368/139.601094",
    );
  });

  it("座標が無ければサービスのトップを開くだけ（住所は渡さない）", () => {
    const top = "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/";
    expect(chibanMapUrl(null, null)).toBe(top);
    expect(chibanMapUrl(35.4, null)).toBe(top);
    expect(chibanMapUrl(null, 139.6)).toBe(top);
    expect(chibanMapUrl(undefined, undefined)).toBe(top);
  });

  it("⚠本番の大半は座標が無い（668件中667件）ので、開けなくならないこと", () => {
    expect(chibanMapUrl(null, null)).toContain("chiban_search/map/");
  });
});

describe("外部へ渡すことの扱い（設計 §3.2）", () => {
  it("⚠rel=noopener noreferrer（物件詳細のURLを外部へ渡さない）", () => {
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).toContain('target="_blank"');
  });

  it("⚠位置を渡すことを画面に書く", () => {
    expect(src).toContain("地図サービスへ渡して開きます");
  });

  it("⚠「送信されない」とは書かない（フラグメントでも相手のJSが読む）", () => {
    expect(src).not.toContain("送信されません");
    expect(src).not.toContain("送信されない");
  });

  it("⚠中心の地番を写さないよう「該当の筆をクリック」と書く", () => {
    // 座標は建物の位置であって筆の代表点ではない。
    expect(src).toContain("該当の筆をクリック");
  });
});

describe("⚠この地図は単独では開けない（2026-08-15 実機で判明）", () => {
  // 発注者のiPhoneで「地番検索サービスを開く」を押したところ、地図ではなく
  //   「現在サービスを利用できません。再度登記情報提供サービスの不動産請求画面から
  //    利用を開始してください。」
  // が出た（座標を持つ唯一の物件=世田谷区若林2-18-3。座標の有無ではなくセッションの問題）。
  // ＝この地図は登記情報提供サービスにログインし、不動産請求画面から起動しないと使えない。
  // ボタンは残す（住所のコピーと地番の入力欄が同じ場所にある利点があるため）が、
  // **前提を書かないと「壊れている」と読まれる**。
  it("ログインと不動産請求画面からの起動が前提だと画面に書く", () => {
    expect(src).toContain("先に登記情報提供サービスへログインしてください");
    expect(src).toContain("不動産請求画面");
    expect(src).toContain("単独では開けません");
  });

  it("⚠前提はリンクより前に置く（押してから気づく順にしない）", () => {
    const noticeIdx = src.indexOf("先に登記情報提供サービスへログインしてください");
    const linkIdx = src.indexOf("地番検索サービスを開く（無料・別タブ）");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeLessThan(linkIdx);
  });

  it("⚠手順にログインの段を含める（住所検索から始まる書き方にしない）", () => {
    // ⚠`indexOf` はファイル冒頭のドキュメントコメントに当たる（同じ語がそこにもある）。
    //   手順の文は画面の下の方にあるので `lastIndexOf` で拾う。
    const clickIdx = src.lastIndexOf("該当の筆をクリック");
    expect(clickIdx).toBeGreaterThan(-1);
    const steps = src.slice(Math.max(0, clickIdx - 700), clickIdx);
    expect(steps).toMatch(/ログイン/);
  });
});

describe("費用の書き分け（設計 §3.2）", () => {
  it("この画面では課金されないこと・課金は次の取得であることを書く", () => {
    expect(src).toContain("この画面の操作では課金されません");
    expect(src).toContain("課金は次の取得のとき");
  });
});

describe("保存（設計 §4.1）", () => {
  it("保存するのは lotNumber だけ", () => {
    expect(src).toContain("lotNumber: value.trim()");
  });

  it("⚠家屋番号を保存する口を作らない（地図が返すのは地番）", () => {
    expect(src).not.toMatch(/buildingNumber:\s*value/);
    expect(src).not.toMatch(/body:[\s\S]{0,200}buildingNumber/);
  });

  it("version を必ず同梱する（更新スキーマの必須項目）", () => {
    expect(src).toContain("version: propertyVersion");
  });

  it("⚠保存しただけでは検索APIを呼ばない（料金の確認を必ず経由する）", () => {
    expect(src).not.toContain("/registry/search");
    expect(src).toContain("onSaved(nextVersion)");
  });

  it("⚠保存後の版番号を持ち帰る（@codex #373 R10 P2）", () => {
    // 物件の取り直しを待たずに流れを続けるため。取り直すと詳細ページが
    // 読み込み中に切り替わり、この画面ごと作り直されて流れが消える。
    expect(src).toContain("saved?.version");
  });

  it("409 は「開き直してください」と案内する（最新versionは返らない）", () => {
    expect(src).toContain("VERSION_CONFLICT");
    expect(src).toContain("開き直して");
  });
});

describe("入力の検査（設計 §4.3）", () => {
  it("⚠同じ判定関数を使う（画面独自の正規表現を書かない）", () => {
    expect(src).toContain("isReadableChiban");
    expect(src).not.toMatch(/new RegExp\(/);
  });

  it("読めない形のあいだは保存ボタンを押せない", () => {
    expect(src).toContain("const canSave = canWriteProperty && readable && !saving");
  });
});

describe("権限（設計 §4.1）", () => {
  it("地番を保存できない利用者には入力欄を出さず案内する", () => {
    expect(src).toContain("canWriteProperty");
    expect(src).toContain("地番の編集権限");
  });
});

describe("建物のとき（設計 §3.3）", () => {
  it("2つの道を出す", () => {
    expect(src).toContain("建物の登記を取る");
    expect(src).toContain("土地の登記を取る");
  });

  it("⚠土地だと分かっている種別以外は2つの道から始める（@codex #373 R10 P2）", () => {
    // 駐車場・その他・不明は土地とも建物とも決まっていない。地番の入力へ直行させると
    // 「建物の謄本が欲しかった」人が、家屋番号の要ることを知らないまま行き止まる。
    expect(src).toContain('offerBuildingPath ? "choose" : "land"');
    expect(PAGE).toContain(
      "offerBuildingPath={!isLandPropertyType(property.propertyType)}",
    );
  });

  it("⚠建物の側は案内だけ（家屋番号は地図では分からない）", () => {
    expect(src).toContain("地番検索サービスの地図では分かりません");
  });
});

describe("秘匿（設計 §5）", () => {
  it("入力した地番を console へ出さない", () => {
    expect(src).not.toMatch(/console\.\w+\(/);
  });
});

describe("導線への差し込み（設計 §3.1 / §4.1）", () => {
  it("番号が無いとき（kind === none）だけポップアップを出す", () => {
    expect(LOC).toContain('target?.kind === "none"');
    expect(LOC).toContain("RegistryChibanPopup");
  });

  it("⚠保存したら分類を取り直すだけ（検索を直接投げない）", () => {
    expect(LOC).toMatch(
      /onSaved=\{\(nextVersion\) => \{[\s\S]{0,600}?setPreflightReload/,
    );
    expect(LOC).not.toMatch(
      /onSaved=\{\(nextVersion\) => \{[\s\S]{0,600}?runSearch\(\)/,
    );
  });

  it("⚠保存の直後に親を取り直さない（流れが消える・@codex #373 R10 P2）", () => {
    // 親（物件詳細ページ）の再取得は画面全体を読み込み中に差し替えるので、
    // このボタンごと作り直され、約束した料金の確認パネルへ進めない。
    expect(LOC).not.toMatch(
      /onSaved=\{\(nextVersion\) => \{[\s\S]{0,600}?onPropertyRefresh\(\)/,
    );
    // 代わりに溜めておき、流れを閉じるとき（reset）に流す。
    expect(LOC).toContain("propertyRefreshPendingRef");
    expect(LOC).toMatch(
      /const reset = \(\) => \{[\s\S]{0,800}?onPropertyRefresh\(\)/,
    );
  });

  it("⚠保存後は持ち帰った版番号で保存する（2回目が必ず409にならない）", () => {
    expect(LOC).toContain("propertyVersion={savedVersion ?? propertyVersion}");
  });

  it("番号があるときは従来どおり確認パネルを出す", () => {
    expect(LOC).toContain('target?.kind !== "none"');
    expect(LOC).toContain("所在で謄本候補を検索しますか？");
  });
});

describe("⚠不動産番号を持つ物件では出さない（設計 §3.1）", () => {
  it("ポップアップは kind === none のときだけ（number では出ない）", () => {
    // 出してしまうと、利用者は外部の地図で地番を調べて保存したのに、
    // 検索は結局「番号があります」と返す＝要らない地番が物件に残るだけになる。
    expect(LOC).toContain('target?.kind === "none"');
    expect(LOC).not.toContain('target?.kind === "number"');
  });

  it("分類に不動産番号を渡している（preflight）", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/registry-fetch/preflight/route.ts"),
      "utf8",
    );
    expect(route).toContain("realEstateNumber: p.realEstateNumber");
  });

  it("番号ありのときは「所在検索の対象外」と案内する", () => {
    const shared = readFileSync(
      join(
        process.cwd(),
        "src/components/properties/registry-preflight-warnings.tsx",
      ),
      "utf8",
    );
    expect(shared).toContain("所在検索の対象外です");
    // ⚠番号での取得は実サイトに触れる前に止まる（段階②が未実装）ので、
    //   「通常の自動取得をどうぞ」と**必ず失敗する経路へ誘導しない**。
    expect(shared).toContain("この経路では取得できません");
    expect(shared).not.toContain("通常の「謄本を自動取得」をご利用ください");
  });
});

describe("⚠必ず弾かれる分類では実行の導線を出さない（@codex #373 R4 P2）", () => {
  it("検索ボタンは土地・建物のときだけ描く", () => {
    expect(LOC).toContain("isSearchableTarget(target.kind)");
  });

  it("分類がまだ読めていない間は、出したうえで押せなくする（fail closed）", () => {
    expect(LOC).toContain(
      "disabled={preflight.pending || preflight.targetsUnavailable}",
    );
  });

  it("住所が無い物件には地番ではなく住所を入れてもらう", () => {
    const shared = readFileSync(
      join(
        process.cwd(),
        "src/components/properties/registry-preflight-warnings.tsx",
      ),
      "utf8",
    );
    expect(shared).toContain("住所が未入力です");
  });
});

describe("⚠座標は文字列で来る（@codex #373 R5 P2）", () => {
  it("Decimal 由来の文字列でも地図をその位置で開く", () => {
    // DBの緯度経度は Prisma の Decimal で、物件詳細APIはそのまま返すため
    // JSON 上は string。number だけ受け付けると**本番の全物件でトップページ**しか
    // 開かず、地図が現地に寄らない。
    expect(chibanMapUrl("35.430368", "139.601094")).toBe(
      "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/#18/35.430368/139.601094",
    );
  });

  it("数値と文字列が混ざっても開ける", () => {
    expect(chibanMapUrl(35.430368, "139.601094")).toContain("#18/");
  });

  it("数値にできない文字列はトップを開く（壊れた座標で誤誘導しない）", () => {
    const top = "https://minji-houmu.rmp.glbs.jp/view/chiban_search/map/";
    expect(chibanMapUrl("abc", "139.6")).toBe(top);
    expect(chibanMapUrl("", "")).toBe(top);
    expect(chibanMapUrl("NaN", "1")).toBe(top);
  });
});

describe("⚠一括は「何を買うか」を承認の前に見せる（@codex #373 R5 P1）", () => {
  const BULK = readFileSync(
    join(
      process.cwd(),
      "src/components/properties/registry-bulk-fetch-button.tsx",
    ),
    "utf8",
  );
  const SHARED = readFileSync(
    join(
      process.cwd(),
      "src/components/properties/registry-preflight-warnings.tsx",
    ),
    "utf8",
  );

  it("一括モーダルが取得内訳を描く", () => {
    // 一括は候補1件で自動購入するので、見せないと
    // 「土地のつもりで建物の謄本を買った」が起きる。
    expect(BULK).toContain("<RegistryTargetSummary state={preflight} />");
  });

  it("種別と食い違う物件を件数と物件リンクで名指しする", () => {
    expect(SHARED).toContain("物件の種別と食い違うものがあります");
    expect(SHARED).toContain("/properties/${id}");
  });

  it("⚠出すのは物件IDの先頭だけ（住所・地番は出さない）", () => {
    expect(SHARED).toContain("id.slice(0, 8)");
  });

  it("食い違いは見せるだけで止めない（発注者判断）", () => {
    expect(SHARED).not.toMatch(/mismatchWarning[\s\S]{0,120}disabled/);
  });
});
