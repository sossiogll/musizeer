"""
What another program calls the library: the pure rules of the delegate mapping (ADR-0008 §7).

A delegate (a download provider whose external system imports into the library) names files in ITS namespace: Lidarr's
``/music/Artist/Album/01 - x.flac``. A mapping says which of its folders is the library (``remote_path`` ``/music``), so a
path of the delegate becomes a path of the library: lexically, on path boundaries, ``/music/Artist/Album/01 - x.flac`` is
``Artist/Album/01 - x.flac``. Whether that file is really there is the storage provider's answer, not this module's.

This module reads no database and calls no provider: ``services/mappings.py`` does, with these rules.
"""
from __future__ import annotations

import posixpath
from typing import Iterable

from core.folders import FolderError, containing, root_path_problem

# The stable codes of a refusal (``FolderError.code``).
REMOTE_PATH_INVALID = "mapping_path_invalid"

# The roles of a mapping: a delegate imports into the library, a music server reads it.
WRITER = "writer"
READER = "reader"

# How a mapping was established, and what came of it.
PROBE = "probe"  # a marker put into the library and found by the other program
SUFFIX = "suffix"  # a file the delegate reported, found in the library under the same relative path
TYPED = "typed"  # typed by the administrator, not checked
VERIFIED = "verified"
FAILED = "failed"

# The name of the probe folder: fixed and documented, so the logs of the other programs are explicable (ADR-0008,
# decision 5). The random part keeps two verifications apart.
PROBE_FOLDER = "Musizeer Probe"
# The deepest relative path tried when a delegated file is matched by its suffix.
MAX_SUFFIX_DEPTH = 16


def normalize_remote_path(raw: object) -> str:
    """A folder of another program, as typed or reported: absolute and normalized (blanks and trailing ``/`` dropped,
    ``..`` refused, never silently collapsed)."""
    if not isinstance(raw, str):
        raise FolderError(REMOTE_PATH_INVALID, "The folder of the other program is required")
    text = raw.strip()
    if len(text) > 1:
        text = text.rstrip("/") or "/"
    problem = root_path_problem(text)
    if problem is not None:
        raise FolderError(REMOTE_PATH_INVALID, f"The folder of the other program {problem}")
    return text


def remote_path_or_none(raw: object) -> str | None:
    """:func:`normalize_remote_path`, or ``None`` for what is not a usable folder (an answer of another program)."""
    try:
        return normalize_remote_path(raw)
    except FolderError:
        return None


def in_library(path: object, remote_paths: Iterable[str]) -> str | None:
    """The relative path in the library of the delegate's ``path``, through the deepest of ``remote_paths`` that contains
    it; ``None`` when none does (the file was imported outside the library) or ``path`` is not a usable file path. The
    folder itself is not a file of it."""
    clean = remote_path_or_none(path)
    if clean is None:
        return None
    found = containing(((remote, remote) for remote in remote_paths), clean)
    if found is None or not found[1]:
        return None
    return found[1]


def remote_from_located(located: object, name: str) -> str | None:
    """The delegate's folder that is the library, from where it sees the probe folder ``name`` (a folder at the top of the
    library): ``/music/Musizeer Probe x`` gives ``/music``. ``None`` when the answer is not a folder called ``name``
    directly inside a usable folder."""
    clean = remote_path_or_none(located)
    if clean is None or posixpath.basename(clean) != name:
        return None
    return remote_path_or_none(posixpath.dirname(clean))


def suffix_candidates(path: object) -> list[tuple[str, str]]:
    """``(remote folder, relative path)`` for every way to split the delegate's file ``path`` into a folder and a path
    under it, the longest relative path first (the most specific evidence), at most :data:`MAX_SUFFIX_DEPTH` deep."""
    clean = remote_path_or_none(path)
    if clean is None:
        return []
    parts = clean.strip("/").split("/")
    candidates = []
    for start in range(1, len(parts)):
        relative = "/".join(parts[start:])
        if len(parts) - start > MAX_SUFFIX_DEPTH:
            continue
        candidates.append(("/" + "/".join(parts[:start]), relative))
    return candidates
