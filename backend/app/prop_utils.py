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
