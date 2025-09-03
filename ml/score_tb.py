# ml/score_tb.py
# Score any batter TB CSV using the trained pipeline + isotonic calibrators.

import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd
from joblib import load

def iso_apply(raw_pred: np.ndarray, x: list, y: list) -> np.ndarray:
    xv = np.asarray(x, dtype=float)
    yv = np.asarray(y, dtype=float)
    return np.interp(raw_pred, xv, yv, left=yv[0], right=yv[-1])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in",  dest="in_path",  required=True, help="Input CSV (e.g., ml/today_batter_tb.csv)")
    ap.add_argument("--out", dest="out_path", default="ml/today_tb_predictions.csv", help="Output CSV")
    ap.add_argument("--model", default="ml/models/tb_poisson_v1.joblib")
    ap.add_argument("--feats", default="ml/models/tb_features_v1.json")
    ap.add_argument("--cal",   default="ml/models/tb_calibrators_v1.json")
    args = ap.parse_args()

    IN   = Path(args.in_path)
    OUT  = Path(args.out_path)
    M    = Path(args.model)
    F    = Path(args.feats)
    CAL  = Path(args.cal)

    df = pd.read_csv(IN)
    if "game_date" in df.columns:
        df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")

    pipe = load(M)
    feature_cols = json.loads(F.read_text())

    # align columns
    for c in feature_cols:
        if c not in df.columns:
            df[c] = np.nan
    X = df[feature_cols].copy()

    # basic impute (mirrors training)
    cat_cols = [c for c in X.columns if X[c].dtype == "object"]
    num_cols = [c for c in X.columns if c not in cat_cols]
    for c in num_cols:
        X[c] = pd.to_numeric(X[c], errors="coerce").fillna(0.0)
    for c in cat_cols:
        X[c] = X[c].fillna("UNK")

    # predict expected TB
    tb_expected = pipe.predict(X)

    # load isotonic calibrators (optional)
    probs = {}
    if CAL.exists():
        calibrators = json.loads(CAL.read_text())
        for name, cal in calibrators.items():   # keys like "0_5","1_5","2_5"
            probs[f"p_over_{name}"] = iso_apply(tb_expected, cal["x"], cal["y"])
    else:
        calibrators = None

    # build output
    keep = [c for c in ("game_id","player_id","player_name","team","opponent","game_date") if c in df.columns]
    out = df[keep].copy()
    out["tb_expected"] = tb_expected
    for k, v in probs.items():
        out[k] = v

    # sort for convenience
    if "p_over_1_5" in out.columns:
        out = out.sort_values("p_over_1_5", ascending=False)
    else:
        out = out.sort_values("tb_expected", ascending=False)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(OUT, index=False)
    print(f"Wrote {OUT} (rows={len(out):,})")

    if "p_over_1_5" in out.columns:
        bins = pd.cut(out["p_over_1_5"], [0,.2,.3,.4,.5,.6,.7,.8,1.0], right=False)
        print("\nPreview: p_over_1_5 bins")
        print(out.groupby(bins, observed=False).size())

if __name__ == "__main__":
    main()
