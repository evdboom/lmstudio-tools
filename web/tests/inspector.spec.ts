import { test, expect } from "@playwright/test";

test("lists bundled games and opens one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
  const cards = page.getByTestId("game-card");
  await expect(cards.first()).toBeVisible();
  // The three bundled games ship in the repo games/ folder.
  expect(await cards.count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByText("The Harbor Letter")).toBeVisible();
});

test("game detail shows manifest, graph nodes, and entity panel", async ({ page }) => {
  await page.goto("/");
  await page.getByText("The Harbor Letter").click();

  // Overview tab: authoring mode.
  await expect(page.getByTestId("authoring-mode")).toHaveText("fixed");

  // Graph tab: nodes render (suspects + clues).
  await page.getByTestId("tab-graph").click();
  await expect(page.getByTestId("graph")).toBeVisible();
  const nodes = page.locator(".react-flow__node");
  await expect(nodes.first()).toBeVisible();
  expect(await nodes.count()).toBeGreaterThanOrEqual(2);

  // Clicking a node opens the entity panel.
  await nodes.first().click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();
});

test("collections tab groups entities into tables", async ({ page }) => {
  await page.goto("/");
  await page.getByText("The Harbor Letter").click();
  await page.getByTestId("tab-collections").click();
  await expect(page.getByTestId("collections")).toBeVisible();
  await expect(page.getByRole("heading", { name: /suspects/ })).toBeVisible();
});
