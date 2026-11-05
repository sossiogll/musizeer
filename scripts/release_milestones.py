#!/usr/bin/env python3
"""The milestones of the releases (ADR-0007 §6): `next` holds what was merged into dev, a release takes it.

    assign <sha>                   a merge into dev: its pull request joins `next` (.github/workflows/milestones.yml)
    release <tag> <numbers file>   a release: `next` becomes the tag's milestone, closed (.github/workflows/images.yml)
    backfill [--apply]             the releases already out, from the local tags: a dry run unless told otherwise

Every command can run again: what is already right is not written. A release's pull requests are the ones its notes
list (the numbers file of images.yml, or for backfill the same reading of the history), so a pull request merged into
dev after the merge into master stays in `next`, and one whose assignment failed still ends up in its release.

Standard library only: it runs on a bare runner. GH_TOKEN and GITHUB_REPOSITORY are required.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

NEXT = "next"
DEV = "dev"
PAGE_SIZE = 100
TIMEOUT_SECONDS = 30
RENAME_RACE_ATTEMPTS = 3
# GitHub asks for a pause between writes when there are many of them, to stay under its secondary rate limit.
BACKFILL_WRITE_PAUSE_SECONDS = 1.0
# The same reading of a merge commit as the version job of images.yml.
MERGE_SUBJECT = re.compile(r"^Merge pull request #(\d+) from ", re.MULTILINE)
RELEASE_TAG = re.compile(r"^v\d+\.\d+\.\d+$")


class GitHubError(Exception):
    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(f"GitHub answered {status}: {message}" if status else f"GitHub is unreachable: {message}")
        self.status = status


class GitHub:
    def __init__(self, repository: str, token: str, api_url: str = "https://api.github.com", write_pause: float = 0.0) -> None:
        self._base = f"{api_url}/repos/{repository}/"
        self._token = token
        self._write_pause = write_pause

    def request(self, method: str, path: str, body: dict | None = None):
        request = urllib.request.Request(
            self._base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        if method != "GET" and self._write_pause:
            time.sleep(self._write_pause)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise GitHubError(exc.code, _error_message(exc)) from None
        except OSError as exc:
            raise GitHubError(None, str(exc)) from None

    def pages(self, path: str) -> list[dict]:
        separator = "&" if "?" in path else "?"
        items: list[dict] = []
        page = 1
        while True:
            batch = self.request("GET", f"{path}{separator}per_page={PAGE_SIZE}&page={page}")
            items += batch
            if len(batch) < PAGE_SIZE:
                return items
            page += 1


def _error_message(error: urllib.error.HTTPError) -> str:
    try:
        return str(json.load(error).get("message", error.reason))
    except ValueError:
        return str(error.reason)


def find_milestone(api: GitHub, title: str) -> dict | None:
    return next((m for m in api.pages("milestones?state=all") if m["title"] == title), None)


def ensure_milestone(api: GitHub, title: str) -> dict:
    found = find_milestone(api, title)
    if found is not None:
        return found
    try:
        return api.request("POST", "milestones", {"title": title})
    except GitHubError as exc:
        # Two runs at once: GitHub refuses the second title, and that one is the milestone.
        found = find_milestone(api, title) if exc.status == 422 else None
        if found is None:
            raise
        return found


def set_milestone(api: GitHub, number: int, milestone: dict) -> None:
    issue = api.request("PATCH", f"issues/{number}", {"milestone": milestone["number"]})
    # Without push access GitHub answers 200 and drops the milestone.
    if (issue.get("milestone") or {}).get("number") != milestone["number"]:
        raise GitHubError(200, f"#{number} did not take the milestone {milestone['title']}")


def join_next(api: GitHub, number: int) -> None:
    for _ in range(RENAME_RACE_ATTEMPTS):
        milestone = ensure_milestone(api, NEXT)
        set_milestone(api, number, milestone)
        # A release may have renamed it between the two calls: then this pull request is not in that release.
        if api.request("GET", f"milestones/{milestone['number']}")["title"] == NEXT:
            print(f"#{number} joined {NEXT}")
            return
    raise GitHubError(409, f"{NEXT} kept changing while #{number} joined it")


def assign(api: GitHub, sha: str) -> None:
    """The pull request a merge commit on dev closed. GitHub also lists the open ones that contain the commit."""
    merged = [
        pull for pull in api.request("GET", f"commits/{sha}/pulls")
        if pull.get("merged_at") and pull.get("merge_commit_sha") == sha and pull["base"]["ref"] == DEV
    ]
    if not merged:
        print(f"{sha}: no pull request merged into {DEV} here")
    for pull in merged:
        if pull.get("milestone"):
            print(f"#{pull['number']} is already in {pull['milestone']['title']}")
        else:
            join_next(api, pull["number"])


def _take_next(api: GitHub, tag: str) -> dict | None:
    current = find_milestone(api, NEXT)
    if current is None:
        return None
    try:
        return api.request("PATCH", f"milestones/{current['number']}", {"title": tag})
    except GitHubError as exc:
        if exc.status != 422:
            raise
        return None  # The tag's milestone exists already: another run got here first.


def settle(api: GitHub, tag: str, numbers: set[int], *, take_next: bool) -> None:
    """The tag's milestone holds exactly `numbers` and is closed, and `next` exists."""
    published_at = api.request("GET", f"releases/tags/{tag}")["published_at"]
    milestone = find_milestone(api, tag)
    if milestone is None and take_next:
        milestone = _take_next(api, tag)
    if milestone is None:
        milestone = ensure_milestone(api, tag)

    held = {item["number"] for item in api.pages(f"issues?milestone={milestone['number']}&state=all")}
    for number in sorted(held - numbers):
        set_milestone(api, number, ensure_milestone(api, NEXT))
        print(f"#{number} is not in {tag}: back to {NEXT}")
    missing = sorted(numbers - held)
    if missing and milestone["state"] == "closed":
        api.request("PATCH", f"milestones/{milestone['number']}", {"state": "open"})
        milestone = {**milestone, "state": "open"}
    for number in missing:
        set_milestone(api, number, milestone)
        print(f"#{number} joined {tag}")

    # GitHub closes a milestone at the time of the call, so the date of the release lives in due_on.
    day = published_at[:10]
    if milestone["state"] != "closed" or (milestone.get("due_on") or "")[:10] != day:
        api.request("PATCH", f"milestones/{milestone['number']}", {"state": "closed", "due_on": f"{day}T12:00:00Z"})
    ensure_milestone(api, NEXT)
    print(f"{tag} closed, pull requests: {len(numbers)}")


def merge_numbers(log_subjects: str) -> set[int]:
    return {int(number) for number in MERGE_SUBJECT.findall(log_subjects)}


def _git(*arguments: str) -> str:
    return subprocess.run(["git", *arguments], check=True, capture_output=True, text=True).stdout


def _release_tags() -> list[str]:
    return [tag for tag in _git("tag", "--list", "v*", "--sort=v:refname").split() if RELEASE_TAG.match(tag)]


def _pulls_into_dev(api: GitHub, log_range: str) -> list[dict]:
    numbers = merge_numbers(_git("log", "--format=%s", log_range))
    pulls = (api.request("GET", f"pulls/{number}") for number in sorted(numbers))
    return [pull for pull in pulls if pull["base"]["ref"] == DEV]


def _describe(pull: dict) -> str:
    kinds = [label["name"] for label in pull["labels"] if label["name"] in ("breaking", "feature", "fix", "chore")]
    return f"  #{pull['number']} [{kinds[0] if kinds else 'no label'}] {pull['title']} ({pull['user']['login']})"


def backfill(api: GitHub, apply: bool) -> None:
    """Oldest first, so the milestones are numbered in the order of the releases. `next` is never taken here: what it
    holds was not in these releases, unless the history says so."""
    previous = None
    tags = _release_tags()
    for tag in tags:
        pulls = _pulls_into_dev(api, f"{previous}..{tag}" if previous else tag)
        day = api.request("GET", f"releases/tags/{tag}")["published_at"][:10]
        print(f"{tag} ({day}), pull requests: {len(pulls)}")
        for pull in pulls:
            print(_describe(pull))
        if apply:
            settle(api, tag, {pull["number"] for pull in pulls}, take_next=False)
        previous = tag

    waiting = _pulls_into_dev(api, f"{previous}..origin/{DEV}" if previous else f"origin/{DEV}")
    print(f"{NEXT}, merged after the last release, pull requests: {len(waiting)}")
    for pull in waiting:
        print(_describe(pull))
        if apply and not pull.get("milestone"):
            join_next(api, pull["number"])
    if apply:
        ensure_milestone(api, NEXT)
    else:
        print("Dry run: nothing was written. --apply writes it.")


def _numbers_file(path: str) -> set[int]:
    with open(path, encoding="utf-8") as lines:
        return {int(line) for line in lines if line.strip()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("assign").add_argument("sha")
    release = commands.add_parser("release")
    release.add_argument("tag")
    release.add_argument("numbers_file")
    commands.add_parser("backfill").add_argument("--apply", action="store_true")
    arguments = parser.parse_args(argv)

    token = os.environ.get("GH_TOKEN")
    repository = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repository:
        print("::error::GH_TOKEN and GITHUB_REPOSITORY are required", file=sys.stderr)
        return 2

    pause = BACKFILL_WRITE_PAUSE_SECONDS if arguments.command == "backfill" else 0.0
    api = GitHub(repository, token, os.environ.get("GITHUB_API_URL", "https://api.github.com"), pause)
    try:
        if arguments.command == "assign":
            assign(api, arguments.sha)
        elif arguments.command == "release":
            settle(api, arguments.tag, _numbers_file(arguments.numbers_file), take_next=True)
        else:
            backfill(api, arguments.apply)
    except GitHubError as exc:
        print(f"::error::release milestones: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
