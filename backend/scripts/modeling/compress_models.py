# 📄 compress_models.py
import os
import joblib

# Set your uncompressed + compressed model root
MODEL_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../models"))

# List all prop types (or auto-detect folders)
prop_types = [
    name for name in os.listdir(MODEL_ROOT)
    if os.path.isdir(os.path.join(MODEL_ROOT, name))
]

def compress_model(model_path):
    # Create .compressed.pkl from original
    base, ext = os.path.splitext(model_path)
    compressed_path = base + "_compressed.pkl"

    print(f"📦 Compressing: {model_path}")
    model = joblib.load(model_path)
    joblib.dump(model, compressed_path, compress=3)
    print(f"✅ Saved compressed model to: {compressed_path}")

def main():
    for prop_type in prop_types:
        model_dir = os.path.join(MODEL_ROOT, prop_type)
        rf_model = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
        lr_model = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")

        if os.path.exists(rf_model):
            compress_model(rf_model)
        else:
            print(f"⚠️ Missing RF model: {rf_model}")

        if os.path.exists(lr_model):
            compress_model(lr_model)
        else:
            print(f"⚠️ Missing LR model: {lr_model}")

if __name__ == "__main__":
    main()
