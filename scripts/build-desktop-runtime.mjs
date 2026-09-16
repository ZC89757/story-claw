import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(projectRoot, "build", "runtime");

const iconSource = path.join(projectRoot, "assets", "branding", "storyclaw-logo-v6-ui.png");
const iconPng = await sharp(iconSource).resize(256, 256, {fit: "contain"}).png().toBuffer();
const iconHeader = Buffer.alloc(22);
iconHeader.writeUInt16LE(0, 0);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);
iconHeader.writeUInt8(0, 6);
iconHeader.writeUInt8(0, 7);
iconHeader.writeUInt8(0, 8);
iconHeader.writeUInt8(0, 9);
iconHeader.writeUInt16LE(1, 10);
iconHeader.writeUInt16LE(32, 12);
iconHeader.writeUInt32LE(iconPng.length, 14);
iconHeader.writeUInt32LE(iconHeader.length, 18);
await fs.mkdir(path.join(projectRoot, "build"), {recursive: true});
await fs.writeFile(path.join(projectRoot, "build", "icon.ico"), Buffer.concat([iconHeader, iconPng]));

console.log(`[desktop-build] runtime: ${runtimeRoot}`);
