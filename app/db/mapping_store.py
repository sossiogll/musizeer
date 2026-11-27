"""
Data access of the mappings (``RootMapping``, ADR-0008 §7, §8): what another program calls the library.

Persistence only: the rules are ``core/mappings.py``, the use cases ``services/mappings.py``. A mapping is unique per
program, role and folder, so recording one is an upsert on that constraint, never a look-then-insert (``db/upsert.py``).
"""
from __future__ import annotations

from datetime import datetime

from sqlmodel import Session, select

from db.models import RootMapping, _now
from db.upsert import upsert


def list_mappings(session: Session, role: str | None = None, provider: str | None = None) -> list[RootMapping]:
    query = select(RootMapping)
    if role is not None:
        query = query.where(RootMapping.role == role)
    if provider is not None:
        query = query.where(RootMapping.provider == provider)
    return list(session.exec(query.order_by(RootMapping.provider, RootMapping.remote_path, RootMapping.id)).all())


def get(session: Session, mapping_id: str) -> RootMapping | None:
    return session.get(RootMapping, mapping_id)


def record(
    session: Session, *, provider: str, role: str, remote_path: str, target_folder: str | None, method: str,
    result: str, detail: str = "", at: datetime | None = None,
) -> RootMapping:
    """Insert the mapping, or update the one with the same program, role and folder. Committed."""
    upsert(
        session,
        RootMapping(
            provider=provider, role=role, remote_path=remote_path, target_folder=target_folder, method=method,
            result=result, detail=detail, verified_at=at or _now(),
        ),
        conflict=("provider", "role", "remote_path"),
        update=("target_folder", "method", "result", "detail", "verified_at"),
    )
    session.commit()
    found = session.exec(select(RootMapping).where(
        RootMapping.provider == provider, RootMapping.role == role, RootMapping.remote_path == remote_path,
    )).one()
    session.refresh(found)
    return found


def delete(session: Session, mapping_id: str) -> bool:
    mapping = session.get(RootMapping, mapping_id)
    if mapping is None:
        return False
    session.delete(mapping)
    session.commit()
    return True
