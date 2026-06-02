export const IS_MOCK_ENV = true;

export const MOCK_VIDEO_URLS = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
];

export const MOCK_FALLBACK_VIDEO_URL = MOCK_VIDEO_URLS[0];

export const getMockVideoUrl = (index = 0) =>
  MOCK_VIDEO_URLS[index % MOCK_VIDEO_URLS.length];

export const getFallbackVideoUrl = (url?: string | null) =>
  url || MOCK_FALLBACK_VIDEO_URL;
