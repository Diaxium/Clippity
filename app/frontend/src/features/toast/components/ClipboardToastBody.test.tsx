import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClipboardToastBody } from "./ClipboardToastBody";

describe("ClipboardToastBody", () => {
  it("renders an image preview with dimensions for the image branch", () => {
    render(
      <ClipboardToastBody
        preview="data:image/png;base64,AAAA"
        width={1280}
        height={720}
      />
    );
    expect(screen.getByText("Clipboard captured")).toBeInTheDocument();
    expect(
      screen.getByText("1280 × 720 · saved to your library")
    ).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA"
    );
  });

  it("renders the captured text and no image for the text branch", () => {
    render(
      <ClipboardToastBody preview="" width={0} height={0} text="hello world" />
    );
    expect(screen.getByText("Text captured")).toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
