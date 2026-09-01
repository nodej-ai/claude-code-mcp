import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProjectName } from "../project-resolver.js";

// ─── Accepts ──────────────────────────────────────────────────────────────────

test("accepts plain top-level name", () => {
  assert.deepStrictEqual(validateProjectName("forkcast"), ["forkcast"]);
});

test("accepts name with hyphens and underscores", () => {
  assert.deepStrictEqual(validateProjectName("my-project_v2"), ["my-project_v2"]);
});

test("accepts two-segment nested path", () => {
  assert.deepStrictEqual(validateProjectName("Apps/lookahead"), ["Apps", "lookahead"]);
});

test("accepts three-segment nested path", () => {
  assert.deepStrictEqual(validateProjectName("Clients/acme/site"), ["Clients", "acme", "site"]);
});

test("accepts segment with spaces", () => {
  assert.deepStrictEqual(validateProjectName("My Projects/lookahead"), ["My Projects", "lookahead"]);
});

// ─── Rejects ──────────────────────────────────────────────────────────────────

test('rejects "../x" (dotdot segment)', () => {
  assert.throws(() => validateProjectName("../x"), /Invalid project name/);
});

test('rejects "Apps/../etc" (dotdot mid-path)', () => {
  assert.throws(() => validateProjectName("Apps/../etc"), /Invalid project name/);
});

test('rejects "/abs" (absolute path)', () => {
  assert.throws(() => validateProjectName("/abs"), /Invalid project name/);
});

test('rejects "Apps//x" (empty segment)', () => {
  assert.throws(() => validateProjectName("Apps//x"), /Invalid project name/);
});

test('rejects "Apps/look;ahead" (unsafe character)', () => {
  assert.throws(() => validateProjectName("Apps/look;ahead"), /Invalid project name/);
});

test('rejects "~/Projects" (tilde prefix)', () => {
  assert.throws(() => validateProjectName("~/Projects"), /Invalid project name/);
});

test("rejects backslash in path", () => {
  assert.throws(() => validateProjectName("Apps\\lookahead"), /Invalid project name/);
});

test("rejects more than 3 segments", () => {
  assert.throws(() => validateProjectName("a/b/c/d"), /Invalid project name/);
});

test('rejects lone "." segment', () => {
  assert.throws(() => validateProjectName("Apps/./lookahead"), /Invalid project name/);
});
