import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CheckinPanel, resolveSwipeDirection } from "./CheckinPanel";

describe("CheckinPanel", () => {
  it("turns green when the check-in becomes saved", async () => {
    const user = userEvent.setup();

    function SaveCheckinHarness() {
      const [isSaved, setIsSaved] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setIsSaved(true)}>
            Save Check-In
          </button>
          <CheckinPanel isSaved={isSaved} isDirty={false} />
        </>
      );
    }

    render(<SaveCheckinHarness />);
    const panel = screen.getByRole("article");

    expect(panel).not.toHaveStyle({ backgroundColor: "#edf5ef" });
    await user.click(screen.getByRole("button", { name: "Save Check-In" }));

    expect(panel).toHaveStyle({ backgroundColor: "#edf5ef" });
    expect(panel).toHaveClass("border", "border-[#d7e6dc]");
  });

  it.each([
    { isDirty: false, isSaved: false },
    { isDirty: true, isSaved: true },
  ])("does not turn green when the check-in is unsaved or dirty", ({ isDirty, isSaved }) => {
    render(<CheckinPanel isSaved={isSaved} isDirty={isDirty} />);
    const panel = screen.getByRole("article");

    expect(panel).not.toHaveStyle({ backgroundColor: "#edf5ef" });
    expect(panel).not.toHaveClass("border-[#d7e6dc]");
  });

  it("maps deliberate horizontal swipes to day navigation", () => {
    expect(resolveSwipeDirection(-80, 10)).toBe("next");
    expect(resolveSwipeDirection(80, 10)).toBe("previous");
  });

  it("ignores short or mostly vertical gestures", () => {
    expect(resolveSwipeDirection(40, 0)).toBeNull();
    expect(resolveSwipeDirection(80, 100)).toBeNull();
  });
});
