PROP_MODEL_MAP = {
    "hits": "hits",
    "home_runs": "home_runs",
    "rbis": "rbis",
    "strikeouts_pitching": "strikeouts_pitching",
    "strikeouts_batting": "strikeouts_batting",
    "runs_scored": "runs_scored",
    "walks": "walks",
    "doubles": "doubles",
    "triples": "triples",
    "outs_recorded": "outs_recorded",
    "earned_runs": "earned_runs",
    "hits_allowed": "hits_allowed",
    "walks_allowed": "walks_allowed",
    "stolen_bases": "stolen_bases",
    "total_bases": "total_bases",
    "hits_runs_rbis": "hits_runs_rbis",
    "runs_rbis": "runs_rbis",
    "singles": "singles"
}

def normalize_prop_type(prop_type: str) -> str:
    return (
        prop_type.lower()
        .replace("(", "")
        .replace(")", "")
        .replace(" + ", "_")
        .replace(" ", "_")
        .strip("_")
    )

def get_canonical_model_name(prop_type: str) -> str | None:
    key = normalize_prop_type(prop_type)
    return PROP_MODEL_MAP.get(key)
