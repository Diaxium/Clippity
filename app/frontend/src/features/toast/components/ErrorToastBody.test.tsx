import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ErrorToastBody } from "./ErrorToastBody";

describe("ErrorToastBody", () => {
  it("renders the message inside a role='alert' container", () => {
    render(<ErrorToastBody message="no monitor found" />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("no monitor found");
  });

  it("renders the 'Capture failed' headline alongside the message", () => {
    render(<ErrorToastBody message="x" />);
    expect(screen.getByText("Capture failed")).toBeInTheDocument();
    expect(screen.getByText("x")).toBeInTheDocument();
  });
});
