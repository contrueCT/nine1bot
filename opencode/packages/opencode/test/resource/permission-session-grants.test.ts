import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

test("evaluateWithSessionGrants keeps deny higher priority than session allow", () => {
  const base: PermissionNext.Ruleset = [{ permission: "skill", pattern: "secret", action: "deny" }]
  const grants: PermissionNext.Ruleset = [{ permission: "skill", pattern: "secret", action: "allow" }]

  expect(PermissionNext.evaluateWithSessionGrants("skill", "secret", base, grants).action).toBe("deny")
})
