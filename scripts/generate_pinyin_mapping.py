import json
import re
import pandas as pd
from pypinyin import lazy_pinyin  # 需要先: pip install pypinyin


# 1. 读 birdMap.json（英文名 -> "英文名(中文名)"）
with open("birdMap.json", "r", encoding="utf-8") as f:
    bird_map = json.load(f)


def extract_chinese_name(full_str: str) -> str:
    """
    从类似 'Emu(鸸鹋)' 里提取出 '鸸鹋'
    如果没有括号就返回空字符串
    """
    if not full_str:
        return ""
    m = re.search(r"\(([^()]+)\)\s*$", full_str)
    return m.group(1) if m else ""


def get_pinyin_and_initials(chinese_name: str):
    """
    用 pypinyin 把中文名转成全拼 + 首字母
    例如: 鸸鹋 -> ['er', 'miao'] -> ('ermiao', 'em')
    """
    if not chinese_name:
        return "", ""

    syllables = lazy_pinyin(chinese_name)  # ['er', 'miao']
    pinyin_full = "".join(syllables)       # 'ermiao'
    initials = "".join(s[0] for s in syllables if s)  # 'em'
    return pinyin_full, initials


# 2. 读 eBird_taxonomy_v2025.xlsx
df = pd.read_excel("eBird_taxonomy_v2025.xlsx")

# 你关心的列：PRIMARY_COM_NAME, SCI_NAME, SPECIES_CODE
mapping = {}

for _, row in df.iterrows():
    eng = row["PRIMARY_COM_NAME"]
    sci = row["SCI_NAME"]
    code = row["SPECIES_CODE"]

    # 有些行可能是空的，直接跳过
    if pd.isna(eng) or pd.isna(code):
        continue

    eng = str(eng).strip()
    sci = "" if pd.isna(sci) else str(sci).strip()
    code = str(code).strip()

    # 从 birdMap.json 里拿到带中文名的字符串，例如 "Emu(鸸鹋)"
    full_name = bird_map.get(eng, "")
    cn_name = extract_chinese_name(full_name)

    # 用 pypinyin 得到全拼和首字母
    pinyin, initials = get_pinyin_and_initials(cn_name)

    mapping[eng] = {
        "pinyin": pinyin,
        "initials": initials,
        "code": code,
        "name": eng,
        "latin": sci,
    }

# 3. 存成 json 文件
with open("pinyin_mapping.json", "w", encoding="utf-8") as f:
    json.dump(mapping, f, ensure_ascii=False, indent=4)

print("Done, written to pinyin_mapping.json")