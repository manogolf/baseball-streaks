from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sys
sys.path.append("src/scripts")
from score_any_prop import predict_prop


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

@app.post("/predict")
def predict(input: PropInput):
    print("📥 API received:", input.model_dump())
    result = predict_prop(input.prop_type, input.model_dump())
    print("🔮 Model response:", result)
    return result

@app.get("/")
def root():
    return {"message": "Baseball Streaks API is live"}


@app.get("/health")
def health_check():
    return {"status": "ok"}
