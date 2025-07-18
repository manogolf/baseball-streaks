import pandas as pd
import numpy as np
import yaml

# Load feature spec YAML (assumes dict already loaded)
with open("model_features.yaml") as f:
    FEATURE_SPEC = yaml.safe_load(f)["features"]

def transform_features(df: pd.DataFrame, spec: dict = FEATURE_SPEC) -> pd.DataFrame | dict:
    if isinstance(df, dict):
        df = pd.DataFrame([df])

    df = df.copy()

    for feature, cfg in spec.items():
        if feature not in df.columns:
            if cfg.get("required", False):
                raise ValueError(f"Missing required feature: {feature}")
            else:
                df[feature] = np.nan

        transform = cfg.get("transform")

    if transform == "one_hot":
        dummies = pd.get_dummies(df[feature], prefix=feature)
        df = pd.concat([df.drop(columns=[feature]), dummies], axis=1)

    elif transform == "bucketize":
            dt_series = pd.to_datetime(df[feature], errors="coerce")
            df[feature + "_bucket"] = dt_series.dt.hour // 4
            df.drop(columns=[feature], inplace=True)

    elif cfg["type"] == "binary":
            df[feature] = df[feature].astype(int)

    elif cfg["type"] == "numeric":
            df[feature] = pd.to_numeric(df[feature], errors="coerce").fillna(0)

    elif cfg["type"] == "categorical":
            df[feature] = df[feature].fillna("unknown")

    # Final return
    if len(df) == 1:
        return df.iloc[0].to_dict()
    return df
