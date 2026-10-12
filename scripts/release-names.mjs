import assert from "node:assert/strict";

export function releasePrefix(version) {
  assert(/^\d+\.\d+\.\d+$/.test(version), "Expected a stable release version");
  const [major, minor] = version.split(".").map(Number);
  return major > 2 || (major === 2 && minor >= 4) ? "aro" : "irang";
}

export function releaseRegistry(version) {
  return `ghcr.io/madrobotnet/${releasePrefix(version)}`;
}

export function installArchiveName(version) {
  return `${releasePrefix(version)}-${version}-install.tar.gz`;
}
