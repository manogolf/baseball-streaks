from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import predict

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
