import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("../public/social-card.svg", import.meta.url));
const output = fileURLToPath(new URL("../public/social-card.png", import.meta.url));
const svg = await readFile(source);

await sharp(svg).png({ compressionLevel: 9, quality: 90 }).toFile(output);

console.log("Generated public/social-card.png (1200×630)");
