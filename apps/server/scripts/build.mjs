import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      // Keep third-party packages external (they are installed in the runtime
      // image); bundle only workspace packages ("./..." or "@sessionbox/...").
      name: "external-node-modules",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@sessionbox/")) return null;
          if (path.isAbsolute(args.path)) return null;
          return { external: true };
        });
      },
    },
  ],
});
