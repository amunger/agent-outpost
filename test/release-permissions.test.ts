import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const permissionNormalization = [
  /find "\$\{(?:partial_release|release_directory)\}" -type f ! -perm \/0111 -exec chmod 0644 \{\} \+/,
  /find "\$\{(?:partial_release|release_directory)\}" -type f -perm \/0111 -exec chmod 0755 \{\} \+/,
];

test("release installers preserve executable files", () => {
  for (const script of ["ops/agent-outpost-deploy", "ops/install-release.sh"]) {
    const content = readFileSync(script, "utf8");
    for (const pattern of permissionNormalization) {
      assert.match(content, pattern, `${script} must normalize release permissions safely`);
    }
  }
});
