#!/usr/bin/env node
import { chmod } from "node:fs/promises";

await chmod(new URL("../dist/bin/domjet.mjs", import.meta.url), 0o755);
