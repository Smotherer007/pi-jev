/**
 * Cheap candidate generation.
 *
 * This module is the reason pi-jev can save tokens at all, so it is worth
 * being explicit about the contract: **nothing here costs model tokens.**
 * Candidates are produced by the filesystem and by regular expressions, they
 * are trimmed to previews, and only then is a provider asked which ones
 * matter. The full text of fifty files never reaches a model at any point.
 *
 * Everything is implemented with `node:fs` rather than shelling out, so a
 * missing `rg` cannot change the result and the behaviour is testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Candidate {
  /** Stable key: the path, or `path:line` for line-level candidates. */
  key: string;
  /** Path relative to the search root. */
  path: string;
  /** 1-based line number, for line-level candidates. */
  line?: number;
  /** Excerpt handed to the provider. */
  preview: string;
  /** Bytes on disk, for files. */
  size?: number;
}

export interface GenerateOptions {
  cwd: string;
  /** Directory to search, relative to cwd. */
  root?: string;
  /** Glob-ish patterns: `*.ts`, `src/**`, `*.test.ts`. */
  globs?: string[];
  /** Only files whose content matches this regex. */
  pattern?: string;
  patternFlags?: string;
  /** Emit one candidate per matching line instead of one per file. */
  perLine?: boolean;
  /** Stop after this many candidates. */
  maxCandidates?: number;
  /** Characters of context kept per candidate. */
  previewChars?: number;
  /** Extra directory names to skip. */
  exclude?: string[];
}

const DEFAULT_EXCLUDE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "graph-out",
  ".cache",
  ".turbo",
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar",
  ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".mov", ".wasm", ".so", ".dylib",
  ".dll", ".exe", ".bin", ".class", ".jar", ".lock",
]);

/**
 * Compile a small glob dialect into a regex.
 *
 * Supports `*` (within a segment), `**` (across segments) and `?`. A pattern
 * without a slash matches against the basename anywhere in the tree, which is
 * what people mean by `*.ts`.
 */
export function globToRegex(glob: string): RegExp {
  const normalised = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < normalised.length; i += 1) {
    const char = normalised[i];
    if (char === undefined) break;
    if (char === "*") {
      if (normalised[i + 1] === "*") {
        // `**/` may match zero directories, so `src/**/*.ts` also matches `src/a.ts`.
        if (normalised[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlobs(relativePath: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  const normalised = relativePath.replace(/\\/g, "/");
  const basename = normalised.split("/").pop() ?? normalised;

  return globs.some((glob) => {
    const regex = globToRegex(glob);
    // A pattern with no slash is a basename pattern; with a slash it is a path pattern.
    return glob.includes("/") ? regex.test(normalised) : regex.test(basename);
  });
}

interface WalkState {
  files: string[];
  limit: number;
}

function walk(dir: string, root: string, exclude: Set<string>, state: WalkState): void {
  if (state.files.length >= state.limit) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.files.length >= state.limit) return;
    if (exclude.has(entry.name)) continue;

    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, root, exclude, state);
    } else if (entry.isFile()) {
      const extension = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      state.files.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
}

export function listFiles(options: GenerateOptions): string[] {
  const cwd = options.cwd;
  const root = path.resolve(cwd, options.root ?? ".");
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);
  const state: WalkState = { files: [], limit: (options.maxCandidates ?? 200) * 20 };

  walk(root, root, exclude, state);

  return state.files
    .filter((file) => matchesGlobs(file, options.globs))
    .sort();
}

/** Read a file, returning null when it is unreadable or looks binary. */
export function readTextFile(absolutePath: string, maxBytes = 200_000): string | null {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const text = fs.readFileSync(absolutePath, "utf-8");
    // A NUL byte in the first kilobyte is the usual cheap binary signal.
    if (text.slice(0, 1024).includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * A line that declares something.
 *
 * What a file *is* lives in its declarations. That is the whole reason the
 * preview is not simply "the first four non-empty lines": in a source file those
 * are almost always imports and imports say nothing about whether the file
 * matters. `import` is deliberately absent from this pattern for that reason.
 */
const DECLARATION =
  /^\s*(export\s|declare\s|class\s|function\s|async\s+function\s|def\s|fn\s|func\s|struct\s|interface\s|type\s|enum\s|impl\s|trait\s|pub\s|public\s|private\s|protected\s|internal\s|module\s|package\s|const\s+\w+\s*=\s*(async\s*)?\(|let\s+\w+\s*=\s*(async\s*)?\(|@|describe\(|it\(|test\()/;

/** Lines that carry no information about what a file is. */
function isNoise(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("#!") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("from ") ||
    trimmed.startsWith("require(") ||
    trimmed.startsWith("using ")
  );
}

/**
 * The excerpt handed to the provider for one candidate.
 *
 * The provider judges a candidate by nothing but this text, so a preview of four
 * import lines makes every source file look identical and leaves the filter
 * guessing — which is the failure mode triage cannot afford, because a wrong
 * drop is silent. Three sources, in this order:
 *
 *   1. The lines that matched the caller's pattern, with a line of context.
 *      They are the reason the file is in the list at all.
 *   2. Lines that declare something.
 *   3. The first plain lines, so a config file, a template or prose still gets
 *      a preview rather than an empty one.
 */
export function filePreview(
  text: string,
  options: { matchedLines?: readonly number[]; maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = options.maxLines ?? 4;
  const maxChars = options.maxChars ?? 400;
  const lines = text.split("\n");
  const chosen = new Set<number>();

  const take = (index: number): void => {
    if (index < 0 || index >= lines.length || chosen.size >= maxLines) return;
    chosen.add(index);
  };

  for (const match of options.matchedLines ?? []) {
    take(match - 2);
    take(match - 1);
    take(match);
  }

  if (chosen.size < maxLines) {
    for (const [index, line] of lines.entries()) {
      if (DECLARATION.test(line)) take(index);
      if (chosen.size >= maxLines) break;
    }
  }

  if (chosen.size === 0) {
    for (const [index, line] of lines.entries()) {
      if (!isNoise(line)) take(index);
      if (chosen.size >= maxLines) break;
    }
  }

  const out: string[] = [];
  let chars = 0;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    const line = (lines[index] ?? "").trim();
    if (chars + line.length > maxChars) break;
    out.push(line);
    chars += line.length + 1;
  }
  return out.join("\n");
}

export interface GenerateResult {
  candidates: Candidate[];
  /** Files considered before filtering. */
  considered: number;
  /** True when the candidate cap cut the list short. */
  truncated: boolean;
}

export function generateCandidates(options: GenerateOptions): GenerateResult {
  const maxCandidates = options.maxCandidates ?? 200;
  const previewChars = options.previewChars ?? 400;
  const root = path.resolve(options.cwd, options.root ?? ".");
  const files = listFiles(options);

  const candidates: Candidate[] = [];
  let truncated = false;

  let regex: RegExp | null = null;
  if (options.pattern) {
    try {
      regex = new RegExp(options.pattern, options.patternFlags ?? "i");
    } catch (error) {
      throw new Error(`Invalid pattern ${JSON.stringify(options.pattern)}: ${(error as Error).message}`);
    }
  }

  for (const file of files) {
    if (candidates.length >= maxCandidates) {
      truncated = true;
      break;
    }

    const absolute = path.join(root, file);

    if (!regex) {
      const text = readTextFile(absolute);
      if (text === null) continue;
      const preview = filePreview(text, { maxLines: 4, maxChars: previewChars });
      candidates.push({
        key: file,
        path: file,
        preview: preview.length > 0 ? preview : "(no declarations, and nothing plain enough to preview)",
        size: fs.statSync(absolute).size,
      });
      continue;
    }

    const text = readTextFile(absolute);
    if (text === null) continue;

    const lines = text.split("\n");
    // Where the pattern hit: those lines are the reason this file is in the
    // list, so they are what the preview has to show.
    const matchedLines: number[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;

      if (!options.perLine) {
        if (matchedLines.length < 6) matchedLines.push(index + 1);
        continue;
      }

      if (candidates.length >= maxCandidates) {
        truncated = true;
        break;
      }
      candidates.push({
        key: `${file}:${index + 1}`,
        path: file,
        line: index + 1,
        preview: line.trim().slice(0, previewChars),
      });
    }

    if (matchedLines.length > 0) {
      const preview = filePreview(text, { matchedLines, maxLines: 4, maxChars: previewChars });
      candidates.push({
        key: file,
        path: file,
        preview: preview.length > 0 ? preview : "(matched, but the surrounding lines are not previewable)",
        size: fs.statSync(absolute).size,
      });
    }
  }

  return { candidates, considered: files.length, truncated };
}

/**
 * Render candidates for the provider. Deliberately compact: index, key, then
 * the preview, so the answer can reference an item by index and stay short.
 */
export function renderCandidatesForState(candidates: readonly Candidate[], maxChars: number): string {
  const parts: string[] = [];
  let total = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const block = `[${index}] ${candidate.key}\n${candidate.preview}`;
    if (total + block.length > maxChars) {
      parts.push(`… ${candidates.length - index} further candidates omitted to fit the state budget.`);
      break;
    }
    parts.push(block);
    total += block.length + 1;
  }
  return parts.join("\n\n");
}
