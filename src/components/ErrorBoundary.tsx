import React, { Component, ErrorInfo, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Changing this value (route path) clears the error automatically. */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

// Wrapper component to use hooks
const ErrorBoundaryWithNavigation: React.FC<Props & { resetKey?: string }> = ({ children }) => {
  // Try to use navigate/location, but fall back to window.location if not in
  // Router context (the boundary is also usable in isolation).
  let navigate: (path: string) => void = (path: string) => {
    window.location.href = path;
  };
  let pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  try {
    navigate = useNavigate();
    pathname = useLocation().pathname;
  } catch {
    // Fallback for when not in Router context
  }
  return (
    <ErrorBoundary navigate={navigate} resetKey={pathname}>
      {children}
    </ErrorBoundary>
  );
};

/**
 * Page-local failure boundary. A render error in one section must never take
 * the whole app down or tell the user to "reload the app": we render an inline
 * recovery card inside the current shell, and navigating anywhere else clears
 * the error automatically.
 */
class ErrorBoundary extends Component<Props & { navigate?: any }, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Keep a real record for debugging/telemetry instead of swallowing the
    // crash. Never throw from here — the fallback UI must still render.
    try {
      console.error('[Equyvo] render error:', error, errorInfo?.componentStack);
    } catch { /* ignore */ }
  }

  public componentDidUpdate(prevProps: Props) {
    // A route change is the user's recovery action: stop showing the old
    // failure instead of leaving a dead card on the next page.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full flex items-center justify-center p-4 py-10">
          <div className="w-full max-w-md rounded-xl border bg-card text-card-foreground shadow-sm">
            <div className="flex flex-col items-center gap-2 p-5 text-center">
              <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-destructive" />
              </div>
              <h2 className="text-lg font-semibold">This section couldn't load</h2>
              <p className="text-sm text-muted-foreground">
                The rest of Equyvo is still working. Try again, or continue
                somewhere else.
              </p>
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <details className="w-full bg-destructive/5 border border-destructive/20 rounded-lg p-3 text-left">
                  <summary className="cursor-pointer text-destructive font-mono text-xs font-medium">
                    Error details (dev only)
                  </summary>
                  <pre className="text-destructive/80 text-[11px] mt-2 whitespace-pre-wrap font-mono max-h-40 overflow-auto">
                    {this.state.error.toString()}
                  </pre>
                </details>
              )}
              <div className="flex w-full flex-col sm:flex-row gap-2 pt-1">
                <Button onClick={this.reset} className="flex-1">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Try again
                </Button>
                <Button
                  onClick={() => {
                    this.reset();
                    this.props.navigate?.('/app/home');
                  }}
                  variant="outline"
                  className="flex-1"
                >
                  <Home className="w-4 h-4 mr-2" />
                  Go home
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundaryWithNavigation;
