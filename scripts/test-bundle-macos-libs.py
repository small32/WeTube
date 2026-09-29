"""Exercise transitive @rpath relocation on macOS using disposable dylibs."""
import importlib.util
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bundler", Path(__file__).with_name("bundle-macos-libs.py"))
bundler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundler)


@unittest.skipUnless(platform.system() == "Darwin", "requires Mach-O tools")
class BundleTests(unittest.TestCase):
    def test_relocated_tool_runs_without_original_libraries(self):
        with tempfile.TemporaryDirectory(prefix="wetube dylib test ") as temporary:
            root = Path(temporary)
            source = root / "original"
            libs = source / "libs"
            libs.mkdir(parents=True)
            (source / "bottom.c").write_text("int bottom(void) { return 42; }\n")
            (source / "middle.c").write_text("extern int bottom(void); int middle(void) { return bottom(); }\n")
            (source / "main.c").write_text("extern int middle(void); int main(void) { return middle() == 42 ? 0 : 1; }\n")
            def cc(*args):
                subprocess.run(["clang", "-Wl,-headerpad_max_install_names", *map(str, args)], check=True)
            cc("-dynamiclib", source / "bottom.c", "-Wl,-install_name,@rpath/libbottom.dylib", "-o", libs / "libbottom.dylib")
            cc("-dynamiclib", source / "middle.c", libs / "libbottom.dylib", "-Wl,-install_name,@rpath/libmiddle.dylib", "-o", libs / "libmiddle.dylib")
            executable = source / "ffmpeg"
            cc(source / "main.c", libs / "libmiddle.dylib", "-Wl,-rpath,@loader_path/libs", "-o", executable)
            bin_dir = root / "Moved.app/Contents/Resources/bin"
            bin_dir.mkdir(parents=True)
            shutil.copy2(executable, bin_dir / "ffmpeg")
            bundler.bundle(bin_dir, platform.machine(), {"ffmpeg": executable})
            self.assertEqual(len(list((bin_dir.parent / "lib").glob("*.dylib"))), 2)
            for path in [*(bin_dir.parent / "lib").glob("*.dylib"), bin_dir / "ffmpeg"]:
                subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)
            shutil.rmtree(source)
            subprocess.run([str(bin_dir / "ffmpeg")], check=True)


if __name__ == "__main__":
    unittest.main()
