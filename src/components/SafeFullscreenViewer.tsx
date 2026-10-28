import React, { Component, ErrorInfo, ReactNode } from 'react';
import { X, RotateCcw } from 'lucide-react';
import FullscreenViewer from './FullscreenViewer';

type ViewerProps = React.ComponentProps<typeof FullscreenViewer>;

interface BoundaryProps {
  children: ReactNode;
  /** Changing id clears the failure so the next item gets a clean viewer. */
  contentId?: string;
  onClose: () => void;
}

interface BoundaryState {
  hasError: boolean;
}

/**
 * Viewer-local failure boundary. A render error inside the fullscreen viewer
 * must degrade to a compact dark retry card over the viewer's own black
 * backdrop — never bubble up and replace the whole page with the app-wide
 * "This section couldn't load" screen. The X / Close affordances are always
 * available, so the page underneath is never lost.
 */
class ViewerBoundary extends Component<BoundaryProps, BoundaryState> {
  public state: BoundaryState = { hasError: false };

  public static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Keep a real record for debugging instead of swallowing the crash.
    try {
      console.error('[Equyvo] fullscreen viewer error:', error, errorInfo?.componentStack);
    } catch { /* ignore */ }
  }

  public componentDidUpdate(prevProps: BoundaryProps) {
    // A different item was opened: clear the failure so it renders cleanly.
    if (this.state.hasError && prevProps.contentId !== this.props.contentId) {
      this.setState({ hasError: false });
    }
  }

  public render() {
    if (this.state.hasError) {
      const { onClose } = this.props;
      return (
        <div className="fixed inset-0 bg-black z-[150] flex items-center justify-center">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <RotateCcw className="w-8 h-8 text-white/60" />
            <p className="text-sm text-white/80">This media couldn't be opened</p>
            <div className="flex gap-2">
              <button
                onClick={() => this.setState({ hasError: false })}
                className="px-4 py-2 text-sm rounded-full bg-white text-black hover:bg-white/90"
              >
                Try again
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm rounded-full bg-white/10 text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Drop-in replacement for FullscreenViewer with local crash isolation. */
const SafeFullscreenViewer: React.FC<ViewerProps> = (props) => (
  <ViewerBoundary
    contentId={String((props.content as { id?: string | number })?.id ?? '')}
    onClose={props.onClose}
  >
    <FullscreenViewer {...props} />
  </ViewerBoundary>
);

export default SafeFullscreenViewer;
