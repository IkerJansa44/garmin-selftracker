import { expect, test } from "@playwright/test";

test("a saved check-in turns green and survives a reload", async ({ page }) => {
  const initialCheckins = page.waitForResponse(
    (response) =>
      response.url().includes("/api/checkins?") && response.request().method() === "GET",
  );
  await page.goto("/?view=checkin");
  await initialCheckins;

  const panel = page.getByRole("article", { name: "Daily Check-In" });
  const journal = page.getByPlaceholder("Optional note");
  await journal.fill("Playwright recovery check");

  const savedCheckin = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/checkins") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save Check-In" }).click();
  expect((await savedCheckin).ok()).toBe(true);

  await expect(page.getByText(/Saved check-in for/)).toBeVisible();
  await expect(panel).toHaveCSS("background-color", "rgb(237, 245, 239)");

  const reloadedCheckins = page.waitForResponse(
    (response) =>
      response.url().includes("/api/checkins?") && response.request().method() === "GET",
  );
  await page.reload();
  await reloadedCheckins;

  await expect(journal).toHaveValue("Playwright recovery check");
  await expect(panel).toHaveCSS("background-color", "rgb(237, 245, 239)");
});
