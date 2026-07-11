#!/usr/bin/env node
/**
 * Build Decky Plugin Studio VSIX and install into VS Code.
 * Usage: node scripts/deploy-to-vscode.mjs [--skip-install] [--skip-build]
 */
import { deploy } from "./deploy-vsix-shared.mjs";

const args = process.argv.slice(2);
deploy({
  prefer: "vscode",
  skipInstall: args.includes("--skip-install"),
  skipBuild: args.includes("--skip-build"),
});
