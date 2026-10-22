import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { imageCells, imagesEnabled, kittyDetected, mediaCachePath, placementSequence, pngSize, wrapTmux } from "./kitty";
import { createMediaProvider, matchAttachment } from "./term-media";
import type { AttachmentData } from "./parser";
import { collectMedia, renderAdf } from "./term-render";
import type { AdfNode } from "./markdown";

const ESC = "\x1b";

function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const attachment = (over: Partial<AttachmentData>): AttachmentData => ({
  id: "10", filename: "shot.png", mimeType: "image/png", size: 1000, created: "", author: "", url: "", ...over,
});

describe("png and sizing", () => {
  test("reads the size from the header, and rejects other bytes", () => {
    expect(pngSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pngSize(new TextEncoder().encode("GIF89a not a png at all......"))).toBeNull();
  });

  test("natural size, the width percent, the width cap and the row cap", () => {
    expect(imageCells({ width: 160, height: 160 }, undefined, 100, 20)).toEqual({ cols: 20, rows: 10 });
    expect(imageCells({ width: 160, height: 160 }, 50, 100, 20)).toEqual({ cols: 40, rows: 20 });
    expect(imageCells({ width: 4000, height: 100 }, undefined, 100, 20).cols).toBe(80);
  });
});

describe("kitty sequences", () => {
  const payload = (sequence: string) => [...sequence.matchAll(/_G([^;]*);([^\x1b]*)\x1b\\/g)];

  test("chunks the payload at 4096 characters", () => {
    expect(payload(placementSequence(new Uint8Array(3072), 1, 1, false))).toHaveLength(1);
    const two = payload(placementSequence(new Uint8Array(3073), 1, 1, false));
    expect(two).toHaveLength(2);
    expect(two[0][1]).toContain("a=T,f=100,q=2,C=1,c=1,r=1,m=1");
    expect(two[1][1]).toBe("m=0");
    expect(two[0][2]).toHaveLength(4096);
  });

  test("wraps every sequence for tmux with the escapes doubled", () => {
    expect(wrapTmux(`${ESC}_Gx${ESC}\\`)).toBe(`${ESC}Ptmux;${ESC}${ESC}_Gx${ESC}${ESC}\\${ESC}\\`);
    expect(placementSequence(new Uint8Array(3073), 1, 1, true).split(`${ESC}Ptmux;`)).toHaveLength(3);
  });
});

describe("detection", () => {
  test.each([
    [{ KITTY_WINDOW_ID: "1" }, true],
    [{ GHOSTTY_RESOURCES_DIR: "/x" }, true],
    [{ TERM: "xterm-ghostty" }, true],
    [{ TERM_PROGRAM: "WezTerm" }, true],
    [{ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }, false],
  ])("%j", (env, expected) => expect(kittyDetected(env)).toBe(expected));

  test("off, a pipe and an unknown terminal give no images", () => {
    expect(imagesEnabled("off", { KITTY_WINDOW_ID: "1" }, true)).toBe(false);
    expect(imagesEnabled("auto", { KITTY_WINDOW_ID: "1" }, false)).toBe(false);
    expect(imagesEnabled("auto", { TERM: "xterm" }, true)).toBe(false);
    expect(imagesEnabled("on", { TERM: "xterm" }, true)).toBe(true);
  });
});

describe("media provider", () => {
  const home = mkdtempSync(`${tmpdir()}/tik-media-`);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  afterAll(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true });
  });

  const options = (attachments: AttachmentData[], over = {}) => ({
    jiraBase: "https://jira.invalid", key: "ABC-1", attachments, images: true, tmux: false, getCredentials: () => Promise.reject(new Error("no network")), ...over,
  });
  const ref = { name: "shot.png" };

  test("matches by media id, else by the newest filename", () => {
    const list = [attachment({ id: "1" }), attachment({ id: "2" }), attachment({ id: "3", filename: "other.png", mediaId: "m" })];
    expect(matchAttachment(ref, list)?.id).toBe("2");
    expect(matchAttachment({ name: "x", id: "m" }, list)?.id).toBe("3");
  });

  test("a cached PNG is placed without a fetch", async () => {
    mkdirSync(`${home}/.cache/tik/media`, { recursive: true });
    writeFileSync(mediaCachePath("10"), png(160, 160));
    const provider = await createMediaProvider([ref], options([attachment({})]));
    const shown = provider.render(ref, 100)!;
    expect(shown.lines).toHaveLength(10);
    expect(shown.lines![0]).toContain("a=T,f=100");
  });

  test("an image over the size cap is not fetched and says so", async () => {
    const provider = await createMediaProvider([ref], options([attachment({ id: "11", size: 12 * 1024 * 1024 })]));
    expect(provider.render(ref, 100)).toEqual({ suffix: "12.0 MB · too large · tik get ABC-1 shot.png" });
  });

  test("a failed download keeps the placeholder", async () => {
    const provider = await createMediaProvider([ref], options([attachment({ id: "12" })]));
    expect(provider.render(ref, 100)?.suffix).toBe("1000 B · (download failed) · tik get ABC-1 shot.png");
  });

  test("other file types and disabled images get a size and a download hint", async () => {
    const video = { name: "clip.mov" };
    const provider = await createMediaProvider([video], options([attachment({ id: "13", filename: "clip.mov", mimeType: "video/quicktime", size: 4404019 })]));
    expect(provider.render(video, 100)).toEqual({ suffix: "4.2 MB · tik get ABC-1 clip.mov" });
  });

  test("the renderer adds the note to the placeholder line and prints the image lines", async () => {
    const doc = (name: string): AdfNode =>
      ({ type: "doc", content: [{ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "1", type: "file", alt: name } }] }] }) as AdfNode;
    const images = await createMediaProvider(collectMedia(doc("clip.mov")), options([attachment({ id: "13", filename: "clip.mov", mimeType: "video/quicktime", size: 4404019 })]));
    expect(renderAdf(doc("clip.mov"), { width: 80, color: "none", images }).join("\n")).toBe("► clip.mov · 4.2 MB · tik get ABC-1 clip.mov");
    const withPng = await createMediaProvider(collectMedia(doc("shot.png")), options([attachment({})]));
    const lines = renderAdf(doc("shot.png"), { width: 80, color: "none", images: withPng });
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain(`${ESC}_G`);
  });
});
