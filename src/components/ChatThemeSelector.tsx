import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Palette, Upload, RotateCcw, Check, X, Trash2, Crop } from 'lucide-react';
import { useChatTheme, CHAT_THEME_DEFAULT } from '@/contexts/ChatThemeContext';
import { showSuccess, showError } from '@/utils/toast';
import MediaCropper from './MediaCropper';

interface ChatThemeSelectorProps {
  children: React.ReactNode;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_BYTES = 5 * 1024 * 1024;

const presetColors = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#111827',
];

export function ChatThemeSelector({ children }: ChatThemeSelectorProps) {
  const { chatTheme, setChatTheme, resetChatTheme } = useChatTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<'color' | 'image' | 'settings'>('color');

  // Draft state — nothing is applied until the user presses Done.
  const [draftColor, setDraftColor] = useState('#3b82f6');
  const [draftImage, setDraftImage] = useState<string | null>(null);
  const [draftOpacity, setDraftOpacity] = useState(1);
  const [draftType, setDraftType] = useState<'color' | 'image'>('color');
  const [hexError, setHexError] = useState('');
  const [fileError, setFileError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Crop/adjust step for still images (same editor as create-page
  // thumbnails). GIFs skip it so animation is preserved.
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropName, setCropName] = useState('chat-background.jpg');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync drafts every time the dialog opens so it never shows stale values.
  useEffect(() => {
    if (!isOpen) return;
    const t = chatTheme.type === 'image' ? 'image' : 'color';
    setTab(chatTheme.type === 'image' ? 'image' : 'color');
    setDraftType(t);
    setDraftColor(
      chatTheme.type === 'color' && chatTheme.value && HEX_RE.test(chatTheme.value)
        ? chatTheme.value
        : '#3b82f6',
    );
    setDraftImage(chatTheme.type === 'image' && chatTheme.value ? chatTheme.value : null);
    setDraftOpacity(
      typeof chatTheme.opacity === 'number' && Number.isFinite(chatTheme.opacity)
        ? Math.min(1, Math.max(0.05, chatTheme.opacity))
        : 1,
    );
    setHexError('');
    setFileError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [isOpen, chatTheme]);

  const pickColor = (color: string) => {
    if (!HEX_RE.test(color)) {
      setHexError('Enter a valid 6-digit hex color, e.g. #3b82f6');
      return;
    }
    setHexError('');
    setDraftColor(color.toLowerCase());
    setDraftType('color');
  };

  const processFile = (file: File | undefined | null) => {
    setFileError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFileError('Please choose an image or GIF file.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError('File must be smaller than 5MB.');
      showError('File must be smaller than 5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      setFileError('Could not read that file. Try another image.');
      showError('Could not read that file.');
    };
    reader.onload = (event) => {
      const url = event.target?.result as string | undefined;
      if (!url || !url.startsWith('data:image/')) {
        setFileError('That file is not a readable image.');
        return;
      }
      if (file.type === 'image/gif') {
        // GIFs open the same crop/adjust editor as stills: confirming
        // untouched keeps the animation, adjusting exports a still frame.
        setCropName((file.name || 'chat-background').replace(/\.[^.]+$/, '') + '.gif');
        setCropSrc(url);
        return;
      }
      // Still image: open the crop/adjust editor first (same as thumbnails).
      setCropName((file.name || 'chat-background').replace(/\.[^.]+$/, '') + '.jpg');
      setCropSrc(url);
    };
    reader.readAsDataURL(file);
    // Reset the input so the same file can be picked again.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFile(e.target.files?.[0]);
  };

  const handleCropComplete = (file: File) => {
    const reader = new FileReader();
    reader.onerror = () => {
      setFileError('Could not apply the adjusted image. Try again.');
      setCropSrc(null);
    };
    reader.onload = (event) => {
      const url = event.target?.result as string | undefined;
      setCropSrc(null);
      if (!url || !url.startsWith('data:image/')) {
        setFileError('Could not apply the adjusted image. Try again.');
        return;
      }
      setDraftImage(url);
      setDraftType('image');
      showSuccess(
        url.startsWith('data:image/gif')
          ? 'Background ready — press Done to apply.'
          : 'Background adjusted — press Done to apply.',
      );
    };
    reader.readAsDataURL(file);
  };

  // Untouched GIF confirmed as-is: keep the animated data URL (a canvas
  // export would silently reduce it to a still frame).
  const handleKeepOriginalGif = () => {
    if (!cropSrc || !cropSrc.startsWith('data:image/')) {
      setCropSrc(null);
      return;
    }
    setDraftImage(cropSrc);
    setDraftType('image');
    setCropSrc(null);
    showSuccess('GIF ready — press Done to apply. (Animated as-is.)');
  };

  const handleReset = () => {
    resetChatTheme();
    setDraftColor('#3b82f6');
    setDraftImage(null);
    setDraftType('color');
    setDraftOpacity(CHAT_THEME_DEFAULT.opacity ?? 1);
    setHexError('');
    setFileError('');
    showSuccess('Chat background reset to default.');
  };

  const handleCancel = () => {
    setIsOpen(false);
  };

  const handleDone = () => {
    if (draftType === 'color') {
      if (!HEX_RE.test(draftColor)) {
        setHexError('Enter a valid 6-digit hex color, e.g. #3b82f6');
        setTab('color');
        return;
      }
      const ok = setChatTheme({ type: 'color', value: draftColor.toLowerCase(), opacity: draftOpacity });
      if (!ok) {
        showError('Could not save theme (storage full). Try a smaller image or reset.');
        return;
      }
    } else {
      if (!draftImage) {
        setFileError('Choose an image first, or switch to the Color tab.');
        setTab('image');
        return;
      }
      const ok = setChatTheme({ type: 'image', value: draftImage, opacity: draftOpacity });
      if (!ok) {
        showError('Image is too large to save. Try a smaller file (under 5MB).');
        return;
      }
    }
    showSuccess('Chat background applied.');
    setIsOpen(false);
  };

  const activePreviewColor = draftType === 'color' ? draftColor : null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="w-5 h-5" />
            Chat background
          </DialogTitle>
          <DialogDescription>
            Pick a color or upload an image, tune the opacity, then press Done to apply it to your chats.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'color' | 'image' | 'settings')} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="color">Color</TabsTrigger>
            <TabsTrigger value="image">Image</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="color" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="chat-hex">Hex color picker</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  aria-label="Pick a background color"
                  value={HEX_RE.test(draftColor) ? draftColor : '#3b82f6'}
                  onChange={(e) => pickColor(e.target.value)}
                  className="w-16 h-10 p-1 border rounded cursor-pointer"
                />
                <Input
                  id="chat-hex"
                  type="text"
                  value={draftColor}
                  onChange={(e) => {
                    setDraftColor(e.target.value);
                    setDraftType('color');
                    if (HEX_RE.test(e.target.value)) setHexError('');
                  }}
                  onBlur={(e) => {
                    if (e.target.value && !HEX_RE.test(e.target.value)) {
                      setHexError('Enter a valid 6-digit hex color, e.g. #3b82f6');
                    }
                  }}
                  placeholder="#3b82f6"
                  maxLength={7}
                  className="flex-1 font-mono"
                />
              </div>
              {hexError ? (
                <p role="alert" className="text-xs text-destructive">{hexError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Changes preview below. Press Done to apply.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Preset colors</Label>
              <div className="grid grid-cols-6 gap-2">
                {presetColors.map((color) => {
                  const selected = draftType === 'color' && draftColor.toLowerCase() === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => pickColor(color)}
                      aria-pressed={selected}
                      aria-label={`Select color ${color}`}
                      title={color}
                      className={`w-8 h-8 rounded border-2 transition-transform hover:scale-110 ${
                        selected ? 'border-primary ring-2 ring-primary/40 scale-110' : 'border-border'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="color-opacity">Opacity: {draftOpacity.toFixed(2)}</Label>
              <Slider
                id="color-opacity"
                value={[draftOpacity]}
                onValueChange={([v]) => setDraftOpacity(Math.min(1, Math.max(0.05, v)))}
                max={1}
                min={0.05}
                step={0.05}
                className="w-full"
              />
            </div>

            {activePreviewColor && HEX_RE.test(activePreviewColor) && (
              <div className="rounded-lg border p-3 flex items-center gap-3">
                <div
                  className="w-12 h-12 rounded border shrink-0"
                  style={{ backgroundColor: activePreviewColor, opacity: draftOpacity }}
                />
                <p className="text-xs text-muted-foreground">
                  Preview of <span className="font-mono">{activePreviewColor}</span> at {Math.round(draftOpacity * 100)}% opacity.
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="image" className="space-y-4">
            <div className="space-y-2">
              <Label>Upload background image</Label>
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload background image. You can also drag and drop a file here."
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  processFile(e.dataTransfer.files?.[0]);
                }}
                className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer transition-colors ${
                  dragOver ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground mb-2 text-center">
                  Upload an image or GIF for chat background
                  <br />
                  <span className="text-xs">Click, or drag &amp; drop · max 5MB</span>
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.gif"
                  onChange={handleFileInput}
                  className="hidden"
                  aria-hidden
                  tabIndex={-1}
                />
                <Button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  variant="outline"
                  size="sm"
                >
                  Choose File
                </Button>
              </div>
              {fileError && (
                <p role="alert" className="text-xs text-destructive">{fileError}</p>
              )}
            </div>

            {draftImage && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Preview</Label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setCropName(
                          draftImage.startsWith('data:image/gif')
                            ? 'chat-background.gif'
                            : 'chat-background.jpg',
                        );
                        setCropSrc(draftImage);
                      }}
                      title={
                        draftImage.startsWith('data:image/gif')
                          ? 'Adjust GIF (keeps animation when unchanged)'
                          : 'Crop or adjust background image'
                      }
                    >
                      <Crop className="w-3 h-3 mr-1" /> Adjust
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:text-destructive"
                      onClick={() => {
                        setDraftImage(null);
                        if (draftType === 'image') setDraftType('color');
                      }}
                    >
                      <Trash2 className="w-3 h-3 mr-1" /> Remove image
                    </Button>
                  </div>
                </div>
                <div className="relative rounded-lg overflow-hidden border">
                  <img
                    src={draftImage}
                    alt="Chat background preview"
                    className="w-full h-32 object-cover"
                    style={{ opacity: draftOpacity }}
                    onError={() => setFileError('Could not display that image.')}
                  />
                </div>
                {draftImage.startsWith('data:image/gif') ? (
                  <p className="text-xs text-muted-foreground">GIF stays animated. Use Adjust for a still crop.</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Press Done to apply this image to your chats.</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="image-opacity">Opacity: {draftOpacity.toFixed(2)}</Label>
              <Slider
                id="image-opacity"
                value={[draftOpacity]}
                onValueChange={([v]) => setDraftOpacity(Math.min(1, Math.max(0.05, v)))}
                max={1}
                min={0.05}
                step={0.05}
                className="w-full"
              />
            </div>
          </TabsContent>

          <TabsContent value="settings" className="space-y-4">
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label>Pending choice</Label>
                <span className="text-sm text-muted-foreground capitalize">{draftType}</span>
              </div>
              <div className="flex items-center justify-between">
                <Label>Opacity</Label>
                <span className="text-sm text-muted-foreground">{draftOpacity.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <Label>Preview</Label>
                {draftType === 'color' ? (
                  <div
                    className="w-8 h-8 rounded border"
                    style={{ backgroundColor: HEX_RE.test(draftColor) ? draftColor : '#3b82f6', opacity: draftOpacity }}
                  />
                ) : draftImage ? (
                  <img src={draftImage} alt="Selected background" className="w-12 h-8 rounded border object-cover" style={{ opacity: draftOpacity }} />
                ) : (
                  <span className="text-sm text-muted-foreground">No image chosen</span>
                )}
              </div>
            </div>

            <Button type="button" onClick={handleReset} variant="outline" className="w-full">
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset to Default
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={handleCancel}>
            <X className="w-4 h-4 mr-1.5" /> Cancel
          </Button>
          <Button type="button" variant="outline" onClick={handleReset}>
            <RotateCcw className="w-4 h-4 mr-1.5" /> Reset
          </Button>
          <Button type="button" onClick={handleDone}>
            <Check className="w-4 h-4 mr-1.5" /> Done
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* Crop/adjust editor — same tool as thumbnails, now for GIFs too.
          Untouched GIFs stay animated; adjusting one exports a still. */}
      {cropSrc && (
        <MediaCropper
          imageSrc={cropSrc}
          preserveAspect
          isGif={cropSrc.startsWith('data:image/gif')}
          keepOriginalLabel="Use GIF as-is"
          title="Adjust chat background"
          confirmLabel="Use background"
          fileName={cropName}
          onCancel={() => setCropSrc(null)}
          onKeepOriginal={handleKeepOriginalGif}
          onCropComplete={handleCropComplete}
        />
      )}
    </Dialog>
  );
}
