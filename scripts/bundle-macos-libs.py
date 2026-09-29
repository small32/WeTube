#!/usr/bin/env python3
"""Copy non-system Mach-O dependencies into Resources/lib and relocate their links."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def bundle(bin_dir, arch, sources=None):
    sources = sources or {}
    lib_dir = bin_dir.parent / "lib"
    copied = {}
    visited = set()

    def inspect(path, flag):
        return run("otool", "-arch", arch, flag, str(path))

    def expand(name, loader, executable):
        return name.replace("@loader_path", str(loader.parent)).replace(
            "@executable_path", str(executable.parent))

    def visit(source, destination, executable, inherited=()):
        source = source.resolve()
        if destination in visited:
            return
        visited.add(destination)
        if arch not in run("lipo", "-archs", str(source)).split():
            raise RuntimeError(f"{source} does not contain {arch}")
        # A dependency may itself use the root executable's LC_RPATH entries.
        rpaths = []
        for entry in inspect(source, "-l").split("Load command "):
            if "cmd LC_RPATH\n" in entry:
                match = re.search(r"\n\s*path (.*?) \(offset", entry)
                if match:
                    rpaths.append(expand(match[1], source, executable))
        rpaths += list(inherited)
        identities = inspect(source, "-D").splitlines()[1:]
        dependencies = []
        for line in inspect(source, "-L").splitlines():
            if " (compatibility version " in line:
                dependencies.append(line.strip().split(" (compatibility version ")[0])
        for name in dict.fromkeys(dependencies):
            if name in identities or name.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if name.startswith("@rpath/"):
                candidates = [Path(root) / name[len("@rpath/"):] for root in rpaths]
            else:
                candidates = [Path(expand(name, source, executable))]
            dependency = next((p.resolve() for p in candidates if p.is_absolute() and p.is_file()), None)
            if dependency is None:
                raise RuntimeError(f"Cannot resolve {name} required by {source}")
            target = copied.get(dependency)
            if target is None:
                lib_dir.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256(str(dependency).encode()).hexdigest()[:12]
                target = lib_dir / f"{digest}-{dependency.name}"
                copied[dependency] = target
                shutil.copy2(dependency, target)
                target.chmod(target.stat().st_mode | stat.S_IWUSR)
                visit(dependency, target, executable, rpaths)
                run("install_name_tool", "-id", f"@rpath/{target.name}", str(target))
            link = "@loader_path/" + os.path.relpath(target, destination.parent)
            run("install_name_tool", "-change", name, link, str(destination))

    for tool in ("yt-dlp", "ffmpeg", "qjs"):
        target = bin_dir / tool
        if target.exists():
            # Sources have already been copied to the bundle, so callers pass the
            # original location for resolving @loader_path and @executable_path.
            source = sources.get(tool) or target
            visit(source, target, source.resolve())
    print(f"Bundled {len(copied)} non-system libraries ({arch})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bin_dir", type=Path)
    parser.add_argument("arch", choices=["x86_64", "arm64"])
    parser.add_argument("--ffmpeg-source", type=Path)
    parser.add_argument("--qjs-source", type=Path)
    args = parser.parse_args()
    bundle(args.bin_dir.resolve(), args.arch, {"ffmpeg": args.ffmpeg_source, "qjs": args.qjs_source})
