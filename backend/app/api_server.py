# backend/app/api_server.py

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import predict  # 🔁 new route
from app.routes import player_profile  # 🔁 player profile route

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

# ✅ Mount route
app.include_router(predict.router)

# ✅ Health check
@app.get("/health")
def health_check():
    return {"status": "ok"}
