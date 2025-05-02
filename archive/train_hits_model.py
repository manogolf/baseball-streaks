# Run this script from the project root:
# python3 src/scripts/train_hits_model.py

import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, roc_auc_score

# Load enriched Hits dataset
df = pd.read_csv("by_prop_type/Hits_with_streaks.csv")

# Drop nulls for available columns
required_cols = ['outcome', 'prop_value', 'rolling_result_avg_7', 'hit_streak', 'win_streak']
optional_cols = ['home_away', 'opponent']
existing_cols = [col for col in required_cols + optional_cols if col in df.columns]
df = df.dropna(subset=existing_cols)

# Compute line_diff
df['line_diff'] = df['rolling_result_avg_7'] - df['prop_value']


# Outcome encoding
df['outcome_binary'] = df['outcome'].map({'win': 1, 'loss': 0})

# Context handling
df['is_home'] = df['home_away'].map({'home': 1, 'away': 0}) if 'home_away' in df.columns else 0
df['opponent_encoded'] = (
    df['opponent'].map(df.groupby('opponent')['outcome_binary'].mean()) if 'opponent' in df.columns else 0
)

# Features
features = [
    'line_diff', 'hit_streak', 'win_streak',
    'is_home', 'opponent_encoded'
]

X = df[features]
y = df['outcome_binary']

# Split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Train Random Forest
model = RandomForestClassifier(n_estimators=100, max_depth=6, random_state=42)
model.fit(X_train, y_train)

# Predict
y_pred = model.predict(X_test)
y_prob = model.predict_proba(X_test)[:, 1]

# Evaluate
print("Classification Report:")
print(classification_report(y_test, y_pred))
print(f"AUC Score: {roc_auc_score(y_test, y_prob):.3f}")

# Feature importance
print("\nFeature Importances:")
for feat, score in zip(features, model.feature_importances_):
    print(f"{feat}: {score:.4f}")
