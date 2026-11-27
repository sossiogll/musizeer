"""
What other programs call the library (ADR-0008 §7, §8), the table "Other tools" of Administration › Root folders. Admin only.

``GET /mappings`` lists every delegating download provider (its import roots, the mappings of its folders to the library,
its notice of files imported outside the library) and every music server with the outcome of its full-sync verification,
each against the library folder of now. A delegate is mapped by ``POST /mappings/{provider}/verify`` (the probe, or a file it
reported) or, as the fallback, by typing its folder (``PUT /mappings/{provider}``). A refusal answers
``{"detail": {"error_code", "error_message", ...}}``.
"""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routes.deps import AdminUserDep, ConfigDep, RegistryDep, SessionDep
from services import mappings as mappings_service
from services.mappings import MappingError

router = APIRouter()


class TypedMapping(BaseModel):
    remote_path: str


@contextmanager
def _refusals():
    try:
        yield
    except MappingError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"error_code": exc.code, "error_message": exc.message, **exc.details},
        ) from None


@router.get("/mappings")
def list_mappings(session: SessionDep, config: ConfigDep, registry: RegistryDep, _admin: AdminUserDep):  # noqa: ARG001
    return mappings_service.overview(session, config, registry)


@router.post("/mappings/{provider}/verify")
def verify_mapping(provider: str, session: SessionDep, config: ConfigDep, registry: RegistryDep, _admin: AdminUserDep):  # noqa: ARG001
    with _refusals():
        return mappings_service.verify(session, config, registry, provider)


@router.put("/mappings/{provider}")
def type_mapping(
    provider: str, body: TypedMapping, session: SessionDep, config: ConfigDep, registry: RegistryDep, _admin: AdminUserDep,  # noqa: ARG001
):
    with _refusals():
        return mappings_service.map_typed(session, config, registry, provider, body.remote_path)


@router.delete("/mappings/{provider}/{mapping_id}")
def delete_mapping(provider: str, mapping_id: str, session: SessionDep, _admin: AdminUserDep):  # noqa: ARG001
    with _refusals():
        mappings_service.delete_mapping(session, provider, mapping_id)
    return {"ok": True}
