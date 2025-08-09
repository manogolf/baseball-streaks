# backend/app/api_server.py
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

# 🧼 Route imports
from app.routes.api.player_profile import router as player_profile_router
from app.routes.api.prepare_prop import router as prepare_prop_router
from app.routes.api.predict import router as predict_router
from app.routes.api.model_metrics import router as model_metrics_router
from app.routes.api.user_vs_model_accuracy import router as user_vs_model_accuracy_router
from app.routes.api.user_vs_model_accuracy_weekly import router as user_vs_model_weekly_router
from app.routes.api.model_accuracy_weekly import router as model_accuracy_weekly_router
from backend.app.routes.api import player_list
from app.services.model_registry import load_model

COMMON_PROPS = [
    "hits", "home_runs", "rbi", "runs_scored", "strikeouts_batting", "walks",
    "total_bases", "singles", "doubles", "triples", "stolen_bases",
    "strikeouts_pitching", "outs_recorded", "earned_runs", "hits_allowed",
    "walks_allowed", "hits_runs_rbis", "runs_rbis",
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("PRELOAD_MODELS", "0") == "1":
        props = os.getenv("PREWARM_PROPS")
        if props:
            props_to_load = [p.strip() for p in props.split(",") if p.strip()]
        else:
            props_to_load = COMMON_PROPS

        for p in props_to_load:
            for algo in ("random_forest", "logistic_regression"):
                try:
                    load_model(p, algo)
                    print(f"✅ Warmed model: {p} / {algo}")
                except Exception as e:
                    print(f"⚠️ Failed to warm model {p} / {algo}: {e}")
    else:
        print("⏩ Skipping model prewarm (PRELOAD_MODELS=0)")
    yield

app = FastAPI(lifespan=lifespan)

@app.get("/health")
def health():
    return {"ok": True}

# ✅ CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://www.proppadia.com",
        "https://baseball-streaks-idcq8g8bq-manogolfs-projects.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Register routes
app.include_router(predict_router, prefix="/api")
app.include_router(prepare_prop_router, prefix="/api")
app.include_router(player_profile_router)
app.include_router(model_metrics_router)
app.include_router(user_vs_model_accuracy_router)
app.include_router(user_vs_model_weekly_router)
app.include_router(model_accuracy_weekly_router)
app.include_router(player_list.router)
