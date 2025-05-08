from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.score_any_prop import predict_prop
from supabase import create_client, Client
import os

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)




app = FastAPI()

# Allow frontend to access this
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # or specify http://localhost:3000 for your React dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PropInput(BaseModel):
    prop_type: str
    prop_value: float
    rolling_result_avg_7: float
    hit_streak: int
    win_streak: int
    is_home: int
    opponent_avg_win_rate: float | None = 0
    over_under: str

@app.post("/predict")
def predict(input: PropInput):
    print("📥 API received:", input.model_dump())

    # 🔄 Fetch streak data from Supabase
    streak_resp = supabase.table("player_streak_profiles") \
        .select("streak_count, streak_type") \
        .eq("player_id", input.player_id) \
        .eq("prop_type", input.prop_type) \
        .maybe_single()

    streak_count = streak_resp.get("streak_count", 0)
    streak_type = streak_resp.get("streak_type", "neutral")

    print(f"🔥 Streak: {streak_type} ({streak_count})")

    # 🧠 Inject streak features into input dict
    enriched_input = input.model_dump()
    enriched_input["streak_count"] = streak_count
    enriched_input["streak_type"] = streak_type

    # 🔮 Run model prediction
    result = predict_prop(input.prop_type, enriched_input)
    print("🔮 Model response:", result)
    return result


@app.get("/")
def root():
    return {"message": "Baseball Streaks API is live"}


from fastapi import Path
import httpx

@app.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str):
    # 1. Fetch recent resolved props from Supabase
    props_resp = supabase.table("player_props") \
        .select("*") \
        .eq("player_id", player_id) \
        .neq("outcome", None)\
        .order("game_date", desc=True) \
        .limit(10) \
        .execute()

    props = props_resp.data or []

    # 2. Compute rolling average and hit streak
    recent_outcomes = [p["outcome"] for p in props]
    wins = sum(1 for o in recent_outcomes if o == "win")
    rolling_avg = wins / len(recent_outcomes) if recent_outcomes else 0

    hit_streak = 0
    for o in recent_outcomes:
        if o == "win":
            hit_streak += 1
        else:
            break

    # 3. Get career + season stats from MLB API
    mlb_url = f"https://statsapi.mlb.com/api/v1/people/{player_id}?hydrate=stats(group=[hitting,pitching],type=[career,season])"
    async with httpx.AsyncClient() as client:
        mlb_resp = await client.get(mlb_url)
    mlb_data = mlb_resp.json()
    stats = mlb_data.get("people", [{}])[0].get("stats", [])

    career_stats = next((s["splits"][0]["stat"]
                         for s in stats
                         if s["type"]["displayName"] == "career"), {})

    season_stats = next((s["splits"][0]["stat"]
                         for s in stats
                         if s["type"]["displayName"] == "season"), {})

    return {
        "player_id": player_id,
        "recent_props": props,
        "rolling_result_avg_7": round(rolling_avg, 3),
        "hit_streak": hit_streak,
        "career_stats": career_stats,
        "season_stats": season_stats,
    }



@app.get("/health")
def health_check():
    return {"status": "ok"}
