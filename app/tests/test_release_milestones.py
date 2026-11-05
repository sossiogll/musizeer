"""scripts/release_milestones.py and the workflows that call it: `next` holds what was merged into dev, a release takes
it, and running anything twice changes nothing. GitHub is a fake at the boundary of `GitHub.request`, plus one real HTTP
round trip for what that boundary hides (pagination, errors)."""
from __future__ import annotations

import http.server
import importlib.util
import json
import re
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_milestones_script", ROOT / "scripts" / "release_milestones.py")
script = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = script
SPEC.loader.exec_module(script)

TAG = "v2.1.0"
SHA = "a" * 40


class FakeGitHub(script.GitHub):
    """Milestones, pull requests and the rules of GitHub this script depends on: titles are unique."""

    def __init__(self) -> None:
        self.milestones: dict[int, dict] = {}
        self.items: dict[int, dict] = {}
        self.commit_pulls: list[dict] = []
        self.writes: list[tuple] = []
        self.drop_milestones = False
        self.fail_on: tuple | None = None
        self.before_write = None
        self.listing_lags_behind_a_rename = False
        self.lagging: set[int] = set()

    def milestone(self, title: str, state: str = "open", due_on: str | None = None) -> dict:
        number = len(self.milestones) + 1
        self.milestones[number] = {"number": number, "title": title, "state": state, "due_on": due_on}
        return self.milestones[number]

    def item(self, number: int, milestone: dict | None = None) -> None:
        self.items[number] = {"number": number, "milestone": milestone["number"] if milestone else None}

    def titles(self) -> dict[str, str]:
        return {m["title"]: m["state"] for m in self.milestones.values()}

    def held_by(self, title: str) -> set[int]:
        numbers = [n for n, m in self.milestones.items() if m["title"] == title]
        return {i["number"] for i in self.items.values() if i["milestone"] in numbers}

    def request(self, method, path, body=None):
        route = urlparse(path)
        query = parse_qs(route.query)
        if method != "GET":
            self.writes.append((method, route.path, body))
            if self.before_write:
                hook, self.before_write = self.before_write, None
                hook()
            if self.fail_on and self.fail_on == (method, route.path):
                self.fail_on = None
                raise script.GitHubError(500, "boom")
        if route.path == "milestones" and method == "GET":
            return self._page(list(self.milestones.values()), query)
        if route.path == "milestones" and method == "POST":
            self._refuse_taken(body["title"])
            return dict(self.milestone(body["title"]))
        if match := re.fullmatch(r"milestones/(\d+)", route.path):
            found = self.milestones[int(match[1])]
            if method == "PATCH":
                if "title" in body:
                    self._refuse_taken(body["title"])
                    if self.listing_lags_behind_a_rename:
                        self.lagging.add(found["number"])
                found.update(body)
            return dict(found)
        if route.path == "issues":
            held = [{"number": i["number"]} for i in self.items.values() if i["milestone"] == int(query["milestone"][0])]
            assert query["state"] == ["all"], "a closed pull request counts"
            if int(query["milestone"][0]) in self.lagging:
                held = []
            return self._page(held, query)
        if match := re.fullmatch(r"issues/(\d+)", route.path):
            item = self.items.setdefault(int(match[1]), {"number": int(match[1]), "milestone": None})
            if not self.drop_milestones:
                item["milestone"] = body["milestone"]
            return {"number": item["number"], "milestone": {"number": item["milestone"]} if item["milestone"] else None}
        if route.path == f"commits/{SHA}/pulls":
            return self.commit_pulls
        if route.path.startswith("releases/tags/"):
            return {"published_at": "2026-11-05T10:00:00Z"}
        raise AssertionError(f"unexpected call: {method} {path}")

    def _refuse_taken(self, title: str) -> None:
        if title in self.titles():
            raise script.GitHubError(422, "Validation Failed")

    @staticmethod
    def _page(items: list, query: dict) -> list:
        size, page = int(query["per_page"][0]), int(query["page"][0])
        return items[(page - 1) * size:page * size]


def pull(number: int, base: str = "dev", merged: bool = True, sha: str = SHA, milestone: dict | None = None) -> dict:
    return {
        "number": number, "base": {"ref": base}, "merged_at": "2026-11-05T09:00:00Z" if merged else None,
        "merge_commit_sha": sha, "milestone": milestone,
    }


@pytest.fixture
def api() -> FakeGitHub:
    return FakeGitHub()


class TestAssign:
    def test_a_merged_pull_request_joins_next_and_a_missing_next_is_created(self, api):
        api.commit_pulls = [pull(7)]
        script.assign(api, SHA)
        assert api.titles() == {"next": "open"}
        assert api.held_by("next") == {7}

    def test_running_again_changes_nothing(self, api):
        api.commit_pulls = [pull(7)]
        script.assign(api, SHA)
        api.commit_pulls = [pull(7, milestone={"title": "next"})]
        api.writes.clear()
        script.assign(api, SHA)
        assert api.writes == []
        assert list(api.titles()) == ["next"]

    def test_a_run_repeated_after_the_release_does_not_take_the_pull_request_out_of_it(self, api):
        released = api.milestone(TAG, "closed")
        api.item(7, released)
        api.commit_pulls = [pull(7, milestone=released)]
        script.assign(api, SHA)
        assert api.held_by(TAG) == {7}
        assert api.writes == []

    @pytest.mark.parametrize("listed", [
        pull(8, base="master"),                    # dev → master: never
        pull(8, merged=False),                     # an open pull request that contains the commit
        pull(8, sha="b" * 40),                     # merged elsewhere, it only contains the commit
        pull(8, base="release/2.0"),               # into an integration branch: its merge into dev counts
    ])
    def test_only_the_pull_request_this_merge_closed_into_dev(self, api, listed):
        api.commit_pulls = [listed]
        script.assign(api, SHA)
        assert api.writes == []
        assert api.items == {}

    def test_a_milestone_github_dropped_is_an_error_not_a_success(self, api):
        api.drop_milestones = True
        api.commit_pulls = [pull(7)]
        with pytest.raises(script.GitHubError, match="did not take"):
            script.assign(api, SHA)

    def test_a_next_another_run_created_first_is_the_one_used(self, api):
        real_find = script.find_milestone
        calls = []

        def stale_first(github, title):
            calls.append(title)
            if len(calls) == 1:
                github.milestone("next")  # The other run wins right after this one looked.
                return None
            return real_find(github, title)

        api.commit_pulls = [pull(7)]
        script.find_milestone = stale_first
        try:
            script.assign(api, SHA)
        finally:
            script.find_milestone = real_find
        assert [m["title"] for m in api.milestones.values()] == ["next"]
        assert api.held_by("next") == {7}

    def test_a_release_that_renames_next_meanwhile_leaves_the_pull_request_in_the_new_next(self, api):
        current = api.milestone("next")
        api.commit_pulls = [pull(7)]
        api.before_write = lambda: current.update(title=TAG, state="closed")
        script.assign(api, SHA)
        assert api.titles() == {TAG: "closed", "next": "open"}
        assert api.held_by("next") == {7}
        assert api.held_by(TAG) == set()


class TestRelease:
    def test_next_becomes_the_tag_closed_and_a_new_next_is_open(self, api):
        current = api.milestone("next")
        api.item(1, current)
        api.item(2, current)
        script.settle(api, TAG, {1, 2}, take_next=True)
        assert api.titles() == {TAG: "closed", "next": "open"}
        assert api.held_by(TAG) == {1, 2}
        assert api.held_by("next") == set()
        assert api.milestones[current["number"]]["due_on"] == "2026-11-05T12:00:00Z"

    def test_a_pull_request_merged_after_the_merge_into_master_stays_for_the_next_release(self, api):
        current = api.milestone("next")
        api.item(1, current)
        api.item(9, current)
        script.settle(api, TAG, {1}, take_next=True)
        assert api.held_by(TAG) == {1}
        assert api.held_by("next") == {9}

    def test_a_pull_request_whose_assignment_failed_still_ends_up_in_its_release(self, api):
        api.milestone("next")
        api.item(3)
        script.settle(api, TAG, {3}, take_next=True)
        assert api.held_by(TAG) == {3}

    def test_a_listing_that_lags_behind_the_rename_loses_nothing_and_writes_nothing_needless(self, api):
        current = api.milestone("next")
        api.item(1, current)
        api.item(9, current)
        api.listing_lags_behind_a_rename = True
        script.settle(api, TAG, {1}, take_next=True)
        assert api.held_by(TAG) == {1}
        assert api.held_by("next") == {9}
        assert ("PATCH", "issues/1", {"milestone": current["number"]}) not in api.writes

    def test_a_pull_request_that_joins_next_just_before_the_rename_goes_back_to_next(self, api):
        current = api.milestone("next")
        api.item(1, current)
        api.before_write = lambda: api.item(9, current)
        script.settle(api, TAG, {1}, take_next=True)
        assert api.held_by(TAG) == {1}
        assert api.held_by("next") == {9}

    def test_what_next_held_does_not_count_when_another_run_made_the_tag_s_milestone(self, api):
        current = api.milestone("next")
        api.item(1, current)
        api.before_write = lambda: api.milestone(TAG)
        script.settle(api, TAG, {1}, take_next=True)
        assert api.milestones[current["number"]]["title"] == "next"
        assert api.held_by(TAG) == {1}
        assert api.held_by("next") == set()

    def test_a_missing_next_does_not_stop_the_release_and_is_created(self, api):
        script.settle(api, TAG, {3}, take_next=True)
        assert api.titles() == {TAG: "closed", "next": "open"}

    def test_running_again_writes_nothing(self, api):
        current = api.milestone("next")
        api.item(1, current)
        script.settle(api, TAG, {1}, take_next=True)
        api.writes.clear()
        script.settle(api, TAG, {1}, take_next=True)
        assert api.writes == []
        assert sorted(api.titles()) == sorted([TAG, "next"])

    def test_running_again_does_not_take_the_new_next(self, api):
        current = api.milestone("next")
        api.item(1, current)
        script.settle(api, TAG, {1}, take_next=True)
        api.item(9, script.find_milestone(api, "next"))
        script.settle(api, TAG, {1}, take_next=True)
        assert api.held_by("next") == {9}
        assert api.held_by(TAG) == {1}

    @pytest.mark.parametrize("step", [("PATCH", "issues/2"), ("POST", "milestones")])
    def test_a_failure_halfway_is_finished_by_running_again(self, api, step):
        current = api.milestone("next")
        api.item(1, current)
        api.item(9, current)
        api.fail_on = step
        with pytest.raises(script.GitHubError):
            script.settle(api, TAG, {1, 2}, take_next=True)
        script.settle(api, TAG, {1, 2}, take_next=True)
        assert api.titles() == {TAG: "closed", "next": "open"}
        assert api.held_by(TAG) == {1, 2}
        assert api.held_by("next") == {9}

    def test_a_closed_milestone_is_reopened_to_take_a_missing_pull_request_and_closed_again(self, api):
        api.milestone(TAG, "closed", "2026-11-05T12:00:00Z")
        script.settle(api, TAG, {4}, take_next=True)
        assert api.titles()[TAG] == "closed"
        assert api.held_by(TAG) == {4}


class TestBackfill:
    def test_it_never_renames_next(self, api):
        waiting = api.milestone("next")
        api.item(9, waiting)
        script.settle(api, "v1.0.0", {1}, take_next=False)
        assert api.titles() == {"next": "open", "v1.0.0": "closed"}
        assert api.milestones[waiting["number"]]["title"] == "next", "the same milestone, not a new one with its name"
        assert api.held_by("next") == {9}

    def test_a_pull_request_of_that_release_found_in_next_moves_to_it(self, api):
        waiting = api.milestone("next")
        api.item(1, waiting)
        script.settle(api, "v1.0.0", {1}, take_next=False)
        assert api.held_by("v1.0.0") == {1}
        assert api.held_by("next") == set()

    def test_it_reads_the_merge_commits_like_the_notes_of_a_release(self):
        log = "\n".join([
            "Merge pull request #12 from sossiogll/dev",
            "fix: a commit that mentions Merge pull request #99 from nowhere",
            "Merge pull request #7 from sossiogll/fix/thing",
            "Merge branch 'dev'",
        ])
        assert script.merge_numbers(log) == {7, 12}
        images = (ROOT / ".github/workflows/images.yml").read_text()
        assert "Merge pull request #\\([0-9][0-9]*\\) from" in images


class TestHttp:
    """A real HTTP round trip: what the fake of `request` cannot show."""

    @pytest.fixture
    def server(self):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self)
                url = urlparse(self.path)
                if url.path.endswith("/milestones"):
                    page = int(parse_qs(url.query)["page"][0])
                    self._answer(200, [{"title": f"m{page}-{i}"} for i in range(100 if page == 1 else 3)])
                else:
                    self._answer(403, {"message": "Resource not accessible by integration"})

            def _answer(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_):
                pass

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{httpd.server_port}", seen
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    def test_every_page_is_read(self, server):
        url, seen = server
        items = script.GitHub("o/r", "secret-token", url).pages("milestones?state=all")
        assert len(items) == 103
        assert len(seen) == 2
        assert seen[0].headers["Authorization"] == "Bearer secret-token"

    def test_an_error_has_its_status_and_github_s_message_and_never_the_token(self, server):
        url, _ = server
        with pytest.raises(script.GitHubError) as caught:
            script.GitHub("o/r", "secret-token", url).request("GET", "issues/1")
        assert caught.value.status == 403
        assert "not accessible" in str(caught.value)
        assert "secret-token" not in str(caught.value)

    def test_an_unreachable_github_has_no_status(self):
        with pytest.raises(script.GitHubError) as caught:
            script.GitHub("o/r", "t", "http://127.0.0.1:9").request("GET", "issues/1")
        assert caught.value.status is None


class TestMain:
    def test_a_failure_is_an_annotation_and_a_failed_exit(self, monkeypatch, capsys):
        monkeypatch.setenv("GH_TOKEN", "t")
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
        monkeypatch.setenv("GITHUB_API_URL", "http://127.0.0.1:9")
        assert script.main(["assign", SHA]) == 1
        assert capsys.readouterr().err.startswith("::error::")

    def test_it_does_not_start_without_its_configuration(self, monkeypatch, capsys):
        monkeypatch.delenv("GH_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
        assert script.main(["assign", SHA]) == 2
        assert "GH_TOKEN" in capsys.readouterr().err

    def test_the_numbers_of_a_release_are_read_from_the_file_of_the_version_job(self, tmp_path):
        numbers = tmp_path / "pull-requests.txt"
        numbers.write_text("12\n7\n\n")
        assert script._numbers_file(str(numbers)) == {7, 12}


class TestWorkflows:
    """What these runs depend on and no fake can show: the place of each step in the workflows."""

    @staticmethod
    def _load(name: str) -> dict:
        workflow = yaml.safe_load((ROOT / ".github/workflows" / name).read_text())
        workflow["on"] = workflow.pop(True)  # YAML reads the key `on` as a boolean.
        return workflow

    def test_the_merge_into_dev_runs_on_push_and_never_on_pull_request_target(self):
        workflow = self._load("milestones.yml")
        assert workflow["on"] == {"push": {"branches": ["dev"]}}
        assert workflow["permissions"] == {}
        job = workflow["jobs"]["next"]
        assert job["permissions"] == {"contents": "read", "issues": "write", "pull-requests": "write"}
        assert job["steps"][0]["with"]["persist-credentials"] is False

    def test_the_milestone_of_a_release_comes_after_the_release_and_cannot_fail_it(self):
        job = self._load("images.yml")["jobs"]["release"]
        assert job["permissions"]["issues"] == "write"
        steps = job["steps"]
        created = next(i for i, s in enumerate(steps) if "gh release create" in s.get("run", ""))
        milestone = next(i for i, s in enumerate(steps) if "release_milestones.py release" in s.get("run", ""))
        assert milestone == created + 1
        assert steps[milestone]["continue-on-error"] is True
        assert "if" not in steps[milestone], "only after the release was created"

    def test_the_numbers_file_holds_what_the_notes_list(self):
        run = next(s["run"] for s in self._load("images.yml")["jobs"]["version"]["steps"] if s.get("id") == "compute")
        skip = run.index("= dev ] || continue")
        written = run.index('echo "$number" >> "$notes/pull-requests.txt"')
        assert skip < written < run.index('>> "$notes/$kind.md"')
        assert ': > "$notes/pull-requests.txt"' in run, "an empty release has an empty file, not a missing one"
