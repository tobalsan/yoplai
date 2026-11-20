import fs from "node:fs";
import { URL } from "node:url";


const destination = new URL("../dist/splash/", import.meta.url);
fs.mkdirSync(destination, { recursive: true });
for (const file of ["splash.html", "splash.css"]) {
  fs.copyFileSync(new URL(`../src/splash/${file}`, import.meta.url), new URL(file, destination));
}
