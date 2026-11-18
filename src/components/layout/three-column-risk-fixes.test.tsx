import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const reviewCenterSource = readFileSync(resolve(__dirname, "../review/review-center-view.tsx"), "utf8")

describe("three-column risk fixes", () => {
  it("keeps non-novel review center compatible with the existing dashboard view", () => {
    expect(reviewCenterSource).toContain("!novelMode")
    expect(reviewCenterSource).toContain("renderReview(<DashboardView headerActions={<ReviewStartButton />} />)")
  })
})
