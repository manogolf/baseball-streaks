# backend/app/routes/api/model_metrics.py
from fastapi import APIRouter
from app.supabase_client import supabase  # This uses your existing client

router = APIRouter()

@router.get("/api/model-metrics")
async def get_model_accuracy():
    result = supabase.rpc("get_model_accuracy_metrics").execute()
    return result.data if result.data else []
