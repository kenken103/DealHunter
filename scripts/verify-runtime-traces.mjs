import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, ".local");
const knownKeys = new Set(["api-key", "demo-auth.key"]);

for (const route of ["sales/page", "api/dashboard/route"]) {
  const manifest = path.join(root, ".next", "server", "app", route + ".js.nft.json");
  try {
    const { files } = JSON.parse(await readFile(manifest, "utf8"));
    if (!Array.isArray(files) || !files.every(file => typeof file === "string")) {
      throw new Error("Invalid files list in the build trace");
    }

    let runtimeFiles = 0;
    let namedKeys = 0;
    for (const file of files) {
      const absolute = path.resolve(path.dirname(manifest), file.replaceAll("\\", "/"));
      const relative = path.relative(runtime, absolute);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
      if (knownKeys.has(relative)) namedKeys++;
      else runtimeFiles++;
    }

    const failed = runtimeFiles > 0;
    console.log(`${failed ? "FAIL" : "PASS"} ${route}: ${runtimeFiles} local runtime paths, ${namedKeys} named key paths`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL ${route}: ${error.code === "ENOENT" ? "Build trace missing. Run npm run build first." : error.message}`);
    process.exitCode = 1;
  }
}
