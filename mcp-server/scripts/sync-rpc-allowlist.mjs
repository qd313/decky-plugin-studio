#!/usr/bin/env node
/** Sync preview-rpc.json for a plugin workspace. Usage: node sync-rpc-allowlist.mjs <workspaceRoot> */
import { syncRpcAllowlistToSandbox } from "../dist/preview/syncRpcAllowlist.js";

const root = process.argv[2] ?? process.env.DECKY_STUDIO_WORKSPACE ?? process.cwd();
process.env.DECKY_STUDIO_WORKSPACE = root;
const snap = syncRpcAllowlistToSandbox(root);
console.log(JSON.stringify(snap));
