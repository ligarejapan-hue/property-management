"""
全宅連の物件状況確認書(告知書・Excel)から文面を取り出して TS にする(設計 第2段階 §3.4・段E の計画 Task 1)。
手元で1回動かす: python -X utf8 -I scripts/deals/extract-zentaku-disclosure.py <全宅書式のフォルダ>
出力: src/lib/deals/documents/texts/disclosure-{house,unit}.ts(手で直さない)
- シートは [表紙, 記入にあたって, 告知書の頁] の順と決めて読む
- セルの文字は前後の空白(全角・半角)だけ外す。セルの中の改行は残す
- 「記入にあたって」は、項目・状況の2つがそろう行を row、1つだけの行を note にする(「項目」「状況」の見出しの行は入れない)
⚠ 読むのは自分の手元の全宅連の書式だけ。openpyxl は手元のパソコンに入っているものを使う(npm の依存ではない)。
"""
import json
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src/lib/deals/documents/texts"
FILES = [
    ("kokuchisyo_kodate.2205.xlsx", "disclosure-house.ts", "DISCLOSURE_HOUSE_SOURCE", "土地建物・土地用"),
    ("kokuchisyo_kubun.2205 (1).xlsx", "disclosure-unit.ts", "DISCLOSURE_UNIT_SOURCE", "区分所有建物用"),
]


def text(v):
    return v.strip(" \u3000") if isinstance(v, str) and v.strip(" \u3000\n") else None


def cells(ws):
    out = []
    for row in ws.iter_rows():
        for c in row:
            t = text(c.value)
            if t:
                out.append((c.row, c.column, t))
    return out


def squeeze(t):
    return re.sub(r"[\s\u3000]", "", t)


def extract(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    cover_ws, guide_ws, form_ws = (wb[n] for n in wb.sheetnames[:3])
    cover = [t for _, _, t in cells(cover_ws)]
    g = cells(guide_ws)
    guide_title = g[0][2]
    by_row = {}
    for r, col, t in g[1:]:
        by_row.setdefault(r, []).append((col, t))
    guide = []
    for r in sorted(by_row):
        parts = [t for _, t in sorted(by_row[r])]
        if [squeeze(p) for p in parts] == ["項目", "状況"]:
            continue
        if len(parts) >= 2:
            guide.append({"kind": "row", "item": parts[0], "text": "\n".join(parts[1:])})
        else:
            guide.append({"kind": "note", "text": parts[0]})
    p = wb.properties
    return {
        "created": p.created.strftime("%Y-%m-%d") if p.created else "",
        "modified": p.modified.strftime("%Y-%m-%d") if p.modified else "",
        "coverTitle": cover[0], "cover": cover[1:],
        "guideTitle": guide_title, "guide": guide,
        "formCells": [t for _, _, t in cells(form_ws)],
    }


def write(src_name, out_name, const, kind, d):
    j = lambda v: json.dumps(v, ensure_ascii=False)
    lines = [
        "// 生成: scripts/deals/extract-zentaku-disclosure.py(手で直さない)",
        "/**",
        f" * 全宅連の書式「物件状況確認書（告知書／{kind}）」から写した文面(設計 第2段階 §3.4)。",
        f" * 元: 全宅書式/{src_name}(作成 {d['created']}・更新 {d['modified']})。セルの文字の前後の空白だけ外した。そのほかは元のまま。",
        " */",
        'import type { DisclosureSource } from "./disclosure-types";',
        "",
        f"export const {const}: DisclosureSource = {{",
        f"  source: {j(src_name)},",
        f"  created: {j(d['created'])},",
        f"  modified: {j(d['modified'])},",
        f"  coverTitle: {j(d['coverTitle'])},",
        "  cover: [",
        *[f"    {j(t)}," for t in d["cover"]],
        "  ],",
        f"  guideTitle: {j(d['guideTitle'])},",
        "  guide: [",
        *[f"    {j(b)}," for b in d["guide"]],
        "  ],",
        "  formCells: [",
        *[f"    {j(t)}," for t in d["formCells"]],
        "  ],",
        "};",
        "",
    ]
    (OUT / out_name).write_text("\n".join(lines), encoding="utf8", newline="\n")


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for src_name, out_name, const, kind in FILES:
        d = extract(folder / src_name)
        write(src_name, out_name, const, kind, d)
        print(out_name, len(d["cover"]), len(d["guide"]), len(d["formCells"]))
