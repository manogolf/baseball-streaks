# Run from project root:
# python3 src/scripts/train_and_export_hits_model.py

import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, roc_auc_score
import joblib
import os

# Load enriched data
df = pd.read_csv("by_prop_type/Hits_with_streaks.csv")

# Drop nulls
required_cols = ['outcome', 'prop_value', 'rolling_result_avg_7', 'hit_streak', 'win_streak']
optional_cols = ['home_away', 'opponent']
existing_cols = [col for col in required_cols + optional_cols if col in df.columns]
df = df.dropna(subset=existing_cols)

# Binary outcome
df['outcome_binary'] = df['outcome'].map({'win': 1, 'loss': 0})

# Context features
df['is_home'] = df['home_away'].map({'home': 1, 'away': 0}) if 'home_away' in df.columns else 0
df['opponent_encoded'] = (
    df['opponent'].map(df.groupby('opponent')['outcome_binary'].mean()) if 'opponent' in df.columns else 0
)

# Feature: line_diff = hot/cold signal vs. line
df['line_diff'] = df['rolling_result_avg_7'] - df['prop_value']

# Features and labels
features = [
    'line_diff', 'hit_streak', 'win_streak',
    'is_home', 'opponent_encoded'
]
X = df[features]
y = df['outcome_binary']

# Split and train
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
model = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42)
model.fit(X_train, y_train)

# Evaluate
y_pred = model.predict(X_test)
y_prob = model.predict_proba(X_test)[:, 1]

print("Classification Report:")
print(classification_report(y_test, y_pred))
print(f"AUC Score: {roc_auc_score(y_test, y_prob):.3f}")

print("\nFeature Importances:")
for feat, score in zip(features, model.feature_importances_):
    print(f"{feat}: {score:.4f}")

# Save model
os.makedirs("models", exist_ok=True)
joblib.dump(model, "models/hits_model.pkl")
print("\n✅ Model saved to: models/hits_model.pkl")
