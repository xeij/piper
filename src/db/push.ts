import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");

await sql.unsafe(schema);
console.log("schema applied");
await sql.end();
