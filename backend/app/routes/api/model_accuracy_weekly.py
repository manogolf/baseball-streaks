from fastapi import APIRouter
from app.supabase_client import supabase

router = APIRouter()

@router.get("/api/model-accuracy-weekly")
async def get_model_accuracy_weekly():
    result = supabase.from_("model_accuracy_metrics_weekly_view").select("*").execute()
    return result.data
