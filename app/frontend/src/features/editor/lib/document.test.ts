import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeRectangle,
  nextNodeId,
  reseedNodeIds,
  type SceneNode,
} from "../types";
import {
  DOCUMENT_VERSION,
  parseDocument,
  serializeDocument,
} from "./document";
import { sceneFromSaved } from "./seed";

function sampleSource() {
  __resetNodeIdForTests();
  const a = makeRectangle({ x: 0, y: 0, width: 10, height: 10 }, { name: "A" });
  const b = makeRectangle(
    { x: 20, y: 0, width: 10, height: 10 },
    { name: "B" }
  );
  const nodes: Record<string, SceneNode> = { [a.id]: a, [b.id]: b };
  return { docName: "Doc", rootIds: [a.id, b.id], nodes, a, b };
}

describe("serializeDocument / parseDocument", () => {
  it("round-trips the scene + name + version", () => {
    const src = sampleSource();
    const doc = parseDocument(serializeDocument(src));
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(DOCUMENT_VERSION);
    expect(doc!.docName).toBe("Doc");
    expect(doc!.rootIds).toEqual([src.a.id, src.b.id]);
    expect(doc!.nodes[src.a.id]!.name).toBe("A");
  });

  it("rejects malformed JSON, wrong version, and missing fields", () => {
    expect(parseDocument("not json")).toBeNull();
    expect(parseDocument(JSON.stringify({ version: 2, rootIds: [], nodes: {} }))).toBeNull();
    expect(parseDocument(JSON.stringify({ version: 1, nodes: {} }))).toBeNull();
    expect(
      parseDocument(JSON.stringify({ version: 1, rootIds: [], nodes: null }))
    ).toBeNull();
  });
});

describe("sceneFromSaved", () => {
  it("restores a SceneInit marked saved, sourced to the capture id", () => {
    const src = sampleSource();
    const json = serializeDocument(src);
    const init = sceneFromSaved(json, "/caps/Shot.png");
    expect(init).not.toBeNull();
    expect(init!.status).toBe("saved");
    expect(init!.sourceId).toBe("/caps/Shot.png");
    expect(init!.rootIds).toEqual([src.a.id, src.b.id]);
  });

  it("returns null for a corrupt sidecar (caller falls back to the flat image)", () => {
    expect(sceneFromSaved("{bad", "/caps/Shot.png")).toBeNull();
  });

  it("reseeds the id counter so new nodes don't collide with restored ones", () => {
    const src = sampleSource();
    const json = serializeDocument(src);
    // Simulate a fresh session: the global counter is back at 0.
    __resetNodeIdForTests();
    const init = sceneFromSaved(json, "/caps/Shot.png")!;
    const existing = new Set(Object.keys(init.nodes));
    // The next generated id must not reuse a restored one.
    expect(existing.has(nextNodeId())).toBe(false);
  });
});

describe("reseedNodeIds", () => {
  it("advances the counter past the highest existing id", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 1, height: 1 }); // n_1 + fill_2
    __resetNodeIdForTests(); // counter back to 0 (stale)
    reseedNodeIds({ [r.id]: r });
    // n_1 and fill_2 exist; the next id must be beyond both.
    const fresh = nextNodeId();
    expect(fresh).not.toBe(r.id);
    expect(fresh).not.toBe(r.fills[0]!.id);
  });
});
