from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a single-file offline map.")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    renderer = Path(__file__).resolve().parent / "engine/dev/CSLModernMapRenderer"
    sys.path.insert(0, str(renderer))
    os.environ["QT_QPA_PLATFORM"] = "offscreen"

    from csmodernmap.parser import parse_document
    from csmodernmap.pixel_sizes import prepare_style
    from csmodernmap.style import load_style
    from csmodernmap.web_export_v2 import export_web

    source, output = args.source.resolve(), args.output.absolute()
    if source == output.resolve() or output.suffix.lower() != ".html":
        parser.error("请选择独立的 .html 输出文件。")
    document = parse_document(str(source))
    style = load_style(str(renderer / "styles/bright.yaml"))
    prepare_style(style, 1.0)
    with TemporaryDirectory(prefix=".offline-map-", dir=output.parent) as folder:
        staging = Path(folder) / output.name
        export_web(document, style, document.city_name, staging, options={
            "visibility": {"poi": True, "transit": True, "traffic": False,
                           "district": False, "zone": False, "label": False, "watermark": False},
        })
        staging.replace(output)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        sys.exit(f"导出失败：{error}")
