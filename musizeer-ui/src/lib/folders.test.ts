import { describe, expect, it } from "vitest";
import { FOLDERS_READY, foldersMissing } from "@/test/roots";
import { folderPathProblem, joinFolder, missingFolders, readFolderValue, relativeToRoot } from "./folders";

describe("folderPathProblem: the rule of a path inside a root folder", () => {
  it.each(["", "Music", "Music/Rock", ".musizeer-work", "a b/c.d", "back\\slash"])("%j is usable", (path) => {
    expect(folderPathProblem(path)).toBeNull();
  });

  it.each([
    ["/Music", "absolute"],
    ["Music/", "empty_segment"],
    ["a//b", "empty_segment"],
    ["./a", "dot"],
    ["a/./b", "dot"],
    ["../a", "dotdot"],
    ["a/../b", "dotdot"],
    ["a\0b", "nul"],
    ["x".repeat(4097), "too_long"],
  ])("%j is refused as %s", (path, problem) => {
    expect(folderPathProblem(path)).toBe(problem);
  });
});

describe("joinFolder", () => {
  it("is the root itself for the empty path", () => {
    expect(joinFolder("/library", "")).toBe("/library");
  });

  it("joins a root and a path with one slash", () => {
    expect(joinFolder("/library", "Music/Rock")).toBe("/library/Music/Rock");
    expect(joinFolder("/library/", "Music")).toBe("/library/Music");
  });
});

describe("relativeToRoot", () => {
  it("is the path inside the root, the inverse of joinFolder", () => {
    expect(relativeToRoot("/library", "/library/Music/Rock")).toBe("Music/Rock");
    expect(relativeToRoot("/library/", "/library/Music")).toBe("Music");
    expect(relativeToRoot("/library", "/library")).toBe("");
  });

  it("is null for a folder outside the root, even one that shares its prefix", () => {
    expect(relativeToRoot("/library", "/library2/Music")).toBeNull();
    expect(relativeToRoot("/library", "/other")).toBeNull();
  });
});

describe("readFolderValue", () => {
  it("reads what a folder setting holds", () => {
    expect(readFolderValue({ root_id: "r1", path: "Music" })).toEqual({ root_id: "r1", path: "Music" });
    expect(readFolderValue({ root_id: "r1" })).toEqual({ root_id: "r1", path: "" });
  });

  it.each([null, undefined, "", {}, { root_id: "" }, { path: "x" }, 5])("%j is no folder", (raw) => {
    expect(readFolderValue(raw)).toBeNull();
  });
});

describe("missingFolders", () => {
  it("lists the folders the status says are missing, with what it reported about each", () => {
    const status = foldersMissing({ admin: true, library: true });
    expect(missingFolders(status).map((m) => m.name)).toEqual(["working_folder", "library_folder"]);
    expect(missingFolders(status)[1].folder.state).toBe("root_refused");
  });

  it("is empty when the folders are ready, or when the status says nothing", () => {
    expect(missingFolders(FOLDERS_READY)).toEqual([]);
    expect(missingFolders(null)).toEqual([]);
    expect(missingFolders(undefined)).toEqual([]);
  });
});
