"""
What other programs call the library (ADR-0008 §7, §8), through the service and the routes: a delegate is mapped by the
probe (or by a file it reported, or typed), a delegated download that completes is recorded in the library through the
mapping, files outside it are reported, and the full-sync result is kept with the library folder. Fakes only: the delegate
"sees" what the fake storage holds, under a folder of its own namespace.
"""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from musizeer_sdk.delegation import FileRef
from musizeer_sdk.interfaces import StorageStreamResult

from core import download_states as ds
from core.user_auth import create_access_token
from db import mapping_store
from db.engine import get_session
from db.models import Download, LibraryEntry, RootMapping, TrackRecord, User
from routes import deps
from routes.mappings import router as mappings_router
from services import mappings
from services.config_manager import ConfigManager
from tests.conftest import FakeDownloadProvider, FakeRegistry, FakeSyncProvider, write_flac
from tests.folders_support import FolderStorage, add_root, store_provider_folder


class LibraryStorage(FolderStorage):
    """The library on disk (``self.base``), streamed the way the library scan reads a file."""

    def __init__(self, base: Path) -> None:
        super().__init__()
        self.base = base

    def store(self, source, relative_dest, session):
        target = self.base / relative_dest
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(source.path, target)
        self.files[relative_dest] = b""
        return relative_dest

    def exists(self, relative_path, session):
        return (self.base / relative_path).is_file()

    def delete(self, relative_path, session):
        self.deleted.append(relative_path)
        (self.base / relative_path).unlink(missing_ok=True)
        return True

    def stream(self, relative_path, workspace, session):
        full = self.base / relative_path
        shutil.copy(full, Path(workspace) / full.name)
        return StorageStreamResult(file=full.name, filename=full.name)


class Delegate(FakeDownloadProvider):
    """A library manager that imports into ``/music``, which is the library: it sees the library's folders there."""

    def __init__(self, library: Path, *, locate: bool = True, files: list[str] | None = None, roots=("/music/", "/other")) -> None:
        super().__init__("delegate")
        self.library = library
        self._locate = locate
        self.files = files or []
        self.roots = list(roots)
        self.located: list[str] = []
        self.down = False

    def supports_import_roots(self):
        return True

    def supports_locate_in_import_roots(self):
        return self._locate

    def list_import_roots(self, session):
        if self.down:
            raise ConnectionError("connection refused")
        return self.roots

    def locate_in_import_roots(self, name, session):
        self.located.append(name)
        return f"/music/{name}/" if (self.library / name).is_dir() else None

    def list_delegated_files(self, handle, session):
        return [FileRef(path=path) for path in self.files]


@pytest.fixture
def world(engine, tmp_path):
    library = tmp_path / "library"
    library.mkdir()
    root = add_root(engine, str(library), "Library")
    store_provider_folder(engine, "foldered", "root_dir", root)
    config = ConfigManager(engine=engine)
    config.update({"storage_provider": "foldered"})
    storage = LibraryStorage(library)
    world = type("World", (), {})()
    world.engine, world.config, world.library, world.storage, world.root = engine, config, library, storage, root

    def registry(delegate=None, syncs=()):
        return FakeRegistry(storage=[storage], downloads=[delegate] if delegate else [], syncs=list(syncs))

    world.registry = registry
    return world


def mappings_of(engine) -> list[RootMapping]:
    with Session(engine) as session:
        return mapping_store.list_mappings(session)


# ------------------------------------------------------------------
# Verification
# ------------------------------------------------------------------


def test_the_probe_maps_the_delegates_folder_and_leaves_nothing_in_the_library(world):
    delegate = Delegate(world.library)

    with Session(world.engine) as session:
        mapping = mappings.verify(session, world.config, world.registry(delegate), "delegate")

    assert (mapping["remote_path"], mapping["method"], mapping["state"]) == ("/music", "probe", "verified")
    assert mapping["target_folder"] == str(world.library)
    (name,) = delegate.located
    assert name.startswith("Musizeer Probe ")
    assert world.storage.deleted == [f"{name}/probe.ogg"]
    assert not any(world.library.rglob("*.ogg")), "the marker is removed"


def test_the_marker_is_removed_even_when_the_delegate_fails(world):
    class Broken(Delegate):
        def locate_in_import_roots(self, name, session):
            raise ConnectionError("connection refused")

    with Session(world.engine) as session, pytest.raises(mappings.MappingError) as refused:
        mappings.verify(session, world.config, world.registry(Broken(world.library)), "delegate")

    assert (refused.value.code, refused.value.status) == ("mapping_verification_unavailable", 503)
    assert len(world.storage.deleted) == 1
    assert mappings_of(world.engine) == []


def test_a_delegate_that_does_not_see_the_probe_fails_its_mapping(world):
    class Elsewhere(Delegate):
        def locate_in_import_roots(self, name, session):
            return None

    with Session(world.engine) as session:
        mappings.map_typed(session, world.config, world.registry(Elsewhere(world.library)), "delegate", "/music")
        with pytest.raises(mappings.MappingError) as refused:
            mappings.verify(session, world.config, world.registry(Elsewhere(world.library)), "delegate")

    assert refused.value.code == "mapping_not_located"
    (mapping,) = mappings_of(world.engine)
    assert (mapping.remote_path, mapping.result) == ("/music", "failed")


def test_a_delegate_that_cannot_locate_is_verified_by_a_file_it_reported(world, engine):
    (world.library / "Artist" / "Album").mkdir(parents=True)
    (world.library / "Artist" / "Album" / "01 - x.flac").write_bytes(b"x")
    delegate = Delegate(world.library, locate=False, files=["/data/media/Artist/Album/01 - x.flac"])
    with Session(engine) as session:
        session.add(Download(track_id="t", status=ds.DOWNLOADED, provider_used="delegate", delegation_handle="7",
                             completed_at=datetime.now(timezone.utc)))
        session.commit()
        mapping = mappings.verify(session, world.config, world.registry(delegate), "delegate")

    assert (mapping["remote_path"], mapping["method"]) == ("/data/media", "suffix")


def test_without_a_reported_file_a_delegate_that_cannot_locate_is_not_mapped(world):
    with Session(world.engine) as session, pytest.raises(mappings.MappingError) as refused:
        mappings.verify(session, world.config, world.registry(Delegate(world.library, locate=False)), "delegate")
    assert refused.value.code == "mapping_not_located"


def test_the_verification_waits_for_the_library_folder(world, engine):
    from db.settings_store import SettingsRepository

    with Session(engine) as session:
        SettingsRepository(session).set_system("provider.foldered.root_dir", None)
    with Session(engine) as session, pytest.raises(mappings.MappingError) as refused:
        mappings.verify(session, world.config, world.registry(Delegate(world.library)), "delegate")
    assert (refused.value.code, refused.value.status) == ("library_folder_not_set", 409)


def test_a_typed_folder_is_normalized_and_recorded_unchecked(world):
    with Session(world.engine) as session:
        mapping = mappings.map_typed(session, world.config, world.registry(Delegate(world.library)), "delegate", " /music/ ")
        with pytest.raises(mappings.MappingError) as refused:
            mappings.map_typed(session, world.config, world.registry(Delegate(world.library)), "delegate", "music")
    assert (mapping["remote_path"], mapping["state"]) == ("/music", "typed")
    assert refused.value.code == "mapping_path_invalid"


# ------------------------------------------------------------------
# The page
# ------------------------------------------------------------------


def test_the_overview_lists_import_roots_mappings_and_what_is_not_mapped(world):
    delegate = Delegate(world.library)
    sync = FakeSyncProvider("server")
    with Session(world.engine) as session:
        mappings.map_typed(session, world.config, world.registry(delegate), "delegate", "/music")
        view = mappings.overview(session, world.config, world.registry(delegate, [sync]))

    assert view["library"] == {"storage_provider": "foldered", "folder": str(world.library), "set": True}
    (row,) = view["delegates"]
    assert row["import_roots"] == ["/music", "/other"]
    assert row["unmapped_roots"] == ["/other"]
    assert [m["remote_path"] for m in row["mappings"]] == ["/music"]
    assert view["music_servers"] == [{"provider": "server", "label": "Server", "state": "not_verified", "result": None}]


def test_a_delegate_that_does_not_answer_is_reported_not_hidden(world):
    delegate = Delegate(world.library)
    delegate.down = True
    with Session(world.engine) as session:
        (row,) = mappings.overview(session, world.config, world.registry(delegate))["delegates"]
    assert (row["import_roots"], row["import_roots_error"]) == (None, "unreachable")


def test_a_provider_that_declares_nothing_is_not_a_delegate(world):
    with Session(world.engine) as session:
        assert mappings.overview(session, world.config, world.registry(FakeDownloadProvider()))["delegates"] == []


def test_a_mapping_made_against_another_library_folder_is_to_verify_again(world, engine, tmp_path):
    with Session(engine) as session:
        mappings.verify(session, world.config, world.registry(Delegate(world.library)), "delegate")
    other = tmp_path / "moved"
    other.mkdir()
    store_provider_folder(engine, "foldered", "root_dir", add_root(engine, str(other)))
    with Session(engine) as session:
        (row,) = mappings.overview(session, world.config, world.registry(Delegate(world.library)))["delegates"]
    assert row["mappings"][0]["state"] == "verify_again"


# ------------------------------------------------------------------
# A delegated download that completed
# ------------------------------------------------------------------


def _album(library: Path) -> list[str]:
    album = library / "Artist" / "Album"
    album.mkdir(parents=True)
    write_flac(album / "01 - One.flac", title="One", artist="Artist", album="Album")
    write_flac(album / "02 - Two.flac", title="Two", artist="Artist", album="Album")
    return ["/music/Artist/Album/01 - One.flac", "/music/Artist/Album/02 - Two.flac"]


def _register(world, delegate):
    registry = world.registry(delegate)
    with Session(world.engine) as session:
        return mappings.register_delegated(
            session, world.config, registry, registry.get_download_provider("delegate"), None, "7",
        )


def _entries(engine) -> dict[str, LibraryEntry]:
    with Session(engine) as session:
        return {entry.file_path: entry for entry in session.exec(select(LibraryEntry)).all()}


def test_the_files_of_a_mapped_delegate_are_recorded_in_the_library(world, engine):
    files = _album(world.library)
    delegate = Delegate(world.library, files=[*files, "/music/Artist/Album/cover.jpg"])
    with Session(engine) as session:
        mappings.map_typed(session, world.config, world.registry(delegate), "delegate", "/music")

    report = _register(world, Delegate(world.library, files=files))

    assert report.indexed == 2 and report.outside == [] and report.unconfirmed == []
    entries = _entries(engine)
    assert set(entries) == {"Artist/Album/01 - One.flac", "Artist/Album/02 - Two.flac"}
    assert {entry.source for entry in entries.values()} == {"delegate"}
    with Session(engine) as session:
        # Read like the library scan reads a file: the track its tags describe.
        assert session.get(TrackRecord, entries["Artist/Album/01 - One.flac"].track_id).title == "One"
    # Again: nothing new, nothing doubled.
    assert _register(world, Delegate(world.library, files=files)).indexed == 0
    assert len(_entries(engine)) == 2


def test_files_outside_the_mapping_or_missing_from_the_storage_are_reported(world, engine):
    files = _album(world.library)
    delegate = Delegate(world.library, files=[files[0], "/elsewhere/Artist/x.flac", "/music/Artist/Album/03 - Gone.flac"])
    with Session(engine) as session:
        mappings.map_typed(session, world.config, world.registry(delegate), "delegate", "/music")

    report = _register(world, delegate)

    assert report.indexed == 1
    assert report.outside == ["/elsewhere/Artist/x.flac"]
    assert report.unconfirmed == ["Artist/Album/03 - Gone.flac"]
    with Session(engine) as session:
        (row,) = mappings.overview(session, world.config, world.registry(delegate))["delegates"]
    assert (row["notice"]["outside"], row["notice"]["unconfirmed"]) == (1, 1)
    # A verification of the mapping clears the notice.
    with Session(engine) as session:
        mappings.verify(session, world.config, world.registry(delegate), "delegate")
        (row,) = mappings.overview(session, world.config, world.registry(delegate))["delegates"]
    assert row["notice"] is None


def test_without_a_mapping_nothing_is_recorded(world, engine):
    assert _register(world, Delegate(world.library, files=_album(world.library))) is None
    assert _entries(engine) == {}


# ------------------------------------------------------------------
# The music server reads the library (step 6)
# ------------------------------------------------------------------


def test_the_full_sync_result_is_kept_with_the_library_folder(world, engine):
    sync = FakeSyncProvider("server")
    with Session(engine) as session:
        mappings.record_full_sync(session, world.config, world.registry(syncs=[sync]), "server", True)
        (server,) = mappings.overview(session, world.config, world.registry(syncs=[sync]))["music_servers"]
    assert server["state"] == "verified"
    assert server["result"]["target_folder"] == str(world.library)

    with Session(engine) as session:
        mappings.record_full_sync(session, world.config, world.registry(syncs=[sync]), "server", False)
        (server,) = mappings.overview(session, world.config, world.registry(syncs=[sync]))["music_servers"]
    assert server["state"] == "failed"
    assert len(mappings_of(engine)) == 1, "one result per music server, the latest"


# ------------------------------------------------------------------
# The routes
# ------------------------------------------------------------------


def _user(engine, role: str) -> dict:
    with Session(engine) as session:
        user = User(username=f"{role}-user", password_hash="x", role=role)
        session.add(user)
        session.commit()
        session.refresh(user)
        return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


@pytest.fixture
def client(world):
    world.config.update({"auth_enabled": True})
    registry = world.registry(Delegate(world.library))
    app = FastAPI()
    app.include_router(mappings_router)

    def _session():
        with Session(world.engine) as s:
            yield s

    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[deps.get_config] = lambda: world.config
    app.dependency_overrides[deps.get_registry] = lambda: registry
    with TestClient(app) as test_client:
        yield test_client, _user(world.engine, "admin"), _user(world.engine, "user")


@pytest.mark.parametrize("method, path", [
    ("get", "/mappings"), ("post", "/mappings/delegate/verify"), ("put", "/mappings/delegate"),
    ("delete", "/mappings/delegate/x"),
])
def test_only_an_administrator_may(client, method, path):
    test_client, _admin, user = client
    assert getattr(test_client, method)(path, headers=user).status_code == 403
    assert getattr(test_client, method)(path).status_code == 401


def test_an_administrator_maps_lists_and_removes(client):
    test_client, admin, _user_headers = client

    verified = test_client.post("/mappings/delegate/verify", headers=admin)
    assert verified.status_code == 200 and verified.json()["remote_path"] == "/music"
    listed = test_client.get("/mappings", headers=admin).json()
    assert [m["id"] for m in listed["delegates"][0]["mappings"]] == [verified.json()["id"]]

    refused = test_client.put("/mappings/delegate", json={"remote_path": "music"}, headers=admin)
    assert (refused.status_code, refused.json()["detail"]["error_code"]) == (422, "mapping_path_invalid")
    assert test_client.post("/mappings/nobody/verify", headers=admin).status_code == 404

    assert test_client.delete(f"/mappings/nobody/{verified.json()['id']}", headers=admin).status_code == 404
    assert test_client.delete(f"/mappings/delegate/{verified.json()['id']}", headers=admin).json() == {"ok": True}
    assert test_client.get("/mappings", headers=admin).json()["delegates"][0]["mappings"] == []
