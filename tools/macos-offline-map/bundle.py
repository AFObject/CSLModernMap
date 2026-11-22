from __future__ import annotations

import importlib.metadata
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RENDERER = Path("dev/CSLModernMapRenderer")
APP = REPO / "build/macos-offline-map/离线地图生成器.app"
IGNORE_CACHE = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


def copy_tree(src: Path, dst: Path, ignore=IGNORE_CACHE) -> None:
    shutil.copytree(src, dst, symlinks=True, ignore=ignore, dirs_exist_ok=True)


def build_app(app: Path) -> None:
    subprocess.run(["osacompile", "-o", app, HERE / "launcher.applescript"], check=True)
    info = app / "Contents/Info.plist"
    settings = plistlib.loads(info.read_bytes())
    settings.update(CFBundleIdentifier="com.cslmodernmap.offline-map-generator",
                    CFBundleDisplayName="离线地图生成器", CFBundleName="离线地图生成器",
                    CFBundleShortVersionString="1.0", CFBundleVersion="1",
                    CFBundleDocumentTypes=[{
                        "CFBundleTypeName": "CSLModernMap map export",
                        "CFBundleTypeExtensions": ["gz", "cmm", "mmap", "cslmap"],
                        "CFBundleTypeRole": "Viewer", "LSHandlerRank": "Alternate",
                    }])
    info.write_bytes(plistlib.dumps(settings))

    resources = app / "Contents/Resources"
    shutil.copy2(HERE / "export_map.py", resources)
    base = Path(sys.base_prefix)
    runtime = resources / "python"
    (runtime / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copy2(base / "bin/python3.12", runtime / "bin")
    shutil.copy2(HERE / "Python-LICENSE.txt", runtime / "LICENSE.txt")
    copy_tree(base / "lib", runtime / "lib", shutil.ignore_patterns("site-packages", "pkgconfig", "__pycache__", "*.pyc"))

    packages = runtime / "lib/python3.12/site-packages"
    packages.mkdir(parents=True, exist_ok=True)
    for name in ("pillow", "fonttools", "numpy", "pyyaml", "pypinyin", "lxml", "aggdraw",
                 "contourpy", "shapely", "PySide6-Essentials", "shiboken6"):
        distribution = importlib.metadata.distribution(name)
        roots = {file.parts[0] for file in distribution.files if file.parts[0] != ".."}
        for root in roots:
            source = distribution.locate_file(root)
            destination = packages / root
            if source.is_dir():
                copy_tree(source, destination)
            elif source.is_file():
                shutil.copy2(source, destination)

    engine = resources / "engine"
    for folder in (RENDERER / "csmodernmap", RENDERER / "resources", RENDERER / "styles",
                   RENDERER / "viewer/dist", "assets/cn_icons", "LICENSES"):
        copy_tree(REPO / folder, engine / folder)
    for file in ("LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md"):
        shutil.copy2(REPO / file, engine / file)
    revision = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"], text=True).strip()
    (resources / "engine-revision.txt").write_text(revision + "\n", encoding="utf-8")
    subprocess.run(["codesign", "--force", "--sign", "-", app], check=True)


def main() -> None:
    if sys.platform != "darwin" or sys.version_info[:2] != (3, 12):
        sys.exit("请在 macOS 上使用 Python 3.12 打包。")
    if not (REPO / RENDERER / "viewer/dist/index.html").is_file():
        sys.exit("请先按 README 构建网页查看器。")

    APP.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=APP.parent) as staging:
        app = Path(staging) / APP.name
        build_app(app)
        if APP.exists():
            shutil.rmtree(APP)
        app.rename(APP)
    print(APP)


if __name__ == "__main__":
    main()
