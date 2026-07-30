/**
 * 表示レベル（オーナー情報を誰にどこまで見せるか）を「項目ごとに1つだけ」に揃える。
 *
 * 【何が壊れていたか】表示レベルは resource ごとに 1 つ効く設計なのに、保存は
 * resource × action の行を足し引きするだけで**複数を同時に granted にできた**。
 * 解決側は**最も緩いものを採用**するため、
 *   ① テンプレートで「マスク」を付けても「全表示」の行が残っていると生値が出続ける
 *   ② 個別上書きで「マスク」を指定しても、テンプレート側の「全表示」が勝って**効かない**
 * ②は「この人だけ電話番号を伏せる」が黙って無効になる＝実害が大きい。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DISPLAY_LEVELS,
  DISPLAY_LEVEL_LABELS,
  effectiveDisplayLevel,
  findDisplayLevelConflicts,
  describeDisplayLevelConflicts,
  withExclusiveDisplayLevel,
  isDisplayLevelResource,
  isDisplayLevelAction,
} from "@/lib/permission-display-levels";

const row = (resource: string, action: string, granted = true) => ({
  resource,
  action,
  granted,
});

describe("効いているレベルの判定", () => {
  it("緩い順に並んでいる（解決側 resolveLevel と同じ順）", () => {
    expect([...DISPLAY_LEVELS]).toEqual([
      "edit",
      "full",
      "read",
      "partial",
      "masked",
      "hidden",
    ]);
  });

  it("複数あるときは最も緩いものが効く", () => {
    expect(effectiveDisplayLevel(["masked", "full"])).toBe("full");
    expect(effectiveDisplayLevel(["hidden", "masked"])).toBe("masked");
    expect(effectiveDisplayLevel(["full", "edit"])).toBe("edit");
  });

  it("1つも無ければ null（未設定）", () => {
    expect(effectiveDisplayLevel([])).toBe(null);
    expect(effectiveDisplayLevel(["write"])).toBe(null);
  });

  it("オーナー自体の read/write/delete は表示レベルではない", () => {
    expect(isDisplayLevelResource("owner")).toBe(false);
    expect(isDisplayLevelResource("owner_phone")).toBe(true);
    expect(isDisplayLevelAction("write")).toBe(false);
    expect(isDisplayLevelAction("read")).toBe(true);
  });
});

describe("重複の検出（保存前の検証に使う）", () => {
  it("同じ項目に2つ以上あれば重複として挙げ、効いている方も返す", () => {
    const conflicts = findDisplayLevelConflicts([
      row("owner_phone", "masked"),
      row("owner_phone", "full"),
      row("owner_name", "full"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resource).toBe("owner_phone");
    expect(conflicts[0].granted).toEqual(["full", "masked"]);
    expect(conflicts[0].effective).toBe("full");
  });

  it("granted:false は数えない（「このレベルを外す」指定は重複ではない）", () => {
    expect(
      findDisplayLevelConflicts([
        row("owner_phone", "full", false),
        row("owner_phone", "masked"),
      ]),
    ).toEqual([]);
  });

  it("表示レベル以外は対象外（property:read と write は同時に持てる）", () => {
    expect(
      findDisplayLevelConflicts([row("property", "read"), row("property", "write")]),
    ).toEqual([]);
  });

  it("エラー文は日本語のラベルで出す（生の識別子を見せない）", () => {
    const text = describeDisplayLevelConflicts(
      findDisplayLevelConflicts([
        row("owner_phone", "masked"),
        row("owner_phone", "full"),
      ]),
    );
    expect(text).toBe("オーナー電話番号: 全表示・マスク");
    expect(text).not.toContain("owner_phone");
  });
});

describe("画面の選択操作（1つ選ぶと他は外れる）", () => {
  const make = (resource: string, action: string) => row(resource, action);

  it("別のレベルを選ぶと前のレベルは外れる", () => {
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "full"), row("owner_name", "full")],
      "owner_phone",
      "masked",
      make,
    );
    expect(after.filter((r) => r.resource === "owner_phone")).toEqual([
      row("owner_phone", "masked"),
    ]);
    // 他の項目は巻き込まない
    expect(after).toContainEqual(row("owner_name", "full"));
  });

  it("選択済みをもう一度押すと解除される（未設定に戻る）", () => {
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "masked")],
      "owner_phone",
      "masked",
      make,
    );
    expect(after.filter((r) => r.resource === "owner_phone")).toEqual([]);
  });

  it("⚠拒否の指定を押すと未設定に戻る（その場で付与に化けない）", () => {
    // 化けると、テンプレのマスクを継いでいる人に古い『全表示=拒否』が残っている
    // 状態でその赤いボタンを押しただけで**マスクが外れて生値が見える**。
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "full", false)],
      "owner_phone",
      "full",
      make,
    );
    expect(after.filter((r) => r.resource === "owner_phone")).toEqual([]);
  });

  it("⚠拒否を消しても、同じ項目の有効な指定は巻き込まない", () => {
    // 個別に『マスク=付与』と『全表示=拒否』が並んでいるとき、拒否を消すつもりで
    // マスクの付与まで消えると、テンプレートの全表示に落ちて**生値が見える**。
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "masked"), row("owner_phone", "full", false)],
      "owner_phone",
      "full",
      make,
    );
    expect(after.filter((r) => r.resource === "owner_phone")).toEqual([
      row("owner_phone", "masked"),
    ]);
  });

  it("付与を解除するときも押した行だけ消す", () => {
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "masked"), row("owner_name", "full")],
      "owner_phone",
      "masked",
      make,
    );
    expect(after).toEqual([row("owner_name", "full")]);
  });

  it("別のレベルを選ぶと拒否の指定も一緒に片付く", () => {
    const after = withExclusiveDisplayLevel(
      [row("owner_phone", "full", false), row("owner_phone", "masked")],
      "owner_phone",
      "hidden",
      make,
    );
    expect(after.filter((r) => r.resource === "owner_phone")).toEqual([
      row("owner_phone", "hidden"),
    ]);
  });

  it("表示レベル以外でも拒否の指定を押すと未設定に戻る", () => {
    const after = withExclusiveDisplayLevel(
      [row("property", "write", false)],
      "property",
      "write",
      make,
    );
    expect(after).toEqual([]);
  });

  describe("テンプレート編集画面（拒否の概念が無い画面）", () => {
    const asTemplate = { deniedRowsAreVisible: false };

    it("拒否行は未選択に見えるので、押したら選択される", () => {
      // 設定済み扱いにすると、押しても選択されず見えない行が消えるだけ＝
      // 管理者には「何も起きない」ように見える。
      const after = withExclusiveDisplayLevel(
        [row("owner_phone", "full", false)],
        "owner_phone",
        "full",
        make,
        asTemplate,
      );
      expect(after).toEqual([row("owner_phone", "full")]);
    });

    it("表示レベル以外でも同じキーの行が二重にならない（保存時の一意制約）", () => {
      const after = withExclusiveDisplayLevel(
        [row("property", "write", false)],
        "property",
        "write",
        make,
        asTemplate,
      );
      expect(after).toEqual([row("property", "write")]);
    });

    it("選択済みを押せば従来どおり解除される", () => {
      const after = withExclusiveDisplayLevel(
        [row("owner_phone", "masked")],
        "owner_phone",
        "masked",
        make,
        asTemplate,
      );
      expect(after).toEqual([]);
    });
  });

  it("表示レベル以外は従来どおりの on/off（他を巻き込まない）", () => {
    const after = withExclusiveDisplayLevel(
      [row("property", "read")],
      "property",
      "write",
      make,
    );
    expect(after).toEqual([row("property", "read"), row("property", "write")]);
  });

  it("何を選んでも重複は生まれない", () => {
    let rows = [row("owner_zip", "hidden")];
    for (const level of ["masked", "full", "hidden", "masked"]) {
      rows = withExclusiveDisplayLevel(rows, "owner_zip", level, make);
    }
    expect(findDisplayLevelConflicts(rows)).toEqual([]);
  });
});

describe("選択操作の全組み合わせ（状態遷移の総当たり）", () => {
  // このロジックは3巡続けて「直した修正が次の穴を作る」ことが起きた箇所
  // （拒否が付与に化ける → 拒否の解除で兄弟の付与まで消える）。個別のケースを
  // 足すのではなく、**取り得る状態 × 押す場所**を全部作って不変条件で縛る。
  const LEVELS = ["full", "masked", "hidden"] as const;
  // 各レベルの状態: 行なし / 付与 / 拒否（同じキーで付与と拒否は同時に持てない）
  const STATES = ["absent", "granted", "denied"] as const;
  const make = (resource: string, action: string) => row(resource, action);

  const buildRows = (combo: readonly (typeof STATES)[number][]) =>
    LEVELS.flatMap((level, i) =>
      combo[i] === "absent" ? [] : [row("owner_phone", level, combo[i] === "granted")],
    );

  const allCombos: (typeof STATES)[number][][] = [];
  for (const a of STATES)
    for (const b of STATES) for (const c of STATES) allCombos.push([a, b, c]);

  const grantedLevels = (rows: readonly ReturnType<typeof row>[]) =>
    rows.filter((r) => r.resource === "owner_phone" && r.granted).map((r) => r.action);

  for (const deniedRowsAreVisible of [true, false]) {
    const modeName = deniedRowsAreVisible ? "個別権限画面" : "テンプレート編集画面";

    it(`${modeName}: 同じ指定が二重にならない / 押していないレベルを勝手に付与しない`, () => {
      for (const combo of allCombos) {
        for (const clicked of LEVELS) {
          const before = buildRows(combo);
          const after = withExclusiveDisplayLevel(
            before,
            "owner_phone",
            clicked,
            make,
            { deniedRowsAreVisible },
          );

          // 1) 同じ (項目, レベル) の行が二重に出ない（保存時の一意制約違反を防ぐ）
          const keys = after.map((r) => `${r.resource}:${r.action}`);
          expect(new Set(keys).size).toBe(keys.length);

          // 2) 押していないレベルを勝手に付与しない
          //    （拒否を押したら付与に化ける、という R2 の不具合を封じる）
          for (const level of grantedLevels(after)) {
            expect(
              level === clicked || grantedLevels(before).includes(level),
            ).toBe(true);
          }

          // 3) 元が正しい状態（付与は多くても1つ）なら、操作後も1つを超えない
          if (grantedLevels(before).length <= 1) {
            expect(grantedLevels(after).length).toBeLessThanOrEqual(1);
          }
        }
      }
    });

    it(`${modeName}: 解除は押した行だけを消す（兄弟の指定を巻き込まない）`, () => {
      // R3 の不具合。拒否を消すつもりで有効なマスクまで消えると、テンプレートの
      // 全表示に落ちて生値が見える。
      for (const combo of allCombos) {
        for (const clicked of LEVELS) {
          const before = buildRows(combo);
          const existing = before.find((r) => r.action === clicked);
          const isSet = deniedRowsAreVisible
            ? existing !== undefined
            : existing?.granted === true;
          if (!isSet) continue;

          const after = withExclusiveDisplayLevel(
            before,
            "owner_phone",
            clicked,
            make,
            { deniedRowsAreVisible },
          );
          expect(after).toEqual(before.filter((r) => r.action !== clicked));
        }
      }
    });

    it(`${modeName}: 選択すると、その1つだけが残る`, () => {
      for (const combo of allCombos) {
        for (const clicked of LEVELS) {
          const before = buildRows(combo);
          const existing = before.find((r) => r.action === clicked);
          const isSet = deniedRowsAreVisible
            ? existing !== undefined
            : existing?.granted === true;
          if (isSet) continue;

          const after = withExclusiveDisplayLevel(
            before,
            "owner_phone",
            clicked,
            make,
            { deniedRowsAreVisible },
          );
          expect(after.filter((r) => r.resource === "owner_phone")).toEqual([
            row("owner_phone", clicked),
          ]);
        }
      }
    });
  }

  it("他の項目は何をしても巻き込まれない", () => {
    const untouched = [row("owner_name", "full"), row("property", "read")];
    for (const combo of allCombos) {
      for (const clicked of LEVELS) {
        const after = withExclusiveDisplayLevel(
          [...untouched, ...buildRows(combo)],
          "owner_phone",
          clicked,
          make,
        );
        for (const keep of untouched) expect(after).toContainEqual(keep);
      }
    }
  });
});

describe("ラベル", () => {
  it("全レベルに日本語ラベルがある", () => {
    for (const level of DISPLAY_LEVELS) {
      expect(DISPLAY_LEVEL_LABELS[level]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const TEMPLATES_PAGE = "src/app/(dashboard)/admin/templates/[id]/page.tsx";
const USERS_PAGE = "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx";

describe("権限画面が実態を表現できる", () => {
  it("両方の画面が排他ロジックを使う（独自実装を持たない）", () => {
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      const src = read(page);
      expect(src).toContain("withExclusiveDisplayLevel(");
      expect(src).toContain(
        'from "@/lib/permission-display-levels"',
      );
    }
  });

  it("住所の「一部表示」を選べる（現地担当の既定なのに選択肢が無かった）", () => {
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      expect(read(page)).toContain(
        '{ key: "owner_address", label: "オーナー住所", actions: ["hidden", "masked", "partial", "full"] }',
      );
    }
  });

  it("備考は「閲覧のみ」と「編集可」を区別する（編集可だけがメモを書ける）", () => {
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      expect(read(page)).toContain(
        '{ key: "owner_note", label: "オーナー備考", actions: ["hidden", "masked", "read", "edit"] }',
      );
    }
  });

  it("法人番号の行がある（設定済みなのに画面に出ていなかった）", () => {
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      expect(read(page)).toContain('key: "owner_corporate_number"');
    }
  });

  it("一覧に無いレベルが保存されていても表示する（見えないまま上書きしない）", () => {
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      expect(read(page)).toContain("storedLevels");
    }
  });

  it("⚠拒否の指定も表示する（見えないと管理者が消せず、後で効き始める）", () => {
    // 一覧から外したレベル（例: 備考の「全表示」）に拒否が残っていると、画面に
    // 出ないのに保存時は往復し続け、テンプレートを変えた途端に効き始める。
    for (const page of [TEMPLATES_PAGE, USERS_PAGE]) {
      const src = read(page);
      const block = src.slice(
        src.indexOf("const storedLevels"),
        src.indexOf("const actions = ["),
      );
      expect(block).toContain("isDisplayLevelAction(p.action)");
      // granted で絞っていない＝拒否行も拾う
      expect(block).not.toContain("p.granted &&");
    }
  });
});

describe("保存API側でも弾く（画面を通さず呼ばれても崩れない）", () => {
  // 書き込み経路すべて。新規作成を漏らすと、一度整理しても同じ状態が再生産される。
  const ROUTES = [
    "src/app/api/admin/templates/route.ts", // 新規作成
    "src/app/api/admin/templates/[id]/route.ts", // 更新
    "src/app/api/admin/users/[id]/permissions/route.ts", // 個別上書き
  ];
  // 「全消し→作り直し」をする経路（新規作成は消さないので対象外）
  const REPLACE_ROUTES = ROUTES.slice(1);

  it("重複していれば 400 で保存を拒否する", () => {
    for (const route of ROUTES) {
      const src = read(route);
      expect(src).toContain("findDisplayLevelConflicts(");
      expect(src).toContain("表示レベルは項目ごとに1つだけ選べます");
      expect(src).toMatch(/ApiError\(\s*400/);
    }
  });

  it("検証は書き込みより先に行う（壊れた組み合わせを保存しない）", () => {
    for (const route of REPLACE_ROUTES) {
      const src = read(route);
      expect(src.indexOf("findDisplayLevelConflicts(")).toBeLessThan(
        src.indexOf("deleteMany"),
      );
    }
  });

  it("全消し→作り直しは同一トランザクション（失敗して権限が消えたままにならない）", () => {
    for (const route of REPLACE_ROUTES) {
      const src = read(route);
      expect(src).toContain("$transaction(async (tx) => {");
      // トランザクション外に素の deleteMany を残さない
      expect(src).not.toContain("await prisma.templatePermission.deleteMany");
      expect(src).not.toContain("await prisma.userPermission.deleteMany");
    }
  });
});

describe("既存データの整理（migration）", () => {
  const MIGRATION =
    "prisma/migrations/20260731000000_normalize_display_level_permissions/migration.sql";

  it("テンプレートと個別上書きの両方を整理する", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('DELETE FROM "template_permissions"');
    expect(sql).toContain('DELETE FROM "user_permissions"');
  });

  it("残すのは「いま効いているレベル」＝緩い順の1位（機能低下を起こさない）", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("WHEN 'edit' THEN 1");
    expect(sql).toContain("WHEN 'full' THEN 2");
    expect(sql).toContain("WHEN 'hidden' THEN 6");
    expect(sql).toContain("WHERE rn > 1");
  });

  it("granted:false（レベルを外す指定）は触らない", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('tp."granted"');
    expect(sql).toContain('up."granted"');
  });

  it("⚠拒否上書きがある項目はテンプレ側を整理しない（落ちる先を消さない）", () => {
    // 消そうとしている下位レベルは「上位を外す」個別指定の受け皿になっていることが
    // ある。消すと落ちる先が無くなり hidden まで下がる＝その人だけ見えなくなる。
    const sql = read(MIGRATION);
    expect(sql).toContain("denied_pairs");
    expect(sql).toContain('NOT up."granted"');
    expect(sql).toContain("NOT EXISTS");
  });

  it("⚠ガードは当人が受け取るテンプレートに限る（無関係なテンプレの重複まで残さない）", () => {
    // resource だけで止めると、現地担当の1人の拒否で管理者用テンプレの重複まで
    // 残り、本来直したい「緩い方が出続ける」状態が解消されない。
    const sql = read(MIGRATION);
    expect(sql).toContain('d."template_id" = r."template_id"');
    // 利用者→テンプレートは role 名で解決する（getUserPermissions と同じ対応）
    expect(sql).toContain("WHEN 'field_staff' THEN '現地担当用'");
    expect(sql).toContain("WHEN 'office_staff' THEN '事務担当用'");
    expect(sql).toContain("WHEN 'admin' THEN '管理者用'");
    expect(sql).toContain("ELSE '現地担当用'");
  });

  it("表示レベルの8項目に限定し、オーナー自体の read/write は含めない", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("'owner_corporate_number'");
    // resource リストに 'owner' 単体が入っていない（入ると owner:read を消しかねない）
    expect(sql).not.toMatch(/IN \(\s*'owner',/);
  });

  it("DDL を含まない", () => {
    expect(read(MIGRATION)).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP TABLE/i);
  });
});

// ---------------------------------------------------------------------------

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-sheet/render-gate", () => ({
  RenderBusyError: class extends Error {},
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
    permissionTemplate: { findUnique: vi.fn() },
    userPermission: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";

const pm = prisma as unknown as {
  user: { findUnique: Mock };
  permissionTemplate: { findUnique: Mock };
  userPermission: { findMany: Mock };
};

describe("テンプレートと個別上書きの合成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pm.user.findUnique.mockResolvedValue({ role: "field_staff" });
  });

  const setup = (
    templateRows: Array<{ resource: string; action: string; granted: boolean }>,
    overrideRows: Array<{ resource: string; action: string; granted: boolean }>,
  ) => {
    pm.permissionTemplate.findUnique.mockResolvedValue({
      templatePermissions: templateRows,
    });
    pm.userPermission.findMany.mockResolvedValue(overrideRows);
  };

  it("⚠この人だけマスクにする指定が実際に効く（テンプレの全表示に勝つ）", async () => {
    setup([row("owner_phone", "full")], [row("owner_phone", "masked")]);
    const config = await getOwnerDisplayConfig("u1");
    expect(config.phone).toBe("masked");
  });

  it("個別指定が無ければテンプレートどおり", async () => {
    setup([row("owner_phone", "full")], []);
    expect((await getOwnerDisplayConfig("u1")).phone).toBe("full");
  });

  it("個別指定は同じ項目のテンプレ側レベルだけを外す（別項目は無傷）", async () => {
    setup(
      [row("owner_phone", "full"), row("owner_name", "full")],
      [row("owner_phone", "hidden")],
    );
    const config = await getOwnerDisplayConfig("u1");
    expect(config.phone).toBe("hidden");
    expect(config.name).toBe("full");
  });

  it("表示レベル以外の権限は従来どおり合成される", async () => {
    setup(
      [row("property", "read"), row("property", "write")],
      [row("property", "write", false)],
    );
    const perms = await getUserPermissions("u1");
    expect(perms).toContainEqual(row("property", "read"));
    expect(perms).toContainEqual(row("property", "write", false));
  });

  it("「このレベルを外す」だけの拒否上書きはテンプレの他レベルを消さない", async () => {
    // 全表示を外したら、テンプレに残るマスクに落ちる（hidden まで落ちない）。
    setup(
      [row("owner_phone", "full"), row("owner_phone", "masked")],
      [row("owner_phone", "full", false)],
    );
    expect((await getOwnerDisplayConfig("u1")).phone).toBe("masked");
  });
});
