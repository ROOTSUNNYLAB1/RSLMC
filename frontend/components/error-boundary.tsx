import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * A page must never turn the panel black.
 *
 * React unmounts the whole tree when a render throws, which is exactly what happened when a page
 * read a `useState` value before it existed: the console showed a `ReferenceError` and the operator
 * was left with an empty black window and no way forward. A boundary cannot repair the page, but it
 * can keep the shell — sidebar, breadcrumb, navigation — alive and say, in plain words, what failed
 * and what to do next. The message is shown as-is (it comes from our own code, not from user input),
 * and the reload buttons are the only actions because anything cleverer would lie about recovery.
 */
interface Props {
  children: ReactNode;
  /** Shown in the card so the reader knows which part of the panel failed. */
  where?: string;
}

interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the details in the browser console for a bug report, without swallowing them.
    console.error(`[RSLMC] ${this.props.where ?? "A page"} failed to render:`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  private reset = (): void => this.setState({ error: null, stack: "" });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card page-crash" role="alert">
        <div className="card-header">
          <span className="card-title">
            <AlertTriangle size={13} />
            This page could not be drawn
          </span>
          <span className="spacer" />
          <span className="text-xs faint">{this.props.where ?? "Panel"}</span>
        </div>
        <div className="card-body">
          <p className="page-crash-lede">
            The rest of the panel is still running — the sidebar, your servers and every other page work
            normally. Only this view failed, and nothing was changed on disk or on the server.
          </p>
          <div className="page-crash-error">
            <span className="page-crash-label">Error</span>
            <code>{error.message || String(error)}</code>
          </div>
          <p className="page-crash-hint">
            If it happens again, open the browser console for the stack trace and report it with the
            build number from <b>Dashboard → Panel health</b>.
          </p>
          <div className="page-crash-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
              <RotateCw size={12} /> Reload the page
            </button>
            <button type="button" className="btn btn-sm" onClick={this.reset}>Try again</button>
            <a className="btn btn-ghost btn-sm" href="/dashboard">Back to dashboard</a>
          </div>
        </div>
      </div>
    );
  }
}
