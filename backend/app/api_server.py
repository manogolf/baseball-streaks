from fastapi import FastAPI, Request, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.score_any_prop import predict_prop
from supabase import create_client, Client
import os
import httpx

# ✅ Supabase Client Setup
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ✅ Create App
app = FastAPI()

# ✅ CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",         
        "https://www.proppadia.com",
        "https://proppadia.com",     
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def normalize_input(raw: dict) -> dict:
    """Ensures prediction input has all required fields with correct names and defaults."""
    return {
        "prop_type": raw.get("prop_type"),
        "prop_value": float(raw.get("prop_value", 0)),
        "rolling_result_avg_7": float(raw.get("rolling_result_avg_7", 0)),
        "hit_streak": int(raw.get("hit_streak", 0)),
        "win_streak": int(raw.get("win_streak", 0)),
        "is_home": int(raw.get("is_home", 0)),
        "opponent_avg_win_rate": float(
            raw.get("opponent_avg_win_rate") or raw.get("opponent_win_rate") or 0
        ),
        "over_under": raw.get("over_under", "").lower(),
        "player_id": raw.get("player_id", "unknown-player"),
    }


# ✅ Prediction Input Model
class PropInput(BaseModel):
    prop_type: str
    prop_value: float
    rolling_result_avg_7: float
    hit_streak: int
    win_streak: int
    is_home: int
    opponent_avg_win_rate: float | None = 0
    over_under: str
    player_id: str  # 🔥 Missing earlier — must be included for prediction

# ✅ Prediction Endpoint
@app.post("/predict")
def predict(raw_input: dict):  # ⬅️ Accept raw dict, not Pydantic model
    print("📥 Raw input received:", raw_input)

    normalized = normalize_input(raw_input)
    print("🧼 Normalized input:", normalized)

    # Fetch streaks
    streak_resp = supabase.table("player_streak_profiles") \
    .select("streak_count, streak_type") \
    .eq("player_id", normalized["player_id"]) \
    .eq("prop_type", normalized["prop_type"]) \
    .maybe_single()
    .execute()

    if not streak_resp:
     streak_data = {}
    else:
     streak_data = streak_resp

    streak_count = streak_data.get("streak_count", 0)
    streak_type = streak_data.get("streak_type", "neutral")


    print(f"🔥 Streak: {streak_type} ({streak_count})")

    enriched_input = {
        **normalized,
        "streak_count": streak_count,
        "streak_type": streak_type,
    }

    result = predict_prop(normalized["prop_type"], enriched_input)
    print("🔮 Model response:", result)
    return result


# ✅ Root Test Route
@app.get("/")
def root():
    return {"message": "Baseball Streaks API is live"}

# ✅ Player Profile Endpoint
@app.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str):
    props_resp = supabase.table("player_props") \
        .select("*") \
        .eq("player_id", player_id) \
        .neq("outcome", None) \
        .order("game_date", desc=True) \
        .limit(10) \
        .execute()

    props = props_resp.data or []
    recent_outcomes = [p["outcome"] for p in props]
    wins = sum(1 for o in recent_outcomes if o == "win")
    rolling_avg = wins / len(recent_outcomes) if recent_outcomes else 0

    hit_streak = 0
    for o in recent_outcomes:
        if o == "win":
            hit_streak += 1
        else:
            break

    mlb_url = f"https://statsapi.mlb.com/api/v1/people/{player_id}?hydrate=stats(group=[hitting,pitching],type=[career,season])"
    async with httpx.AsyncClient() as client:
        mlb_resp = await client.get(mlb_url)
    mlb_data = mlb_resp.json()
    stats = mlb_data.get("people", [{}])[0].get("stats", [])

    career_stats = next((s["splits"][0]["stat"] for s in stats if s["type"]["displayName"] == "career"), {})
    season_stats = next((s["splits"][0]["stat"] for s in stats if s["type"]["displayName"] == "season"), {})

    return {
        "player_id": player_id,
        "recent_props": props,
        "rolling_result_avg_7": round(rolling_avg, 3),
        "hit_streak": hit_streak,
        "career_stats": career_stats,
        "season_stats": season_stats,
    }

# ✅ Health check
@app.get("/health")
def health_check():
    return {"status": "ok"}
