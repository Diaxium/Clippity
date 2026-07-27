import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exportImage = vi.fn();

vi.mock("../../hooks/useEditorExport", () => ({
  useEditorExport: () => ({ busy: false, exportImage, copyPng: vi.fn() }),
}));

import { useEditorStore } from "../../state/editorStore";
import { ExportSection } from "./ExportSection";

/** Open the format dropdown and pick `label`. */
function chooseFormat(label: string): void {
  fireEvent.click(screen.getByLabelText("Export format"));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

/** The submit button — named for the document, so it doesn't collide with the
 *  "Export format" / "Export scale" dropdown triggers. */
const exportButton = (): HTMLElement =>
  screen.getByRole("button", { name: "Export Doc" });

afterEach(cleanup);

beforeEach(() => {
  exportImage.mockClear();
  useEditorStore.getState().loadScene({
    rootIds: [],
    nodes: {},
    docName: "Doc",
    sourceId: null,
  });
  useEditorStore.setState({ sectionsOpen: {} });
});

describe("ExportSection", () => {
  it("defaults to a lossless PNG export with no quality control", () => {
    render(<ExportSection />);
    // Quality is meaningless for PNG, so the field is absent entirely.
    expect(screen.queryByText("Quality")).toBeNull();

    fireEvent.click(exportButton());
    expect(exportImage).toHaveBeenCalledWith({
      scale: 1,
      nodeId: null,
      format: "png",
      quality: undefined,
    });
  });

  it("reveals quality for JPG and sends it as a 0–1 factor", () => {
    render(<ExportSection />);
    chooseFormat("JPG");

    expect(screen.getByText("Quality")).toBeTruthy();
    fireEvent.click(exportButton());
    expect(exportImage).toHaveBeenCalledWith({
      scale: 1,
      nodeId: null,
      format: "jpeg",
      // The panel shows percent; the encoder wants a fraction.
      quality: 0.92,
    });
  });

  it("carries an edited quality and the chosen scale through to the export", () => {
    render(<ExportSection />);
    chooseFormat("WebP");

    const quality = screen.getByDisplayValue("92");
    fireEvent.change(quality, { target: { value: "60" } });
    fireEvent.keyDown(quality, { key: "Enter" });

    fireEvent.click(screen.getByLabelText("Export scale"));
    fireEvent.click(screen.getByRole("option", { name: "2x" }));

    fireEvent.click(exportButton());
    expect(exportImage).toHaveBeenCalledWith({
      scale: 2,
      nodeId: null,
      format: "webp",
      quality: 0.6,
    });
  });

  it("exports the selection when one node is selected", () => {
    useEditorStore.setState({ selectedIds: ["n1"] });
    render(<ExportSection />);

    fireEvent.click(screen.getByRole("button", { name: "Export selection" }));
    expect(exportImage).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "n1" })
    );
  });
});
