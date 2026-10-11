import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(process.argv[2] || ".env");
const setupToken = randomBytes(32).toString("hex");
const databasePassword = randomBytes(32).toString("hex");
const databaseAdminPassword = randomBytes(32).toString("hex");
const content = [
  "# Generated installation secrets. Keep this file private.",
  `POSTGRES_PASSWORD=${databasePassword}`,
  `POSTGRES_ADMIN_PASSWORD=${databaseAdminPassword}`,
  `SETUP_TOKEN=${setupToken}`,
  "APP_PORT=3000",
  "# Use 1 only for a loopback HTTP test, never a public service.",
  "INSECURE_COOKIES=0",
  "TRUSTED_PROXY_HOPS=1",
  "",
].join("\n");

try {
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
  console.log(`Created ${target}`);
  console.log("Installation code is stored only in the private environment file.");
  console.log("Read SETUP_TOKEN locally in a private terminal and enter it on /setup.");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    console.error("The environment file already exists; it was not changed.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
