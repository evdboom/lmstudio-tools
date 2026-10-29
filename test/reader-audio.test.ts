import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { afterEach, describe, expect, it, vi } from "vitest";
import { audioConfiguration, registerReaderAudio } from "../src/reader-audio.js";
import { makeSandbox } from "./helpers.js";
import { createReaderServer } from "../src/reader-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
const wav = Buffer.from("RIFF0000WAVEfmt test audio");
const mp3 = Buffer.from("ID3 test audio");
const audioRunId = "1a2039b0-4b3b-4ee2-8e42-8319b88ed628";

function pcmWav(): Buffer {
  const audio = Buffer.alloc(44 + 4800);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(4800, 40);
  return audio;
}

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
  it("exports a complete MP3 and rejects mismatched clip references", async () => {
    const encoded = spawnSync(ffmpeg!, ["-nostdin", "-v", "error", "-i", "pipe:0", "-f", "mp3", "pipe:1"], { input: pcmWav(), windowsHide: true });
    expect(encoded.status).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/model-info")
      ? Response.json({ type: "original", supports_paralinguistic_tags: false })
      : new Response(encoded.stdout)));
    const app = await server({ profile: "chatterbox", format: "mp3" });
    const prepared = (await app.inject({ method: "POST", url: "/api/audio/beats", payload: {
      run_id: audioRunId, beat_index: 1, narration: "One.\n\nTwo.", voice: "Emily.wav",
    } })).json().audio;
    const reference = { run_id: audioRunId, beat_index: 1, revision: prepared.revision, clip_index: 0 };
    const wrong = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Wrong text.", voice: "Emily.wav", beat: reference } });
    expect(wrong.statusCode).toBe(409);
    for (const [clipIndex, text] of ["One.", "Two."].entries()) {
      expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text, voice: "Emily.wav", beat: { ...reference, clip_index: clipIndex } } })).statusCode).toBe(200);
    }
    const result = await app.inject(`/api/audio/beats/${audioRunId}/1/download?revision=${prepared.revision}`);
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("audio/mpeg");
    const decoded = spawnSync(ffmpeg!, ["-nostdin", "-v", "error", "-i", "pipe:0", "-f", "s16le", "pipe:1"], { input: result.rawPayload, windowsHide: true });
    expect(decoded.status).toBe(0);
    expect(decoded.stdout.length).toBeGreaterThan(4800);
  });

  it("preserves a beat playlist, reuses cached clips, and exports one complete WAV", async () => {
    const fetchMock = vi.fn(async () => new Response(pcmWav()));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "portable" });
    await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "First paragraph.", voice: "af_heart" } });
    const prepare = { method: "POST" as const, url: "/api/audio/beats", payload: {
      run_id: audioRunId, beat_index: 0, narration: "First paragraph.\n\nSecond paragraph.", voice: "af_heart",
    } };
    const saved = (await app.inject(prepare)).json().audio;
    expect(saved.available).toEqual([0]);
    const base = `/api/audio/beats/${audioRunId}/0`;
    expect((await app.inject(`${base}/download?revision=${saved.revision}`)).statusCode).toBe(409);
    await app.inject({ method: "POST", url: "/api/audio/speech", payload: {
      text: "Second paragraph.", voice: "af_heart",
      beat: { run_id: audioRunId, beat_index: 0, revision: saved.revision, clip_index: 1 },
    } });
    expect((await app.inject(base)).json().audio.available).toEqual([0, 1]);
    expect((await app.inject(`${base}/clips/0?revision=${saved.revision}`)).rawPayload).toEqual(pcmWav());
    const complete = await app.inject(`${base}/download?revision=${saved.revision}`);
    expect(complete.statusCode).toBe(200);
    expect(complete.headers["content-disposition"]).toContain("folio-beat-1.wav");
    expect(complete.rawPayload.length).toBeGreaterThan(pcmWav().length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const changed = await app.inject({ ...prepare, payload: { ...prepare.payload, narration: "Changed prose." } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().changed).toBe(true);
    expect((await app.inject(`${base}/clips/0?revision=${saved.revision}`)).statusCode).toBe(200);
    const replaced = await app.inject({ ...prepare, payload: { ...prepare.payload, narration: "Changed prose.", replace: true } });
    expect(replaced.json().audio.available).toEqual([]);
    expect((await app.inject(`${base}/clips/0?revision=${saved.revision}`)).statusCode).toBe(409);
  });

  it("defaults to disabled and keeps CPU-compatible laptop settings separate from desktop", () => {
    expect(audioConfiguration().enabled).toBe(false);
    expect(audioConfiguration({ profile: "laptop" })).toMatchObject({ enabled: true, model: "kokoro", voice: "af_heart" });
    expect(audioConfiguration({ profile: "desktop" })).toMatchObject({ model: "chatterbox", baseUrl: "http://127.0.0.1:8004/v1", voice: "", responseFormat: "wav" });
    expect(audioConfiguration({ profile: "kokoro" })).toMatchObject({ model: "kokoro", baseUrl: "http://127.0.0.1:8880/v1" });
    expect(audioConfiguration({ profile: "chatterbox" })).toMatchObject({ model: "chatterbox", baseUrl: "http://127.0.0.1:8004/v1", voice: "", responseFormat: "wav" });
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
    for (const payload of [{ text: " " }, { text: "x".repeat(20_001) }, { text: "Hi", speed: 3 }, { text: "Hi", url: "http://elsewhere" }]) {
      expect((await app.inject({ method: "POST", url: "/api/audio/speech", payload })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts and forwards a complete long paragraph without truncating it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(wav));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "portable" });
    const paragraph = "A long uninterrupted paragraph. ".repeat(500).trim();
    const response = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: paragraph } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).input).toBe(paragraph);
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

  it("reports Chatterbox readiness failures without blaming the voice ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/model-info")
      ? Response.json({ loaded: false, supports_paralinguistic_tags: false })
      : Response.json({ detail: "TTS engine model is not currently loaded or available." }, { status: 503 })));
    const app = await server({ profile: "chatterbox" });
    const result = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "Hello", voice: "Emily.wav" } });
    expect(result.statusCode).toBe(502);
    expect(result.json().error).toContain("model loaded successfully");
    expect(result.json().error).not.toContain("voice ID");
  });

  it("requests and caches MP3 output for Chatterbox", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(mp3));
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "chatterbox", format: "mp3" });
    const result = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "A novel line." } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("audio/mpeg");
    expect(result.rawPayload).toEqual(mp3);
    const speechCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"));
    expect(JSON.parse(speechCall![1]!.body as string).response_format).toBe("mp3");
  });

  it("uses a listed Chatterbox filename and WAV by default", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/model-info")) return Response.json({ type: "turbo", supports_paralinguistic_tags: true });
      if (url.endsWith("/get_predefined_voices")) return Response.json([{ display_name: "Abigail", filename: "Abigail.wav" }]);
      if (url.endsWith("/audio/speech")) return new Response(wav);
      throw new Error(`Unexpected TTS URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "chatterbox" });
    const result = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "A short story.", voice: "Abigail.wav" } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("audio/wav");
    const speechCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"));
    expect(JSON.parse(speechCall![1]!.body as string)).toMatchObject({
      model: "chatterbox", voice: "Abigail.wav", response_format: "wav",
    });
  });

  it("uses the active Turbo capability to preserve cue tags in TTS requests", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/model-info")) return Response.json({ type: "turbo", supports_paralinguistic_tags: true });
      if (url.endsWith("/audio/speech")) return new Response(wav);
      throw new Error(`Unexpected TTS URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "chatterbox" });
    expect((await app.inject("/api/audio/config")).json().supports_vocal_cues).toBe(true);
    const result = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "[gasp] She waited—then ran.", voice: "Abigail.wav" } });
    expect(result.statusCode).toBe(200);
    const speechCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"));
    expect(JSON.parse(speechCall![1]!.body as string).input).toBe("[gasp] She waited, then ran.");
  });

  it("strips Chatterbox vocal tags when the active engine does not support them", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/model-info")) return Response.json({ type: "original", supports_paralinguistic_tags: false });
      if (url.endsWith("/audio/speech")) return new Response(wav);
      throw new Error(`Unexpected TTS URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "chatterbox" });
    expect((await app.inject("/api/audio/config")).json().supports_vocal_cues).toBe(false);
    const result = await app.inject({ method: "POST", url: "/api/audio/speech", payload: { text: "[whispering] Wait—[gasp]run!", voice: "Abigail.wav" } });
    expect(result.statusCode).toBe(200);
    const speechCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"));
    expect(JSON.parse(speechCall![1]!.body as string).input).toBe("Wait, run!");
  });

  it("normalizes Kokoro voice lists and reports unavailable discovery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ voices: ["af_bella", "af_bella", { id: "af_sky" }] }))
      .mockRejectedValueOnce(new Error("offline")));
    const app = await server({ profile: "portable" });
    expect((await app.inject("/api/audio/voices")).json()).toEqual({ voices: [
      { id: "af_bella", label: "af_bella" },
      { id: "af_sky", label: "af_sky" },
      { id: "af_heart", label: "af_heart" },
    ] });
    expect((await app.inject("/api/audio/voices")).statusCode).toBe(502);
  });

  it("queries Chatterbox display names and returns their actual filenames as IDs", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8004/get_predefined_voices");
      return Response.json([
        { display_name: "Emily", filename: "Emily.wav" },
        { display_name: "Abigail", filename: "Abigail.wav" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await server({ profile: "chatterbox" });
    expect((await app.inject("/api/audio/config")).json().voice).toBe("");
    expect((await app.inject("/api/audio/voices")).json()).toEqual({ voices: [
      { id: "Emily.wav", label: "Emily" },
      { id: "Abigail.wav", label: "Abigail" },
    ] });
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