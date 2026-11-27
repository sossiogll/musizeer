"""The pure rules of the delegate mapping (ADR-0008 §7): a path of another program becomes a path of the library lexically,
on path boundaries, and the probe's answer gives the folder that is the library."""
from __future__ import annotations

import pytest

from core import mappings as rules
from core.folders import FolderError


@pytest.mark.parametrize("raw, clean", [
    ("/music", "/music"), (" /music/ ", "/music"), ("/data/Music Library", "/data/Music Library"),
])
def test_a_folder_of_another_program_is_absolute_and_normalized(raw, clean):
    assert rules.normalize_remote_path(raw) == clean


@pytest.mark.parametrize("raw", ["", "music", "/", "/music/../etc", "/music//a", "/a\0b", None, 3])
def test_a_folder_that_is_not_one_is_refused(raw):
    with pytest.raises(FolderError) as refused:
        rules.normalize_remote_path(raw)
    assert refused.value.code == rules.REMOTE_PATH_INVALID


@pytest.mark.parametrize("path, relative", [
    ("/music/Artist/Album/01 - x.flac", "Artist/Album/01 - x.flac"),
    ("/music2/Artist/x.flac", None),  # a prefix that is not a path boundary
    ("/other/Artist/x.flac", None),
    ("/music", None),  # the folder itself is not a file of it
    ("music/Artist/x.flac", None),
    ("/music/../etc/passwd", None),
    (None, None),
])
def test_a_path_of_the_delegate_is_in_the_library_only_under_a_mapped_folder(path, relative):
    assert rules.in_library(path, ["/music"]) == relative


def test_the_deepest_mapped_folder_wins():
    assert rules.in_library("/media/music/A/x.flac", ["/media", "/media/music"]) == "A/x.flac"


@pytest.mark.parametrize("located, remote", [
    ("/music/Musizeer Probe abc", "/music"),
    ("/music/Musizeer Probe abc/", "/music"),
    ("/data/lib/Musizeer Probe abc", "/data/lib"),
    ("/Musizeer Probe abc", None),  # directly under "/": not a folder of its own
    ("/music/Other", None),
    ("relative/Musizeer Probe abc", None),
    (None, None),
])
def test_the_probe_answer_gives_the_folder_that_is_the_library(located, remote):
    assert rules.remote_from_located(located, "Musizeer Probe abc") == remote


def test_a_reported_file_is_split_the_longest_relative_path_first():
    assert rules.suffix_candidates("/music/A/B/x.flac") == [
        ("/music", "A/B/x.flac"), ("/music/A", "B/x.flac"), ("/music/A/B", "x.flac"),
    ]
    assert rules.suffix_candidates("x.flac") == []
    deep = "/" + "/".join(f"d{i}" for i in range(30)) + "/x.flac"
    assert all(len(relative.split("/")) <= rules.MAX_SUFFIX_DEPTH for _, relative in rules.suffix_candidates(deep))
