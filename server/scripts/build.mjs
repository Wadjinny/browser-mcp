// Bundle the server into dist/index.js for npm. `@browser-mcp/shared` is a
// private workspace package, so it is inlined; real npm dependencies stay
// external and are installed from package.json.
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  alias: { "@browser-mcp/shared": join(root, "../shared/src/index.ts") },
  define: {
    __SERVER_VERSION__: JSON.stringify(pkg.version),
    __SERVER_PACKAGE__: JSON.stringify(pkg.name),
  },
  logLevel: "info",
});
