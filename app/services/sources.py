"""
Sources, catalogs and the providers installed from them (ADR-0006, phase 4).

A SOURCE is the URL of a catalog (``core/catalog.py``, version 2): the providers it lists
are OCI images pinned by digest. Installing records ``image@digest`` together with what the admin
APPROVED (roles and permissions); the database is the only source of truth for what is
installed, and the gateway runs exactly that (``services/gateway_sync.py``). An UPDATE is a
newer digest in the catalog that the admin approves, shown with the difference in permissions.
The AUTOMATIC update (ADR-0007 §5.1, the routine ``auto_update_providers``) applies by itself, through
the same write, only an update that is compatible and asks for exactly what was approved; any other
waits for the admin.

Whatever the admin looked at is what is recorded: install and update take the digest that was
on screen and are refused (``catalog_changed``) if the catalog offers another one by the time
the request arrives.

A source may carry a CREDENTIAL (the token of a private catalog and its images). It is sent as
``Authorization: Bearer`` to the catalog's host over https (never to a host a redirect leads
to), and handed to the gateway only to pull the images of that source. It is never returned
(``has_credential``), logged, or part of an error message.

Every refusal is a :class:`SourceError` with a stable ``code`` and the HTTP status the routes
answer with; the CLI (``scripts/provider_sources.py``) prints the same.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
from sqlalchemy import update as sql_update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from core.catalog import (
    Catalog,
    CatalogEntry,
    CatalogError,
    PermissionsDiff,
    automatic_update_wait,
    diff_permissions,
    parse_catalog,
    permissions_from_dict,
    permissions_to_dict,
)
from core.utc import utc_iso
from db.models import InstalledProvider, ProviderSource, _now
from services.gateway_client import GatewayClient, GatewayUnreachable
from services.gateway_sync import GatewaySync
from services import provider_order
from services.provider_events import announce_changed

logger = logging.getLogger(__name__)

FETCH_TIMEOUT = 15.0
MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_URL = 2000
MAX_CREDENTIAL = 4096

# The event the admins get on the progress stream when a provider was updated automatically.
PROVIDER_UPDATE_EVENT = "provider_update"


class SourceError(Exception):
    """A refusal, with a stable ``code`` (the routes' ``error_code``) and the HTTP ``status``."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class Unset:
    """The marker of a field a request did not mention (``None`` is a value: no credential)."""

    def __repr__(self) -> str:
        return "UNSET"


UNSET = Unset()


# ------------------------------------------------------------------
# Fetching a catalog
# ------------------------------------------------------------------


class CatalogFetcher:
    """GETs a catalog and parses it. ``transport`` is for tests."""

    def __init__(self, transport: httpx.BaseTransport | None = None, timeout: float = FETCH_TIMEOUT) -> None:
        self._transport = transport
        self._timeout = timeout

    def fetch(self, url: str, credential: str | None = None) -> Catalog:
        check_url(url)
        if credential and urlsplit(url).scheme != "https":
            raise SourceError(
                "credential_requires_https", "a source with a token must be an https URL: the token is never sent over plain HTTP", 422,
            )
        document = self._get_json(url, credential)
        try:
            return parse_catalog(document)
        except CatalogError as exc:
            raise SourceError("catalog_invalid", f"not a usable catalog: {exc}", 422) from exc

    def _get_json(self, url: str, credential: str | None) -> Any:
        origin = _origin(url)
        headers = {"Accept": "application/json, */*;q=0.1", "User-Agent": "musizeer"}
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout, follow_redirects=False) as client:
                current = url
                for _ in range(MAX_REDIRECTS + 1):
                    sent = dict(headers)
                    if credential and _origin(current) == origin:
                        sent["Authorization"] = f"Bearer {credential}"
                    with client.stream("GET", current, headers=sent) as response:
                        if response.status_code in (301, 302, 303, 307, 308):
                            location = response.headers.get("location")
                            if not location:
                                raise SourceError("catalog_unreachable", "the catalog's server redirected without saying where", 502)
                            target = str(httpx.URL(current).join(location))
                            if urlsplit(target).scheme not in ("http", "https") or (credential and urlsplit(target).scheme != "https"):
                                raise SourceError("catalog_unreachable", "the catalog's server redirected to a URL that is not https", 502)
                            current = target
                            continue
                        return self._read(response, credential is not None)
                raise SourceError("catalog_unreachable", "too many redirects fetching the catalog", 502)
        except httpx.TimeoutException:
            raise SourceError("catalog_unreachable", "the catalog's server did not answer in time", 502) from None
        except httpx.HTTPError as exc:
            # The name of the failure only: the text of a transport error is not ours to trust with a URL.
            raise SourceError("catalog_unreachable", f"the catalog could not be fetched: {type(exc).__name__}", 502) from None

    @staticmethod
    def _read(response: httpx.Response, authenticated: bool) -> Any:
        status = response.status_code
        if status in (401, 403):
            raise SourceError(
                "catalog_unauthorized",
                "the catalog's server refused the token" if authenticated else "the catalog is private: add a token to this source",
                502,
            )
        if status == 404:
            hint = " (for a private repository the server answers 404 when the token cannot read it)" if authenticated else ""
            raise SourceError("catalog_not_found", f"nothing is published at this URL{hint}", 502)
        if status != 200:
            raise SourceError("catalog_unreachable", f"the catalog's server answered {status}", 502)
        body = bytearray()
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > MAX_CATALOG_BYTES:
                raise SourceError("catalog_invalid", f"the catalog is larger than {MAX_CATALOG_BYTES // 1024} KiB", 422)
        try:
            return json.loads(bytes(body))
        except ValueError:
            raise SourceError("catalog_invalid", "the catalog is not JSON", 422) from None


def _origin(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    return scheme, (parts.hostname or "").lower(), parts.port or (443 if scheme == "https" else 80)


def short_digest(digest: str) -> str:
    """The first 12 hex digits of a digest, as the admin's page shows it: the result of a routine is a summary
    kept in a few thousand characters, and the full digest is on the installed provider's row."""
    return digest.removeprefix("sha256:")[:12]


def check_url(url: object) -> str:
    """The URL of a catalog if it is one an admin may add; else a 422 ``invalid_source_url``."""
    if not isinstance(url, str) or not url.strip() or len(url) > MAX_URL:
        raise SourceError("invalid_source_url", "the URL of a catalog is required", 422)
    url = url.strip()
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 — raises on a bad port
    except ValueError:
        raise SourceError("invalid_source_url", "that is not a URL", 422) from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SourceError("invalid_source_url", "the URL of a catalog is http(s)://host/path", 422)
    if parts.username is not None or parts.password is not None:
        raise SourceError("invalid_source_url", "put the token in its own field, not in the URL", 422)
    return url


def check_credential(credential: object) -> str | None:
    if credential is None:
        return None
    if not isinstance(credential, str):
        raise SourceError("invalid_credential", "the token is text", 422)
    credential = credential.strip()
    if not credential:
        return None
    if len(credential) > MAX_CREDENTIAL or any(ord(char) < 32 or ord(char) == 127 for char in credential):
        raise SourceError("invalid_credential", "the token must be printable text on one line", 422)
    return credential


# ------------------------------------------------------------------
# Views (what leaves this module: never a credential)
# ------------------------------------------------------------------


def source_view(source: ProviderSource) -> dict:
    return {
        "id": source.id,
        "name": source.name,
        "url": source.url,
        "enabled": source.enabled,
        "added_at": utc_iso(source.added_at),
        "has_credential": bool(source.credential),
        "allow_insecure_registry": source.allow_insecure_registry,
    }


def entry_view(entry: CatalogEntry) -> dict:
    return {
        "name": entry.name,
        "label": entry.label,
        "description": entry.description,
        "homepage": entry.homepage,
        "image": entry.image,
        "registry": entry.registry,
        "digest": entry.digest,
        "provider_api_version": entry.provider_api_version,
        "roles": list(entry.roles),
        "permissions": permissions_to_dict(entry.permissions),
        "compatible": entry.compatible,
        "incompatibility": entry.incompatibility,
    }


def installed_view(row: InstalledProvider, source: ProviderSource | None) -> dict:
    return {
        "name": row.name,
        "label": row.label,
        "image": row.image,
        "registry": row.image.partition("/")[0],
        "digest": row.digest,
        "provider_api_version": row.provider_api_version,
        "roles": json.loads(row.roles),
        "permissions": json.loads(row.permissions),
        "source_id": row.source_id,
        "source_name": source.name if source else None,
        "sends_source_token": bool(source and source.credential),
        "approved_at": utc_iso(row.approved_at),
        "approved_by": row.approved_by,
        "approved_automatically": row.approved_automatically,
        "previous_digest": row.previous_digest,
        "installed_at": utc_iso(row.installed_at),
    }


@dataclass(frozen=True)
class Offer:
    """What a catalog offers for an installed provider whose digest differs from the installed one."""

    entry: CatalogEntry
    diff: PermissionsDiff

    def view(self) -> dict:
        return {**entry_view(self.entry), "diff": self.diff.to_dict()}


# ------------------------------------------------------------------
# The manager
# ------------------------------------------------------------------


class SourceManager:
    def __init__(
        self,
        session: Session,
        announce_change: Callable[[], None] = announce_changed,
        gateway: GatewaySync | None = None,
        fetcher: CatalogFetcher | None = None,
    ) -> None:
        self.session = session
        # Every process rebuilds its registry when it hears that the providers changed.
        self.announce_change = announce_change
        self.gateway = gateway or GatewaySync(GatewayClient())
        self.fetcher = fetcher or CatalogFetcher()

    # ---- after a change -------------------------------------------------

    def _providers_changed(self) -> None:
        """The change is made and committed. Tell the gateway the desired set and the other processes
        that the providers changed; both best effort (the watcher and the next event bring them in
        line)."""
        self.gateway.push(self.session)
        try:
            self.announce_change()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not announce the change of the providers: %s", exc)

    # ---- sources --------------------------------------------------------

    def list_sources(self) -> list[ProviderSource]:
        return list(self.session.exec(select(ProviderSource).order_by(ProviderSource.added_at)).all())

    def get_source(self, source_id: str) -> ProviderSource:
        source = self.session.get(ProviderSource, source_id)
        if source is None:
            raise SourceError("source_not_found", "that source does not exist", 404)
        return source

    def resolve_source(self, reference: str) -> ProviderSource:
        """A source by id, by exact URL or by name (for the command line)."""
        sources = self.list_sources()
        for match in (
            [s for s in sources if s.id == reference],
            [s for s in sources if s.url == reference],
            [s for s in sources if s.name == reference],
        ):
            if len(match) == 1:
                return match[0]
            if len(match) > 1:
                raise SourceError("source_ambiguous", f"'{reference}' matches {len(match)} sources: use the id", 409)
        raise SourceError("source_not_found", f"no source is '{reference}'", 404)

    def preview_source(self, url: str, credential: str | None = None, allow_insecure_registry: bool = False) -> Catalog:
        """The catalog a new source would give (nothing is written): what ``add_source`` checks."""
        url, credential = check_url(url), check_credential(credential)
        self._check_flags(url, credential, allow_insecure_registry)
        if self.session.exec(select(ProviderSource).where(ProviderSource.url == url)).first():
            raise SourceError("source_exists", "that source is already added", 409)
        return self.fetcher.fetch(url, credential)

    def add_source(self, url: str, credential: str | None = None, allow_insecure_registry: bool = False) -> ProviderSource:
        url, credential = check_url(url), check_credential(credential)
        catalog = self.preview_source(url, credential, allow_insecure_registry)
        source = ProviderSource(name=catalog.name, url=url, allow_insecure_registry=allow_insecure_registry)
        source.set_credential(credential)
        self.session.add(source)
        try:
            self.session.commit()
        except IntegrityError:  # added meanwhile by another request
            self.session.rollback()
            raise SourceError("source_exists", "that source is already added", 409) from None
        self.session.refresh(source)
        return source

    def edit_source(
        self,
        source_id: str,
        *,
        enabled: bool | Unset = UNSET,
        credential: str | None | Unset = UNSET,
        allow_insecure_registry: bool | Unset = UNSET,
    ) -> ProviderSource:
        """Change what a request names (a field left out is left alone; ``credential=None`` removes
        the token). The gateway is told again when the token or the registry mode changed: it
        needs them for its next pull."""
        source = self.get_source(source_id)
        new_credential = source.credential if isinstance(credential, Unset) else check_credential(credential)
        new_insecure = source.allow_insecure_registry if isinstance(allow_insecure_registry, Unset) else bool(allow_insecure_registry)
        self._check_flags(source.url, new_credential, new_insecure)
        if not isinstance(enabled, Unset):
            source.enabled = bool(enabled)
        credential_changed = not isinstance(credential, Unset) and (
            new_credential != source.credential or (new_credential is None and source.sealed_credential is not None)
        )  # removing a token that cannot be read is a change too
        pulls_changed = credential_changed or new_insecure != source.allow_insecure_registry
        if credential_changed:
            # Only a token the request named is written: a stored one that cannot be read is
            # not overwritten with "none" by a request that changes something else.
            source.set_credential(new_credential)
        source.allow_insecure_registry = new_insecure
        self.session.add(source)
        self.session.commit()
        self.session.refresh(source)
        if pulls_changed and self._installed_from(source.id):
            self._providers_changed()
        return source

    def toggle_source(self, source_id: str, enabled: bool) -> ProviderSource:
        return self.edit_source(source_id, enabled=enabled)

    @staticmethod
    def _check_flags(url: str, credential: str | None, allow_insecure_registry: bool) -> None:
        if credential and urlsplit(url).scheme != "https":
            raise SourceError(
                "credential_requires_https", "a source with a token must be an https URL: the token is never sent over plain HTTP", 422,
            )
        if credential and allow_insecure_registry:
            raise SourceError(
                "credential_with_insecure_registry",
                "a source cannot have both a token and an insecure registry: the token would travel over plain HTTP", 422,
            )

    def remove_source(self, source_id: str) -> list[str]:
        """Remove a source and uninstall the providers installed from it; their names."""
        source = self.get_source(source_id)
        installed = self._installed_from(source.id)
        for row in installed:
            self.session.delete(row)
        self.session.flush()  # the providers first: they point at the source
        self.session.delete(source)
        self.session.commit()
        if installed:
            self._providers_changed()
        return [row.name for row in installed]

    def _installed_from(self, source_id: str) -> list[InstalledProvider]:
        return list(self.session.exec(select(InstalledProvider).where(InstalledProvider.source_id == source_id)).all())

    # ---- the catalog of a source ----------------------------------------

    def fetch_catalog(self, source: ProviderSource) -> Catalog:
        return self.fetcher.fetch(source.url, source.credential)

    def _enabled_catalog(self, source_id: str) -> tuple[ProviderSource, Catalog]:
        source = self.get_source(source_id)
        if not source.enabled:
            raise SourceError("source_disabled", "that source is disabled: enable it first", 409)
        return source, self.fetch_catalog(source)

    def browse(self, source_id: str) -> dict:
        """The entries of a source's catalog with what the host knows about each: whether it can be
        installed here, whether it is installed (from this source) and whether the catalog offers an
        update."""
        source, catalog = self._enabled_catalog(source_id)
        installed = {row.name: row for row in self.session.exec(select(InstalledProvider)).all()}
        entries = []
        for entry in catalog.entries:
            view = entry_view(entry)
            row = installed.get(entry.name)
            from_here = bool(row and row.source_id == source.id)
            offer = self._offer(row, entry) if row is not None and from_here else None
            view.update(
                installed=row is not None,
                installed_from_this_source=from_here,
                installed_digest=row.digest if row else None,
                update=offer.view() if offer else None,
            )
            entries.append(view)
        return {
            "source": source_view(source),
            "name": catalog.name,
            "entries": entries,
            "rejected": [{"name": r.label, "reason": r.reason} for r in catalog.rejected],
        }

    @staticmethod
    def _offer(row: InstalledProvider, entry: CatalogEntry) -> Offer | None:
        """What ``entry`` offers over the installed ``row``: None if it is the same image asking for the same.

        A catalog that keeps the digest but now declares other permissions or roles is an offer too:
        what the admin approved is no longer what the catalog says (and the image's labels, which the
        gateway checks against the approval, may be the new ones)."""
        diff = diff_permissions(
            permissions_from_dict(json.loads(row.permissions)), entry.permissions, tuple(json.loads(row.roles)), entry.roles,
        )
        if entry.digest == row.digest and diff.is_empty:
            return None
        return Offer(entry, diff)

    # ---- install / update / uninstall -----------------------------------

    def install(self, source_id: str, provider_name: str, digest: str, approved_by: str | None = None) -> InstalledProvider:
        """Install ``provider_name`` from the source, at ``digest``: the one the admin was shown."""
        source, catalog = self._enabled_catalog(source_id)
        entry = catalog.get(provider_name)
        if entry is None:
            raise SourceError("provider_not_in_catalog", f"'{provider_name}' is not in this source's catalog", 404)
        if self.session.exec(select(InstalledProvider).where(InstalledProvider.name == provider_name)).first():
            raise SourceError("already_installed", f"'{provider_name}' is already installed", 409)
        self._check_installable(entry, digest)
        row = InstalledProvider(
            source_id=source.id, name=entry.name, image=entry.image, digest=entry.digest,
            provider_api_version=entry.provider_api_version, label=entry.label,
            roles=json.dumps(list(entry.roles)), permissions=json.dumps(permissions_to_dict(entry.permissions), sort_keys=True),
            approved_at=_now(), approved_by=approved_by,
        )
        self.session.add(row)
        try:
            self.session.flush()
            # The new provider goes to the end of the stored default order, in the install's own transaction.
            provider_order.sync_default(self.session, reinstalled=row.name)
            self.session.commit()
        except IntegrityError:  # installed meanwhile by another request
            self.session.rollback()
            raise SourceError("already_installed", f"'{provider_name}' is already installed", 409) from None
        self.session.refresh(row)
        self._providers_changed()
        return row

    @staticmethod
    def _check_installable(entry: CatalogEntry, approved_digest: str) -> None:
        if not entry.compatible:
            raise SourceError("incompatible_provider", f"'{entry.name}' {entry.incompatibility}", 422)
        if entry.digest != approved_digest:
            raise SourceError(
                "catalog_changed",
                f"the catalog now offers '{entry.name}' at another digest than the one you were shown: look at it again", 409,
            )

    def get_installed(self, name: str) -> InstalledProvider:
        row = self.session.exec(select(InstalledProvider).where(InstalledProvider.name == name)).first()
        if row is None:
            raise SourceError("not_installed", f"'{name}' is not installed", 404)
        return row

    def available_update(self, name: str) -> tuple[InstalledProvider, Offer | None]:
        """The installed provider and what its source's catalog offers over it (None: nothing newer)."""
        row = self.get_installed(name)
        _source, catalog = self._enabled_catalog(row.source_id)
        entry = catalog.get(name)
        if entry is None:
            raise SourceError("provider_not_in_catalog", f"'{name}' is no longer in its source's catalog", 404)
        return row, self._offer(row, entry)

    def update(self, name: str, digest: str, approved_by: str | None = None) -> InstalledProvider:
        """Move an installed provider to the digest the admin approved (with the permissions of that
        digest's catalog entry)."""
        row, offer = self.available_update(name)
        if offer is None:
            raise SourceError("already_current", f"'{name}' is already what its catalog offers", 409)
        self._check_installable(offer.entry, digest)
        self._apply_update(row, offer.entry, approved_by=approved_by, automatic=False)
        self._providers_changed()
        return row

    def _apply_update(self, row: InstalledProvider, entry: CatalogEntry, *, approved_by: str | None, automatic: bool) -> None:
        """The one write of an update, committed: ``row`` becomes ``entry`` as approved. It is conditional on the
        row still being what the caller judged (its digest, permissions and roles): a row changed meanwhile (another
        update, an uninstall) is ``provider_changed`` (409) and nothing is written."""
        name = row.name  # the rollback of a lost race expires the row, which may be gone
        moved = self.session.exec(
            sql_update(InstalledProvider)
            .where(
                InstalledProvider.id == row.id,
                InstalledProvider.digest == row.digest,
                InstalledProvider.permissions == row.permissions,
                InstalledProvider.roles == row.roles,
            )
            .values(
                image=entry.image, digest=entry.digest, provider_api_version=entry.provider_api_version, label=entry.label,
                roles=json.dumps(list(entry.roles)),
                permissions=json.dumps(permissions_to_dict(entry.permissions), sort_keys=True),
                approved_at=_now(), approved_by=approved_by, approved_automatically=automatic, previous_digest=row.digest,
            )
        )
        if moved.rowcount != 1:
            self.session.rollback()
            raise SourceError("provider_changed", f"'{name}' changed meanwhile: look at it again", 409)
        provider_order.sync_default(self.session)  # an update may add the role that makes it a metadata provider
        self.session.commit()
        self.session.refresh(row)

    def apply_compatible_updates(self, notify: Callable[[dict], None]) -> dict:
        """The automatic update (ADR-0007 §5.1): every installed provider whose catalog offers a digest that is
        compatible and asks for exactly what was approved is moved to it, recorded as approved automatically, and
        ``notify`` gets an event for each one (the admins are told). Any other update is left to the admin. The
        gateway is told once, after the last update.

        The result is the routine's, digests in their short form: ``updated`` (name, label, from, to), ``waiting``
        (name, digest, reason: why the admin has to look), ``not_checked`` (name, reason: a disabled source, a
        provider its catalog no longer lists, a provider changed meanwhile), ``failed`` (name, error_code: its
        catalog could not be read), with the counts the page words (``applied``, ``waiting_for_admin``, and
        ``current``: the providers already at what their catalog offers). A catalog that could not be read makes the
        run an ``error``: nothing is known of those providers."""
        rows = list(self.session.exec(select(InstalledProvider).order_by(InstalledProvider.name)).all())
        sources = {source.id: source for source in self.list_sources()}
        catalogs: dict[str, Catalog | SourceError] = {}
        updated: list[dict] = []
        waiting: list[dict] = []
        not_checked: list[dict] = []
        failed: list[dict] = []
        current = 0
        for row in rows:
            source = sources[row.source_id]
            if not source.enabled:
                not_checked.append({"name": row.name, "reason": "source_disabled"})
                continue
            if source.id not in catalogs:
                try:
                    catalogs[source.id] = self.fetch_catalog(source)
                except SourceError as exc:
                    catalogs[source.id] = exc
            catalog = catalogs[source.id]
            if isinstance(catalog, SourceError):
                failed.append({"name": row.name, "error_code": catalog.code})
                continue
            entry = catalog.get(row.name)
            if entry is None:
                not_checked.append({"name": row.name, "reason": "provider_not_in_catalog"})
                continue
            offer = self._offer(row, entry)
            if offer is None:
                current += 1
                continue
            wait = automatic_update_wait(offer.entry, offer.diff)
            if wait is not None:
                waiting.append({"name": row.name, "digest": short_digest(entry.digest), "reason": wait})
                continue
            name, previous = row.name, row.digest  # a lost race rolls back, and the row may be gone with it
            try:
                self._apply_update(row, entry, approved_by=None, automatic=True)
            except SourceError as exc:
                not_checked.append({"name": name, "reason": exc.code})
                continue
            updated.append({"name": name, "label": entry.label, "from": short_digest(previous), "to": short_digest(entry.digest)})
        if updated:
            self._providers_changed()
            for applied in updated:
                try:
                    notify({"type": PROVIDER_UPDATE_EVENT, "provider": applied})
                except Exception as exc:  # noqa: BLE001 — the update is made: the notice is best effort
                    logger.warning("Could not announce the automatic update of %s: %s", applied["name"], exc)
        result: dict[str, Any] = {
            "status": "error" if failed else "ok",
            "applied": len(updated), "waiting_for_admin": len(waiting), "current": current,
            "updated": updated, "waiting": waiting, "not_checked": not_checked, "failed": failed,
        }
        if failed:
            result["error_code"] = failed[0]["error_code"]
        return result

    def uninstall(self, name: str) -> None:
        row = self.get_installed(name)
        self.session.delete(row)
        self.session.commit()
        self._providers_changed()

    # ---- what is installed ----------------------------------------------

    def list_installed(self, check_updates: bool = True) -> list[dict]:
        """The installed providers. With ``check_updates`` each carries ``update`` (what its source's
        catalog offers over it, with the difference in permissions; None if nothing) and
        ``update_error`` (why that could not be looked at). A newer digest is never stored: it is read
        from the catalog here, so it cannot go stale and nothing has to refresh it."""
        rows = list(self.session.exec(select(InstalledProvider).order_by(InstalledProvider.name)).all())
        sources = {source.id: source for source in self.list_sources()}
        catalogs: dict[str, Catalog | SourceError] = {}
        result = []
        for row in rows:
            source = sources.get(row.source_id)
            view = installed_view(row, source)
            view["update"], view["update_error"] = None, None
            if check_updates and source is not None:
                if not source.enabled:
                    view["update_error"] = "source_disabled"
                else:
                    if source.id not in catalogs:
                        try:
                            catalogs[source.id] = self.fetch_catalog(source)
                        except SourceError as exc:
                            catalogs[source.id] = exc
                    catalog = catalogs[source.id]
                    if isinstance(catalog, SourceError):
                        view["update_error"] = catalog.code
                    else:
                        entry = catalog.get(row.name)
                        if entry is None:
                            view["update_error"] = "provider_not_in_catalog"
                        else:
                            offer = self._offer(row, entry)
                            view["update"] = offer.view() if offer else None
            result.append(view)
        return result

    def gateway_state(self, host_rejected: dict[str, str] | None = None) -> dict:
        """What the gateway says it runs, for the admin's page: the state of each provider it was
        told about (running, pulling, refused, unavailable...) with the reason."""
        client = self.gateway.client
        try:
            listing = client.listing()
        except GatewayUnreachable as exc:
            return {
                "reachable": False, "status": "unreachable", "detail": str(exc), "deployed": client.deployed(),
                "sandbox": None, "providers": [], "rejected": {}, "host_rejected": dict(host_rejected or {}),
            }
        providers = [
            {
                "name": p.name, "state": p.state, "reason": p.reason, "restarts": p.restarts,
                "roles": list((p.declared or {}).get("roles") or ()),
            }
            for p in listing.providers
        ]
        if listing.sandbox_available is False:
            status, detail = "unavailable", f"sandbox unavailable: {listing.sandbox_reason}"
        elif any(p.state != "running" for p in listing.providers):
            status, detail = "degraded", ""
        else:
            status, detail = "ok", ""
        return {
            "reachable": True, "status": status, "detail": detail, "deployed": True,
            "sandbox": {"available": listing.sandbox_available, "reason": listing.sandbox_reason},
            "providers": providers, "rejected": dict(listing.rejected), "host_rejected": dict(host_rejected or {}),
        }
