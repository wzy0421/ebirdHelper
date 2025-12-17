"""
Build single-file userscripts by inlining bird/endemic maps and rewriting
metadata/remote URLs to a given branch (main or dev).
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "eBirdHelper.js"
INLINE_START = "// @ebh-inline-data-start"
INLINE_END = "// @ebh-inline-data-end"


def read_json(name: str) -> object:
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def build_inline_block(bird_map: object, endemic_map: object) -> str:
    return "\n".join(
        [
            INLINE_START,
            f"const birdMap = {json.dumps(bird_map, ensure_ascii=False, indent=4)};",
            "",
            f"const endemicMap = {json.dumps(endemic_map, ensure_ascii=False, indent=4)};",
            INLINE_END,
        ]
    )


def apply_inline_data(source: str, inline_block: str) -> str:
    pattern = re.compile(
        rf"{re.escape(INLINE_START)}[\s\S]*?{re.escape(INLINE_END)}",
        flags=re.MULTILINE,
    )
    if not pattern.search(source):
        raise RuntimeError("Inline marker block not found in eBirdHelper.js")
    return pattern.sub(inline_block, source, count=1)


def rewrite_urls_for_branch(text: str, branch: str, bundle_name: str) -> str:
    base = f"https://raw.githubusercontent.com/wzy0421/ebirdHelper/{branch}/"
    single_file_url = base + bundle_name

    text = re.sub(
        r"//\s*@updateURL.*",
        f"// @updateURL  {single_file_url}",
        text,
        count=1,
    )
    text = re.sub(
        r"//\s*@downloadURL.*",
        f"// @downloadURL  {single_file_url}",
        text,
        count=1,
    )
    text = re.sub(
        r"const RAW_BASE = 'https://raw.githubusercontent.com/wzy0421/ebirdHelper/[^']*/';",
        f"const RAW_BASE = '{base}';",
        text,
        count=1,
    )
    return text


def build_single(branch: str, bird_map: object, endemic_map: object) -> Path:
    bundle_name = "eBirdHelperSingleFile.js" if branch == "main" else "eBirdHelperSingleFile.dev.js"
    dest = ROOT / bundle_name

    source = SOURCE.read_text(encoding="utf-8")
    inline_block = build_inline_block(bird_map, endemic_map)
    output = apply_inline_data(source, inline_block)
    output = rewrite_urls_for_branch(output, branch, bundle_name)

    dest.write_text(output, encoding="utf-8")
    print(f"Wrote {branch} bundle to {dest}")
    return dest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build main/dev single-file userscripts")
    parser.add_argument(
        "--branch",
        choices=["main", "dev", "both"],
        default="both",
        help="Which branch URLs to use (default: both).",
    )
    args = parser.parse_args()

    bird_map = read_json("birdMap.json")
    endemic_map = read_json("endemicMap.json")

    branches = ["main", "dev"] if args.branch == "both" else [args.branch]
    for br in branches:
        build_single(br, bird_map, endemic_map)


if __name__ == "__main__":
    main()
