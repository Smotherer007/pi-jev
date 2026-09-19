import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateCandidates,
  globToRegex,
  listFiles,
  matchesGlobs,
  readTextFile,
  renderCandidatesForState,
} from "../src/candidates.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = path.join(here, "fixtures", "sample");

describe("globToRegex", () => {
  it("anchors the pattern", () => {
    assert.ok(globToRegex("auth.ts").test("auth.ts"));
    assert.ok(!globToRegex("auth.ts").test("src/auth.ts"));
  });

  it("treats * as within a path segment", () => {
    const regex = globToRegex("*.ts");
    assert.ok(regex.test("auth.ts"));
    assert.ok(!regex.test("auth.js"));
  });

  it("treats ** as spanning segments and allows zero directories", () => {
    const regex = globToRegex("src/**/*.ts");
    assert.ok(regex.test("src/auth.ts"), "zero directories should match");
    assert.ok(regex.test("src/deep/nested/auth.ts"));
    assert.ok(!regex.test("other/auth.ts"));
  });

  it("escapes regex metacharacters instead of interpreting them", () => {
    const regex = globToRegex("a.b+c.ts");
    assert.ok(regex.test("a.b+c.ts"));
    assert.ok(!regex.test("axbbc.ts"));
  });

  it("supports ? for a single character", () => {
    assert.ok(globToRegex("a?c.ts").test("abc.ts"));
    assert.ok(!globToRegex("a?c.ts").test("abbc.ts"));
  });
});

describe("matchesGlobs", () => {
  it("accepts everything when no globs are given", () => {
    assert.ok(matchesGlobs("anything/at/all.ts", undefined));
    assert.ok(matchesGlobs("anything/at/all.ts", []));
  });

  it("matches a slashless pattern against the basename at any depth", () => {
    assert.ok(matchesGlobs("deep/nested/auth.ts", ["*.ts"]));
    assert.ok(matchesGlobs("auth.ts", ["auth.*"]));
    assert.ok(!matchesGlobs("deep/nested/auth.ts", ["src/*.ts"]));
  });

  it("matches a pattern with a slash against the full path", () => {
    assert.ok(matchesGlobs("src/auth.ts", ["src/*.ts"]));
    assert.ok(!matchesGlobs("src/deep/auth.ts", ["src/*.ts"]));
  });
});

describe("listFiles", () => {
  it("skips node_modules and other noise by default", () => {
    const files = listFiles({ cwd: sample });
    assert.ok(files.includes("src/auth.ts"));
    assert.ok(!files.some((file) => file.includes("node_modules")), "node_modules must not be walked");
  });

  it("returns paths relative to the search root, posix-separated", () => {
    for (const file of listFiles({ cwd: sample })) {
      assert.ok(!file.startsWith("/"), `${file} should be relative`);
      assert.ok(!file.includes("\\"), `${file} should use forward slashes`);
    }
  });

  it("filters by glob", () => {
    const files = listFiles({ cwd: sample, globs: ["*.md"] });
    assert.deepEqual(files.sort(), ["README.md", "docs/notes.md"]);
  });

  it("honours an extra exclude", () => {
    const files = listFiles({ cwd: sample, exclude: ["docs"] });
    assert.ok(!files.includes("docs/notes.md"));
  });

  it("restricts to a subdirectory via root", () => {
    const files = listFiles({ cwd: sample, root: "src" });
    assert.ok(files.includes("auth.ts"));
    assert.ok(!files.includes("README.md"));
  });

  it("sorts deterministically", () => {
    assert.deepEqual(listFiles({ cwd: sample }), [...listFiles({ cwd: sample })].sort());
  });
});

describe("readTextFile", () => {
  it("reads a text file", () => {
    assert.match(readTextFile(path.join(sample, "README.md")) ?? "", /# Sample/);
  });

  it("returns null for a missing file rather than throwing", () => {
    assert.equal(readTextFile(path.join(sample, "does-not-exist.ts")), null);
  });

  it("returns null when the file is over the size cap", () => {
    assert.equal(readTextFile(path.join(sample, "README.md"), 5), null);
  });
});

describe("generateCandidates", () => {
  it("produces one candidate per file with a preview, and no pattern", () => {
    const { candidates, considered } = generateCandidates({ cwd: sample, globs: ["*.ts"] });
    assert.ok(considered >= 3);
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((candidate) => candidate.preview.length > 0));
  });

  it("skips shebang and comment banner lines when building the preview", () => {
    const { candidates } = generateCandidates({ cwd: sample, globs: ["auth.ts"] });
    assert.doesNotMatch(candidates[0]?.preview ?? "", /authentication helpers/);
    assert.match(candidates[0]?.preview ?? "", /export function login/);
  });

  it("filters to files whose content matches the pattern", () => {
    const { candidates } = generateCandidates({ cwd: sample, globs: ["*.ts"], pattern: "createInvoice" });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.path, "src/billing.ts");
  });

  it("emits one candidate per matching line when perLine is set", () => {
    const { candidates } = generateCandidates({ cwd: sample, globs: ["*.md"], pattern: "login", perLine: true });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]?.key ?? "", /notes\.md:3$/);
    assert.equal(candidates[0]?.line, 3);
  });

  it("ignores case by default so a pattern need not be exact", () => {
    const { candidates } = generateCandidates({ cwd: sample, globs: ["*.md"], pattern: "NOTES" });
    assert.equal(candidates.length, 1);
  });

  it("reports truncation instead of silently dropping candidates", () => {
    const { candidates, truncated } = generateCandidates({ cwd: sample, globs: ["*.ts"], maxCandidates: 2 });
    assert.equal(candidates.length, 2);
    assert.equal(truncated, true);
  });

  it("throws a readable error for an invalid pattern", () => {
    assert.throws(
      () => generateCandidates({ cwd: sample, pattern: "([unclosed" }),
      /Invalid pattern/,
    );
  });

  it("returns nothing rather than throwing when no file matches", () => {
    const { candidates } = generateCandidates({ cwd: sample, globs: ["*.nope"] });
    assert.deepEqual(candidates, []);
  });
});

describe("renderCandidatesForState", () => {
  const candidates = [
    { key: "a.ts", path: "a.ts", preview: "first" },
    { key: "b.ts", path: "b.ts", preview: "second" },
    { key: "c.ts", path: "c.ts", preview: "third" },
  ];

  it("numbers candidates so answers can reference them by index", () => {
    const text = renderCandidatesForState(candidates, 10_000);
    assert.match(text, /\[0\] a\.ts/);
    assert.match(text, /\[2\] c\.ts/);
  });

  it("states how many were omitted when the budget runs out", () => {
    const text = renderCandidatesForState(candidates, 30);
    assert.match(text, /further candidates omitted/);
    assert.ok(!text.includes("third"), "the omitted preview must not leak into the state");
  });

  it("includes everything when the budget allows", () => {
    const text = renderCandidatesForState(candidates, 10_000);
    assert.ok(text.includes("first") && text.includes("second") && text.includes("third"));
  });
});
