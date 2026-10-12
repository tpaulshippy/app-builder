import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "../src/agent";
import { PI_TOOLS, piCompleteTurn, resetPiModels, resolvePiModel } from "../src/pi-opencode";

function headerOf(init: unknown, name: string): string | undefined {
  const headers = (init as { headers?: unknown })?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(", ") : String(v);
  }
  return undefined;
}

const userMsg = [{ role: "user", content: "hi", timestamp: Date.now() }] as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPiModels();
});

describe("resolvePiModel", () => {
  it("maps zen/go to Pi's opencode provider ids", () => {
    expect(resolvePiModel("zen", "muse-spark-1.3")).toEqual({ provider: "opencode", modelId: "muse-spark-1.3" });
    expect(resolvePiModel("go", "muse-spark-1.3-contributor")).toEqual({
      provider: "opencode-go",
      modelId: "muse-spark-1.3-contributor",
    });
  });

  it("falls back to the gateway default for an unknown model", () => {
    expect(resolvePiModel("zen", "nope-free")).toEqual({ provider: "opencode", modelId: DEFAULT_MODEL });
  });
});

describe("PI_TOOLS", () => {
  it("exposes the same three tools as the custom harness", () => {
    expect(PI_TOOLS.map((t) => t.name).sort()).toEqual(["bash", "read_file", "write_file"]);
  });
});

describe("piCompleteTurn BYOK", () => {
  it("sends the browser key (not env) to the zen endpoint with session + user-agent", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "env-key-must-lose");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      piCompleteTurn("byok-key-123", userMsg, "sys", {
        gateway: "zen",
        model: "muse-spark-1.3",
        sessionId: "sess-1",
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://opencode.ai/zen/v1")).toBe(true);
    expect(headerOf(init, "authorization")).toBe("Bearer byok-key-123");
    expect(headerOf(init, "x-opencode-session")).toBe("sess-1");
    expect(headerOf(init, "user-agent")).toBe("app-builder/0.1.0");
  });

  it("sends the browser key to the go endpoint", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "env-key-must-lose");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      piCompleteTurn("byok-key-123", userMsg, "sys", {
        gateway: "go",
        model: "muse-spark-1.3-contributor",
        sessionId: "sess-2",
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(headerOf(init, "authorization")).toBe("Bearer byok-key-123");
    expect(headerOf(init, "x-opencode-session")).toBe("sess-2");
  });

  it("omits the session header when there is no session id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(piCompleteTurn("byok-key-123", userMsg, "sys", { gateway: "zen" })).rejects.toThrow();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(headerOf(init, "x-opencode-session")).toBeUndefined();
    expect(headerOf(init, "authorization")).toBe("Bearer byok-key-123");
  });

  it("fails visibly with no key configured anywhere", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(piCompleteTurn("", userMsg, "sys", { gateway: "zen" })).rejects.toThrow();
  });

  it("times out a stalled model instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation timed out", "TimeoutError")),
            );
          }),
      ),
    );

    await expect(piCompleteTurn("byok-key-123", userMsg, "sys", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
