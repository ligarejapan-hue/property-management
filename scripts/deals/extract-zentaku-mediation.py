"""
全宅連の媒介契約書(Word)から文面を取り出して TS にする(設計 第2段階 §3.4・段D の計画 Task 1)。
手元で1回動かす: python -X utf8 -I scripts/deals/extract-zentaku-mediation.py <全宅書式のフォルダ>
出力: src/lib/deals/documents/texts/mediation-{general,exclusive,dedicated}.ts(手で直さない)

整え方(計画「決めたこと」1):
- 段落の先頭の番号(第１条・一・２・イ・注１・＊)の後ろの全角スペース1つは残し、それ以外の全角・半角スペースは外す
- 書き込み欄の半角幅の空白(U+2002)は「＿」1つにする
- 文の途中で切れた段落はつなぐ
- 依頼者・宅建業者の欄と日付の行(7段落)は入れない(組み立てで作る)。別表は入れない
⚠ 読むのは自分の手元の全宅連の書式だけ(信頼できるファイル)。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DC = "{http://purl.org/dc/terms/}"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src/lib/deals/documents/texts"
FILES = [
    ("182_ippan.docx", "mediation-general.ts", "MEDIATION_GENERAL", "一般"),
    ("180_sennin.docx", "mediation-exclusive.ts", "MEDIATION_EXCLUSIVE", "専任"),
    ("181_senzoku.docx", "mediation-dedicated.ts", "MEDIATION_DEDICATED", "専属専任"),
]
MARK = re.compile(r"^(第[０-９0-9]+条|[０-９0-9]{1,2}|[一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)　")
PARTY = re.compile(r"^(＿?年＿月＿日|甲・依頼者住所|氏名㊞|乙・宅地建物取引業者商号（名称）|代表者㊞|主たる事務所の所在地|免許証番号＿（＿）第＿号)$")
NO_JOIN = {"依頼の内容", "売却・購入・交換", "備考"}
WORD_END = re.compile(r"[ぁ-んァ-ヶ一-龠]$")


def raw_paragraphs(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
        core = ET.fromstring(z.read("docProps/core.xml"))
    paras = ["".join(e.text or "" for e in p.iter(W + "t")) for p in root.iter(W + "p")]
    created = core.find(DC + "created").text[:10]
    modified = core.find(DC + "modified").text[:10]
    return paras, created, modified


def squeeze(t):
    return re.sub(r"[　  ]", "", t)


def clean(t):
    body = t.strip(" 　 \n")
    if not body:
        return None
    m = MARK.match(body)
    head, rest = (m.group(1), body[m.end():]) if m else ("", body)
    rest = re.sub(" +", "＿", rest)
    rest = re.sub("[　 ]+", "", rest)
    return f"{head}　{rest}" if head else rest


def join_broken(lines):
    out = []
    for t in lines:
        prev = out[-1] if out else None
        if (prev is not None and WORD_END.search(prev) and prev not in NO_JOIN and not MARK.match(prev)
                and not prev.startswith("・") and not MARK.match(t) and not t.startswith("・")):
            out[-1] = prev + t
        else:
            out.append(t)
    return out


def extract(path, kind):
    paras, created, modified = raw_paragraphs(path)
    title = f"{kind}媒介契約書"
    clauses_title = f"{kind}媒介契約約款"
    i_title = next(i for i, p in enumerate(paras) if squeeze(p) == title)
    i_table = next(i for i, p in enumerate(paras) if squeeze(p) == "別表")
    i_clauses = next(i for i, p in enumerate(paras) if squeeze(p) == clauses_title)
    head = [c for c in (clean(p) for p in paras[:i_title]) if c]
    body = [c for c in (clean(p) for p in paras[i_title + 1:i_table]) if c]
    dropped = [c for c in body if PARTY.match(c)]
    assert len(dropped) == 7, (path, dropped)
    contract = join_broken(head + [c for c in body if not PARTY.match(c)])
    clauses = join_broken([c for c in (clean(p) for p in paras[i_clauses + 1:]) if c])
    return {"created": created, "modified": modified, "title": title, "contract": contract, "clausesTitle": clauses_title, "clauses": clauses}


def write(src_name, out_name, const, kind, d):
    j = lambda v: json.dumps(v, ensure_ascii=False)
    lines = [
        "// 生成: scripts/deals/extract-zentaku-mediation.py(手で直さない)",
        "/**",
        f" * 全宅連の書式「{kind}媒介契約書」から写した文面(設計 第2段階 §3.4)。",
        f" * 元: 全宅書式/{src_name}(作成 {d['created']}・更新 {d['modified']})。",
        " * 行をそろえるための全角スペースは外し、書き込み欄(半角幅の空白)は「＿」にした。文の途中で切れた段落はつないだ。そのほかは元のまま。",
        " * 依頼者・宅建業者の欄と日付の行、別表は、組み立てで作るので入れていない。",
        " */",
        'import type { MediationText } from "./mediation-types";',
        "",
        f"export const {const}: MediationText = {{",
        f"  source: {j(src_name)},",
        f"  created: {j(d['created'])},",
        f"  modified: {j(d['modified'])},",
        f"  title: {j(d['title'])},",
        "  contract: [",
        *[f"    {j(t)}," for t in d["contract"]],
        "  ],",
        f"  clausesTitle: {j(d['clausesTitle'])},",
        "  clauses: [",
        *[f"    {j(t)}," for t in d["clauses"]],
        "  ],",
        "};",
        "",
    ]
    (OUT / out_name).write_text("\n".join(lines), encoding="utf8", newline="\n")


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for src_name, out_name, const, kind in FILES:
        d = extract(folder / src_name, kind)
        write(src_name, out_name, const, kind, d)
        print(out_name, len(d["contract"]), len(d["clauses"]))
