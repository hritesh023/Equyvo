// ---------------------------------------------------------------------------
// Equyvo language catalog — 70+ languages, Indian languages first-class.
// Every language renders the full app; UI strings missing from a language
// fall back to English automatically (see ./index.tsx), so no language is
// ever broken or half-rendered.
// ---------------------------------------------------------------------------

export interface LanguageDef {
  /** BCP-47 code used on <html lang> and in storage. */
  code: string;
  /** Endonym — what speakers call it (shown first in the picker). */
  native: string;
  /** English name (shown as secondary info + searchable). */
  english: string;
  /** Grouping in the Settings selector. */
  group: 'indian' | 'world';
  /** Right-to-left script? (document.dir flips to rtl automatically.) */
  rtl?: boolean;
}

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'equyvo_lang';

export const LANGUAGES: LanguageDef[] = [
  // --- India & South Asia -------------------------------------------------
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', group: 'indian' },
  { code: 'bn', native: 'বাংলা', english: 'Bengali', group: 'indian' },
  { code: 'mr', native: 'मराठी', english: 'Marathi', group: 'indian' },
  { code: 'ta', native: 'தமிழ்', english: 'Tamil', group: 'indian' },
  { code: 'te', native: 'తెలుగు', english: 'Telugu', group: 'indian' },
  { code: 'gu', native: 'ગુજરાતી', english: 'Gujarati', group: 'indian' },
  { code: 'kn', native: 'ಕನ್ನಡ', english: 'Kannada', group: 'indian' },
  { code: 'ml', native: 'മലയാളം', english: 'Malayalam', group: 'indian' },
  { code: 'pa', native: 'ਪੰਜਾਬੀ', english: 'Punjabi', group: 'indian' },
  { code: 'or', native: 'ଓଡ଼ିଆ', english: 'Odia', group: 'indian' },
  { code: 'as', native: 'অসমীয়া', english: 'Assamese', group: 'indian' },
  { code: 'ur', native: 'اردو', english: 'Urdu', group: 'indian', rtl: true },
  { code: 'sd', native: 'سنڌي', english: 'Sindhi', group: 'indian', rtl: true },
  { code: 'sa', native: 'संस्कृतम्', english: 'Sanskrit', group: 'indian' },
  { code: 'bho', native: 'भोजपुरी', english: 'Bhojpuri', group: 'indian' },
  { code: 'kok', native: 'कोंकणी', english: 'Konkani', group: 'indian' },
  { code: 'ne', native: 'नेपाली', english: 'Nepali', group: 'indian' },
  { code: 'si', native: 'සිංහල', english: 'Sinhala', group: 'indian' },

  // --- World --------------------------------------------------------------
  { code: 'en', native: 'English', english: 'English', group: 'world' },
  { code: 'es', native: 'Español', english: 'Spanish', group: 'world' },
  { code: 'fr', native: 'Français', english: 'French', group: 'world' },
  { code: 'de', native: 'Deutsch', english: 'German', group: 'world' },
  { code: 'pt', native: 'Português', english: 'Portuguese', group: 'world' },
  { code: 'it', native: 'Italiano', english: 'Italian', group: 'world' },
  { code: 'ca', native: 'Català', english: 'Catalan', group: 'world' },
  { code: 'ru', native: 'Русский', english: 'Russian', group: 'world' },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', group: 'world' },
  { code: 'pl', native: 'Polski', english: 'Polish', group: 'world' },
  { code: 'cs', native: 'Čeština', english: 'Czech', group: 'world' },
  { code: 'sk', native: 'Slovenčina', english: 'Slovak', group: 'world' },
  { code: 'sl', native: 'Slovenščina', english: 'Slovenian', group: 'world' },
  { code: 'hr', native: 'Hrvatski', english: 'Croatian', group: 'world' },
  { code: 'sr', native: 'Српски', english: 'Serbian', group: 'world' },
  { code: 'bg', native: 'Български', english: 'Bulgarian', group: 'world' },
  { code: 'ro', native: 'Română', english: 'Romanian', group: 'world' },
  { code: 'hu', native: 'Magyar', english: 'Hungarian', group: 'world' },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', group: 'world' },
  { code: 'nl', native: 'Nederlands', english: 'Dutch', group: 'world' },
  { code: 'sv', native: 'Svenska', english: 'Swedish', group: 'world' },
  { code: 'nb', native: 'Norsk', english: 'Norwegian', group: 'world' },
  { code: 'da', native: 'Dansk', english: 'Danish', group: 'world' },
  { code: 'fi', native: 'Suomi', english: 'Finnish', group: 'world' },
  { code: 'lt', native: 'Lietuvių', english: 'Lithuanian', group: 'world' },
  { code: 'lv', native: 'Latviešu', english: 'Latvian', group: 'world' },
  { code: 'et', native: 'Eesti', english: 'Estonian', group: 'world' },
  { code: 'ar', native: 'العربية', english: 'Arabic', group: 'world', rtl: true },
  { code: 'he', native: 'עברית', english: 'Hebrew', group: 'world', rtl: true },
  { code: 'fa', native: 'فارسی', english: 'Persian', group: 'world', rtl: true },
  { code: 'ps', native: 'پښتو', english: 'Pashto', group: 'world', rtl: true },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', group: 'world' },
  { code: 'az', native: 'Azərbaycan', english: 'Azerbaijani', group: 'world' },
  { code: 'ka', native: 'ქართული', english: 'Georgian', group: 'world' },
  { code: 'hy', native: 'Հայերեն', english: 'Armenian', group: 'world' },
  { code: 'kk', native: 'Қазақша', english: 'Kazakh', group: 'world' },
  { code: 'uz', native: 'Oʻzbekcha', english: 'Uzbek', group: 'world' },
  { code: 'mn', native: 'Монгол', english: 'Mongolian', group: 'world' },
  { code: 'zh-Hans', native: '简体中文', english: 'Chinese (Simplified)', group: 'world' },
  { code: 'zh-Hant', native: '繁體中文', english: 'Chinese (Traditional)', group: 'world' },
  { code: 'ja', native: '日本語', english: 'Japanese', group: 'world' },
  { code: 'ko', native: '한국어', english: 'Korean', group: 'world' },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', group: 'world' },
  { code: 'th', native: 'ไทย', english: 'Thai', group: 'world' },
  { code: 'my', native: 'မြန်မာ', english: 'Burmese', group: 'world' },
  { code: 'km', native: 'ខ្មែរ', english: 'Khmer', group: 'world' },
  { code: 'lo', native: 'ລາວ', english: 'Lao', group: 'world' },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', group: 'world' },
  { code: 'ms', native: 'Bahasa Melayu', english: 'Malay', group: 'world' },
  { code: 'tl', native: 'Filipino', english: 'Filipino', group: 'world' },
  { code: 'sw', native: 'Kiswahili', english: 'Swahili', group: 'world' },
  { code: 'am', native: 'አማርኛ', english: 'Amharic', group: 'world' },
  { code: 'ha', native: 'Hausa', english: 'Hausa', group: 'world' },
  { code: 'yo', native: 'Yorùbá', english: 'Yoruba', group: 'world' },
  { code: 'ig', native: 'Igbo', english: 'Igbo', group: 'world' },
  { code: 'af', native: 'Afrikaans', english: 'Afrikaans', group: 'world' },
  { code: 'zu', native: 'isiZulu', english: 'Zulu', group: 'world' },
];

export function isRtl(code: string): boolean {
  return !!LANGUAGES.find((l) => l.code === code)?.rtl;
}

export function languageLabel(code: string): string {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? `${l.native} (${l.english})` : code;
}
