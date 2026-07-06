// API client for Equyvo backend
// In development, proxies through Vite to local Pages Functions
// In production, same origin (Pages serves both frontend and functions)

const API_BASE = '/api';

async function request<T = any>(
  path: string,
  options?: RequestInit
): Promise<{ data?: T; error?: string }> {
  try {
    const url = `${API_BASE}${path}`;
    const headers: Record<string, string> = {};
    const isFormData = options?.body instanceof FormData;
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, {
      headers,
      ...options,
    });
    const json = await res.json();
    if (!res.ok) {
      return { error: json.error || `Request failed with status ${res.status}` };
    }
    return json;
  } catch (err: any) {
    return { error: err.message || 'Network error' };
  }
}

export const api = {
  // Posts
  getPosts: (limit = 50) =>
    request<{ data: any[]; error: null }>(`/posts?limit=${limit}`),

  createPost: (data: any) =>
    request<{ data: any; error: null }>('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Thoughts
  getThoughts: (limit = 20, offset = 0) =>
    request<{ data: any[]; error: null }>(`/thoughts?limit=${limit}&offset=${offset}`),

  createThought: (data: any) =>
    request<{ data: any; error: null }>('/thoughts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Stories
  getStories: (limit = 20) =>
    request<{ data: any[]; error: null }>(`/stories?limit=${limit}`),

  createStory: (data: any) =>
    request<{ data: any; error: null }>('/stories', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Moments
  getMoments: (limit = 20) =>
    request<{ data: any[]; error: null }>(`/moments?limit=${limit}`),

  createMoment: (data: any) =>
    request<{ data: any; error: null }>('/moments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Profile
  getProfile: (userId: string) =>
    request<{ data: any; error: null }>(`/profile/${userId}`),

  updateProfile: (data: any) =>
    request<{ data: any; error: null }>('/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Search
  search: (query: string) =>
    request<{ data: { results: any[]; totalCount: number; isAiRecommended: boolean }; error: null }>(
      `/search?q=${encodeURIComponent(query)}`
    ),

  // Content indexing (called after Cloudinary upload)
  indexContent: (data: any) =>
    request<{ data: { success: boolean }; error: null }>('/content-index', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Delete
  deletePost: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/posts/${id}`, { method: 'DELETE' }),

  deleteThought: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/thoughts/${id}`, { method: 'DELETE' }),

  deleteStory: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/stories/${id}`, { method: 'DELETE' }),

  deleteMoment: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/moments/${id}`, { method: 'DELETE' }),

  deleteUserData: (userId: string) =>
    request<{ data: { success: boolean }; error: null }>(`/user/${userId}/data`, { method: 'DELETE' }),

  // Upload file via backend proxy (keeps Cloudinary creds server-side)
  uploadFile: (file: File | Blob, folder?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (folder) formData.append('folder', folder);
    return request<{
      publicId: string;
      secureUrl: string;
      resourceType: string;
      format: string;
      bytes: number;
      width: number;
      height: number;
      createdAt: string;
      duration?: number;
    }>('/upload', {
      method: 'POST',
      body: formData,
    });
  },

  // Get user's own posts
  getUserPosts: (userId: string, limit = 50) =>
    request<{ data: any[]; error: null }>(`/users/${userId}/posts?limit=${limit}`),

  // Health check
  health: () => request<{ status: string }>('/health'),
};

export default api;