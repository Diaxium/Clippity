import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Crop } from "lucide-react";

import { ModeTile } from "./ModeTile";
import type { ModeDef } from "../types";

const enabled: ModeDef<"region"> = {
  id: "region",
  label: "Region",
  icon: Crop,
  tint: "warm",
  available: true,
};

const disabled: ModeDef<"region"> = {
  id: "region",
  label: "Region",
  icon: Crop,
  tint: "warm",
  available: false,
  unavailableHint: "Available with overlay port.",
};

describe("ModeTile", () => {
  it("calls onSelect when an enabled tile is clicked", () => {
    const onSelect = vi.fn();
    render(<ModeTile def={enabled} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("region");
  });

  it("renders aria-pressed when active", () => {
    render(<ModeTile def={enabled} active={true} onSelect={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("does not fire onSelect when disabled", () => {
    const onSelect = vi.fn();
    render(<ModeTile def={disabled} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks disabled tiles with aria-disabled and a Soon badge", () => {
    render(<ModeTile def={disabled} active={false} onSelect={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Soon")).toBeInTheDocument();
  });

  it("uses the unavailableHint as the tooltip when disabled", () => {
    render(<ModeTile def={disabled} active={false} onSelect={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "Available with overlay port."
    );
  });
});
