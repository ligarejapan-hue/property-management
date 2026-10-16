import { describe, it, expect } from "vitest";
import { unifyReceptionDraft, type CsvImportDraft } from "../screens/csv-import";

const A = { name: "受付帳A.xlsx", xlsxBase64: "AAA" };
const B = { name: "受付帳B.xlsx", xlsxBase64: "BBB" };
const O = { name: "所有者.xlsx", xlsxBase64: "OOO" };
const draft = (over: Partial<CsvImportDraft>): CsvImportDraft => ({ rev: 1, main: null, ro: null, rp: null, ...over });

describe("unifyReceptionDraft(第4回 D: 受付帳は1回)", () => {
  it("控えが無い・①②どちらも無いときはそのまま", () => {
    expect(unifyReceptionDraft(null)).toBeNull();
    const d = draft({});
    expect(unifyReceptionDraft(d)).toBe(d);
  });

  it("同じファイル・同じ条件なら②の下見を残す", () => {
    const d = draft({
      rp: { rpFile: A, rpDlFilter: "all", rpShinkiFilter: "new", rpPreview: { x: 1 } },
      ro: { receptionFile: { ...A }, ownerFile: O, dlFilter: "all", shinkiFilter: "new", roPreview: { y: 1 } },
    });
    const u = unifyReceptionDraft(d)!;
    expect(u.ro).toMatchObject({ receptionFile: A, dlFilter: "all", shinkiFilter: "new", roPreview: { y: 1 } });
    expect(u.rp).toBe(d.rp);
  });

  it("①と②で別のファイルなら①にそろえ、②の下見は捨てる", () => {
    const u = unifyReceptionDraft(
      draft({
        rp: { rpFile: A, rpDlFilter: "marked", rpShinkiFilter: "existing", rpPreview: null },
        ro: { receptionFile: B, ownerFile: O, dlFilter: "marked", shinkiFilter: "existing", roPreview: { y: 1 } },
      }),
    )!;
    expect(u.ro).toMatchObject({ receptionFile: A, ownerFile: O, roPreview: null });
  });

  it("条件が違っても①にそろえ、②の下見は捨てる", () => {
    const u = unifyReceptionDraft(
      draft({
        rp: { rpFile: A, rpDlFilter: "all", rpShinkiFilter: "existing", rpPreview: null },
        ro: { receptionFile: A, ownerFile: O, dlFilter: "marked", shinkiFilter: "existing", roPreview: { y: 1 } },
      }),
    )!;
    expect(u.ro).toMatchObject({ dlFilter: "all", roPreview: null });
  });

  it("①が済んで控えから外れたら②の控えのファイル・条件を使う(下見も残す)", () => {
    const u = unifyReceptionDraft(
      draft({ ro: { receptionFile: B, ownerFile: O, dlFilter: "unmarked", shinkiFilter: "all", roPreview: { y: 1 } } }),
    )!;
    expect(u.ro).toMatchObject({ receptionFile: B, dlFilter: "unmarked", shinkiFilter: "all", roPreview: { y: 1 } });
    expect(u.rp).toBeNull();
  });
});
