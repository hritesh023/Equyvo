import api from './api';

export function isCloudinaryConfigured(): boolean {
  return true; // Backend handles Cloudinary upload with server env vars
}

export interface CloudinaryUploadResult {
  publicId: string;
  secureUrl: string;
  resourceType: 'image' | 'video';
  format: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
  duration?: number;
}

export function compressImage(
  file: File,
  maxWidth = 600,
  quality = 0.2
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, maxWidth / img.width);
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Could not get canvas context')); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob failed'));
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Failed to load image for compression'));
    };
    img.src = URL.createObjectURL(file);
  });
}

export async function uploadToCloudinary(
  file: File | Blob,
  options?: {
    folder?: string;
    publicId?: string;
    tags?: string[];
    skipCompression?: boolean;
  }
): Promise<CloudinaryUploadResult> {
  const isImage = file instanceof File && file.type.startsWith('image/');

  let uploadFile = file;
  if (isImage && !options?.skipCompression) {
    try {
      uploadFile = await compressImage(file);
    } catch {
      // fall through to upload original if compression fails
    }
  }

  const { data, error } = await api.uploadFile(uploadFile, options?.folder || 'equyvo/uploads');

  if (error || !data) {
    throw new Error(error || 'Upload failed');
  }

  return {
    publicId: data.publicId,
    secureUrl: data.secureUrl,
    resourceType: data.resourceType as 'image' | 'video',
    format: data.format,
    bytes: data.bytes,
    width: data.width,
    height: data.height,
    createdAt: data.createdAt,
    duration: data.duration,
  };
}

export function getCloudinaryUrl(
  publicId: string,
  options?: {
    width?: number;
    height?: number;
    crop?: string;
    quality?: number | 'auto';
    format?: string;
    resourceType?: 'image' | 'video';
    effects?: string[];
  }
): string {
  if (!publicId) return '';
  return ''; // URLs are constructed server-side; just return the secureUrl from upload result
}

export function getOptimizedImageUrl(
  publicId: string,
  options?: {
    width?: number;
    height?: number;
    crop?: string;
  }
): string {
  return ''; // Use secureUrl from upload result directly
}

export function getOptimizedVideoUrl(publicId: string, options?: { width?: number; height?: number }): string {
  return ''; // Use secureUrl from upload result directly
}

export function getThumbnailUrl(
  publicId: string,
  options?: { width?: number; height?: number }
): string {
  return ''; // Use secureUrl from upload result directly
}

export function getAvatarUrl(publicId: string, size?: number): string {
  return ''; // Use secureUrl from upload result directly
}
