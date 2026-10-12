import { expect, test } from "bun:test";
import { installArchiveName, releasePrefix, releaseRegistry } from "./release-names.mjs";

test.each([["2.3.2", "irang"], ["2.3.99", "irang"], ["2.4.0", "aro"], ["2.10.0", "aro"], ["3.0.0", "aro"]])(
  "release names for %s use %s", (version, prefix) => {
    expect(releasePrefix(version)).toBe(prefix);
    expect(releaseRegistry(version)).toBe(`ghcr.io/madrobotnet/${prefix}`);
    expect(installArchiveName(version)).toBe(`${prefix}-${version}-install.tar.gz`);
  },
);
