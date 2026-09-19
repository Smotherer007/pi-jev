/**
 * Small process helper.
 *
 * Extensions get `pi.exec`, but tools in this package are plain objects so
 * they can be unit-tested without a pi session. `node:child_process` with an
 * explicit timeout and an output cap covers what is needed here, and the cap
 * matters: the point is to keep the state small, so a runaway `git diff` must
 * be truncated rather than handed to a provider.
 */

import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 120_000;

  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: maxBytes * 4,
        // Keep the environment, but stop git from opening a pager or asking
        // for credentials on a repo that needs them.
        env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        const rawOut = stdout ?? "";
        const rawErr = stderr ?? "";
        const truncated = rawOut.length > maxBytes;

        resolve({
          ok: error === null,
          stdout: truncated ? rawOut.slice(0, maxBytes) : rawOut,
          stderr: rawErr.slice(0, 4_000),
          code: typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : 0,
          truncated,
        });
      },
    );
  });
}

export interface DiffEvidence {
  text: string;
  files: number;
  truncated: boolean;
  note?: string;
}

/**
 * Working-tree evidence: the staged and unstaged diff against HEAD, plus the
 * contents of new files, which `git diff HEAD` does not include.
 *
 * That last part is the common failure of naive diff-based verification: the
 * agent adds a file, claims it added tests, and the diff shows nothing.
 */
export async function collectGitDiff(cwd: string, maxBytes = 100_000): Promise<DiffEvidence> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 5_000 });
  if (!inside.ok || !inside.stdout.includes("true")) {
    return { text: "", files: 0, truncated: false, note: "not a git repository" };
  }

  const [diff, staged, status] = await Promise.all([
    run("git", ["diff", "--no-color", "--unified=3", "HEAD"], { cwd, maxBytes }),
    run("git", ["diff", "--no-color", "--unified=3", "--cached"], { cwd, maxBytes }),
    run("git", ["status", "--porcelain"], { cwd, maxBytes: 20_000 }),
  ]);

  const parts: string[] = [];
  const changed = new Set<string>();

  for (const line of status.stdout.split("\n")) {
    const path = line.slice(3).trim();
    if (path) changed.add(path.replace(/^"|"$/g, ""));
  }

  if (staged.stdout.trim()) parts.push("# staged\n" + staged.stdout);

  // Untracked files never appear in a diff; include their content directly.
  const untracked: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.startsWith("??")) continue;
    const path = line.slice(3).trim().replace(/^"|"$/g, "");
    untracked.push(path);
  }

  if (untracked.length > 0) {
    const { readTextFile } = await import("./candidates.ts");
    const blocks: string[] = [];
    for (const relative of untracked.slice(0, 25)) {
      const text = readTextFile(`${cwd}/${relative}`, 40_000);
      if (text === null) continue;
      blocks.push(`--- new file: ${relative}\n${text}`);
    }
    if (blocks.length > 0) parts.push("# new files\n" + blocks.join("\n\n"));
    if (untracked.length > 25) parts.push(`# ${untracked.length - 25} further new files omitted`);
  }

  if (diff.stdout.trim()) parts.push("# unstaged\n" + diff.stdout);

  const text = parts.join("\n\n");
  return {
    text: text.length > maxBytes ? text.slice(0, maxBytes) : text,
    files: changed.size,
    truncated: text.length > maxBytes || diff.truncated || staged.truncated,
    ...(text.trim().length === 0 ? { note: "the working tree is clean — there is no evidence to check against" } : {}),
  };
}
