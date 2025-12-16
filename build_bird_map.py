#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Build eBird English -> IOC Chinese (Simplified) mapping.

Inputs (default filenames match your current setup):
  - eBird_taxonomy_v2025.xlsx
  - Multiling IOC 15.1_c.xlsx

Output:
  - If output endswith .json: { "eBird English": "IOC Chinese", ... }
  - If output endswith .csv : columns: eBird_English, Scientific, IOC_Chinese

Matching strategy:
  1) Scientific name exact match (highest priority)
  2) English name "key" match (remove punctuation, normalize grey/gray, hyphen/space, apostrophes)
  3) Prefix/Base -> Base (Prefix) attempt (eBird style -> IOC style)
  4) Small set of conservative manual variants
  5) If Simplified missing but Traditional exists, copy Traditional as placeholder
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, Tuple

import pandas as pd


# ----------------------------
# Normalization helpers
# ----------------------------

def norm1(s: object) -> str | None:
    """Basic English normalization: remove parenthetical, normalize dashes, lowercase."""
    if pd.isna(s):
        return None
    text = str(s)
    text = re.sub(r"\s*\(.*?\)\s*", "", text)  # remove parentheses content
    text = text.replace("–", "-").replace("—", "-")
    text = text.strip().lower()
    return text or None


def norm2(s: object) -> str | None:
    """More aggressive English normalization for fallback matching."""
    t = norm1(s)
    if t is None:
        return None
    t = t.replace("'", "")       # remove apostrophes
    t = t.replace("-", " ")      # hyphen -> space
    t = re.sub(r"\s+", " ", t)   # collapse spaces
    t = re.sub(r"\bgray\b", "grey", t)  # US -> UK spelling
    return t or None


def normkey(s: object) -> str | None:
    """Key used for robust matching: keep only letters after norm2."""
    t = norm2(s)
    if t is None:
        return None
    t = re.sub(r"[^a-z]", "", t)
    return t or None


def invert_prefix(title: object) -> str | None:
    """
    eBird sometimes uses "Prefix Base" while IOC uses "Base (Prefix)".
    Example: "Mexican Squirrel-Cuckoo" -> "Squirrel-Cuckoo (Mexican)"
    """
    if pd.isna(title):
        return None
    t = str(title).strip()
    parts = t.split(" ", 1)
    if len(parts) < 2:
        return None
    prefix, base = parts[0], parts[1]
    return f"{base} ({prefix})"


def manual_variants(title: object) -> list[str]:
    """A conservative set of variants for common punctuation differences."""
    if pd.isna(title):
        return []
    t = str(title)

    variants = [
        norm1(t.replace("-", " ")),
        norm1(t.replace("White-Tern", "White Tern")),
        norm1(t.replace("Fig-Parrot", "Fig Parrot")),
        norm1(t.replace("Waterhen", "Water-hen")),
        norm1(t.replace("Wood-Pigeon", "Woodpigeon")),
        norm1(t.replace("Wood-Pigeon", "Wood Pigeon")),
        norm1(t.replace("Turtle-Dove", "Turtle Dove")),
        norm1(t.replace("Gray", "Grey")),
    ]
    # de-dup & drop None
    out: list[str] = []
    seen = set()
    for v in variants:
        if v and v not in seen:
            out.append(v)
            seen.add(v)
    return out


# ----------------------------
# Core build function
# ----------------------------

def build_ebird_en_to_ioc_cn_map(
    ebird_xlsx: str | Path = "eBird_taxonomy_v2025.xlsx",
    ioc_xlsx: str | Path = "Multiling IOC 15.1_c.xlsx",
) -> Tuple[pd.DataFrame, Dict[str, str], pd.DataFrame]:
    """
    Returns:
      - mapping_df: columns [eBird_English, Scientific, IOC_Chinese]
      - mapping_dict: {eBird_English: IOC_Chinese} (only matched)
      - remaining_unmatched_df: columns [eBird_English, Scientific] for audit
    """
    ebird = pd.read_excel(ebird_xlsx)
    ioc = pd.read_excel(ioc_xlsx)

    # eBird: keep species only
    ebird_species = ebird[ebird["CATEGORY"].astype(str).str.lower() == "species"].copy()
    ebird_species["sci_norm"] = ebird_species["SCI_NAME"].astype(str).str.strip().str.lower()

    # IOC
    ioc_clean = ioc.copy()
    ioc_clean["sci_norm"] = ioc_clean["IOC_15.1"].astype(str).str.strip().str.lower()
    ioc_clean["eng1"] = ioc_clean["English"].map(norm1)
    ioc_clean["eng2"] = ioc_clean["English"].map(norm2)
    ioc_clean["engk"] = ioc_clean["English"].map(normkey)

    # 1) Primary: scientific name match
    merged = ebird_species.merge(
        ioc_clean[["sci_norm", "English", "Chinese", "Chinese (Traditional)", "eng1", "eng2", "engk"]],
        on="sci_norm",
        how="left",
    ).rename(
        columns={
            "English": "IOC_English",
            "Chinese": "IOC_Chinese",
            "Chinese (Traditional)": "IOC_Chinese_trad",
        }
    )

    # Add eBird-side keys for fallback matching
    merged["eng1_left"] = merged["PRIMARY_COM_NAME"].map(norm1)
    merged["eng2_left"] = merged["PRIMARY_COM_NAME"].map(norm2)
    merged["engk_left"] = merged["PRIMARY_COM_NAME"].map(normkey)

    # Helper: fill from aligned series (avoid ndarray fillna issues)
    def fill_series(target: pd.Series, fill_values: pd.Series) -> pd.Series:
        return target.where(target.notna(), fill_values)

    # 2) Fallback: engk key match
    need = merged[merged["IOC_Chinese"].isna()].index
    join1 = pd.DataFrame({"engk": merged.loc[need, "engk_left"]}).merge(
        ioc_clean[["engk", "Chinese", "Chinese (Traditional)"]],
        on="engk",
        how="left",
    )
    merged.loc[need, "IOC_Chinese"] = fill_series(
        merged.loc[need, "IOC_Chinese"],
        pd.Series(join1["Chinese"].values, index=need),
    )
    merged.loc[need, "IOC_Chinese_trad"] = fill_series(
        merged.loc[need, "IOC_Chinese_trad"],
        pd.Series(join1["Chinese (Traditional)"].values, index=need),
    )

    # 3) Fallback: "Prefix Base" -> "Base (Prefix)" on eng1
    need2 = merged[merged["IOC_Chinese"].isna()].index
    cand = merged.loc[need2, "PRIMARY_COM_NAME"].apply(invert_prefix).map(norm1)
    ioc_by_eng1 = ioc_clean.set_index("eng1")
    cn_tr = ioc_by_eng1.reindex(cand)[["Chinese", "Chinese (Traditional)"]]
    merged.loc[need2, "IOC_Chinese"] = fill_series(
        merged.loc[need2, "IOC_Chinese"],
        pd.Series(cn_tr["Chinese"].values, index=need2),
    )
    merged.loc[need2, "IOC_Chinese_trad"] = fill_series(
        merged.loc[need2, "IOC_Chinese_trad"],
        pd.Series(cn_tr["Chinese (Traditional)"].values, index=need2),
    )

    # 4) If Simplified missing but Traditional present -> copy Traditional as placeholder
    need3 = merged[merged["IOC_Chinese"].isna() & merged["IOC_Chinese_trad"].notna()].index
    merged.loc[need3, "IOC_Chinese"] = merged.loc[need3, "IOC_Chinese_trad"]

    # 5) Manual variants matching against IOC eng1
    need4 = merged[merged["IOC_Chinese"].isna()].index
    hits_cn = pd.Series(index=need4, dtype=object)
    hits_tr = pd.Series(index=need4, dtype=object)

    for idx in need4:
        title = merged.at[idx, "PRIMARY_COM_NAME"]
        for cand_eng in manual_variants(title):
            if cand_eng in ioc_by_eng1.index:
                row = ioc_by_eng1.loc[cand_eng]
                if isinstance(row, pd.DataFrame):
                    # take first row; prefer one with Chinese if possible
                    row2 = row[row["Chinese"].notna()].head(1)
                    row = (row2 if len(row2) else row.head(1)).iloc[0]
                hits_cn.at[idx] = row.get("Chinese")
                hits_tr.at[idx] = row.get("Chinese (Traditional)")
                if pd.notna(hits_cn.at[idx]) or pd.notna(hits_tr.at[idx]):
                    break

    merged.loc[need4, "IOC_Chinese"] = fill_series(merged.loc[need4, "IOC_Chinese"], hits_cn)
    merged.loc[need4, "IOC_Chinese_trad"] = fill_series(merged.loc[need4, "IOC_Chinese_trad"], hits_tr)

    # Final outputs
    mapping_df = merged[["PRIMARY_COM_NAME", "SCI_NAME", "IOC_Chinese"]].rename(
        columns={
            "PRIMARY_COM_NAME": "eBird_English",
            "SCI_NAME": "Scientific",
        }
    )

    mapping_dict = {
        r["eBird_English"]: f'{r["eBird_English"]}({r["IOC_Chinese"]})'
        for _, r in mapping_df.dropna(subset=["IOC_Chinese"]).iterrows()
    }

    remaining_unmatched_df = mapping_df[mapping_df["IOC_Chinese"].isna()][
        ["eBird_English", "Scientific"]
    ].reset_index(drop=True)

    return mapping_df, mapping_dict, remaining_unmatched_df


def write_output(
    output_path: str | Path,
    mapping_df: pd.DataFrame,
    mapping_dict: Dict[str, str],
) -> None:
    """
    Write mapping to output_path.
      - .json -> mapping_dict
      - .csv  -> mapping_df
    """
    output_path = Path(output_path)
    suffix = output_path.suffix.lower()

    if suffix == ".json":
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(mapping_dict, f, ensure_ascii=False, indent=2)
    elif suffix == ".csv":
        mapping_df.to_csv(output_path, index=False)
    else:
        raise ValueError(f"Unsupported output extension: {suffix}. Use .json or .csv")


# ----------------------------
# Main
# ----------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build eBird English -> IOC Chinese mapping (Simplified)."
    )
    parser.add_argument(
        "--ebird",
        default="eBird_taxonomy_v2025.xlsx",
        help="Path to eBird taxonomy xlsx (default: eBird_taxonomy_v2025.xlsx)",
    )
    parser.add_argument(
        "--ioc",
        default="Multiling IOC 15.1_c.xlsx",
        help="Path to IOC multilingual xlsx (default: Multiling IOC 15.1_c.xlsx)",
    )
    parser.add_argument(
        "--out",
        default="birdMap.json",
        help="Output file (.json or .csv). Default: ebird_en_to_ioc_cn_mapping_fixed.json",
    )
    parser.add_argument(
        "--unmatched",
        default="remaining_unmatched_species.csv",
        help="Write remaining unmatched list to this CSV (default: remaining_unmatched_species.csv)",
    )

    args = parser.parse_args()

    mapping_df, mapping_dict, remaining = build_ebird_en_to_ioc_cn_map(args.ebird, args.ioc)

    write_output(args.out, mapping_df, mapping_dict)

    # Always write unmatched list for audit
    Path(args.unmatched).parent.mkdir(parents=True, exist_ok=True)
    remaining.to_csv(args.unmatched, index=False)

    matched = mapping_df["IOC_Chinese"].notna().sum()
    total = len(mapping_df)
    print(f"Done. Matched: {matched}/{total}, Unmatched: {total - matched}")
    print(f"Output: {args.out}")
    print(f"Remaining unmatched list: {args.unmatched}")


if __name__ == "__main__":
    main()