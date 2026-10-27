import { loadedProjectEnvSnapshot } from "@gajae-code/utils";

loadedProjectEnvSnapshot();

const worktreeCwd = process.env.GJC_PROXY_TRUST_TEST_WORKTREE_CWD;
if (!worktreeCwd) throw new Error("missing test worktree cwd");
process.chdir(worktreeCwd);
