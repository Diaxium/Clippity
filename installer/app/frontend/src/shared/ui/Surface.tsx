import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

import { cn } from "@shared/lib/cn";

/**
 * Surface variants map 1:1 to the `.glass-*` and `.surface-*` classes in
 * `theme.css`. Callers say `<Surface variant="elevated" />` instead of
 * memorizing the class-name catalog.
 */
export type SurfaceVariant =
  | "elevated"
  | "card"
  | "inset"
  | "glass-1"
  | "glass-2"
  | "glass-3"
  | "glass-4"
  | "float";

const VARIANT_CLASS: Record<SurfaceVariant, string> = {
  elevated: "surface-elevated",
  card: "surface-card",
  inset: "surface-inset",
  "glass-1": "glass-1",
  "glass-2": "glass-2",
  "glass-3": "glass-3",
  "glass-4": "glass-4",
  float: "float-card",
};

type SurfaceOwnProps<E extends ElementType> = {
  as?: E;
  variant?: SurfaceVariant;
  children?: ReactNode;
};

export type SurfaceProps<E extends ElementType = "div"> = SurfaceOwnProps<E> &
  Omit<ComponentPropsWithoutRef<E>, keyof SurfaceOwnProps<E>>;

export function Surface<E extends ElementType = "div">({
  as,
  variant = "card",
  className,
  children,
  ...rest
}: SurfaceProps<E>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cn(VARIANT_CLASS[variant], className)} {...rest}>
      {children}
    </Tag>
  );
}
