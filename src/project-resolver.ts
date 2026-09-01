import { join, resolve } from "path";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";

export const PROJECTS_DIR = join(homedir(), "Projects");

// Each segment may contain alphanumeric characters, hyphens, underscores, dots, or spaces.
// This is the same character set as the original flat-name validator.
const SAFE_SEGMENT = /^[a-zA-Z0-9_\-. ]+$/;

/**
 * Validate a project name and return its path segments.
 *
 * Accepts 1–3 "/" separated segments. Rejects leading "/" or "~",
 * backslashes, empty segments, ".", "..", and segments with unsafe characters.
 * Does NOT touch the filesystem — pure string validation.
 */
export function validateProjectName(project: string): string[] {
  if (project.startsWith("/") || project.startsWith("~") || project.includes("\\")) {
    throw new Error(
      `Invalid project name: "${project}". Must not start with /, ~, or contain backslashes.`
    );
  }

  const segments = project.split("/");

  if (segments.length > 3) {
    throw new Error(
      `Invalid project name: "${project}". At most 3 path segments allowed (e.g. "Apps/lookahead" or "Clients/acme/site").`
    );
  }

  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new Error(
        `Invalid project name: "${project}". Segments must not be empty, ".", or "..".`
      );
    }
    if (!SAFE_SEGMENT.test(seg)) {
      throw new Error(
        `Invalid project name: "${project}". Each segment may only contain alphanumeric characters, hyphens, underscores, dots, or spaces.`
      );
    }
  }

  return segments;
}

function isInBounds(p: string): boolean {
  return p === PROJECTS_DIR || p.startsWith(PROJECTS_DIR + "/");
}

/**
 * Resolve a validated project name to an absolute path under ~/Projects/.
 *
 * Single-segment names use the existing search: ~/Projects/{name} first,
 * then one level deep (backwards compatible with the original flat lookup).
 *
 * Multi-segment names (e.g. "Apps/lookahead") are resolved directly as
 * ~/Projects/{name} — no search needed since the caller specified the full path.
 *
 * Throws if the name is invalid or the directory cannot be found.
 */
export function resolveProjectPath(project: string): string {
  const segments = validateProjectName(project);

  if (segments.length === 1) {
    // Backwards-compatible flat search
    const flat = resolve(PROJECTS_DIR, project);
    if (isInBounds(flat) && existsSync(flat)) return flat;

    try {
      const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = resolve(PROJECTS_DIR, entry.name, project);
        if (isInBounds(candidate) && existsSync(candidate)) return candidate;
      }
    } catch {
      // fall through to not-found
    }

    throw new Error(
      `Project not found: ${project} (checked ~/Projects/${project} and one level deep)`
    );
  }

  // Multi-segment: the caller specified the explicit nested path
  const explicit = resolve(PROJECTS_DIR, ...segments);
  if (!isInBounds(explicit)) {
    throw new Error(
      `Invalid project name: "${project}". Resolved path escapes ~/Projects/.`
    );
  }
  if (!existsSync(explicit)) {
    throw new Error(
      `Project not found: ${project} (expected ~/Projects/${project})`
    );
  }
  return explicit;
}
