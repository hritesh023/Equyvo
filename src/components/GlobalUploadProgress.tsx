import React, { useEffect, useState } from 'react';
import { subscribeUpload, getUploadState, UploadState } from '@/lib/upload-store';

const GlobalUploadProgress: React.FC = () => {
  const [state, setState] = useState<UploadState>(getUploadState());
  useEffect(() => subscribeUpload(setState), []);

  if (!state.isUploading || !state.progress) return null;
  const pct = Math.max(1, Math.min(99, state.progress.pct || 1));
  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-muted/40 pointer-events-none"
      aria-live="polite"
      aria-label="Upload in progress"
    >
      <div
        className="h-full bg-primary transition-all duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

export default GlobalUploadProgress;
