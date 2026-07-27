import type { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  children: ReactNode;
}

/**
 * Visual grouping for a settings section. Header + bordered rows.
 * Mirrors the legacy `SectionCard` shape so panels look familiar but
 * the styling tokens come from `theme.css`.
 */
export function SectionCard({ title, children }: SectionCardProps) {
  return (
    <section className="mb-6 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)] shadow-[var(--shadow-subtle)]">
      <header className="border-b border-[color:var(--hairline)] px-5 py-3.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
          {title}
        </h2>
      </header>
      <div className="divide-y divide-[color:var(--hairline)]">{children}</div>
    </section>
  );
}
