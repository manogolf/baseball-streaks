# ml/feature_utils.py

from pathlib import Path
import json

FEATURE_META_PATH = Path("backend/scripts/modeling/feature_metadata.json")

def _load_meta():
    return json.loads(FEATURE_META_PATH.read_text())

def load_feature_list(task: str, family: str) -> list[str]:
    meta = _load_meta()
    entry = meta.get(task, {})
    return list(dict.fromkeys(entry.get(family, [])))  # preserve order, de-dupe

def load_feature_union(task: str) -> list[str]:
    meta = _load_meta()
    entry = meta.get(task, {})
    rf = entry.get("random_forest", [])
    lr = entry.get("logistic_regression", [])
    seen, out = set(), []
    for c in rf + lr:  # RF first, then LR
        if c not in seen:
            seen.add(c); out.append(c)
    return out
