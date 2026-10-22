import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { audioConfiguration, registerReaderAudio } from "../src/reader-audio.js";
import { makeSandbox } from "./helpers.js";
import { createReaderServer } from "../src/reader-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
const wav = Buffer.from("RIFF0000WAVEfmt test audio");

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(options?: Parameters<typeof registerReaderAudio>[2]) {
  const sandbox = await makeSandbox();
  const app = Fastify();
  cleanups.push(sandbox.cleanup, () => app.close());
  registerReaderAudio(app, sandbox.root, options);
  return app;
}

describe("reader audio", () => {
  it("defaults to disabled and keeps CPU-compatible laptop settings separate from desktop", () => {
    expect(audioConfiguration().enabled).toBe(false);
    expect(audioConfiguration({ profile: "laptop" })).toMatchObject({ enabled: true, model: "kokoro", voice: "af_heart" });
    expect(audioConfiguration({ profile: "desktop" })).toMatchObject({ model: "chatterbox", baseUrl: "http://127.0.0.1:8004/v1" });
    expect(() => audioConfiguration({ baseUrl: "file:///secret" })).toThrow("HTTP(S)");
    expect(() => audioConfiguration({ baseUrl: "http://user:secret@localhost/v1" })).toThrow("credentials");
  });

  it("does not contact a service while disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await server();
    expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Hello" } })).statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies WAV speech and reuses disk cache without the provider", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(wav));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "portable", apiToken: "private-token" });
    const payload = { text: "The library was quiet.", voice: "af_bella", speed: 1.2 };
    const first = await app.inject({ method: "POST", url: "/api/audio/speech", payload });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("audio/wav");
    expect(first.rawPayload).toEqual(wav);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: "kokoro", input: payload.text, voice: "af_bella", speed: 1.2, response_format: "wav" });
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload })).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const config = (await app.inject("/api/audio/config")).json();
    expect(JSON.stringify(config)).not.toContain("private-token");
    expect(JSON.stringify(config)).not.toContain("127.0.0.1");
  });

  it("rejects invalid inputs before contacting a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "laptop" });
    for (const payload of [{ text: " " }, { text: "x".repeat(2001) }, { text: "Hi", speed: 3 }, { text: "Hi", url: "http://elsewhere" }]) {
      expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles provider failures and invalid audio without caching them", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("secret upstream detail", { status: 500 }))
      .mockResolvedValueOnce(new Response("not audio"))
      .mockResolvedValueOnce(new Response(wav));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "portable" });
    const request = { method: "POST" as const, url: "/api/audio/speech", payload: { text: "Hello" } };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain("secret upstream detail");
    expect((await app.inject(request)).json().error).toContain("WAV");
    expect((await app.inject(request)).statusCode).toBe(200);
  });

  it("normalizes provider voice lists and reports unavailable discovery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ voices: ["af_bella", "af_bella", { id: "af_sky" }] }))
      .mockRejectedValueOnce(new Error("offline")));
    const app = await server({ profile: "portable" });
    expect((await app.inject("/api/audio/voices")).json()).toEqual({ voices: ["af_heart", "af_bella", "af_sky"] });
    expect((await app.inject("/api/audio/voices")).statusCode).toBe(502);
  });

  it("reports a useful message when the speech service is offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const app = await server({ profile: "portable" });
    const response = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Hello" } });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("Start the configured speech server");
  });

  it("allows only one provider render at a time", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "portable" });
    const pending = app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "First clip" } });
    const first = pending.then((response) => response);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const second = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Second clip" } });
    finish(new Response(wav));
    expect(second.statusCode).toBe(429);
    expect((await first).statusCode).toBe(200);
  });

  it("protects audio configuration and synthesis with the Folio session", async () => {
    const sandbox = await makeSandbox();
    const app = await createReaderServer({ root: sandbox.root, lmStudioUrl: "http://unused.test", folioPassword: "test-password", audio: { profile: "portable" } });
    cleanups.push(sandbox.cleanup, () => app.close());
    expect((await app.inject("/api/audio/config")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Hello" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "test-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    expect((await app.inject({ url: "/api/audio/config", headers: { cookie } })).json().enabled).toBe(true);
  });
});