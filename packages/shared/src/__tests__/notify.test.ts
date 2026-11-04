import { describe, expect, it, vi } from "vitest";
import { notify } from "../notify.js";

const config = {
  channels: {
    default: { discord: "discord-channel", slack: "slack-channel" },
    alerts: { slack: "alerts-channel" },
  },
};

describe("notify", () => {
  it("posts Mattermost messages with the channel id in the body and bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    const result = await notify({
      config: { channels: { default: { mattermost: "mattermost-channel" } } },
      channel: "default",
      surface: "mattermost",
      message: "hi",
      mattermostUrl: "https://mattermost.example.com",
      mattermostToken: "fake-mattermost-token",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      results: [{ surface: "mattermost", channelId: "mattermost-channel", ok: true }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://mattermost.example.com/api/v4/posts", {
      method: "POST",
      headers: {
        authorization: "Bearer fake-mattermost-token",
        "content-type": "application/json",
      },
      body: '{"channel_id":"mattermost-channel","message":"hi"}',
    });
  });

  it("sends discord notifications to the resolved channel id", async () => {
    const discord = vi.fn().mockResolvedValue(undefined);

    const result = await notify({
      config,
      channel: "default",
      surface: "discord",
      message: "hi",
      discordToken: "discord-token",
      adapters: { discord },
    });

    expect(result.ok).toBe(true);
    expect(discord).toHaveBeenCalledWith({
      channelId: "discord-channel",
      text: "hi",
      token: "discord-token",
      fetchImpl: expect.any(Function),
    });
  });

  it.each([
    " https://mattermost.example.com/ ",
    "https://mattermost.example.com/api/v4",
    "https://mattermost.example.com/api/v4///",
  ])("normalizes the Mattermost server URL %s", async (mattermostUrl) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await notify({
      config: { channels: { default: { mattermost: "mattermost-channel" } } },
      channel: "default",
      surface: "mattermost",
      message: "hi",
      mattermostUrl,
      mattermostToken: "fake-mattermost-token",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mattermost.example.com/api/v4/posts",
      expect.any(Object)
    );
  });

  it("fans out to both configured surfaces", async () => {
    const discord = vi.fn().mockResolvedValue(undefined);
    const slack = vi.fn().mockResolvedValue(undefined);

    const result = await notify({
      config,
      channel: "default",
      surface: "both",
      message: "hi",
      discordToken: "discord-token",
      slackToken: "slack-token",
      adapters: { discord, slack },
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((entry) => entry.surface)).toEqual([
      "discord",
      "slack",
    ]);
    expect(discord).toHaveBeenCalledOnce();
    expect(slack).toHaveBeenCalledOnce();
  });

  it.each(["all", "both", undefined])("fans out to every configured surface with %s", async (surface) => {
    const discord = vi.fn().mockResolvedValue(undefined);
    const slack = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    const result = await notify({
      config: {
        channels: {
          default: { discord: "discord-channel", slack: "slack-channel", mattermost: "mattermost-channel" },
        },
      },
      channel: "default",
      surface,
      message: "hi",
      discordToken: "discord-token",
      slackToken: "slack-token",
      mattermostToken: "fake-mattermost-token",
      mattermostUrl: "https://mattermost.example.com",
      adapters: { discord, slack },
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      results: [
        { surface: "discord", channelId: "discord-channel", ok: true },
        { surface: "slack", channelId: "slack-channel", ok: true },
        { surface: "mattermost", channelId: "mattermost-channel", ok: true },
      ],
    });
    expect(discord).toHaveBeenCalledOnce();
    expect(slack).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("errors clearly when the channel is missing", async () => {
    await expect(
      notify({
        config,
        channel: "missing",
        message: "hi",
      })
    ).rejects.toThrow(/Notification channel not configured: missing/);
  });

  it("rejects a Mattermost request when the key only has Discord and Slack", async () => {
    await expect(notify({
      config,
      channel: "default",
      surface: "mattermost",
      message: "hi",
      fetchImpl: vi.fn(),
    })).rejects.toThrow('No mattermost notification target configured for channel "default"');
  });

  it("rejects a channel key without any targets using the all default", async () => {
    await expect(notify({
      config: { channels: { default: {} } },
      channel: "default",
      message: "hi",
      fetchImpl: vi.fn(),
    })).rejects.toThrow('No all notification target configured for channel "default"');
  });

  it.each([
    { mattermostToken: undefined, mattermostUrl: "https://mattermost.example.com", error: "Missing mattermost token" },
    { mattermostToken: "fake-mattermost-token", mattermostUrl: undefined, error: "Missing mattermost url" },
  ])("keeps sending other surfaces when Mattermost fails with $error", async ({ error, ...credentials }) => {
    const slack = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();

    const result = await notify({
      config: { channels: { default: { slack: "slack-channel", mattermost: "mattermost-channel" } } },
      channel: "default",
      message: "hi",
      slackToken: "slack-token",
      ...credentials,
      adapters: { slack },
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      results: [
        { surface: "slack", channelId: "slack-channel", ok: true },
        { surface: "mattermost", channelId: "mattermost-channel", ok: false, error },
      ],
    });
    expect(slack).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid surfaces before adapters run", async () => {
    const discord = vi.fn().mockResolvedValue(undefined);
    const slack = vi.fn().mockResolvedValue(undefined);

    await expect(
      notify({
        config,
        channel: "default",
        surface: "bogus",
        message: "hi",
        discordToken: "discord-token",
        slackToken: "slack-token",
        adapters: { discord, slack },
      })
    ).rejects.toThrow(/Invalid notify surface "bogus"/);
    expect(discord).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
  });

  it("returns the Mattermost HTTP status and error text without echoed tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      "permission denied for fake-mattermost-token; fake-mattermost-token",
      { status: 403 }
    ));

    const result = await notify({
      config: { channels: { default: { mattermost: "mattermost-channel" } } },
      channel: "default",
      surface: "mattermost",
      message: "hi",
      mattermostToken: "fake-mattermost-token",
      mattermostUrl: "https://mattermost.example.com",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.results[0].error).toBe(
      "Mattermost API returned 403: permission denied for [redacted]; [redacted]"
    );
    expect(JSON.stringify(result)).not.toContain("fake-mattermost-token");
  });

  it("redacts tokens before truncating long Mattermost error bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      `${"x".repeat(490)}fake-mattermost-token${"y".repeat(600)}`,
      { status: 400 }
    ));

    const result = await notify({
      config: { channels: { default: { mattermost: "mattermost-channel" } } },
      channel: "default",
      surface: "mattermost",
      message: "hi",
      mattermostToken: "fake-mattermost-token",
      mattermostUrl: "https://mattermost.example.com",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.results[0].error).toMatch(/^Mattermost API returned 400: x+\[redacted\]$/);
    expect(result.results[0].error?.length).toBeLessThanOrEqual(530);
    expect(JSON.stringify(result)).not.toContain("fake-matt");
  });

  it("requires Slack responses to be parseable JSON with ok true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await notify({
      config,
      channel: "default",
      surface: "slack",
      message: "hi",
      slackToken: "slack-token",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.results[0].error).toMatch(/Slack response was not valid JSON/);
  });

  it("redacts Mattermost tokens from fetch failures", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(
      "network failure with fake-mattermost-token and fake-mattermost-token"
    ));

    const result = await notify({
      config: { channels: { default: { mattermost: "mattermost-channel" } } },
      channel: "default",
      surface: "mattermost",
      message: "hi",
      mattermostToken: "fake-mattermost-token",
      mattermostUrl: "https://mattermost.example.com",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      results: [{
        surface: "mattermost",
        channelId: "mattermost-channel",
        ok: false,
        error: "network failure with [redacted] and [redacted]",
      }],
    });
  });

  it("rejects Slack responses missing ok true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ ts: "123.456" }, { status: 200 })
    );

    const result = await notify({
      config,
      channel: "default",
      surface: "slack",
      message: "hi",
      slackToken: "slack-token",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.results[0].error).toMatch(/Slack response missing ok: true/);
  });

  it.each([
    ["mattermost", "alex", "@alex hi"],
    ["mattermost", "@alex", "@alex hi"],
    ["mattermost", "fake-user-id", "@fake-user-id hi"],
    ["discord", "fake-user-id", "<@fake-user-id> hi"],
    ["slack", "fake-user-id", "<@fake-user-id> hi"],
  ])("formats a %s mention of %s", async (surface, mention, text) => {
    const adapter = vi.fn().mockResolvedValue(undefined);

    await notify({
      config: {
        channels: {
          default: { discord: "discord-channel", slack: "slack-channel", mattermost: "mattermost-channel" },
        },
      },
      channel: "default",
      surface,
      message: "hi",
      mention,
      discordToken: "discord-token",
      slackToken: "slack-token",
      mattermostToken: "fake-mattermost-token",
      mattermostUrl: "https://mattermost.example.com",
      adapters: { discord: adapter, slack: adapter, mattermost: adapter },
    });

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });
});
