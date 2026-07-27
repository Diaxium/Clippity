import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@shared/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]",
  secondary:
    "bg-[var(--color-overlay-2)] text-[var(--color-ink)] hover:bg-[var(--color-overlay-3)]",
  ghost:
    "bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-overlay-1)]",
  danger:
    "bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] rounded-[var(--radius-sm)]",
  md: "h-9 px-3.5 text-[13px] rounded-[var(--radius-md)]",
  lg: "h-11 px-5 text-[14px] rounded-[var(--radius-lg)]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Primary action button. Visual tokens come from `theme.css` so
 * dark-mode and accent overrides cascade automatically. Forwarded ref so
 * floating UIs can anchor to it.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", className, type, ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 font-medium",
          "transition-colors duration-150 ease-[var(--ease-std)]",
          "focus-ring disabled:opacity-50 disabled:cursor-not-allowed",
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          className
        )}
        {...rest}
      />
    );
  }
);
