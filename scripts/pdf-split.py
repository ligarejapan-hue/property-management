#!/usr/bin/env python3
"""pdf-split — まとめてある PDF(物件概要書・図面・謄本などが1冊になったもの)を書類ごとに分ける。

使い方(アプリの src/lib/pdf-split/run.ts から呼ばれる):
  python3 pdf-split.py ocr   <入力PDF> <作業フォルダ> --pages 4,6,7
      指定したページの**上のほう**(見出しのあたり)だけを画像にして文字を読み、
      作業フォルダに ocr-NNN.txt(NNN=ページ番号)を書く。
  python3 pdf-split.py split <入力PDF> <作業フォルダ> --ranges 1-1,2-3,4-8
      ページの範囲ごとに part-00.pdf, part-01.pdf … を作業フォルダに書く。

標準出力に JSON を1行だけ出す(読み取った文字・ファイル名は出さない):
  ocr:   {"ok": true, "ocr": "done"|"unavailable"|"failed", "pages": [{"page": 4, "chars": 120}, ...]}
  split: {"ok": true, "pageCount": 18, "parts": [{"pages": 1, "bytes": 12345}, ...]}
  失敗:  {"ok": false, "reason": "invalid_pdf"|"encrypted"|"bad_args"}

⚠見出しを読むのは種類を見分けるためだけ。ページの上 HEAD_RATIO だけを読むので速い
  (1ページ1秒ほど)。読んだ文字はアプリが判別に使うだけで、保存しない。
⚠文字の読み取りは Tesseract(日本語)・画像にするのは pdftoppm(poppler)。どちらもこのサーバーの中だけ。
⚠入力ファイルには書き込まない。ページの中身(描画命令・図版)には手を触れず、そのまま写す。
⚠ライセンス: pikepdf(MPL-2.0)・Pillow(HPND)・poppler(GPL・別プロセスで呼ぶだけ)・Tesseract(Apache-2.0)。
"""
import argparse
import json
import os
import subprocess
import sys

try:
    import resource

    _LIMIT = 1536 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (_LIMIT, _LIMIT))
except Exception:  # Windows 等では無い。呼び出し側の時間制限が最後の守り。
    pass

import pikepdf  # noqa: E402
from PIL import Image  # noqa: E402

MAX_PAGES = 60
HEAD_RATIO = 0.4          # ページの上 4 割だけ読む(見出しはここにある)
RENDER_DPI = 150
RENDER_TIMEOUT_SEC = 30
OCR_TIMEOUT_SEC = 30
Image.MAX_IMAGE_PIXELS = 40_000_000


def _out(obj):
    print(json.dumps(obj))


def _open(path):
    try:
        return pikepdf.open(path)
    except pikepdf.PasswordError:
        return "encrypted"
    except Exception:
        return None


def _parse_pages(raw, count):
    pages = []
    for s in raw.split(","):
        s = s.strip()
        if not s:
            continue
        n = int(s)
        if n < 1 or n > count:
            raise ValueError("page")
        pages.append(n)
    return pages


def _parse_ranges(raw, count):
    ranges = []
    for s in raw.split(","):
        a, b = s.split("-")
        a, b = int(a), int(b)
        if a < 1 or b < a or b > count:
            raise ValueError("range")
        ranges.append((a, b))
    if not ranges:
        raise ValueError("range")
    return ranges


def cmd_ocr(args):
    pdf = _open(args.input)
    if pdf == "encrypted":
        return _out({"ok": False, "reason": "encrypted"})
    if pdf is None:
        return _out({"ok": False, "reason": "invalid_pdf"})
    count = len(pdf.pages)
    pdf.close()
    if count > MAX_PAGES:
        return _out({"ok": False, "reason": "bad_args"})
    try:
        pages = _parse_pages(args.pages, count)
    except Exception:
        return _out({"ok": False, "reason": "bad_args"})

    state = "done"
    results = []
    for n in pages:
        stem = os.path.join(args.workdir, "page-%03d" % n)
        try:
            subprocess.run(
                ["pdftoppm", "-f", str(n), "-l", str(n), "-r", str(RENDER_DPI), "-gray", "-png", "-singlefile",
                 args.input, stem],
                capture_output=True, timeout=RENDER_TIMEOUT_SEC, check=True,
            )
            with Image.open(stem + ".png") as im:
                head = im.crop((0, 0, im.width, max(1, int(im.height * HEAD_RATIO))))
                head.save(stem + "-head.png", "PNG")
            out = subprocess.run(
                ["tesseract", stem + "-head.png", "stdout", "-l", "jpn", "--psm", "3"],
                capture_output=True, timeout=OCR_TIMEOUT_SEC, check=True,
            )
            text = out.stdout.decode("utf-8", "replace")
        except FileNotFoundError:
            state = "unavailable"
            break
        except Exception:
            # 1ページ読めなくても残りは続ける(そのページは「前の書類の続き」になるだけ)。
            state = "failed"
            text = ""
        with open(os.path.join(args.workdir, "ocr-%03d.txt" % n), "w", encoding="utf-8") as f:
            f.write(text)
        results.append({"page": n, "chars": sum(1 for ch in text if not ch.isspace())})
    _out({"ok": True, "ocr": state, "pages": results})


def cmd_split(args):
    pdf = _open(args.input)
    if pdf == "encrypted":
        return _out({"ok": False, "reason": "encrypted"})
    if pdf is None:
        return _out({"ok": False, "reason": "invalid_pdf"})
    with pdf:
        count = len(pdf.pages)
        if count > MAX_PAGES:
            return _out({"ok": False, "reason": "bad_args"})
        try:
            ranges = _parse_ranges(args.ranges, count)
        except Exception:
            return _out({"ok": False, "reason": "bad_args"})
        parts = []
        for i, (a, b) in enumerate(ranges):
            out = pikepdf.new()
            for n in range(a, b + 1):
                out.pages.append(pdf.pages[n - 1])
            path = os.path.join(args.workdir, "part-%02d.pdf" % i)
            out.save(path, compress_streams=True)
            out.close()
            parts.append({"pages": b - a + 1, "bytes": os.path.getsize(path)})
    _out({"ok": True, "pageCount": count, "parts": parts})


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("ocr")
    o.add_argument("input")
    o.add_argument("workdir")
    o.add_argument("--pages", required=True)
    s = sub.add_parser("split")
    s.add_argument("input")
    s.add_argument("workdir")
    s.add_argument("--ranges", required=True)
    args = ap.parse_args()
    if args.cmd == "ocr":
        cmd_ocr(args)
    else:
        cmd_split(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        _out({"ok": False, "reason": "invalid_pdf"})
        sys.exit(0)
