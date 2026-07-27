import { Component, type ErrorInfo, type ReactNode } from "react";

import { createLogger } from "@shared/lib/logger";

const log = createLogger("error-boundary");

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Label for the window/region this boundary guards, so the logged
   * breadcrumb says *where* the crash happened (e.g. `"capture window"`).
   */
  scope?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time crashes anywhere in the subtree so a thrown
 * component shows a recoverable panel instead of a blank window — and,
 * critically, leaves a logged breadcrumb (with the component stack) that
 * otherwise would not exist anywhere.
 *
 * The fallback is intentionally styled with inline rules + CSS color
 * tokens rather than the design-system components: it must render even
 * when the thing that broke is the design system itself.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = this.props.scope ? ` in ${this.props.scope}` : "";
    log.error(`render crash${where}`, {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  private readonly handleReload = (): void => {
    // Reloading re-runs the window from its hash route — the cheapest
    // full recovery for a desktop webview.
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          minHeight: "100vh",
          padding: "1.5rem",
          textAlign: "center",
          color: "var(--color-ink)",
          background: "var(--color-bg)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <p style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>
          Something went wrong
        </p>
        <p
          style={{
            fontSize: "0.85rem",
            opacity: 0.7,
            maxWidth: "28rem",
            margin: 0,
          }}
        >
          This window hit an unexpected error and stopped. Reloading usually
          fixes it; the details were written to the log.
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            marginTop: "0.25rem",
            padding: "0.4rem 0.9rem",
            borderRadius: "0.5rem",
            border: "none",
            cursor: "pointer",
            color: "var(--color-accent-ink)",
            background: "var(--color-accent)",
            fontSize: "0.85rem",
            fontWeight: 500,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
