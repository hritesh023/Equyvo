"use client";

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { X, Upload, Camera, Loader2, Crop } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import { compressImage } from '@/lib/utils';
import AvatarCropper from '@/components/AvatarCropper';
import api from '@/lib/api';

async function uploadFile(file: File, folder: string) {
  const uploadFile = file.type.startsWith('image/') ? await compressImage(file) : file;
  const { data, error } = await api.uploadFile(uploadFile, folder);
  if (error) throw new Error(error);
  return data!;
}

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: {
    name: string;
    username: string;
    bio: string;
    avatar: string;
  };
  onSave: (profile: any) => void;
}

const EditProfileModal: React.FC<EditProfileModalProps> = ({
  isOpen,
  onClose,
  currentProfile,
  onSave,
}) => {
  const navigate = useNavigate();
  const [name, setName] = useState(currentProfile.name);
  const [username, setUsername] = useState(currentProfile.username);
  const [bio, setBio] = useState(currentProfile.bio);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState(currentProfile.avatar);
  const [isUploading, setIsUploading] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  // Display-name quota (server-enforced; shown here for transparency).
  // Avatars stay unlimited — only the Name field consumes quota.
  const [quota, setQuota] = useState<{ used: number; quota: number; remaining: number } | null>(null);

  // Refresh fields + quota every time the modal opens (the parent keeps this
  // component mounted, so initial useState would otherwise go stale).
  React.useEffect(() => {
    if (!isOpen) return;
    setName(currentProfile.name);
    setUsername(currentProfile.username);
    setBio(currentProfile.bio);
    setAvatarFile(null);
    setAvatarPreview(currentProfile.avatar);
    setCropSrc(null);
    setQuota(null);
    let cancelled = false;
    api.getNameQuota()
      .then(({ data, error }) => {
        if (!cancelled && !error && data && typeof data.remaining === 'number') {
          setQuota({ used: data.used, quota: data.quota, remaining: data.remaining });
        }
      })
      .catch(() => { /* fail-open: the server still enforces on save */ });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const nameChanged =
    name.trim() !== (currentProfile.name || '').trim();
  const nameBlocked =
    !!nameChanged && !!quota && quota.remaining <= 0;

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Allow picking the same file again
    e.target.value = '';
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        showError('Avatar file size must be less than 5MB');
        return;
      }
      if (!file.type.startsWith('image/')) {
        showError('Please select an image file');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setCropSrc(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCropComplete = (file: File) => {
    if (avatarPreview.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(avatarPreview);
      } catch {
        /* ignore */
      }
    }
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    setCropSrc(null);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      showError('Name is required');
      return;
    }
    if (!username.trim()) {
      showError('Username is required');
      return;
    }
    if (username.length < 3) {
      showError('Username must be at least 3 characters');
      return;
    }
    // Display-name quota is enforced server-side; check first so the user
    // gets the Premium upsell instead of a silent round-trip. Avatar uploads
    // are always allowed — only a changed Name consumes quota.
    if (nameBlocked) {
      showError('You have used all your profile name changes. Buy Premium to get 2 more.');
      return;
    }

    let avatarUrl = avatarPreview;
    if (avatarFile) {
      setIsUploading(true);
      try {
        const result = await uploadFile(avatarFile, 'equyvo/avatars');
        avatarUrl = result.secureUrl;
      } catch {
        showError('Failed to upload avatar. Using local preview.');
      }
      setIsUploading(false);
    }

    const updatedProfile = {
      name,
      username,
      bio,
      avatar: avatarUrl,
    };

    onSave(updatedProfile);
    showSuccess('Profile updated successfully!');
    onClose();
  };

  const handleRemoveAvatar = () => {
    setAvatarFile(null);
    setAvatarPreview('');
  };

  if (!isOpen) return null;

  const modal = (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <Card className="w-full max-w-md max-h-[90vh] overflow-y-auto">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle>Edit Profile</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Avatar Upload */}
          <div className="flex flex-col items-center space-y-2">
            <div className="relative">
              <Avatar className="h-20 w-20">
                <AvatarImage src={avatarPreview} />
                <AvatarFallback className="text-lg">
                  {name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <Button
                variant="outline"
                size="sm"
                className="absolute -bottom-2 -right-2 rounded-full h-8 w-8 p-0"
                onClick={() => document.getElementById('avatar-upload')?.click()}
              >
                <Camera className="h-4 w-4" />
              </Button>
            </div>
            <input
              id="avatar-upload"
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="hidden"
            />
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Click camera to change photo
              </p>
              {avatarPreview && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setCropSrc(avatarPreview)}
                >
                  <Crop className="h-3 w-3" /> Adjust
                </Button>
              )}
            </div>
          </div>

          {/* Name (quota-limited: 2 free, +2 per Premium purchase) */}
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="mt-1"
            />
            {quota ? (
              quota.remaining > 0 || !nameChanged ? (
                <p className="text-xs text-muted-foreground mt-1">
                  {quota.remaining} of {quota.quota} name changes remaining
                  {nameChanged ? ' (saving will use 1)' : ''} · profile photo changes are unlimited
                </p>
              ) : (
                <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-xs font-semibold">No name changes left ({quota.used}/{quota.quota} used)</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Buy Premium to get 2 more name changes. You can still update your photo, username and bio for free.
                  </p>
                  <div className="flex gap-2 mt-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => { onClose(); navigate('/pricing'); }}
                    >
                      Buy Premium
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setName(currentProfile.name)}
                    >
                      Keep old name
                    </Button>
                  </div>
                </div>
              )
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                Profile photo changes are unlimited · name changes are limited
              </p>
            )}
          </div>

          {/* Username */}
          <div>
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/\s/g, '').toLowerCase())}
              placeholder="Enter username"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Username can only contain letters, numbers, and underscores
            </p>
          </div>

          {/* Bio */}
          <div>
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell us about yourself"
              className="mt-1"
              rows={3}
              maxLength={200}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {bio.length}/200 characters
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 pt-4">
            <Button variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isUploading} className="flex-1">
              {isUploading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Uploading...</>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(
    <>
      {modal}
      {cropSrc && (
        <AvatarCropper
          imageSrc={cropSrc}
          onCancel={() => setCropSrc(null)}
          onCropComplete={handleCropComplete}
        />
      )}
    </>,
    document.body,
  );
};

export default EditProfileModal;
