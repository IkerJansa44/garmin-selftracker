import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deletePushSubscription,
  fetchQuestionSettings,
  fetchWebPushPublicKey,
  saveCheckInDraft,
  savePushSubscription,
} from "../../src/lib/api";

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

  it("loads, saves, and removes Web Push subscriptions", async () => {
    const subscription = {
      endpoint: "https://web.push.apple.com/example",
      expirationTime: null,
      keys: { p256dh: "public-key", auth: "auth-key" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: "vapid-key" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscribed: true, created: true })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscribed: false, removed: true })),
      );

    await expect(fetchWebPushPublicKey()).resolves.toEqual({ publicKey: "vapid-key" });
    await expect(savePushSubscription(subscription)).resolves.toEqual({
      subscribed: true,
      created: true,
    });
    await expect(deletePushSubscription(subscription.endpoint)).resolves.toEqual({
      subscribed: false,
      removed: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
      signal: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: undefined,
    });
  });
});
