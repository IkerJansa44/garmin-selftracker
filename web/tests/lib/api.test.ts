import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchQuestionSettings, saveCheckInDraft } from "../../src/lib/api";

describe("API requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serializes JSON requests and returns the parsed response", async () => {
    const draft = { date: "2026-08-09", answers: { energy: 4 } };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ draft })));

    await expect(saveCheckInDraft(draft.date, draft.answers)).resolves.toEqual({ draft });
    expect(fetchMock).toHaveBeenCalledWith("/api/checkin-drafts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
      signal: undefined,
    });
  });

  it("surfaces structured API errors and falls back for non-JSON responses", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Invalid draft", details: "Date is required" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    await expect(saveCheckInDraft("", {})).rejects.toThrow("Invalid draft: Date is required");
    await expect(fetchQuestionSettings()).rejects.toThrow("Questions API failed: 503");
  });
});
