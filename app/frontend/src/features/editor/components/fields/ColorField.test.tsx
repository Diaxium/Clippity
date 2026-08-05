import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorField } from "./ColorField";

afterEach(cleanup);

describe("ColorField", () => {
  it("opens the floating editor from the swatch when wired", () => {
    const onOpenEditor = vi.fn();
    render(
      <ColorField
        value="#ff0000"
        onChange={() => {}}
        onOpenEditor={onOpenEditor}
      />
    );
    fireEvent.click(screen.getByLabelText("Pick color"));
    expect(onOpenEditor).toHaveBeenCalled();
  });

  it("commits a typed hex through onChange", () => {
    const onChange = vi.fn();
    render(<ColorField value="#ff0000" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "00FF00" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("#00ff00");
  });
});
