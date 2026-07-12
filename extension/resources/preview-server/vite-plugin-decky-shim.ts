import type { Plugin } from "vite";

import path from "path";



export function deckyShimPlugin(): Plugin {

  const shimRoot = path.resolve("src/shim");

  const shims: Record<string, string> = {

    "@decky/api": path.join(shimRoot, "api.ts"),

    "@decky/ui": path.join(shimRoot, "ui/index.tsx"),

    "@decky/manifest": path.join(shimRoot, "manifest.ts"),

    "decky-frontend-lib": path.join(shimRoot, "ui/index.tsx"),

  };



  return {

    name: "decky-shim",

    enforce: "pre",

    resolveId(source) {

      return shims[source] ?? null;

    },

  };

}


