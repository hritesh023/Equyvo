import React, { useEffect, useState } from 'react';
import { Radio, Copy, Check, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { showError, showSuccess } from '@/utils/toast';

interface StreamCredentials {
  uid: string;
  hlsUrl: string;
  rtmpUrl: string;
  streamKey: string;
  srtUrl: string;
  srtPassphrase: string;
}

export interface PublishedStream {
  contentId: string;
  hlsUrl: string;
  uid: string;
  title: string;
}

interface StreamStudioProps {
  title: string;
  onPublish: (stream: PublishedStream) => Promise<void>;
}

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={secret && !copied ? '•'.repeat(Math.min(24, value.length)) : value}
          className="h-8 text-xs font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              showSuccess('Copied to clipboard');
              setTimeout(() => setCopied(false), 1500);
            } catch { showError('Could not copy. Select and copy manually.'); }
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** OBS / external-encoder setup backed by Cloudflare Stream: RTMP/SRT ingest,
 *  adaptive HLS playback and automatic VOD replay. */
const StreamStudio: React.FC<StreamStudioProps> = ({ title, onPublish }) => {
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<StreamCredentials | null>(null);
  const [contentId, setContentId] = useState('');

  useEffect(() => {
    api.streamConfig().then((res) => setConfigured(!!res.data?.configured)).catch(() => setConfigured(false));
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const id = Date.now().toString();
      const res = await api.createLiveInput({ name: title || 'Equyvo live', contentId: id, lowLatency: true });
      if (res.error || !res.data?.uid) {
        showError(res.error || 'Could not create a stream connection.');
        return;
      }
      setContentId(id);
      setCreds({
        uid: res.data.uid,
        hlsUrl: res.data.hlsUrl,
        rtmpUrl: res.data.rtmpUrl,
        streamKey: res.data.streamKey,
        srtUrl: res.data.srtUrl,
        srtPassphrase: res.data.srtPassphrase,
      });
      showSuccess('Stream connection ready — paste these into OBS.');
    } catch { showError('Could not reach the streaming service.'); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!creds) return;
    setBusy(true);
    try {
      await onPublish({ contentId, hlsUrl: creds.hlsUrl, uid: creds.uid, title: title || 'Live now' });
      showSuccess('Your live stream is published — viewers can watch now.');
    } catch { showError('Could not publish the stream card.'); }
    finally { setBusy(false); }
  };

  if (!configured) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        OBS / external-encoder streaming is not configured for this account yet.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-red-500" />
        <p className="text-sm font-semibold">OBS / External Encoder (Cloudflare Stream)</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Broadcast-grade live: adaptive 1080p/720p/480p, low-latency HLS, DVR rewind and automatic replay.
      </p>

      {!creds ? (
        <Button type="button" onClick={() => void create()} disabled={busy || !title.trim()} className="w-full">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radio className="mr-2 h-4 w-4" />}
          Create stream connection
        </Button>
      ) : (
        <>
          <div className="space-y-3">
            <CopyField label="RTMP / RTMPS URL" value={creds.rtmpUrl} />
            <CopyField label="Stream Key" value={creds.streamKey} secret />
            {creds.srtUrl && <CopyField label="SRT URL (alternative)" value={creds.srtUrl} />}
            {creds.srtPassphrase && <CopyField label="SRT Passphrase" value={creds.srtPassphrase} secret />}
          </div>
          <div className="rounded-md bg-background p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">In OBS: Settings → Stream → Server / Stream Key.</p>
            <p className="mt-1">Use <span className="font-mono">rtmps://live.cloudflare.com:443/live/</span> plus the key above. Start streaming in OBS, then publish the card below.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => void publish()} disabled={busy} className="flex-1 bg-red-500 hover:bg-red-600">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radio className="mr-2 h-4 w-4" />}
              Publish live card
            </Button>
            <a href={creds.hlsUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-xs hover:bg-muted">
              Preview <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </>
      )}
    </div>
  );
};

export default StreamStudio;
