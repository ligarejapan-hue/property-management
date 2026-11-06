#!/usr/bin/env python3
"""pdf_sandbox — 圧縮の処理が読み書きできる場所を、その回の作業フォルダだけに絞る(2026-11-06 発注者)。

Linux の Landlock(カーネル 5.13 以降・Ubuntu 24.04 は有効)を使う。root も特別な権限も要らない。
confine(作業フォルダ) を呼んだあと、このプロセス(と子)は:
  ・作業フォルダの中 … 読む・書く・消す・作る(全部)
  ・/usr の中 …………… 読むだけ(Python と pikepdf・Pillow の部品)
  ・それ以外 ………………… 読むことも書くこともできない(保存ファイルの置き場所・app.env・/tmp のほかの場所)
⚠閉じ込められないとき(Landlock が無い・Linux でない)は SandboxUnavailable を投げる=縮めずに失敗する。
  閉じ込めずに続けることはしない(お客様の提出からも信用しない PDF が来るため)。
⚠Landlock の版(ABI)は 3 以上が要る(カーネル 6.2 以降・Ubuntu 24.04 の 6.8 は 4 以上)。
  2 以下では外のファイルを空にする(truncate)ことを止められない=保存ファイルを消せてしまうので断る(@codex P2)。

確かめ方(テストと反映後の点検):
  python3 pdf_sandbox.py --probe <作業フォルダ> <外のファイル>
  → {"writeInside": "ok", "readOutside": "denied", "writeOutside": "denied", "truncateOutside": "denied", "readUsr": "ok"}
"""
import ctypes
import json
import os
import struct
import sys

# syscall 番号(x86_64・aarch64 とも共通の表)
_SYS_CREATE_RULESET = 444
_SYS_ADD_RULE = 445
_SYS_RESTRICT_SELF = 446
_CREATE_RULESET_VERSION = 1 << 0
_RULE_PATH_BENEATH = 1
_PR_SET_NO_NEW_PRIVS = 38

# ファイルの扱い(ABI 1)
_EXECUTE = 1 << 0
_WRITE_FILE = 1 << 1
_READ_FILE = 1 << 2
_READ_DIR = 1 << 3
_ABI1_ALL = (1 << 13) - 1  # EXECUTE 〜 MAKE_SYM
_REFER = 1 << 13  # ABI 2
_TRUNCATE = 1 << 14  # ABI 3
_MIN_ABI = 3

_READ_ONLY_DIR = _EXECUTE | _READ_FILE | _READ_DIR
# 1つのファイルに付けてよいのはファイル向けの扱いだけ(READ_DIR を付けると EINVAL)。
_READ_ONLY_FILE = _READ_FILE

# 読むだけ許す場所。/lib・/lib64 は Ubuntu 24.04 では /usr への別名なので、本物のフォルダのときだけ足す。
_READ_DIRS = ("/usr", "/lib", "/lib64")
_READ_FILES = ("/dev/null", "/dev/urandom", "/etc/ld.so.cache")


class SandboxUnavailable(RuntimeError):
    pass


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


def _path_beneath_attr(access, fd):
    """struct landlock_path_beneath_attr(__u64 + __s32・詰めて 12 バイト)。"""
    return ctypes.create_string_buffer(struct.pack("=Qi", access, fd), 12)


def _libc():
    if not sys.platform.startswith("linux"):
        raise SandboxUnavailable("not-linux")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    libc.prctl.restype = ctypes.c_int
    return libc


def _add_rule(libc, ruleset_fd, path, access):
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        attr = _path_beneath_attr(access, fd)
        if libc.syscall(_SYS_ADD_RULE, ctypes.c_int(ruleset_fd), ctypes.c_int(_RULE_PATH_BENEATH),
                        attr, ctypes.c_uint32(0)) != 0:
            raise SandboxUnavailable("add-rule errno=%d" % ctypes.get_errno())
    finally:
        os.close(fd)


def confine(workdir):
    """このプロセスの読み書きを workdir(全部)と /usr(読むだけ)に絞る。戻せない。"""
    libc = _libc()
    abi = libc.syscall(_SYS_CREATE_RULESET, ctypes.c_void_p(None), ctypes.c_size_t(0),
                       ctypes.c_uint32(_CREATE_RULESET_VERSION))
    if abi < 1:
        raise SandboxUnavailable("landlock errno=%d" % ctypes.get_errno())
    if abi < _MIN_ABI:
        raise SandboxUnavailable("landlock-abi=%d" % abi)
    handled = _ABI1_ALL | _REFER | _TRUNCATE
    attr = _RulesetAttr(handled_access_fs=handled)
    ruleset_fd = libc.syscall(_SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)),
                              ctypes.c_uint32(0))
    if ruleset_fd < 0:
        raise SandboxUnavailable("create-ruleset errno=%d" % ctypes.get_errno())
    try:
        _add_rule(libc, ruleset_fd, os.path.realpath(workdir), handled)
        for d in _READ_DIRS:
            if os.path.isdir(d) and not os.path.islink(d):
                _add_rule(libc, ruleset_fd, d, _READ_ONLY_DIR)
        for f in _READ_FILES:
            if os.path.exists(f):
                _add_rule(libc, ruleset_fd, f, _READ_ONLY_FILE)
        if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise SandboxUnavailable("no-new-privs errno=%d" % ctypes.get_errno())
        if libc.syscall(_SYS_RESTRICT_SELF, ctypes.c_int(ruleset_fd), ctypes.c_uint32(0)) != 0:
            raise SandboxUnavailable("restrict-self errno=%d" % ctypes.get_errno())
    finally:
        os.close(ruleset_fd)


def probe_outside(workdir, outside_file):
    """閉じ込めたあとに呼ぶ。外のファイルを読めず・空にできず、外に書けないことを確かめる。"""
    result = {}
    try:
        with open(outside_file, "rb") as fh:
            fh.read(1)
        result["readOutside"] = "ok"
    except PermissionError:
        result["readOutside"] = "denied"
    try:
        os.truncate(outside_file, 0)
        result["truncateOutside"] = "ok"
    except PermissionError:
        result["truncateOutside"] = "denied"
    escape = os.path.join(os.path.dirname(os.path.realpath(outside_file)), "pdfc-escape-probe")
    try:
        with open(escape, "w") as fh:
            fh.write("x")
        result["writeOutside"] = "ok"
    except PermissionError:
        result["writeOutside"] = "denied"
    return result


def _probe(workdir, outside_file):
    confine(workdir)
    result = {}
    with open(os.path.join(workdir, "probe.txt"), "w") as fh:
        fh.write("ok")
    result["writeInside"] = "ok"
    result.update(probe_outside(workdir, outside_file))
    try:
        os.listdir("/usr")
        result["readUsr"] = "ok"
    except PermissionError:
        result["readUsr"] = "denied"
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--probe":
        try:
            sys.exit(_probe(sys.argv[2], sys.argv[3]))
        except SandboxUnavailable as e:
            print(json.dumps({"unavailable": str(e)}))
            sys.exit(1)
    print("usage: pdf_sandbox.py --probe <workdir> <outside-file>", file=sys.stderr)
    sys.exit(2)
