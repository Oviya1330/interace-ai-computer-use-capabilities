#!/usr/bin/env node
// Thin launcher so `npx cua` works without a build step.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "cli", "main.ts");
const child = spawn(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
