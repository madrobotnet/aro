import { modelLock } from "./model-management";
const directory = process.argv[2];
if (!directory) throw new Error("Fixture requires directory");
const release = await modelLock(directory);
process.on("SIGTERM", () => { release(); process.exit(0); });
console.log("LOCKED");
// Stay alive until the parent deliberately kills this fixture.
process.stdin.resume();
