import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { X, ZoomIn, Check, Loader2 } from 'lucide-react';
import { showError } from '@/utils/toast';

interface AvatarCropperProps {
  imageSrc: string;
  onCancel: () => void;
  onCropComplete: (file: File) => void;
}

const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

/**
 * Circular avatar cropper. The white ring shows exactly what will fit
 * inside the round profile icon — drag to reposition, slider/wheel to zoom.
 * Outputs a square JPEG (the avatar displays it clipped to a circle).
 */
const AvatarCropper: React.FC<AvatarCropperProps> = ({ imageSrc, onCancel, onCropComplete }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [stageSize, setStageSize] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [working, setWorking] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; id: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      if (stageRef.current) setStageSize(stageRef.current.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const baseScale = imgSize.w > 0 && imgSize.h > 0 && stageSize > 0
    ? Math.max(stageSize / imgSize.w, stageSize / imgSize.h)
    : 1;
  const renderedW = imgSize.w * baseScale * zoom;
  const renderedH = imgSize.h * baseScale * zoom;

  const clampPos = useCallback((x: number, y: number) => {
    const maxX = Math.max(0, (renderedW - stageSize) / 2);
    const maxY = Math.max(0, (renderedH - stageSize) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, [renderedW, renderedH, stageSize]);

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
    const img = imgRef.current;
    if (!img || imgSize.w === 0 || stageSize === 0 || working) return;
    setWorking(true);
    try {
      const unit = baseScale * zoom; // rendered px per natural px
      const s = stageSize / unit; // visible square side in natural px
      const sx = (stageSize / 2 + pos.x - renderedW / 2) / unit;
      const sy = (stageSize / 2 + pos.y - renderedH / 2) / unit;
      const cx = Math.min(Math.max(0, sx), Math.max(0, imgSize.w - s));
      const cy = Math.min(Math.max(0, sy), Math.max(0, imgSize.h - s));
      const cw = Math.min(s, imgSize.w - cx);
      const ch = Math.min(s, imgSize.h - cy);
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas context');
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob(resolve, 'image/jpeg', 0.92);
        } catch {
          resolve(null);
        }
      });
      if (!blob) throw new Error('crop failed');
      onCropComplete(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    } catch {
      showError("Couldn't crop this photo. Please try another one.");
    } finally {
      setWorking(false);
    }
  };

  const left = stageSize / 2 + pos.x - renderedW / 2;
  const top = stageSize / 2 + pos.y - renderedH / 2;

  const content = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">Adjust profile photo</h3>
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close cropper">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          ref={stageRef}
          className="relative aspect-square w-full cursor-grab touch-none select-none overflow-hidden rounded-xl bg-black active:cursor-grabbing"
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
            alt="Crop preview"
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
            onError={() => showError("Couldn't load this photo. Please try another one.")}
          />
          {/* Dim everything outside the inscribed circle + white ring */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(circle closest-side, transparent 98%, rgba(0,0,0,0.72) 100%)' }}
          />
          <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/90" />
        </div>

        <p className="mt-3 text-center text-xs text-muted-foreground">
          Drag to position. Only what's inside the circle becomes your profile icon.
        </p>

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
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cropping...</>
            ) : (
              <><Check className="mr-2 h-4 w-4" /> Use photo</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(content, document.body);
};

export default AvatarCropper;
