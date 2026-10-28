"""
Build single-file userscripts by inlining the bird name map and rewriting
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


def parse_version(source_text: str) -> str:
    m = re.search(r"@version\s+([^\s]+)", source_text)
    return m.group(1) if m else "0.0.0"


def build_inline_block(bird_map: object) -> str:
    return "\n".join(
        [
            INLINE_START,
            f"const birdMap = {json.dumps(bird_map, ensure_ascii=False, indent=4)};",
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


def rewrite_urls_for_branch(
    text: str,
    branch: str,
    bundle_name: str | None,
    update_download: bool = True,
) -> str:
    base = f"https://raw.githubusercontent.com/wzy0421/ebirdHelper/{branch}/"
    single_file_url = base + bundle_name if bundle_name else None

    if update_download and single_file_url:
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


def rename_script(text: str, suffix: str) -> str:
    """Append suffix to @name, so Tampermonkey shows (and keeps) the bundle apart from eBirdHelper.js."""
    text, n = re.subn(r"^(//\s*@name\s+)(.*?)\s*$", lambda m: f"{m.group(1)}{m.group(2)}{suffix}", text, count=1, flags=re.MULTILINE)
    if n != 1:
        raise RuntimeError("@name not found in eBirdHelper.js")
    return text


def strip_userscript_header(text: str) -> str:
    return re.sub(
        r"// ==UserScript==[\s\S]*?// ==/UserScript==\s*",
        "",
        text,
        count=1,
    )


def inject_gm_shim(text: str) -> str:
    shim = """\n// Minimal GM storage shim for extension build\nconst GM = {\n  async getValue(key, defaultValue = null) {\n    const raw = localStorage.getItem(key);\n    if (raw === null) return defaultValue;\n    try { return JSON.parse(raw); } catch (_) { return raw; }\n  },\n  async setValue(key, value) {\n    localStorage.setItem(key, JSON.stringify(value));\n  },\n  async deleteValue(key) {\n    localStorage.removeItem(key);\n  },\n  xmlHttpRequest(details) {\n    fetch(details.url, { method: details.method || 'GET', headers: details.headers || {} })\n      .then(async (r) => details.onload && details.onload({\n        status: r.status,\n        statusText: r.statusText,\n        responseText: await r.text(),\n        responseHeaders: [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\\r\\n'),\n      }))\n      .catch((e) => details.onerror && details.onerror(e));\n  },\n};\n"""
    return shim + "\n" + text


def wrap_async_iife(text: str) -> str:
    return "(async () => {\n" + text + "\n})();\n"


def render_bundle(branch: str, bird_map: object, include_meta: bool, bundle_name: str | None) -> str:
    source = SOURCE.read_text(encoding="utf-8")
    inline_block = build_inline_block(bird_map)
    output = apply_inline_data(source, inline_block)
    output = rewrite_urls_for_branch(output, branch, bundle_name, update_download=include_meta)
    if not include_meta:
        output = strip_userscript_header(output)
    return output


def build_single(branch: str, bird_map: object) -> Path:
    bundle_name = "eBirdHelperSingleFile.js" if branch == "main" else "eBirdHelperSingleFile.dev.js"
    dest = ROOT / bundle_name

    output = render_bundle(branch, bird_map, include_meta=True, bundle_name=bundle_name)
    output = rename_script(output, "（单文件版）" if branch == "main" else "（单文件 dev 版）")

    dest.write_text(output, encoding="utf-8")
    print(f"Wrote {branch} bundle to {dest}")
    return dest


def write_manifest(dest_dir: Path, version: str, branch: str) -> None:
    name = "eBird Helper" if branch == "main" else "eBird Helper (dev)"
    manifest = {
        "manifest_version": 3,
        "name": name,
        "version": version,
        "description": "Translate bird names and add @pinyin shortcuts on eBird.",
        "content_scripts": [
            {
                "matches": ["https://ebird.org/*"],
                "js": ["content.js"],
                "run_at": "document_idle",
            }
        ],
        "host_permissions": [
            "https://raw.githubusercontent.com/*"
        ],
    }
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def build_extension(branch: str, bird_map: object, version: str) -> Path:
    out_dir = ROOT / "dist" / f"chrome-extension-{branch}"
    out_dir.mkdir(parents=True, exist_ok=True)

    code = render_bundle(branch, bird_map, include_meta=False, bundle_name=None)
    code = inject_gm_shim(code)
    code = wrap_async_iife(code)

    (out_dir / "content.js").write_text(code, encoding="utf-8")
    write_manifest(out_dir, version, branch)

    print(f"Wrote Chrome extension ({branch}) to {out_dir}")
    return out_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Build single-file userscripts and Chrome extension")
    parser.add_argument(
        "--branch",
        choices=["main", "dev", "both"],
        default="both",
        help="Which branch URLs to use (default: both).",
    )
    parser.add_argument(
        "--extension-only",
        action="store_true",
        help="Only build Chrome extension outputs (skip userscripts).",
    )
    args = parser.parse_args()

    source_text = SOURCE.read_text(encoding="utf-8")
    version = parse_version(source_text)
    bird_map = read_json("birdMap.json")

    branches = ["main", "dev"] if args.branch == "both" else [args.branch]

    for br in branches:
        if not args.extension_only:
            build_single(br, bird_map)
        build_extension(br, bird_map, version)


if __name__ == "__main__":
    main()
