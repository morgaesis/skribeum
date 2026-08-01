// Installs the lefthook-managed hooks into the repository's common hooks
// directory. A host-level core.hooksPath (a personal hook wrapper layer)
// must never be written to by a repository tool; such wrappers delegate to
// the common directory, which is also what linked worktrees share.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "lefthook.cmd" : "lefthook",
);
const lefthook = existsSync(local) ? local : "lefthook";
const commonGitDirectory = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

execFileSync(lefthook, ["install"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.join(commonGitDirectory, "hooks"),
  },
});
