import sys
import os, time
from contextlib import asynccontextmanager

# Ensure package resolution (keep if you rely on it)
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse
import time

# ---- Routers (import the APIRouter objects directly) ----
from backend.app.routes.api.player_profile import router as player_profile_router
from backend.app.routes.api.prepare_prop import router as prepare_router
from backend.app.routes.api.predict import router as predict_router
from backend.app.routes.api.model_metrics import router as model_metrics_router
from backend.app.routes.api.user_vs_model_accuracy import router as user_vs_model_accuracy_router
from backend.app.routes.api.user_vs_model_accuracy_weekly import router as user_vs_model_weekly_router
from backend.app.routes.api.model_accuracy_weekly import router as model_accuracy_weekly_router
from backend.app.routes.api.player_list import router as player_list_router
from backend.app.routes.api.players import router as players_router
from backend.app.routes.api.props import router as props_router
from backend.app.services.model_registry import load_model
from backend.app.routes.api.score_prop import router as score_prop_router

COMMON_PROPS = [
    "hits", "home_runs", "rbis", "runs_scored", "strikeouts_batting", "walks",
    "total_bases", "singles", "doubles", "triples", "stolen_bases",
    "strikeouts_pitching", "outs_recorded", "earned_runs", "hits_allowed",
    "walks_allowed", "hits_runs_rbis", "runs_rbis",
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("PRELOAD_MODELS", "0") == "1":
        props = os.getenv("PREWARM_PROPS")
        props_to_load = [p.strip() for p in props.split(",") if p.strip()] if props else COMMON_PROPS
        for p in props_to_load:
            for algo in ("random_forest","logistic_regression"):
                try:
                    load_model(p, algo)
                    print(f"✅ Warmed model: {p} / {algo}")
                except Exception as e:
                    print(f"⚠️ Failed to warm model {p} / {algo}: {e}")
    else:
        print("⏩ Skipping model prewarm (PRELOAD_MODELS=0)")
    yield

app = FastAPI(lifespan=lifespan)

# Health endpoints (Render probe)
@app.api_route("/", methods=["GET","HEAD"], include_in_schema=False)
def root_ok():
    return PlainTextResponse("OK", status_code=200)

@app.api_route("/health", methods=["GET","HEAD"], include_in_schema=False)
def health_ok():
    return JSONResponse({"ok": True})

@app.api_route("/healthz", methods=["GET","HEAD"], include_in_schema=False)
def healthz_ok():
    return JSONResponse({"status": "ok", "ts": int(time.time())})

# ⬇️ Import and register routers AFTER app creation
def register_routes(app: FastAPI) -> None:
    from backend.app.routes.api.player_profile import router as player_profile_router
    from backend.app.routes.api.prepare_prop import router as prepare_router
    from backend.app.routes.api.predict import router as predict_router
    from backend.app.routes.api.model_metrics import router as model_metrics_router
    from backend.app.routes.api.user_vs_model_accuracy import router as user_vs_model_accuracy_router
    from backend.app.routes.api.user_vs_model_accuracy_weekly import router as user_vs_model_weekly_router
    from backend.app.routes.api.model_accuracy_weekly import router as model_accuracy_weekly_router
    from backend.app.routes.api.player_list import router as player_list_router
    from backend.app.routes.api.players import router as players_router
    
    # from backend.app.routes.api.games import router as games_router  # if exists

    # CORS middleware (keep)
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

    # API routes
    app.include_router(players_router, prefix="/api", tags=["players"])
    app.include_router(prepare_router, prefix="/api", tags=["prepare"])
    app.include_router(predict_router, prefix="/api", tags=["predict"])
    app.include_router(player_profile_router)
    app.include_router(model_metrics_router)
    app.include_router(user_vs_model_accuracy_router)
    app.include_router(user_vs_model_weekly_router)
    app.include_router(model_accuracy_weekly_router)
    app.include_router(player_list_router)
    app.include_router(score_prop_router, tags=["poisson"])
    # app.include_router(games_router, prefix="/api", tags=["games"])

register_routes(app)