from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import predict
from app.routes.player_profile import router as player_profile_router
from app.routes.api.model_metrics import router as model_metrics_router
from routes.api import user_vs_model_accuracy
from app.routes.api.user_vs_model_accuracy_weekly import router as user_vs_model_weekly_router
from backend.app.routes.api.model_accuracy_weekly import router as model_accuracy_weekly_router




app = FastAPI()


# 🌍 Allowed origins for development and production
allowed_origins = [
    "http://localhost:3000",  # Local React dev server
    "https://www.proppadia.com",  # 🔥 Replace with your live domain
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.include_router(predict.router)
app.include_router(player_profile_router)
app.include_router(model_metrics_router)
app.include_router(user_vs_model_accuracy.router)
app.include_router(user_vs_model_weekly_router)
app.include_router(model_accuracy_weekly_router)

