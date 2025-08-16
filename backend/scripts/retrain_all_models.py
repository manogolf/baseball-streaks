# backend/scripts/retrain_all_models.py
"""
Cron-friendly retrain driver.

Usage examples:
  python backend/scripts/retrain_all_models.py --quiet
  python backend/scripts/retrain_all_models.py --days-back 365 --limit 80000
"""

import argparse
from datetime import datetime

from model_trainer import train_models_for_prop, PROP_TYPES, DEFAULT_DAYS_BACK, DEFAULT_ROW_LIMIT


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true", help="minimal logs")
    ap.add_argument("--days-back", type=int, default=DEFAULT_DAYS_BACK, help="look-back window for training rows")
    ap.add_argument("--limit", type=int, default=DEFAULT_ROW_LIMIT, help="max rows per prop")
    args = ap.parse_args()

    summaries = []
    for prop in PROP_TYPES:
        s = train_models_for_prop(prop, days_back=args.days_back, limit=args.limit, quiet=args.quiet)
        if s:
            summaries.append(s)

    if not args.quiet:
        print("\n🏁 Done.")
        for s in summaries:
            print(f"• {s['prop_type']}: rows={s['rows']} AUC(LR/RF)={s['auc_lr']}/{s['auc_rf']} → {s['latest_path']}")

if __name__ == "__main__":
    main()
