#!/usr/bin/env node
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const productName = pkg.productName || pkg.name;
const icns = path.join(ROOT, "assets", "icon").replace(/\.icns$/, "");

console.log(`Packaging ${productName}...`);
execFileSync("npx", [
  "electron-packager", ".", productName,
  "--platform=darwin", "--arch=x64",
  "--icon=" + icns,
  "--out=dist", "--overwrite", "--no-prune",
], { cwd: ROOT, stdio: "inherit" });
console.log(`Done → dist/`);
