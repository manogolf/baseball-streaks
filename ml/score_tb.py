# ml/score_tb.py
import argparse, json
import numpy as np
import pandas as pd
from pathlib import Path
from joblib import load

def load_artifacts(models_dir=Path("ml/models")):
    pipe = load(models_dir / "tb_poisson_v1.joblib")
    feature_cols = json.loads((models_dir / "tb_features_v1.json").read_text())
    calibrators = json.loads((models_dir / "tb_calibrators_v1.json").read_text())
    return pipe, feature_cols, calibrators

def iso_predict(raw, cal):
    xs = np.asarray(cal["x"], dtype=float)
    ys = np.asarray(cal["y"], dtype=float)
    return np.interp(raw, xs, ys)  # piecewise-linear calibration

def main(inp, outp):
    pipe, feature_cols, calibrators = load_artifacts()

    df = pd.read_csv(inp)
    # Keep IDs if present so you can join back
    id_cols = [c for c in ["game_id","player_id","game_date"] if c in df.columns]
    ids = df[id_cols].copy() if id_cols else pd.DataFrame()

    # Subset to the exact features (order matters)
    X = df[feature_cols].copy()

    # Mirror training imputations
    for c in X.columns:
        if pd.api.types.is_numeric_dtype(X[c]):
            X[c] = pd.to_numeric(X[c], errors="coerce").fillna(0.0)
        else:
            X[c] = X[c].astype("object").fillna("UNK")

    mu_tb = pipe.predict(X)

    out = ids.copy()
    out["mu_tb"] = mu_tb

    # Calibrated probabilities for the lines you saved (e.g., "0_5","1_5","2_5")
    for name, cal in calibrators.items():
        out[f"p_over_{name}"] = iso_predict(mu_tb, cal)

    out.to_csv(outp, index=False)
    print(f"Wrote {outp} with mu_tb and calibrated probabilities.")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--in",  dest="inp",  required=True, help="CSV with today features")
    ap.add_argument("--out", dest="outp", required=True, help="Where to write scores")
    args = ap.parse_args()
    main(args.inp, args.outp)
