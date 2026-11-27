"""
What other programs call the library, the use cases (ADR-0008 §7, §8): the delegate mapping and the full-sync result.

- A **delegate** (a download provider whose external system imports into the library, declared by
  ``supports_import_roots`` / ``supports_locate_in_import_roots``) names its files in its own namespace. The administrator
  maps its folder to the library: by a **probe** (a marker folder ``Musizeer Probe <random>`` is stored in the library
  through the storage provider and the delegate is asked where it sees it, ``locate_in_import_roots``; the marker is
  removed in a ``finally``), by a **suffix** (a file the delegate reported for a delegated download, found in the library
  under the same relative path, for a delegate that cannot locate) or, as the fallback, **typed**.
- Once a delegate has a mapping, a delegated download that completes is registered: the files the delegate reports for it
  (``list_delegated_files``) are translated into library paths and each one the storage confirms becomes a
  ``LibraryEntry`` (``source=delegate``), read like the library scan reads a file. A file outside every mapping is not
  ignored: the delegate's notice says it was imported outside the library the administrator declared.
- A **music server** (a sync provider) reads the library: the existing full-sync verification (``workers.maintenance
  .verify_full_sync``) is the evidence, and its outcome is recorded here with the library folder it was run against.

A mapping or a result established against another library folder than the current one is "to verify again". The table is
``db/mapping_store.py``, the rules ``core/mappings.py``. Nothing here knows a provider by name.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable
from uuid import uuid4

from sqlmodel import Session, select

from core import download_states as ds
from core import mappings as rules
from core.folders import FolderError
from core.tagging import make_probe_audio
from core.utc import utc_iso
from db import mapping_store, root_store
from db.expressions import descending
from db.models import Download, RootMapping
from services import folders
from services.errors import classify_error
from services.workspace import open_workspace

logger = logging.getLogger(__name__)

# The delegate's notice (``host_state``): the last registration that found files it could not put in the library.
NOTICE_PREFIX = "delegate_notice:"
NOTICE_EXAMPLES = 5
# How many recent delegated downloads a verification by suffix looks at.
SUFFIX_DOWNLOADS = 5

# The states of a mapping or of a music server's result, as the page shows them.
STATE_VERIFIED = "verified"
STATE_TYPED = "typed"
STATE_FAILED = "failed"
STATE_VERIFY_AGAIN = "verify_again"
STATE_NOT_VERIFIED = "not_verified"


class MappingError(Exception):
    """A refusal with a stable ``code`` (``error_code`` of the routes), the HTTP ``status`` and ``details``."""

    def __init__(self, code: str, message: str, status: int = 400, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


# ------------------------------------------------------------------
# The library folder
# ------------------------------------------------------------------


@dataclass(frozen=True)
class Library:
    """The active storage provider and the library folder it resolves to now (``folder`` None: not a folder of this
    machine, or not set: ``set`` says which)."""

    storage: Any
    folder: str | None
    set: bool


def library(session: Session, config, registry) -> Library:
    status = folders.library_status(session, config, registry)
    storage = folders.active_storage(config, registry)
    if not status.applicable:
        return Library(storage, None, storage is not None)
    return Library(storage, status.status.resolved, status.status.is_set)


def _state(mapping: RootMapping, current_folder: str | None) -> str:
    if mapping.result == rules.FAILED:
        return STATE_FAILED
    if mapping.target_folder != current_folder:
        return STATE_VERIFY_AGAIN
    return STATE_TYPED if mapping.result == rules.TYPED else STATE_VERIFIED


def mapping_view(mapping: RootMapping, current_folder: str | None) -> dict[str, Any]:
    return {
        "id": mapping.id, "provider": mapping.provider, "role": mapping.role, "remote_path": mapping.remote_path,
        "target_folder": mapping.target_folder, "method": mapping.method, "result": mapping.result,
        "detail": mapping.detail, "verified_at": utc_iso(mapping.verified_at), "state": _state(mapping, current_folder),
    }


# ------------------------------------------------------------------
# The page
# ------------------------------------------------------------------


def is_delegate(provider) -> bool:
    return bool(provider.supports_import_roots() or provider.supports_locate_in_import_roots())


def _authenticate(session: Session, provider):
    from services.auth import auth_manager_for
    from services.credentials import shared_store

    return auth_manager_for(shared_store(session)).authenticate(provider)


def _import_roots(session: Session, provider) -> tuple[list[str] | None, str | None]:
    """The delegate's import roots, normalized, or ``(None, error kind)`` when it could not say."""
    if not provider.supports_import_roots():
        return None, None
    try:
        roots = provider.list_import_roots(_authenticate(session, provider))
    except Exception as exc:  # noqa: BLE001 — the page reports it, a provider failure is never a 500
        return None, classify_error(exc)
    cleaned = [path for path in (rules.remote_path_or_none(root) for root in roots or []) if path]
    return list(dict.fromkeys(cleaned)), None


def _notice(session: Session, provider_name: str) -> dict[str, Any] | None:
    return root_store.state_get(session, NOTICE_PREFIX + provider_name)


def delegate_view(session: Session, provider, current: Library) -> dict[str, Any]:
    mappings = mapping_store.list_mappings(session, rules.WRITER, provider.name)
    roots, error = _import_roots(session, provider)
    mapped = {mapping.remote_path for mapping in mappings if mapping.result != rules.FAILED}
    return {
        "provider": provider.name, "label": provider.label,
        "can_locate": bool(provider.supports_locate_in_import_roots()),
        "import_roots": roots, "import_roots_error": error,
        "unmapped_roots": [root for root in roots or [] if root not in mapped],
        "mappings": [mapping_view(mapping, current.folder) for mapping in mappings],
        "notice": _notice(session, provider.name),
    }


def music_server_view(session: Session, provider, current: Library) -> dict[str, Any]:
    found = mapping_store.list_mappings(session, rules.READER, provider.name)
    result = mapping_view(found[0], current.folder) if found else None
    return {
        "provider": provider.name, "label": provider.label,
        "state": result["state"] if result else STATE_NOT_VERIFIED, "result": result,
    }


def overview(session: Session, config, registry) -> dict[str, Any]:
    """The table "Other tools" of the page: every delegate with its import roots and mappings, and every music server with
    the outcome of its full-sync verification, against the library folder of now."""
    current = library(session, config, registry)
    return {
        "library": {
            "storage_provider": current.storage.name if current.storage is not None else None,
            "folder": current.folder, "set": current.set,
        },
        "delegates": [delegate_view(session, provider, current) for provider in registry.all_download() if is_delegate(provider)],
        "music_servers": [music_server_view(session, provider, current) for provider in registry.all_sync()],
    }


# ------------------------------------------------------------------
# Establishing a mapping
# ------------------------------------------------------------------


def _delegate(registry, name: str):
    provider = registry.get_download_provider(name)
    if provider is None or not is_delegate(provider):
        raise MappingError("mapping_provider_not_found", "No delegating download provider has this name", 404)
    return provider


def _ready_library(session: Session, config, registry) -> Library:
    blocking = folders.blocked(session, config, registry)
    if blocking is not None:
        raise MappingError(blocking.error_code, blocking.message, 409)
    current = library(session, config, registry)
    if current.storage is None:
        raise MappingError("storage_provider_not_found", "No storage provider is active", 409)
    return current


def _forget_notice(session: Session, provider_name: str) -> None:
    root_store.state_delete(session, NOTICE_PREFIX + provider_name)


def _by_probe(session: Session, config, provider, storage) -> tuple[str | None, str]:
    """Put the marker folder into the library, ask the delegate where it sees it, remove it whatever happens."""
    name = f"{rules.PROBE_FOLDER} {uuid4().hex[:12]}"
    relative = f"{name}/probe.ogg"
    storage_session = _authenticate(session, storage)
    delegate_session = _authenticate(session, provider)
    with open_workspace(config.workspace_dir, storage.name) as workspace:
        if not make_probe_audio(name, name, album=name, path=str(workspace.path / "probe.ogg")):
            raise MappingError("probe_failed", "The probe file could not be made", 500)
        storage.store(workspace.file("probe.ogg"), relative, storage_session)
        try:
            located = provider.locate_in_import_roots(name, delegate_session)
        finally:
            try:
                storage.delete(relative, storage_session)
            except Exception as exc:  # noqa: BLE001 — a marker left behind is logged, the answer still counts
                logger.warning("The probe '%s' could not be removed from the library: %s", relative, exc)
    if located is None:
        return None, f"{provider.label} does not see the folder '{name}' in its import roots"
    remote = rules.remote_from_located(located, name)
    if remote is None:
        return None, f"{provider.label} answered '{located}', which is not a folder called '{name}'"
    return remote, f"{provider.label} sees the library as '{remote}'"


def _delegated_files(session: Session, provider) -> list[Any]:
    downloads = session.exec(
        select(Download).where(
            Download.provider_used == provider.name, Download.delegation_handle.is_not(None),
            Download.status == ds.DOWNLOADED,
        ).order_by(descending(Download.completed_at)).limit(SUFFIX_DOWNLOADS)
    ).all()
    delegate_session = _authenticate(session, provider)
    files = []
    for download in downloads:
        files.extend(provider.list_delegated_files(download.delegation_handle, delegate_session))
    return files


def _by_suffix(session: Session, provider, storage) -> tuple[str | None, str]:
    """A file the delegate reported for a delegated download, under the deepest relative path the storage holds."""
    storage_session = _authenticate(session, storage)
    files = _delegated_files(session, provider)
    for ref in files:
        for remote, relative in rules.suffix_candidates(getattr(ref, "path", None)):
            if storage.exists(relative, storage_session):
                return remote, f"'{relative}' is in the library and {provider.label} has it as '{ref.path}'"
    if not files:
        return None, f"{provider.label} has reported no file of a completed delegated download yet"
    return None, f"none of the files {provider.label} reported is in the library"


def verify(session: Session, config, registry, provider_name: str) -> dict[str, Any]:
    """Find which folder of the delegate is the library and record it. A delegate that can locate is verified by the probe,
    otherwise by a suffix; when neither finds it the refusal says so, and the administrator may type the folder. A failed
    verification of a folder already mapped marks that mapping failed."""
    provider = _delegate(registry, provider_name)
    current = _ready_library(session, config, registry)
    method = rules.PROBE if provider.supports_locate_in_import_roots() else rules.SUFFIX
    try:
        if method == rules.PROBE:
            remote, detail = _by_probe(session, config, provider, current.storage)
        else:
            remote, detail = _by_suffix(session, provider, current.storage)
    except MappingError:
        raise
    except Exception as exc:  # noqa: BLE001 — a provider failure is an answer of the page, never a 500
        kind = classify_error(exc)
        raise MappingError("mapping_verification_unavailable", f"The verification could not run ({kind})", 503,
                           {"kind": kind}) from None
    if remote is None:
        for mapping in mapping_store.list_mappings(session, rules.WRITER, provider.name):
            mapping_store.record(
                session, provider=provider.name, role=rules.WRITER, remote_path=mapping.remote_path,
                target_folder=mapping.target_folder, method=method, result=rules.FAILED, detail=detail,
            )
        raise MappingError("mapping_not_located", detail, 422, {"method": method})
    mapping = mapping_store.record(
        session, provider=provider.name, role=rules.WRITER, remote_path=remote, target_folder=current.folder,
        method=method, result=rules.VERIFIED, detail=detail,
    )
    _forget_notice(session, provider.name)
    return mapping_view(mapping, current.folder)


def map_typed(session: Session, config, registry, provider_name: str, remote_path: object) -> dict[str, Any]:
    """The fallback: the administrator types the delegate's folder. Recorded as typed, not checked."""
    provider = _delegate(registry, provider_name)
    try:
        remote = rules.normalize_remote_path(remote_path)
    except FolderError as refused:
        raise MappingError(refused.code, refused.message, 422) from refused
    current = library(session, config, registry)
    mapping = mapping_store.record(
        session, provider=provider.name, role=rules.WRITER, remote_path=remote, target_folder=current.folder,
        method=rules.TYPED, result=rules.TYPED, detail="typed by an administrator",
    )
    _forget_notice(session, provider.name)
    return mapping_view(mapping, current.folder)


def delete_mapping(session: Session, provider_name: str, mapping_id: str) -> None:
    mapping = mapping_store.get(session, mapping_id)
    if mapping is None or mapping.provider != provider_name or mapping.role != rules.WRITER:
        raise MappingError("mapping_not_found", "That mapping does not exist", 404)
    mapping_store.delete(session, mapping_id)


# ------------------------------------------------------------------
# The music server reads the library (step 6)
# ------------------------------------------------------------------


def record_full_sync(session: Session, config, registry, sync_name: str, found: bool, detail: str = "") -> None:
    """Keep the outcome of a full-sync verification with the library folder it ran against."""
    current = library(session, config, registry)
    mapping_store.record(
        session, provider=sync_name, role=rules.READER, remote_path="", target_folder=current.folder,
        method=rules.PROBE, result=rules.VERIFIED if found else rules.FAILED,
        detail=detail or ("the music server found the probe" if found else "the probe did not appear on the music server"),
    )


# ------------------------------------------------------------------
# A delegated download that completed
# ------------------------------------------------------------------


@dataclass
class Registration:
    indexed: int = 0
    confirmed: list[str] = field(default_factory=list)
    unconfirmed: list[str] = field(default_factory=list)  # mapped, but the storage does not hold it
    outside: list[str] = field(default_factory=list)  # under no mapping of the delegate


def _translate(paths: Iterable[str], remote_paths: list[str]) -> Registration:
    from services.library_scan import is_library_audio

    report = Registration()
    for path in paths:
        relative = rules.in_library(path, remote_paths)
        if relative is None:
            report.outside.append(path)
        elif is_library_audio(relative):
            report.confirmed.append(relative)
    return report


def register_delegated(session: Session, config, registry, provider, delegate_session, handle: str) -> Registration | None:
    """Record in the library the files the delegate imported for ``handle``. ``None`` when there is nothing to do: the
    delegate has no mapping (the page says it is not mapped) or no storage provider is active. Whatever the providers
    raise propagates: the caller logs it, the download stays landed."""
    from services.library_scan import index_library_files

    remote_paths = [
        mapping.remote_path for mapping in mapping_store.list_mappings(session, rules.WRITER, provider.name)
        if mapping.result != rules.FAILED
    ]
    storage = folders.active_storage(config, registry)
    if not remote_paths or storage is None:
        return None
    files = provider.list_delegated_files(handle, delegate_session)
    report = _translate((ref.path for ref in files if getattr(ref, "path", None)), remote_paths)
    storage_session = _authenticate(session, storage)
    candidates, report.confirmed = report.confirmed, []
    for relative in candidates:
        (report.confirmed if storage.exists(relative, storage_session) else report.unconfirmed).append(relative)
    if report.confirmed:
        _found, report.indexed = index_library_files(
            report.confirmed, storage, storage.name, storage_session, config.workspace_dir, session, source="delegate",
        )
    if report.outside or report.unconfirmed:
        root_store.state_set(session, NOTICE_PREFIX + provider.name, {
            "at": datetime.now(timezone.utc).isoformat(), "outside": len(report.outside),
            "unconfirmed": len(report.unconfirmed),
            "examples": (report.outside + report.unconfirmed)[:NOTICE_EXAMPLES],
        })
        logger.warning(
            "%s imported %d file(s) outside the library declared for it and %d the storage does not hold",
            provider.name, len(report.outside), len(report.unconfirmed),
        )
    return report
