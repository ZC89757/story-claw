import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {build as esbuild} from "esbuild";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "..");
const payloadRoot = path.join(projectRoot, "build", "mg-template-pack");
const packageEntry = require.resolve("@story-claw/mg-templates");
const templateRoot = path.resolve(path.dirname(packageEntry), "..");
const templatePackage = JSON.parse(await fs.readFile(path.join(templateRoot, "package.json"), "utf8"));

await fs.rm(payloadRoot, {recursive: true, force: true});
await fs.mkdir(path.join(payloadRoot, "src"), {recursive: true});

for (const name of ["src", "runtime", "public"]) {
  await fs.cp(path.join(templateRoot, name), path.join(payloadRoot, name), {recursive: true});
}
await fs.mkdir(path.join(payloadRoot, "tools", "mg-template-gallery", "public"), {recursive: true});
for (const name of ["index.html", "gallery.css"]) {
  await fs.copyFile(
    path.join(templateRoot, "tools", "mg-template-gallery", name),
    path.join(payloadRoot, "tools", "mg-template-gallery", name),
  );
}
await fs.cp(
  path.join(templateRoot, "tools", "mg-template-gallery", "public"),
  path.join(payloadRoot, "tools", "mg-template-gallery", "public"),
  {recursive: true},
);

const videoLibraryPath = path.normalize(path.join(templateRoot, "src", "video-footage", "library.ts"));
await esbuild({
  entryPoints: [path.join(templateRoot, "src", "provider.ts")],
  outfile: path.join(payloadRoot, "src", "provider.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
  plugins: [{
    name: "preserve-template-public-root",
    setup(build) {
      build.onLoad({filter: /[\\/]video-footage[\\/]library\.ts$/}, async (args) => {
        if (path.normalize(args.path) !== videoLibraryPath) return null;
        const source = await fs.readFile(args.path, "utf8");
        return {contents: source.replace('new URL("../../public/", import.meta.url)', 'new URL("../public/", import.meta.url)'), loader: "ts"};
      });
    },
  }],
});

const manifest = {
  name: "Story Claw MG Template Pack",
  version: templatePackage.version,
  protocolVersion: 1,
  provider: "src/provider.js",
  templateCommit: "0831945371d1956218561db06cce368ee3bc8281",
};
await fs.writeFile(path.join(payloadRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[template-pack] payload: ${payloadRoot}`);
console.log(`[template-pack] version: ${templatePackage.version}; protocol: 1`);
