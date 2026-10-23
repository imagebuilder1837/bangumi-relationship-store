import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { check } from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
async function modules(directory) {
  const files = [];
  for (const entry of await readdir(resolve(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await modules(path)));
    else if (entry.name.endsWith(".mjs")) files.push(path);
  }
  return files.sort();
}
for (const file of [
  ...(await modules("src")),
  ...(await modules("scripts")),
  ...(await modules("test")),
]) {
  if (
    !(await check(await readFile(resolve(root, file), "utf8"), {
      filepath: file,
    }))
  )
    throw new Error(`Prettier failed: ${file}`);
  execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
}
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(resolve(root, "package-lock.json"), "utf8"),
);
for (const field of ["name", "version", "devDependencies", "dependencies"]) {
  if (!isDeepStrictEqual(manifest[field], lock.packages[""][field]))
    throw new Error(`Lockfile ${field} differs from package.json`);
}
if (lock.name !== manifest.name || lock.version !== manifest.version)
  throw new Error("Lockfile identity differs from package.json");
const tests = (await modules("test")).filter((path) =>
  path.endsWith(".test.mjs"),
);
if (!tests.length) throw new Error("No tests found");
execFileSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});
console.log("Relationship store check passed");
