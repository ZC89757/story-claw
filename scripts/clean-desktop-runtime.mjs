import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
await fs.rm(path.join(projectRoot, "build", "runtime"), {recursive: true, force: true});
