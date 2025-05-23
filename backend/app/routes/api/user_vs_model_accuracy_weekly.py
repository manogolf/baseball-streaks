from fastapi import APIRouter
from app.supabase_client import supabase

router = APIRouter()

@router.get("/api/user-vs-model-accuracy-weekly")
async def get_user_vs_model_accuracy_weekly():
    result = supabase.from_("user_vs_model_accuracy_weekly_view").select("*").execute()
    return result.data
