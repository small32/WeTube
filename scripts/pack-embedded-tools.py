#!/usr/bin/env python3
"""把 vendor/ 下的外置工具压成 .xz，供构建时以压缩态内嵌进 exe。

    python scripts/pack-embedded-tools.py

为什么压：Windows 版把 yt-dlp / ffmpeg / qjs 编进 exe，其中 ffmpeg 静态版
就有 98MB（占整个包的八成），xz 能压到 26MB 左右。yt-dlp 是 PyInstaller
打的包，内部已经压过，几乎压不动——脚本会照实打印比例，压不动也照样生成，
统一走同一条解压路径。

产物：vendor/<工具>.exe.xz，与 vendor/<工具>.exe 同目录并存；
build.rs 发现 .xz 就内嵌压缩态，运行时解回原样再执行。
"""
import io
import lzma
import os
import sys
import time

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "vendor")


def pack(path: str) -> None:
    raw_size = os.path.getsize(path)
    out = path + ".xz"
    # 已经压过且比源文件新就跳过，避免每次构建都白压 98MB
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(path):
        packed_size = os.path.getsize(out)
        print(f"跳过 {os.path.basename(path)}（.xz 已是最新，{packed_size / 1048576:.2f} MB）")
        return

    started = time.time()
    with open(path, "rb") as src:
        data = src.read()
    # preset 6：ffmpeg 实测 98MB→26MB，再往上调收益很小、耗时翻倍
    packed = lzma.compress(data, preset=6)
    with io.open(out, "wb") as dst:
        dst.write(packed)
    ratio = len(packed) / raw_size * 100
    print(
        f"{os.path.basename(path):12} {raw_size / 1048576:7.2f} MB -> "
        f"{len(packed) / 1048576:6.2f} MB ({ratio:4.1f}%)  {time.time() - started:.1f}s"
    )


def main() -> int:
    if not os.path.isdir(VENDOR):
        print(f"没有 vendor 目录：{VENDOR}（先跑 fetch-bundled-tools-windows 取工具）")
        return 1
    tools = sorted(n for n in os.listdir(VENDOR) if n.endswith(".exe"))
    if not tools:
        print("vendor/ 下没有 .exe 工具，跳过")
        return 0
    for name in tools:
        pack(os.path.join(VENDOR, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
