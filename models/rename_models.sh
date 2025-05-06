#!/bin/bash

# Navigate to the directory containing the model files
cd "$(dirname "$0")"

# Loop through all model files
for file in *\ *_model.pkl; do
  # Skip files that are already normalized
  if [[ "$file" == *_with_* ]]; then
    continue
  fi

  # Replace spaces with underscores only before "_model.pkl"
  new_file=$(echo "$file" | sed -E 's/ /_/g')

  # Rename the file
  if [[ "$file" != "$new_file" ]]; then
    echo "Renaming: '$file' → '$new_file'"
    mv "$file" "$new_file"
  fi
done

echo "✅ Model renaming complete."
