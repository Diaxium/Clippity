import type { ComponentType } from "react";

/**
 * The shape of a lucide-react icon as we consume it: sizable, weight-able,
 * and class-able. Centralized so icon-map records accept `className`
 * without each call site re-declaring the prop set.
 */
export type IconComponent = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;
