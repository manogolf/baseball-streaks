# backend/app/api_server.py

from fastapi import FastAPI
from app.routes import predict

app = FastAPI()

# Register routes
app.include_router(predict.router)
