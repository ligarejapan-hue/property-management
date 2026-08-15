/**
 * 地番を人が確認して入れるポップアップ（設計 §3.2 / §3.3 / §4.1 / §4.3）。
 *
 * jsdom が無いので、純関数は直接呼び、画面はソース走査で固定する
 * （このリポの UI テストの主流。registry-location-search-button.test.ts と同型）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("ボタンの飛び先=ログイン画面（A案・発注者判断 2026-08-15）", () => {
  // 実機で「地図は登記情報提供サービスの中からしか開けない」と判明したため、
  // ボタンは**ログイン画面**を開く(ブラウザの保存パスワードで1タップ)。
  // ⚠資格情報は絶対に画面側へ配らない(自動ログインは作らない=発注者に説明済み)。
  it("飛び先の正は**サーバの実効値**(preflightで受け取る)。既定値はフォールバックのみ", () => {
    // ⚠既定値の直書きだけだと、本番が REGISTRY_FETCH_BASE_URL/LOGIN_PATH で
    //   URLを差し替えたとき(サイト改修時の即応用)に**画面だけ古いURLへ飛ぶ**
    //   (@codex #381 P2)。サーバが計算した実効値を優先し、届く前・失敗時だけ
    //   既定値へフォールバックする。
    expect(src).toMatch(/registryLoginUrl \?\? REGISTRY_SERVICE_LOGIN_URL/);
  });

  it("フォールバックの既定値は自動操作の既定値と一致(両ファイル読み合わせ)", () => {
    const auto = readFileSync(
      join(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
      "utf8",
    );
    const base = auto.match(
      /DEFAULT_REGISTRY_BASE_URL = "([^"]+)"/,
    )?.[1];
    const path = auto.match(
      /DEFAULT_REGISTRY_LOGIN_PATH = "([^"]+)"/,
    )?.[1];
    expect(base).toBeTruthy();
    expect(path).toBeTruthy();
    expect(src).toContain(`"${base}${path}"`);
  });

  it("サーバの実効値が preflight 経由で配線されている(route→hook→button→popup)", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/registry-fetch/preflight/route.ts"),
      "utf8",
    );
    // ⚠public 専用ヘルパー(R2: 自動操作用の BASE_URL は内部を指し得るため配らない)。
    expect(route).toMatch(/registryLoginUrl: publicRegistryLoginUrl\(\)/);
    expect(route).not.toMatch(/effectiveRegistryLoginUrl/);
    const shared = readFileSync(
      join(
        process.cwd(),
        "src/components/properties/registry-preflight-warnings.tsx",
      ),
      "utf8",
    );
    expect(shared).toMatch(/loginUrl/);
    expect(LOC).toMatch(/registryLoginUrl=\{preflight\.loginUrl\}/);
  });

  it("⚠旧・地図への直リンクを残さない(単独では開けないと実証済み)", () => {
    expect(src).not.toContain("minji-houmu");
    expect(src).not.toContain("chibanMapUrl");
    expect(src).not.toContain("#18/");
  });

  it("⚠座標を受け取らない(外部に何も渡さないことを構造で担保)", () => {
    // 旧実装は座標からURLを組み立てて渡していた。ログイン画面には何も要らない。
    expect(src).not.toMatch(/gpsLat|gpsLng/);
  });
});

describe("外部へ渡すことの扱い（設計 §3.2）", () => {
  it("⚠rel=noopener noreferrer（物件詳細のURLを外部へ渡さない）", () => {
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).toContain('target="_blank"');
  });

  it("⚠位置を渡す説明を残さない(もう渡していない)・「送信されない」の断定もしない", () => {
    expect(src).not.toContain("地図サービスへ渡して開きます");
    expect(src).not.toContain("送信されません");
    expect(src).not.toContain("送信されない");
  });

  it("⚠中心の地番を写さないよう「該当の筆をクリック」と書く", () => {
    // 座標は建物の位置であって筆の代表点ではない。
    expect(src).toContain("該当の筆をクリック");
  });
});

describe("⚠地図はサービスの中からしか開けない（2026-08-15 実機で判明・A案）", () => {
  // 発注者のiPhoneで旧ボタン(地図への直リンク)を押したところ、地図ではなく
  //   「現在サービスを利用できません。再度登記情報提供サービスの不動産請求画面から
  //    利用を開始してください。」
  // が出た。＝ボタンはログイン画面を開き、地図はサービス内の「地番検索」から開く。
  it("ボタンがログイン画面を開くことと、その理由を画面に書く", () => {
    expect(src).toContain("ログイン画面");
    expect(src).toContain("中からしか開けません");
    expect(src).toContain("登記情報提供サービスを開く（別タブ）");
    expect(src).not.toContain("地番検索サービスを開く（無料・別タブ）");
  });

  it("⚠説明はリンクより前に置く（押してから気づく順にしない）", () => {
    const noticeIdx = src.indexOf("中からしか開けません");
    const linkIdx = src.indexOf("登記情報提供サービスを開く（別タブ）");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeLessThan(linkIdx);
  });

  it("⚠地図を開く入口は**サービス自身の「地番検索」**と書く（@codex #378 P2の維持）", () => {
    expect(src).toContain("その画面の「地番検索」から地図を開く");
    expect(src).not.toContain("このボタンで地図を開く");
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

// (旧「⚠座標は文字列で来る(@codex #373 R5 P2)」describe は A案で削除。
//  座標からURLを作る機能ごと無くなった=Decimal文字列の変換問題も消滅。)

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
