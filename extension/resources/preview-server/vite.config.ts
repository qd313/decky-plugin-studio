import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";

import fs from "fs";

import path from "path";

import { deckyShimPlugin } from "./vite-plugin-decky-shim";



const previewRoot = path.resolve(".");

const pluginRoot = process.env.DECKY_PLUGIN_ROOT ?? path.resolve("..", "example-plugin");

const pluginSrc = path.join(pluginRoot, "src/index.tsx");

const pluginDist = path.join(pluginRoot, "dist/index.js");

const pluginEntry = fs.existsSync(pluginSrc)

  ? pluginSrc

  : fs.existsSync(pluginDist)

    ? pluginDist

    : pluginSrc;



const fsAllow = new Set<string>([previewRoot, pluginRoot]);

const pluginNodeModules = path.join(pluginRoot, "node_modules");

if (fs.existsSync(pluginNodeModules)) {

  fsAllow.add(pluginNodeModules);

}



export default defineConfig({

  plugins: [react(), deckyShimPlugin()],

  root: previewRoot,

  build: {

    rollupOptions: {

      input: {

        sandbox: path.resolve("sandbox-host.html"),

      },

    },

  },

  server: {

    port: Number(process.env.DECKY_PREVIEW_PORT ?? 5173),

    host: "127.0.0.1",

    fs: {

      allow: [...fsAllow],

    },

    configureServer(server) {

      server.middlewares.use("/api/permissions", (req, res, next) => {
        if (req.method === "GET") {
          const file = path.join(process.cwd(), ".preview-permissions.json");
          let perms = {};
          if (fs.existsSync(file)) {
            try {
              perms = JSON.parse(fs.readFileSync(file, "utf8"));
            } catch {
              /* ignore */
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ permissions: perms }));
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              fs.writeFileSync(
                path.join(process.cwd(), ".preview-permissions.json"),
                JSON.stringify(parsed, null, 2)
              );
            } catch {
              /* ignore */
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ permissions: JSON.parse(body || "{}") }));
          });
          return;
        }
        next();
      });

      server.middlewares.use("/api/hw-state", (req, res, next) => {

        if (req.method === "POST") {

          let body = "";

          req.on("data", (c) => (body += c));

          req.on("end", () => {

            try {

              const state = JSON.parse(body);

              import("fs").then((fsMod) => {

                fsMod.writeFileSync(path.join(process.cwd(), ".hw-state.json"), body);

              });

            } catch {

              /* ignore */

            }

            res.writeHead(204);

            res.end();

          });

          return;

        }

        next();

      });

    },

  },

  resolve: {

    dedupe: ["react", "react-dom"],

    alias: {

      "@plugin": pluginRoot,

      "@decky-plugin-entry": pluginEntry,

      "@decky/api": path.join(previewRoot, "src/shim/api.ts"),

      "@decky/ui": path.join(previewRoot, "src/shim/ui/index.tsx"),

      "@decky/manifest": path.join(previewRoot, "src/shim/manifest.ts"),

      "decky-frontend-lib": path.join(previewRoot, "src/shim/ui/index.tsx"),

      react: path.join(previewRoot, "node_modules/react"),

      "react-dom": path.join(previewRoot, "node_modules/react-dom"),

    },

  },

  define: {

    "import.meta.env.DECKY_PLUGIN_ROOT": JSON.stringify(pluginRoot),

    "import.meta.env.DECKY_PLUGIN_ENTRY": JSON.stringify(pluginEntry),

    "import.meta.env.DECKY_PREVIEW": JSON.stringify(process.env.DECKY_PREVIEW === "true"),

  },

});


