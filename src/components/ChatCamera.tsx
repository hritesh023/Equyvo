import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, Zap, RotateCcw, Camera, Video, Image as ImageIcon, Plus } from 'lucide-react';
import { showError } from '@/utils/toast';

type Facing = 'user' | 'environment';

interface ChatCameraProps {
  open: boolean;
  onClose: () => void;
  onAttach: (file: File) => void;
}

const pickMime = (candidates: string[]) =>
  candidates.find((m) => {
    try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m); } catch { return false; }
  });

export const ChatCamera: React.FC<ChatCameraProps> = ({ open, onClose, onAttach }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [facing, setFacing] = useState<Facing>('environment');
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ file: File; url: string }[]>([]);

  const stopStream = useCallback(() => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    streamRef.current = null;
    setStream(null);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const startStream = useCallback(async (f: Facing, deviceId?: string) => {
    setError(null);
    stopStream();
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: f }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = s;
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        try { await videoRef.current.play(); } catch { /* ignore */ }
      }
      const track = s.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() || {}) as { torch?: boolean };
      setTorchSupported(!!caps.torch);
      // enumerate devices
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        setDevices(devs.filter((d) => d.kind === 'videoinput'));
      } catch { /* ignore */ }
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        setError('Camera permission is needed. Allow camera access for Equyvo, then try again.');
      } else if (e?.name === 'NotFoundError') {
        setError('No camera was found on this device.');
      } else if (e?.name === 'NotReadableError') {
        setError('Camera is being used by another app. Close it and try again.');
      } else {
        setError('Could not open the camera. Try again.');
      }
    }
  }, [stopStream]);

  useEffect(() => {
    if (!open) return;
    void startStream(facing);
    return () => {
      stopStream();
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        try { recorderRef.current.stop(); } catch { /* ignore */ }
      }
      recorderRef.current = null;
    };
  }, [open]);

  // when facing changes while open
  useEffect(() => {
    if (!open) return;
    void startStream(facing);
  }, [facing]);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [stream]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await (track as any).applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn((v) => !v);
    } catch {
      showError('Flash is not available on this camera.');
    }
  };

  const rotateCamera = () => {
    // cycle through available video devices if more than one, else flip facing
    if (devices.length > 1) {
      const idx = devices.findIndex((d) => d.deviceId === stream?.getVideoTracks()[0]?.getSettings?.().deviceId);
      const next = devices[(idx + 1) % devices.length];
      void startStream(facing, next.deviceId);
    } else {
      setFacing((f) => (f === 'user' ? 'environment' : 'user'));
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      showError('Camera not ready yet.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) { showError('Could not capture photo.'); return; }
    // mirror if front camera
    if (facing === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { showError('Could not capture photo.'); return; }
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      onAttach(file);
      onClose();
    }, 'image/jpeg', 0.92);
  };

  const startVideoRecording = () => {
    const s = streamRef.current;
    if (!s) { showError('Camera not ready yet.'); return; }
    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    if (!mime) { showError('Video recording is not supported on this device.'); return; }
    try {
      const rec = new MediaRecorder(s, { mimeType: mime });
      recChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(recChunksRef.current, { type: mime });
        recChunksRef.current = [];
        recorderRef.current = null;
        setRecording(false);
        if (!blob.size) { showError('Recording was empty — try again.'); return; }
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `video-${Date.now()}.${ext}`, { type: mime });
        onAttach(file);
        onClose();
      };
      recorderRef.current = rec;
      setRecording(true);
      rec.start(250);
    } catch {
      showError('Could not start recording.');
    }
  };

  const stopVideoRecording = () => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      try { rec.stop(); } catch { setRecording(false); }
    }
  };

  const handleRecentPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const next = files.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
    setRecent((prev) => [...next, ...prev].slice(0, 24));
    if (e.target) e.target.value = '';
  };

  const attachRecent = (item: { file: File; url: string }) => {
    onAttach(item.file);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-4 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 rounded-full bg-black/40 text-white hover:bg-black/60"
          onClick={onClose}
          aria-label="Close camera"
          title="Close camera"
        >
          <X className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          {torchSupported && (
            <Button
              variant="ghost"
              size="icon"
              className={`h-10 w-10 rounded-full ${torchOn ? 'bg-amber-400/30 text-amber-300' : 'bg-black/40 text-white hover:bg-black/60'}`}
              onClick={() => void toggleTorch()}
              aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
              title={torchOn ? 'Flash on' : 'Flash off'}
            >
              <Zap className="w-5 h-5" />
            </Button>
          )}
        </div>
      </div>

      {/* Viewfinder */}
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div>
              <Camera className="w-12 h-12 mx-auto mb-3 opacity-60" />
              <p className="text-sm opacity-80">{error}</p>
              <Button className="mt-4" onClick={() => void startStream(facing)}>Retry</Button>
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            className={`absolute inset-0 w-full h-full object-cover ${facing === 'user' ? 'scale-x-[-1]' : ''}`}
            playsInline
            muted
            autoPlay
          />
        )}
        {recording && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-red-600/80 px-3 py-1 text-xs font-medium">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            Recording…
          </div>
        )}
      </div>

      {/* Recent files strip (circular previews) */}
      {recent.length > 0 && (
        <div className="shrink-0 bg-black/80 px-4 py-2">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            {recent.map((item, i) => (
              <button
                key={i}
                type="button"
                onClick={() => attachRecent(item)}
                className="shrink-0 h-14 w-14 rounded-full overflow-hidden border-2 border-white/30 bg-white/10"
                aria-label={`Select ${item.file.name}`}
                title={item.file.name}
              >
                {item.file.type.startsWith('image/') ? (
                  <img src={item.url} alt={item.file.name} className="h-full w-full object-cover" />
                ) : item.file.type.startsWith('video/') ? (
                  <video src={item.url} className="h-full w-full object-cover" muted />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] px-1 text-center break-all">{item.file.name.slice(0, 8)}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 bg-black/80 backdrop-blur-md px-4 py-4" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex items-center justify-center gap-6">
          {/* Attach (circular preview of most recent) — tapping attaches the
              most recent item directly (WhatsApp-style); the + button opens
              the picker to add more from local storage. */}
          <button
            type="button"
            onClick={() => {
              if (recent.length > 0) attachRecent(recent[0]);
              else fileInputRef.current?.click();
            }}
            className="h-14 w-14 rounded-full overflow-hidden border-2 border-white/40 bg-white/10 flex items-center justify-center hover:bg-white/20 shrink-0"
            aria-label="Attach from storage"
            title="Attach from local storage"
          >
            {recent.length > 0 && recent[0].file.type.startsWith('image/') ? (
              <img src={recent[0].url} alt="recent" className="h-full w-full object-cover" />
            ) : recent.length > 0 && recent[0].file.type.startsWith('video/') ? (
              <video src={recent[0].url} className="h-full w-full object-cover" muted />
            ) : (
              <ImageIcon className="w-6 h-6" />
            )}
          </button>

          {/* Capture center */}
          <button
            type="button"
            onClick={() => {
              if (mode === 'photo') capturePhoto();
              else if (recording) stopVideoRecording();
              else startVideoRecording();
            }}
            disabled={!!error}
            aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}
            className={`h-20 w-20 rounded-full border-4 ${recording ? 'border-red-500 bg-red-600' : 'border-white bg-white/20'} flex items-center justify-center active:scale-95 transition shrink-0`}
          >
            {mode === 'photo' ? (
              <Camera className="w-8 h-8" />
            ) : recording ? (
              <span className="h-7 w-7 rounded-sm bg-white" />
            ) : (
              <Video className="w-8 h-8" />
            )}
          </button>

          {/* Photo/Video toggle */}
          <button
            type="button"
            onClick={() => setMode((m) => (m === 'photo' ? 'video' : 'photo'))}
            className="h-14 w-14 rounded-full border-2 border-white/40 bg-white/10 flex items-center justify-center hover:bg-white/20 shrink-0"
            aria-label={`Switch to ${mode === 'photo' ? 'video' : 'photo'} mode`}
            title={mode === 'photo' ? 'Photo mode' : 'Video mode'}
          >
            {mode === 'photo' ? <ImageIcon className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </button>

          {/* Rotate */}
          <button
            type="button"
            onClick={rotateCamera}
            className="h-14 w-14 rounded-full border-2 border-white/40 bg-white/10 flex items-center justify-center hover:bg-white/20 shrink-0"
            aria-label="Rotate camera"
            title="Rotate camera"
          >
            <RotateCcw className="w-6 h-6" />
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.doc,.docx,.txt"
          onChange={handleRecentPick}
          className="sr-only"
          aria-label="Pick recent files"
        />
      </div>
    </div>
  );
};

export default ChatCamera;