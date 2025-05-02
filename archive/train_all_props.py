# Run from project root:
# python3 src/scripts/train_all_props.py

import os
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score
import joblib

# Props to loop (adjust if needed)
prop_types = [f.replace('.csv', '') for f in os.listdir('by_prop_type') if f.endswith('.csv')]

# Output folder
os.makedirs("models", exist_ok=True)

for prop in prop_types:
    path = f"by_prop_type/{prop}.csv"
    print(f"📦 Processing: {prop}")

    try:
        df = pd.read_csv(path)
        required = ['outcome', 'prop_value', 'rolling_result_avg_7', 'hit_streak', 'win_streak']
        optional = ['home_away', 'opponent']
        cols = [c for c in required + optional if c in df.columns]
        df = df.dropna(subset=cols)

        df['outcome_binary'] = df['outcome'].map({'win': 1, 'loss': 0})
        df['line_diff'] = df['rolling_result_avg_7'] - df['prop_value']
        df['is_home'] = df['home_away'].map({'home': 1, 'away': 0}) if 'home_away' in df.columns else 0
        df['opponent_encoded'] = (
            df['opponent'].map(df.groupby('opponent')['outcome_binary'].mean()) if 'opponent' in df.columns else 0
        )

        features = ['line_diff', 'hit_streak', 'win_streak', 'is_home', 'opponent_encoded']
        X = df[features]
        y = df['outcome_binary']

        if y.nunique() < 2:
            print(f"⚠️ Skipping {prop}: not enough class variation.")
            continue

        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        model = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42)
        model.fit(X_train, y_train)
        auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])

        # Save model
        model_path = f"models/{prop}_model.pkl"
        joblib.dump(model, model_path)
        print(f"✅ Saved: {model_path} | AUC: {auc:.3f}")

    except Exception as e:
        print(f"❌ Failed to process {prop}: {e}")
