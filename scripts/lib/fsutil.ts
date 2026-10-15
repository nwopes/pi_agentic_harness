import fs from "node:fs";
import path from "node:path";
import { exists, isInside } from "./util.ts";

/** Recursive copy that skips excluded directory/file names anywhere in the tree. Symlinks are not followed. */
export function copyDir(src: string, dest: string, exclude: string[] = []): { files: number; bytes: number } {
  const ex = new Set(exclude.map((e) => e.toLowerCase()));
  let files = 0;
  let bytes = 0;
  const walk = (s: string, d: string) => {
    fs.mkdirSync(d, { recursive: true });
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      if (ex.has(ent.name.toLowerCase())) continue;
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(sp, dp);
      else if (ent.isFile()) {
        fs.copyFileSync(sp, dp);
        files++;
        bytes += fs.statSync(dp).size;
      } else if (ent.isSymbolicLink()) {
        try {
          fs.symlinkSync(fs.readlinkSync(sp), dp);
        } catch {
          /* ignore symlinks we cannot recreate (Windows privileges) */
        }
      }
    }
  };
  walk(src, dest);
  return { files, bytes };
}

/** rm -rf, but only for paths inside an allowed root (guards against deleting something important). */
export function removeInside(target: string, allowedRoot: string): void {
  if (!exists(target)) return;
  if (!isInside(target, allowedRoot) || path.resolve(target) === path.resolve(allowedRoot)) {
    throw new Error(`Refusing to delete ${target}: not strictly inside ${allowedRoot}`);
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

/** Ancestor directories of `dir` (excluding dir itself) that contain AGENTS.md or CLAUDE.md — Pi loads those. */
export function ancestorContextFiles(dir: string): string[] {
  const found: string[] = [];
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const f = path.join(cur, name);
      if (exists(f)) found.push(f);
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}
