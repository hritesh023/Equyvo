import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { X, ZoomIn, Check, Loader2, RotateCcw, Maximize2, Shrink } from 'lucide-react';
import { showError } from '@/utils/toast';

interface MediaCropperProps {
  imageSrc: string;
  /** Width / height of the crop frame, e.g. 16/9 landscape or 9/16 portrait. */
  aspect?: number;
  /** Output pixel size, e.g. [1280, 720]. */
  output?: [number, number];
  title?: string;
  /** Label for the confirm button, e.g. 'Use thumbnail'. */
  confirmLabel?: string;
  /** Export file name for the cropped result. */
  fileName?: string;
  /**
   * Preserve the source image's own aspect instead of forcing `aspect`:
   * the stage follows the loaded image and the export keeps its framing
   * (scaled to max 1600px on the long edge). Used for chat backgrounds and
   * chat attachments where any forced crop would lose content.
   */
  preserveAspect?: boolean;
  /**
   * GIF-aware mode (same editor as thumbnails, now for GIFs too): canvas
   * export can't preserve animation, so while the framing is untouched the
   * confirm button keeps the original via `onKeepOriginal`; once the user
   * zooms/pans/switches to Fill it exports a still frame instead.
   */
  isGif?: boolean;
  /** Label for the keep-original confirm, e.g. 'Send GIF as-is'. */
  keepOriginalLabel?: string;
  /** Called instead of exporting when a GIF is confirmed untouched. */
  onKeepOriginal?: () => void;
  onCancel: () => void;
  onCropComplete: (file: File) => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

type FitMode = 'fit' | 'fill';

/**
 * Flexible thumbnail cropper. Two modes:
 * - Fit (default): whole image visible, no auto-crop — letterboxed output.
 * - Fill: classic cover crop — drag to position, zoom to choose the crop.
 * Reset restores the original framing (zoom 1, centered) at any time.
 */
const MediaCropper: React.FC<MediaCropperProps> = ({
  imageSrc,
  aspect = 16 / 9,
  output = [1280, 720],
  title = 'Adjust thumbnail',
  confirmLabel = 'Use thumbnail',
  fileName = 'thumbnail.jpg',
  preserveAspect = false,
  isGif = false,
  keepOriginalLabel = 'Use original GIF',
  onKeepOriginal,
  onCancel,
  onCropComplete,
}) => {
  const safeAspect = typeof aspect === 'number' && !isNaN(aspect) && aspect > 0 ? aspect : 16 / 9;
  const propOutW = output && output[0] > 0 ? output[0] : 1280;
  const propOutH = output && output[1] > 0 ? output[1] : 720;

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [stageW, setStageW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [fitMode, setFitMode] = useState<FitMode>('fit');
  const [working, setWorking] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; id: number } | null>(null);

  const hasNatural = imgSize.w > 0 && imgSize.h > 0;
  // Preserve mode: the frame follows the source image's own aspect once it
  // loads; otherwise the fixed aspect/output props apply (create-page flow).
  const effAspect = preserveAspect && hasNatural ? imgSize.w / imgSize.h : safeAspect;
  // Preserve mode exports the source framing scaled so the long edge fits
  // 1600px (keeps chat backgrounds + attachments crisp but storage-safe).
  const preserveScale = preserveAspect && hasNatural
    ? Math.min(1, 1600 / Math.max(imgSize.w, imgSize.h))
    : 1;
  const outW = preserveAspect && hasNatural
    ? Math.max(1, Math.round(imgSize.w * preserveScale))
    : propOutW;
  const outH = preserveAspect && hasNatural
    ? Math.max(1, Math.round(imgSize.h * preserveScale))
    : propOutH;

  const stageH = stageW > 0 ? stageW / effAspect : 0;

  const resetFraming = useCallback(() => {
    setZoom(1);
    setPos({ x: 0, y: 0 });
  }, []);

  const switchMode = useCallback((mode: FitMode) => {
    setFitMode(mode);
    // Re-center so the original framing is restored instead of keeping a
    // stale crop offset from the other mode.
    setPos({ x: 0, y: 0 });
    if (mode === 'fit') setZoom(1);
  }, []);

  useEffect(() => {
    const measure = () => {
      if (stageRef.current) setStageW(stageRef.current.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const baseScale = imgSize.w > 0 && imgSize.h > 0 && stageW > 0 && stageH > 0
    ? (fitMode === 'fit'
        ? Math.min(stageW / imgSize.w, stageH / imgSize.h)
        : Math.max(stageW / imgSize.w, stageH / imgSize.h))
    : 1;
  const renderedW = imgSize.w * baseScale * zoom;
  const renderedH = imgSize.h * baseScale * zoom;

  const clampPos = useCallback((x: number, y: number) => {
    const maxX = Math.max(0, (renderedW - stageW) / 2);
    const maxY = Math.max(0, (renderedH - stageH) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, [renderedW, renderedH, stageW, stageH]);

  useEffect(() => {
    setPos((p) => clampPos(p.x, p.y));
  }, [clampPos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handlePointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, id: e.pointerId };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    setPos(clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY)));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z - Math.sign(e.deltaY) * 0.15)));
  };

  const handleConfirm = async () => {
    // Untouched GIF: keep the original file/data so animation survives —
    // a canvas export would silently reduce it to a still frame.
    if (isGif && zoom === 1 && pos.x === 0 && pos.y === 0 && fitMode === 'fit') {
      if (onKeepOriginal) {
        onKeepOriginal();
        return;
      }
    }
    const img = imgRef.current;
    if (!img || imgSize.w === 0 || stageW === 0 || working) return;
    setWorking(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas context');
      // Fill background so Fit outputs never have transparent gutters.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, outW, outH);
      if (fitMode === 'fit' && zoom === 1 && pos.x === 0 && pos.y === 0) {
        // True original-size export: whole image, aspect-preserved, centered.
        const s = Math.min(outW / imgSize.w, outH / imgSize.h);
        const dw = imgSize.w * s;
        const dh = imgSize.h * s;
        ctx.drawImage(img, 0, 0, imgSize.w, imgSize.h, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
      } else if (fitMode === 'fit') {
        // Fit + user zoom/pan: keep aspect, letterbox, honor framing.
        const unit = baseScale * zoom;
        const renderedWFit = imgSize.w * unit;
        const renderedHFit = imgSize.h * unit;
        const dx = (outW - (renderedWFit / stageW) * outW) / 2 + (pos.x / stageW) * outW;
        const dy = (outH - (renderedHFit / stageH) * outH) / 2 + (pos.y / stageH) * outH;
        const dw = (renderedWFit / stageW) * outW;
        const dh = (renderedHFit / stageH) * outH;
        ctx.drawImage(img, 0, 0, imgSize.w, imgSize.h, dx, dy, dw, dh);
      } else {
        const unit = baseScale * zoom;
        const sW = stageW / unit;
        const sH = stageH / unit;
        const sx = (stageW / 2 + pos.x - renderedW / 2) / unit;
        const sy = (stageH / 2 + pos.y - renderedH / 2) / unit;
        const cx = Math.min(Math.max(0, sx), Math.max(0, imgSize.w - sW));
        const cy = Math.min(Math.max(0, sy), Math.max(0, imgSize.h - sH));
        const cw = Math.min(sW, imgSize.w - cx);
        const ch = Math.min(sH, imgSize.h - cy);
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, outW, outH);
      }
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob(resolve, 'image/jpeg', 0.9);
        } catch {
          resolve(null);
        }
      });
      if (!blob) throw new Error('crop failed');
      onCropComplete(new File([blob], fileName, { type: 'image/jpeg' }));
    } catch {
      showError("Couldn't crop this image. Please try another one.");
    } finally {
      setWorking(false);
    }
  };

  const left = stageW / 2 + pos.x - renderedW / 2;
  const top = stageH / 2 + pos.y - renderedH / 2;

  const content = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close thumbnail editor">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          ref={stageRef}
          className="relative w-full cursor-grab touch-none select-none overflow-hidden rounded-xl bg-black active:cursor-grabbing"
          style={{ aspectRatio: `${outW} / ${outH}` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
          onWheel={handleWheel}
        >
          <img
            ref={imgRef}
            src={imageSrc}
            alt="Thumbnail preview"
            crossOrigin="anonymous"
            draggable={false}
            className="absolute max-w-none"
            style={{
              width: renderedW > 0 ? renderedW : 'auto',
              height: renderedH > 0 ? renderedH : 'auto',
              left,
              top,
              opacity: imgSize.w > 0 ? 1 : 0,
            }}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0) setImgSize({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            onError={() => showError("Couldn't load this image. Please try another one.")}
          />
        </div>

        <p className="mt-3 text-center text-xs text-muted-foreground">
          {isGif
            ? (fitMode === 'fit' && zoom === 1
              ? 'GIF stays animated when used as-is. Zoom or switch to Fill to create a still.'
              : 'Adjusting a GIF creates a still image — animation is lost.')
            : (fitMode === 'fit'
              ? 'Fit shows the whole image with no auto-crop. Switch to Fill to crop, or zoom/drag to adjust.'
              : 'Fill crops to the frame — drag to position, zoom to choose the crop.')}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant={fitMode === 'fit' ? 'default' : 'outline'}
            size="sm"
            className="flex-1"
            onClick={() => switchMode('fit')}
          >
            <Shrink className="mr-1 h-3.5 w-3.5" /> Fit (no crop)
          </Button>
          <Button
            type="button"
            variant={fitMode === 'fill' ? 'default' : 'outline'}
            size="sm"
            className="flex-1"
            onClick={() => switchMode('fill')}
          >
            <Maximize2 className="mr-1 h-3.5 w-3.5" /> Fill (crop)
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetFraming}
            title="Reset to original framing"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <ZoomIn className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Slider
            value={[zoom]}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            onValueChange={([v]) => setZoom(v)}
            aria-label="Zoom"
          />
        </div>

        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={onCancel} className="flex-1" disabled={working}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={working || imgSize.w === 0} className="flex-1">
            {working ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
            ) : isGif && fitMode === 'fit' && zoom === 1 ? (
              <><Check className="mr-2 h-4 w-4" /> {keepOriginalLabel}</>
            ) : isGif ? (
              <><Check className="mr-2 h-4 w-4" /> Use still image</>
            ) : (
              <><Check className="mr-2 h-4 w-4" /> {confirmLabel}</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(content, document.body);
};

export default MediaCropper;
