# src/ml/train_model.py
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report
import joblib

# Load your preprocessed data (assuming it's already joined, cleaned, and feature engineered)
df = pd.read_csv('./data/model_training_data.csv')

# Drop rows with missing results or outcomes
df = df.dropna(subset=['result', 'outcome'])

# Convert categorical target to numeric
label_map = {'win': 1, 'loss': 0}  # drop 'push' rows beforehand
df = df[df['outcome'].isin(label_map)]
df['target'] = df['outcome'].map(label_map)

# Drop unnecessary columns and define features
X = df.drop(columns=['outcome', 'target', 'created_at', 'status', 'result'])
y = df['target']

# Encode categorical variables
X = pd.get_dummies(X, drop_first=True)

# Split data
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

# Train model
model = RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1)
model.fit(X_train, y_train)

# Evaluate
y_pred = model.predict(X_test)
print(classification_report(y_test, y_pred))

# Save model
joblib.dump(model, './models/mlb_prop_rf_model.joblib')
print('✅ Model training complete and saved.')
