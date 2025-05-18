PROP_MODEL_MAP = {
    "hits": "Hits",
    "home_runs": "Home_Runs",
    "rbis": "RBIs",
    "strikeouts_pitching": "Strikeouts_Pitching",
    "strikeouts_batting": "Strikeouts_Batting",
    "runs_scored": "Runs_Scored",
    "walks": "Walks",
    "doubles": "Doubles",
    "triples": "Triples",
    "outs_recorded": "Outs_Recorded",
    "earned_runs": "Earned_Runs",
    "hits_allowed": "Hits_Allowed",
    "walks_allowed": "Walks_Allowed",
    "stolen_bases": "Stolen_Bases",
    "total_bases": "Total_Bases",
    "hits_runs_rbis": "Hits_Runs_RBIs",
    "runs_rbis": "Runs_RBIs",
    "singles": "Singles"
}

def normalize_prop_type(prop_type: str) -> str:
    if not prop_type:
        return None
    formatted = (
        prop_type.lower()
        .replace("(", "")
        .replace(")", "")
        .replace(" + ", "_")
        .replace(" ", "_")
        .rstrip("_")
        .strip()
    )
    return formatted

def get_canonical_model_name(prop_type: str) -> str | None:
    norm = normalize_prop_type(prop_type)
    return PROP_MODEL_MAP.get(norm)
