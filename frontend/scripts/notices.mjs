// Writes the licence texts of every npm package bundled in the built
// frontend (not development tools), for the app's licence notices.
//
//   node scripts/notices.mjs [utfil]     (standard: skriver till stdout)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows that would be "/D:/…".
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const out = [];
const rows = [];
for (const [key, info] of Object.entries(lock.packages)) {
  if (!key || info.dev || info.optional) continue;
  const dir = path.join(root, key);
  const name = key.replace(/^.*node_modules\//, "");
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue; // inte installerat på den här plattformen
  }
  const license = info.license ?? pkg.license ?? "okänd";
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort()
    : [];
  rows.push({ name, version: info.version ?? pkg.version, license, url: pkg.homepage ?? "" });
  out.push(`${"=".repeat(78)}\n${name} ${info.version ?? pkg.version} – ${license}\n${pkg.homepage ?? ""}\n${"=".repeat(78)}\n`);
  for (const f of files) out.push(fs.readFileSync(path.join(dir, f), "utf8").trim() + "\n");
  if (!files.length) out.push(`(Ingen licensfil i paketet. Licens enligt package.json: ${license}.)\n`);
  out.push("\n");
}
rows.sort((a, b) => a.name.localeCompare(b.name));
const text = out.join("");
if (process.argv[2] === "--json") process.stdout.write(JSON.stringify(rows, null, 1));
else if (process.argv[2]) fs.writeFileSync(process.argv[2], text);
else process.stdout.write(text);
