# File: backend/scripts/prediction/make_prediction.py

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression

def make_prediction(payload: dict, rf_model=None, lr_model=None) -> dict:
    prop_type = payload["prop_type"]
    features = payload["features"]

    print(f"📊 Running prediction for {prop_type} with features: {features}")

    # Convert features to 2D array (1 sample)
    feature_vector = np.array([list(features.values())])

    # 🚀 Predict with both models
    if rf_model is None or lr_model is None:
        raise ValueError("Random Forest and Logistic Regression models must be provided.")

    rf_proba = rf_model.predict_proba(feature_vector)[0][1]
    lr_proba = lr_model.predict_proba(feature_vector)[0][1]

    hybrid_score = round((rf_proba + lr_proba) / 2, 4)

    print(f"🔢 RF: {rf_proba:.4f}, LR: {lr_proba:.4f}, Hybrid: {hybrid_score:.4f}")

    return {
        "prop_type": prop_type,
        "hybrid_score": hybrid_score,
        "random_forest_score": rf_proba,
        "logistic_regression_score": lr_proba,
        "input_features": features
    }
