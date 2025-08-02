# backend/app/api_server.py

import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# 🧼 Route imports
from app.routes.api.player_profile import router as player_profile_router
from app.routes.api.prepare_prop import router as prepare_prop_router
from app.routes.api.predict import router as predict_router
from app.routes.api.model_metrics import router as model_metrics_router
from app.routes.api.user_vs_model_accuracy import router as user_vs_model_accuracy_router
from app.routes.api.user_vs_model_accuracy_weekly import router as user_vs_model_weekly_router
from app.routes.api.model_accuracy_weekly import router as model_accuracy_weekly_router
from backend.app.routes.api import player_list
from app.routes.api.prepare_prop import router as prepare_prop_router

app = FastAPI()

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
app.include_router(predict_router)
app.include_router(prepare_prop_router, prefix="/api")
app.include_router(player_profile_router)
app.include_router(model_metrics_router)
app.include_router(user_vs_model_accuracy_router)
app.include_router(user_vs_model_weekly_router)
app.include_router(model_accuracy_weekly_router)
app.include_router(player_list.router)
