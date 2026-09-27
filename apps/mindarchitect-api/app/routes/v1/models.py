"""
Models API Route
Exposes sovereign V-Series and M-Series hierarchy to the Studio UI and Developer Clients.
"""

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from app.services.model_registry import ModelRegistryService, ModelMetadata

router = APIRouter()

@router.get("/models", response_model=List[ModelMetadata])
async def list_models(series: Optional[str] = Query(None, description="Filter by series (e.g. V-Series, M-Series)")):
    """Lists all registered sovereign models in MindArchitect Studio."""
    return ModelRegistryService.list_models(series=series)

@router.get("/models/{model_id}", response_model=ModelMetadata)
async def get_model(model_id: str):
    """Retrieves metadata and status for a specific sovereign model."""
    model = ModelRegistryService.get_model(model_id)
    if not model:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found in sovereign registry")
    return model
