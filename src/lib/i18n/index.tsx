// ---------------------------------------------------------------------------
// Equyvo i18n runtime.
//
// - 70+ languages (see ./languages.ts). Nav-level strings are translated for
//   every language; Settings- and chat-level strings additionally for the
//   major ones. Anything missing falls back to English automatically so no
//   language can ever render half-broken UI.
// - Language persists in localStorage, is applied instantly (no reload),
//   and drives <html lang> + <html dir> (RTL for Arabic, Hebrew, Farsi,
//   Pashto, Urdu, Sindhi).
// ---------------------------------------------------------------------------

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_STORAGE_KEY, isRtl } from './languages';

export type I18nDict = Record<string, string>;

/** Compact row column order — every language row below follows this. */
const CORE_ORDER = [
  'nav.home',
  'nav.discover',
  'nav.create',
  'nav.moments',
  'nav.thoughts',
  'nav.profile',
  'nav.settings',
  'nav.premium',
  'nav.chats',
  'nav.search',
  'action.follow',
  'action.message',
  'action.send',
  'action.save',
  'action.cancel',
  'action.signOut',
  'settings.language',
  'settings.languageDesc',
  'lang.searchPlaceholder',
  'settings.darkMode',
  'settings.languageNote',
  'common.error',
] as const;

// ---------------------------------------------------------------------------
// English base — complete dictionary (fallback for every language).
// ---------------------------------------------------------------------------
const EN: I18nDict = {
  'nav.home': 'Home',
  'nav.discover': 'Discover',
  'nav.create': 'Create',
  'nav.moments': 'Moments',
  'nav.thoughts': 'Thoughts',
  'nav.profile': 'Profile',
  'nav.settings': 'Settings',
  'nav.premium': 'Go Premium',
  'nav.chats': 'Chats',
  'nav.search': 'Search',
  'action.follow': 'Follow',
  'action.message': 'Message',
  'action.send': 'Send',
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign Out',
  'settings.language': 'Language',
  'settings.languageDesc': 'Choose your language',
  'lang.searchPlaceholder': 'Search languages…',
  'settings.darkMode': 'Dark Mode',
  'settings.languageNote': 'Sections not translated yet continue in English.',
  'common.error': 'Something went wrong',
  'settings.groupIndian': 'India & South Asia',
  'settings.groupWorld': 'World languages',
  'settings.privacy': 'Privacy & Security',
  'settings.notifications': 'Notifications',
  'settings.appearance': 'Appearance',
  'settings.account': 'Account',
  'settings.privateProfile': 'Private Profile',
  'settings.showEmail': 'Show Email',
  'settings.pushNotifications': 'Push Notifications',
  'settings.compactView': 'Compact View',
  'action.viewProfile': 'View Profile',
  'settings.contactSupport': 'Contact Support',
  'settings.deleteAccount': 'Delete Account',
  'chat.message': 'Message',
  'chat.noMessages': 'No messages yet',
  'feed.empty': 'Nothing here yet',
  'common.loading': 'Loading…',
  'action.ok': 'OK',
  'badge.verified': 'Verified',
  'pricing.choosePlan': 'Choose plan',
  'settings.personalizedAds': 'Personalized ads',
  'settings.goAdFree': 'Go ad-free',
  'action.seePlans': 'See plans',
  'common.signedOut': 'Signed out',
  'display.title': 'Text & Display',
  'display.desc': 'Text size and focused pinch-zoom for content',
  'display.fontSection': 'Text size',
  'display.fontDesc': 'Make everything across Equyvo smaller or larger',
  'display.fontSmall': 'Small',
  'display.fontNormal': 'Normal',
  'display.fontLarge': 'Large',
  'display.fontReset': 'Reset text size',
  'display.zoomSection': 'Pinch zoom',
  'display.zoomOn': 'Pinch to zoom focused content',
  'display.zoomOnDesc': 'Pinch two fingers on a card or content area to enlarge only that area; the header and navigation stay fixed',
  'display.antimistouch': 'Anti-mistouch',
  'display.antimistouchDesc': 'Only a firm, deliberate two-finger pinch changes zoom — quick accidental touches are ignored',
  'display.zoomLevel': 'Zoom level',
  'display.resetZoom': 'Reset zoom',
  'display.zoomNote': 'Focused zoom follows the area under your fingers. Header, navbar and fixed controls stay in place; use Reset zoom to restore all content.',
};

// ---------------------------------------------------------------------------
// Translation rows — one line per language, values follow CORE_ORDER.
// Empty slot → English fallback at runtime, so partial rows are safe.
// ---------------------------------------------------------------------------
 
const ROWS: Record<string, string[]> = {
  //   .---------------0 home
  //   |          .------------1 discover
  //   |          |          .------------2 create
  //   |          |          |        .----------3 moments
  //   |          |          |        |         .--------4 thoughts
  //   ▼          ▼          ▼        ▼         ▼         ▼ profile  settings premium  chats    search   follow   message  send     save     cancel   signOut  language languageDesc languageSearch darkMode languageNote error
  hi: ['होम', 'खोज', 'बनाएँ', 'मोमेंट्स', 'विचार', 'प्रोफ़ाइल', 'सेटिंग्स', 'प्रीमियम लें', 'चैट', 'खोजें', 'फ़ॉलो', 'संदेश', 'भेजें', 'सहेजें', 'रद्द करें', 'साइन आउट', 'भाषा', 'अपनी भाषा चुनें', 'भाषाएँ खोजें…', 'डार्क मोड', 'जो हिस्से अनुवादित नहीं हैं वे अंग्रेज़ी में दिखेंगे।', 'कुछ गड़बड़ हो गई'],
  bn: ['হোম', 'আবিষ্কার', 'তৈরি করুন', 'মোমেন্টস', 'ভাবনা', 'প্রোফাইল', 'সেটিংস', 'প্রিমিয়াম নিন', 'চ্যাট', 'অনুসন্ধান', 'অনুসরণ', 'মেসেজ', 'পাঠান', 'সংরক্ষণ', 'বাতিল', 'সাইন আউট', 'ভাষা', 'আপনার ভাষা নির্বাচন করুন', 'ভাষা খুঁজুন…', 'ডার্ক মোড', 'অনুবাদ হয়নি অংশ ইংরেজিতে দেখা যাবে।', 'কিছু ভুল হয়েছে'],
  mr: ['होम', 'शोध', 'तयार करा', 'मोमेंट्स', 'विचार', 'प्रोफाइल', 'सेटिंग्ज', 'प्रीमियम घ्या', 'चॅट', 'शोधा', 'फॉलो', 'संदेश', 'पाठवा', 'जतन करा', 'रद्द करा', 'साइन आउट', 'भाषा', 'तुमची भाषा निवडा', 'भाषा शोधा…', 'डार्क मोड', 'न भाषांतरित भाग इंग्रजीत दिसतील।', 'काहीतरी चूक झाले'],
  ta: ['முகப்பு', 'கண்டறிதல்', 'உருவாக்கு', 'மொமென்ட்ஸ்', 'எண்ணங்கள்', 'சுயவிவரம்', 'அமைப்புகள்', 'பிரீமியம் பெறுங்கள்', 'அரட்டைகள்', 'தேடல்', 'பின்தொடர்', 'செய்தி', 'அனுப்பு', 'சேமி', 'ரத்து', 'வெளியேறு', 'மொழி', 'உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்', 'மொழிகளைத் தேடுங்கள்…', 'டார்க் மோட்', 'மொழிபெயர்க்காத பகுதிகள் ஆங்கிலத்தில் தொடரும்.', 'ஏதோ தவறு நடந்தது'],
  te: ['హోమ్', 'కనుగొను', 'సృష్టించండి', 'మోమెంట్స్', 'ఆలోచనలు', 'ప్రొఫైల్', 'సెట్టింగ్‌లు', 'ప్రీమియం తీసుకోండి', 'చాట్‌లు', 'వెతకండి', 'ఫాలో', 'సందేశం', 'పంపండి', 'సేవ్ చేయండి', 'రద్దు చేయండి', 'సైన్ అవుట్', 'భాష', 'మీ భాషను ఎంచుకోండి', 'భాషలను వెతకండి…', 'డార్క్ మోడ్', 'అనువదించని భాగాలు ఇంగ్లీషులో కొనసాగుతాయి.', 'ఏదో తప్పు జరిగింది'],
  gu: ['હોમ', 'શોધ', 'બનાવો', 'મોમેન્ટ્સ', 'વિચારો', 'પ્રોફાઇલ', 'સેટિંગ્સ', 'પ્રીમિયમ લો', 'ચેટ', 'શોધો', 'ફોલો', 'સંદેશ', 'મોકલો', 'સાચવો', 'રદ કરો', 'સાઇન આઉટ', 'ભાષા', 'તમારી ભાષા પસંદ કરો', 'ભાષાઓ શોધો…', 'ડાર્ક મોડ', 'જે ભાગ અનુવાદિત નથી તે અંગ્રેજીમાં દેખાશે.', 'કંઈક ખોટું થયું'],
  kn: ['ಹೋಮ್', 'ಹುಡುಕು', 'ರಚಿಸಿ', 'ಮೊಮೆಂಟ್ಸ್', 'ಚಿಂತನೆಗಳು', 'ಪ್ರೊಫೈಲ್', 'ಸೆಟ್ಟಿಂಗ್‌ಗಳು', 'ಪ್ರೀಮಿಯಂ ಪಡೆಯಿರಿ', 'ಚಾಟ್‌ಗಳು', 'ಹುಡುಕಾಡು', 'ಫಾಲೋ', 'ಸಂದೇಶ', 'ಕಳುಹಿಸಿ', 'ಉಳಿಸಿ', 'ರದ್ದುಮಾಡಿ', 'ಸೈನ್ ಔಟ್', 'ಭಾಷೆ', 'ನಿಮ್ಮ ಭಾಷೆಯನ್ನು ಆರಿಸಿ', 'ಭಾಷೆಗಳನ್ನು ಹುಡುಕಿ…', 'ಡಾರ್ಕ್ ಮೋಡ್', 'ಅನುವಾದವಾಗದ ಭಾಗಗಳು ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ ಮುಂದುವರಿಯುತ್ತವೆ.', 'ಏನೋ ತಪ್ಪಾಗಿದೆ'],
  ml: ['ഹോം', 'കണ്ടെത്തുക', 'സൃഷ്ടിക്കുക', 'മോമെന്റ്സ്', 'ചിന്തകൾ', 'പ്രൊഫൈൽ', 'സെറ്റിംഗ്സ്', 'പ്രീമിയം എടുക്കുക', 'ചാറ്റുകൾ', 'തിരയുക', 'ഫോളോ', 'സന്ദേശം', 'അയക്കുക', 'സേവ് ചെയ്യുക', 'റദ്ദാക്കുക', 'സൈൻ ഔട്ട്', 'ഭാഷ', 'നിങ്ങളുടെ ഭാഷ തിരഞ്ഞെടുക്കുക', 'ഭാഷകൾ തിരയുക…', 'ഡാർക്ക് മോഡ്', 'വിവർത്തനം ചെയ്യാത്ത ഭാഗങ്ങൾ ഇംഗ്ലീഷിൽ തുടരും.', 'എന്തോ തെറ്റായി'],
  pa: ['ਹੋਮ', 'ਖੋਜ', 'ਬਣਾਓ', 'ਮੋਮੈਂਟਸ', 'ਵਿਚਾਰ', 'ਪ੍ਰੋਫਾਈਲ', 'ਸੈਟਿੰਗਾਂ', 'ਪ੍ਰੀਮੀਅਮ ਲਵੋ', 'ਚੈਟ', 'ਖੋਜੋ', 'ਫਾਲੋ', 'ਸੁਨੇਹਾ', 'ਭੇਜੋ', 'ਸੰਭਾਲੋ', 'ਰੱਦ ਕਰੋ', 'ਸਾਈਨ ਆਉਟ', 'ਭਾਸ਼ਾ', 'ਆਪਣੀ ਭਾਸ਼ਾ ਚੁਣੋ', 'ਭਾਸ਼ਾਵਾਂ ਖੋਜੋ…', 'ਡਾਰਕ ਮੋਡ', 'ਜੋ ਹਿੱਸੇ ਅਨੁਵਾਦਿਤ ਨਹੀਂ ਉਹ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਦਿਖਣਗੇ।', 'ਕੁਝ ਗਲਤ ਹੋ ਗਿਆ'],
  or: ['ହୋମ', 'ଆବିଷ୍କାର', 'ସୃଷ୍ଟି କରନ୍ତୁ', 'ମୋମେଣ୍ଟସ୍', 'ଚିନ୍ତାଧାରା', 'ପ୍ରୋଫାଇଲ୍', 'ସେଟିଂ', 'ପ୍ରିମିୟମ୍ ନିଅନ୍ତୁ', 'ଚାଟ୍', 'ଖୋଜନ୍ତୁ', 'ଅନୁସରଣ', 'ମେସେଜ', 'ପଠାନ୍ତୁ', 'ସେଭ୍ କରନ୍ତୁ', 'ବାତିଲ କରନ୍ତୁ', 'ସାଇନ୍ ଆଉଟ୍', 'ଭାଷା', 'ନିଜ ଭାଷା ବାଛନ୍ତୁ', 'ଭାଷା ଖୋଜନ୍ତୁ…', 'ଡାର୍କ ମୋଡ୍', 'ଅନୁବାଦ ହୋଇନଥିବା ଅଂଶ ଇଂରାଜୀରେ ଦେଖାଯିବ।', 'କିଛି ଭୁଲ ହୋଇଛି'],
  as: ['ঘৰ', 'আৱিষ্কাৰ', 'সৃষ্টি কৰক', 'ম’মেণ্টছ', 'চিন্তা', 'প্ৰফাইল', 'ছেটিংছ', 'প্ৰিমিয়াম লওক', 'চেট', 'সন্ধান কৰক', 'অনুসৰণ', 'বাৰ্তা', 'পঠিয়াওক', 'ছেভ কৰক', 'বাতিল', 'ছাইন আউট', 'ভাষা', 'আপোনাৰ ভাষা বাছনি কৰক', 'ভাষা সন্ধান কৰক…', 'ডাৰ্ক মোড', 'অনুবাদ নোহোৱা অংশ ইংৰাজীত দেখা যাব।', 'অলপ ভুল হ’ল'],
  ur: ['ہوم', 'دریافت', 'بنائیں', 'لمحے', 'خیالات', 'پروفائل', 'ترتیبات', 'پریمیئم لیں', 'چیٹس', 'تلاش', 'فالو', 'پیغام', 'بھیجیں', 'محفوظ کریں', 'منسوخ', 'سائن آؤٹ', 'زبان', 'اپنی زبان منتخب کریں', 'زبانیں تلاش کریں…', 'ڈارک موڈ', 'ان حصوں کا انگریزی میں ظہور جاری رہے گا۔', 'کچھ غلط ہو گیا'],
  sd: ['گهر', 'ڳول', 'بڻايو', 'لمحا', 'خيال', 'پروفائل', 'سيٽنگون', 'پريميم وٺو', 'چيٽ', 'ڳوليو', 'فالو', 'پيغام', 'موکيو', 'محفوظ', 'رد', 'سائن آئوٽ', 'ٻولي', 'پنهنجي ٻولي چونڊيو', 'ٻوليون ڳوليو…', 'ڊارڪ موڊ', 'جيڪي حصا ترجمو ٿيل ناهن اهي انگريزي ۾ هوندا.', 'ڪجهه غلط ٿيو'],
  sa: ['गृहम्', 'अन्वेषणम्', 'निर्माणम्', 'क्षणाः', 'विचाराः', 'प्रोफ़ाइल', 'विन्यासाः', 'प्रीमियम्', 'संवादाः', 'अन्विष्यताम्', 'अनुसरणम्', 'संदेशः', 'प्रेषयतु', 'संरक्ष्यताम्', 'निरस्यताम्', 'निर्गच्छतु', 'भाषा', 'भवतः भाषां वृणुत', 'भाषाः अन्विष्यताम्…', 'अंधकारप्रकारः', 'अणुवादहीनाः भागाः आङ्ग्लभाषायां भविष्यन्ति।', 'किञ्चित् दोषः अभवत्'],
  bho: ['घर', 'खोज', 'बनाईं', 'मोमेंटस', 'विचार', 'प्रोफाइल', 'सेटिंग', 'प्रीमियम लीं', 'चैट', 'खोजीं', 'फॉलो', 'संदेश', 'भेजीं', 'सहेजीं', 'रद्द करीं', 'साइन आउट', 'भाषा', 'आपन भाषा चुनीं', 'भाषा खोजीं…', 'डार्क मोड', 'जे हिस्सा अनुवादित बा ना ऊ अंग्रेजी में देखाई।', 'कछू गलत हो गई'],
  kok: ['घर', 'सोद', 'तयार करचें', 'मोमेंट्स', 'विचार', 'प्रोफायल', 'सेटिंग्स', 'प्रीमियम घेचें', 'चॅट', 'सोदचें', 'फॉलो', 'संदेश', 'धाडचें', 'सांबाळचें', 'खोशी करचें', 'सायन आउट', 'भास', 'तुमची भास निवडची', 'भासो सोदच्यो…', 'डार्क मोड', 'अणकार जाळोल्ले विभाग इंग्लीशींत दिसतले।', 'कित्येक गरत जालें'],
  ne: ['गृह', 'खोज', 'बनाउनुहोस्', 'मोमेन्टहरू', 'विचारहरू', 'प्रोफाइल', 'सेटिङ', 'प्रिमियम लिनुहोस्', 'च्याट', 'खोज्नुहोस्', 'फलो', 'सन्देश', 'पठाउनुहोस्', 'सुरक्षित गर्नुहोस्', 'रद्द गर्नुहोस्', 'साइन आउट', 'भाषा', 'आफ्नो भाषा छान्नुहोस्', 'भाषा खोज्नुहोस्…', 'डार्क मोड', 'अनुवाद नभएका भागहरू अंग्रेजीमा देखिनेछन्।', 'केही गडबड भयो'],
  si: ['මුල් පිටුව', 'සොයා ගන්න', 'සාදන්න', 'මොමන්ට්ස්', 'සිතුවිලි', 'පැතිකඩ', 'සැකසුම්', 'ප්‍රීමියම් ගන්න', 'චැට්', 'සොයන්න', 'පසුපස', 'පණිවිඩය', 'යවන්න', 'සුරකින්න', 'අවලංගු කරන්න', 'ඉවත්වන්න', 'භාෂාව', 'ඔබේ භාෂාව තෝරන්න', 'භාෂා සොයන්න…', 'අඳුරු ප්‍රකාරය', 'පරිවර්තනය නොකළ කොටස් ඉංග්‍රීසියෙන් පෙනේ.', 'යමක් වැරදී ඇත'],
  es: ['Inicio', 'Descubrir', 'Crear', 'Momentos', 'Pensamientos', 'Perfil', 'Ajustes', 'Hacerse Premium', 'Chats', 'Buscar', 'Seguir', 'Mensaje', 'Enviar', 'Guardar', 'Cancelar', 'Cerrar sesión', 'Idioma', 'Elige tu idioma', 'Buscar idiomas…', 'Modo oscuro', 'Las secciones sin traducir se muestran en inglés.', 'Algo salió mal'],
  fr: ['Accueil', 'Découvrir', 'Créer', 'Moments', 'Pensées', 'Profil', 'Paramètres', 'Passer Premium', 'Discussions', 'Rechercher', 'Suivre', 'Message', 'Envoyer', 'Enregistrer', 'Annuler', 'Se déconnecter', 'Langue', 'Choisissez votre langue', 'Rechercher des langues…', 'Mode sombre', 'Les sections non traduites restent en anglais.', 'Une erreur est survenue'],
  de: ['Start', 'Entdecken', 'Erstellen', 'Moments', 'Gedanken', 'Profil', 'Einstellungen', 'Premium holen', 'Chats', 'Suchen', 'Folgen', 'Nachricht', 'Senden', 'Speichern', 'Abbrechen', 'Abmelden', 'Sprache', 'Sprache wählen', 'Sprachen suchen…', 'Dunkelmodus', 'Nicht übersetzte Bereiche erscheinen auf Englisch.', 'Etwas ist schiefgelaufen'],
  pt: ['Início', 'Descobrir', 'Criar', 'Momentos', 'Pensamentos', 'Perfil', 'Configurações', 'Assinar Premium', 'Chats', 'Buscar', 'Seguir', 'Mensagem', 'Enviar', 'Salvar', 'Cancelar', 'Sair', 'Idioma', 'Escolha seu idioma', 'Buscar idiomas…', 'Modo escuro', 'Seções não traduzidas continuam em inglês.', 'Algo deu errado'],
  it: ['Home', 'Scopri', 'Crea', 'Momenti', 'Pensieri', 'Profilo', 'Impostazioni', 'Passa a Premium', 'Chat', 'Cerca', 'Segui', 'Messaggio', 'Invia', 'Salva', 'Annulla', 'Esci', 'Lingua', 'Scegli la tua lingua', 'Cerca lingue…', 'Modalità scura', 'Le sezioni non tradotte restano in inglese.', 'Si è verificato un errore'],
  ca: ['Inici', 'Descobreix', 'Crea', 'Moments', 'Pensaments', 'Perfil', 'Configuració', 'Fes-te Premium', 'Xats', 'Cerca', 'Segueix', 'Missatge', 'Envia', 'Desa', 'Cancel·la', 'Tanca la sessió', 'Idioma', 'Tria el teu idioma', 'Cerca idiomes…', 'Mode fosc', 'Les seccions no traduïdes queden en anglès.', 'Alguna cosa ha fallat'],
  ru: ['Главная', 'Обзор', 'Создать', 'Моменты', 'Мысли', 'Профиль', 'Настройки', 'Получить Премиум', 'Чаты', 'Поиск', 'Подписаться', 'Сообщение', 'Отправить', 'Сохранить', 'Отмена', 'Выйти', 'Язык', 'Выберите язык', 'Поиск языков…', 'Тёмный режим', 'Непереведённые разделы отображаются на английском.', 'Что-то пошло не так'],
  uk: ['Головна', 'Огляд', 'Створити', 'Моменти', 'Думки', 'Профіль', 'Налаштування', 'Оформити Преміум', 'Чати', 'Пошук', 'Підписатися', 'Повідомлення', 'Надіслати', 'Зберегти', 'Скасувати', 'Вийти', 'Мова', 'Виберіть мову', 'Пошук мов…', 'Темний режим', 'Неперекладені розділи — англійською.', 'Щось пішло не так'],
  pl: ['Start', 'Odkrywaj', 'Utwórz', 'Momenty', 'Myśli', 'Profil', 'Ustawienia', 'Wesprzyj Premium', 'Czaty', 'Szukaj', 'Obserwuj', 'Wiadomość', 'Wyślij', 'Zapisz', 'Anuluj', 'Wyloguj się', 'Język', 'Wybierz język', 'Szukaj języków…', 'Tryb ciemny', 'Nieprzetłumaczone sekcje pozostają po angielsku.', 'Coś poszło nie tak'],
  cs: ['Domů', 'Objevit', 'Vytvořit', 'Okamžiky', 'Myšlenky', 'Profil', 'Nastavení', 'Získat Premium', 'Chaty', 'Hledat', 'Sledovat', 'Zpráva', 'Odeslat', 'Uložit', 'Zrušit', 'Odhlásit se', 'Jazyk', 'Vyberte jazyk', 'Hledat jazyky…', 'Tmavý režim', 'Nepřeložené části zůstávají anglicky.', 'Něco se pokazilo'],
  sk: ['Domov', 'Objaviť', 'Vytvoriť', 'Okamihy', 'Myšlienky', 'Profil', 'Nastavenia', 'Získať Premium', 'Chaty', 'Hľadať', 'Sledovať', 'Správa', 'Odoslať', 'Uložiť', 'Zrušiť', 'Odhlásiť sa', 'Jazyk', 'Vyberte jazyk', 'Hľadať jazyky…', 'Tmavý režim', 'Nepreložené časti zostávajú po anglicky.', 'Niečo sa pokazilo'],
  sl: ['Dom', 'Odkrij', 'Ustvari', 'Trenutki', 'Misle', 'Profil', 'Nastavitve', 'Pridobi Premium', 'Klepet', 'Iskanje', 'Sledi', 'Sporočilo', 'Pošlji', 'Shrani', 'Prekliči', 'Odjava', 'Jezik', 'Izberi jezik', 'Iskanje jezikov…', 'Temen način', 'Neprevedeni deli ostanejo v angleščini.', 'Nekaj je šlo narobe'],
  hr: ['Početna', 'Otkrij', 'Stvori', 'Trenuci', 'Misli', 'Profil', 'Postavke', 'Premium', 'Razgovori', 'Traži', 'Prati', 'Poruka', 'Pošalji', 'Spremi', 'Odustani', 'Odjava', 'Jezik', 'Odaberi jezik', 'Traži jezike…', 'Tamni način', 'Neprevedeni dijelovi ostaju na engleskom.', 'Nešto nije uspjelo'],
  sr: ['Почетна', 'Откриј', 'Направи', 'Тренуци', 'Мисли', 'Профил', 'Подешавања', 'Надогради на Премиум', 'Ћаскања', 'Претрага', 'Запрати', 'Порука', 'Пошаљи', 'Сачувај', 'Откажи', 'Одјава', 'Језик', 'Одаберите језик', 'Претражи језике…', 'Тамни режим', 'Непреведени делови остају на енглеском.', 'Нешто није успело'],
  bg: ['Начало', 'Открий', 'Създай', 'Моменти', 'Мисли', 'Профил', 'Настройки', 'Премиум', 'Чатове', 'Търсене', 'Последвай', 'Съобщение', 'Изпращай', 'Запази', 'Отмени', 'Изход', 'Език', 'Избери език', 'Търсене на езици…', 'Тъмен режим', 'Непреведените части остават на английски.', 'Нещо се провали'],
  ro: ['Acasă', 'Descoperă', 'Creează', 'Momente', 'Gânduri', 'Profil', 'Setări', 'Fă upgrade Premium', 'Discuții', 'Caută', 'Urmărește', 'Mesaj', 'Trimite', 'Salvează', 'Anulează', 'Deconectare', 'Limbă', 'Alege limba', 'Caută limbi…', 'Mod întunecat', 'Secțiunile netraduse rămân în engleză.', 'Ceva n-a mers'],
  hu: ['Kezdőlap', 'Felfedezés', 'Létrehozás', 'Pillanatok', 'Gondolatok', 'Profil', 'Beállítások', 'Premium megvétele', 'Beszélgetések', 'Keresés', 'Követés', 'Üzenet', 'Küldés', 'Mentés', 'Mégse', 'Kijelentkezés', 'Nyelv', 'Válassz nyelvet', 'Nyelvek keresése…', 'Sötét mód', 'A lefordítatlan részek angolul jelennek meg.', 'Hiba történt'],
  el: ['Αρχή', 'Εξερεύνηση', 'Δημιουργία', 'Στιγμές', 'Σκέψεις', 'Προφίλ', 'Ρυθμίσεις', 'Λήψη Premium', 'Συνομιλίες', 'Αναζήτηση', 'Ακολούθηση', 'Μήνυμα', 'Αποστολή', 'Αποθήκευση', 'Άκυρο', 'Αποσύνδεση', 'Γλώσσα', 'Διάλεξε γλώσσα', 'Αναζήτηση γλωσσών…', 'Σκοτεινή λειτουργία', 'Οι αμετάφραστες ενότητες εμφανίζονται στα αγγλικά.', 'Κάτι πήγε στραβά'],
  nl: ['Start', 'Ontdekken', 'Maken', 'Momenten', 'Gedachten', 'Profiel', 'Instellingen', 'Premium nemen', 'Chats', 'Zoeken', 'Volgen', 'Bericht', 'Versturen', 'Opslaan', 'Annuleren', 'Uitloggen', 'Taal', 'Kies je taal', 'Talen zoeken…', 'Donkere modus', 'Niet-vertaalde delen blijven Engels.', 'Er ging iets mis'],
  sv: ['Hem', 'Utforska', 'Skapa', 'Ögonblick', 'Tankar', 'Profil', 'Inställningar', 'Skaffa Premium', 'Chattar', 'Sök', 'Följ', 'Meddelande', 'Skicka', 'Spara', 'Avbryt', 'Logga ut', 'Språk', 'Välj språk', 'Sök språk…', 'Mörkt läge', 'Oöversatta delar visas på engelska.', 'Något gick fel'],
  nb: ['Hjem', 'Utforsk', 'Opprett', 'Øyeblikk', 'Tanke', 'Profil', 'Innstillinger', 'Skaff Premium', 'Chatter', 'Søk', 'Følg', 'Melding', 'Send', 'Lagre', 'Avbryt', 'Logg ut', 'Språk', 'Velg språk', 'Søk språk…', 'Mørk modus', 'Uoversatte deler vises på engelsk.', 'Noe gikk galt'],
  da: ['Hjem', 'Opdag', 'Opret', 'Øjeblikke', 'Tanker', 'Profil', 'Indstillinger', 'Få Premium', 'Chats', 'Søg', 'Følg', 'Besked', 'Send', 'Gem', 'Annuller', 'Log ud', 'Sprog', 'Vælg dit sprog', 'Søg sprog…', 'Mørk tilstand', 'Uoversatte dele vises på engelsk.', 'Noget gik galt'],
  fi: ['Koti', 'Tutki', 'Luo', 'Hetket', 'Ajatukset', 'Profiili', 'Asetukset', 'Osta Premium', 'Chattit', 'Hae', 'Seuraa', 'Viesti', 'Lähetä', 'Tallenna', 'Peruuta', 'Kirjaudu ulos', 'Kieli', 'Valitse kieli', 'Hae kieliä…', 'Tumma tila', 'Kääntämättömät osat näkyvät englanniksi.', 'Jokin meni pieleen'],
  lt: ['Pradžia', 'Atrask', 'Kurti', 'Momentas', 'Mintys', 'Profilis', 'Nustatymai', 'Naudotis Premium', 'Pokalbiai', 'Ieškoti', 'Sekti', 'Žinutė', 'Siųsti', 'Išsaugoti', 'Atšaukti', 'Atsijungti', 'Kalba', 'Pasirink kalbą', 'Ieškoti kalbų…', 'Tamsus režimas', 'Neišverstos dalys lieka angliškai.', 'Kažkas nepavyko'],
  lv: ['Sākums', 'Atklāt', 'Izveidot', 'Brīži', 'Domāšanas', 'Profils', 'Iestatījumi', 'Iegūt Premium', 'Sarunas', 'Meklēt', 'Sekot', 'Ziņa', 'Sūtīt', 'Saglabāt', 'Atcelt', 'Iziet', 'Valoda', 'Izvēlies valodu', 'Meklēt valodas…', 'Tumšais režīms', 'Netulkotās daļas paliek angļu valodā.', 'Kaut kas nogāja greizi'],
  et: ['Avaleht', 'Avasta', 'Loo', 'Hetked', 'Mõtted', 'Profiil', 'Seaded', 'Hankige Premium', 'Vestlused', 'Otsi', 'Jälgi', 'Sõnum', 'Saada', 'Salvesta', 'Tühista', 'Logi välja', 'Keel', 'Vali oma keel', 'Otsi keeli…', 'Tume režiim', 'Tõlkimata osad jäävad inglise keelde.', 'Midagi läks valesti'],
  ar: ['الرئيسية', 'استكشاف', 'إنشاء', 'لحظات', 'أفكار', 'الملف الشخصي', 'الإعدادات', 'احصل على بريميوم', 'المحادثات', 'بحث', 'متابعة', 'رسالة', 'إرسال', 'حفظ', 'إلغاء', 'تسجيل الخروج', 'اللغة', 'اختر لغتك', 'ابحث عن اللغات…', 'الوضع الليلي', 'الأقسام غير المترجمة تبقى بالإنجليزية.', 'حدث خطأ ما'],
  he: ['בית', 'גילוי', 'צור', 'רגעים', 'מחשבות', 'פרופיל', 'הגדרות', 'שדרג לפרימיום', 'צ׳אטים', 'חיפוש', 'עקוב', 'הודעה', 'שלח', 'שמור', 'בטל', 'התנתקות', 'שפה', 'בחר את השפה שלך', 'חפש שפות…', 'מצב כהה', 'קטעים שלא תורגמו יישארו באנגלית.', 'משהו השתבש'],
  fa: ['خانه', 'کشف کردن', 'ایجاد', 'لحظه‌ها', 'اندیشه‌ها', 'نمایه', 'تنظیمات', 'گرفتن پرمیوم', 'گفتگوها', 'جستجو', 'دنبال کردن', 'پیام', 'ارسال', 'ذخیره', 'لغو', 'خروج', 'زبان', 'زبان خود را انتخاب کنید', 'جستجوی زبان‌ها…', 'حالت تاریک', 'بخش‌های ترجمه‌نشده به انگلیسی می‌مانند.', 'مشکلی پیش آمد'],
  ps: ['کور', 'پلټنه', 'جوړول', 'شېبې', 'فکرونه', 'پروفایل', 'امستندنې', 'پریمیم ترلاسه کړه', 'چټونه', 'لټونه', 'تعقیب', 'پیغام', 'لېږل', 'ساتل', 'لغوه کول', 'وتل', 'ژبه', 'خپله ژبه وټاکه', 'ژبې ولټوه…', 'تور حالت', 'ژباړل شوي نه برخې انګلیسي پاتې کېږي.', 'هڅه ناکامه شوه'],
  tr: ['Ana Sayfa', 'Keşfet', 'Oluştur', 'Anlar', 'Düşünceler', 'Profil', 'Ayarlar', 'Premium Al', 'Sohbetler', 'Ara', 'Takip et', 'Mesaj', 'Gönder', 'Kaydet', 'İptal', 'Çıkış yap', 'Dil', 'Dilini seç', 'Dilleri ara…', 'Karanlık mod', 'Çevrilmemiş bölümler İngilizce kalır.', 'Bir şeyler ters gitti'],
  az: ['Ev', 'Kəşf', 'Yarat', 'Anlar', 'Fikirlər', 'Profil', 'Parametrlər', 'Premium Al', 'Çatlar', 'Axtar', 'İzlə', 'Mesaj', 'Göndər', 'Saxla', 'Ləğv et', 'Çıxış', 'Dil', 'Dilini seç', 'Dilləri axtar…', 'Tünd rejim', 'Tərcümə olunmayan hissələr ingiliscə qalır.', 'Xəta baş verdi'],
  ka: ['მთავარი', 'აღმოჩენა', 'შექმნა', 'მომენტები', 'აზრები', 'პროფილი', 'პარამეტრები', 'პრემიუმის მიღება', 'ჩატები', 'ძიება', 'გამოყოლა', 'შეტყობინება', 'გაგზავნა', 'შენახვა', 'გაუქმება', 'გასვლა', 'ენა', 'აირჩიე ენა', 'ენების ძიება…', 'ბნელი რეჟიმი', 'უთარგმნელი ნაწილები ინგლისურად ჩნდება.', 'რაღაც ჩავარდა'],
  hy: ['Գլխավոր', 'Բացահայտել', 'Ստեղծել', 'Պահեստներ', 'Մտքեր', 'Պրոֆիլ', 'Կարգավորումներ', 'Ստանալ Premium', 'Չատեր', 'Որոնել', 'Հետևել', 'Հաղորդագրություն', 'Ուղարկել', 'Պահպանել', 'Չեղարկել', 'Ելք', 'Լեզու', 'Ընտրեք ձեր լեզուն', 'Որոնել լեզուներ…', 'Մութ ռեժիմ', 'չթարգմանված մասերն անգլերեն կմնան։', 'Ինչ-որ խնդիր առաջացավ'],
  kk: ['Басты бет', 'Ашу', 'Жасау', 'Сәттер', 'Ойлар', 'Профиль', 'Параметрлер', 'Премиум алу', 'Чаттар', 'Іздеу', 'Жазылу', 'Хабарлама', 'Жіберу', 'Сақтау', 'Болдырмау', 'Шығу', 'Тіл', 'Тіліңізді таңдаңыз', 'Тілдер іздеу…', 'Қараңғы режим', 'Аудармаусыз бөлімдер ағылшынша көрінеді.', 'Бірдеңе дұрыс болмады'],
  uz: ['Asosiy', 'Kashf etish', 'Yaratish', 'Lahzalar', 'Fikrlar', 'Profil', 'Sozlamalar', 'Premium olish', 'Chatlar', 'Qidirish', 'Kuzatish', 'Xabar', 'Yuborish', 'Saqlash', 'Bekor qilish', 'Chiqish', 'Til', 'Tilingizni tanlang', 'Til qidirish…', 'Qorongʻi rejim', 'Tarjima qilinmagan qismlar inglizcha koʻrinadi.', 'Xatolik yuz berdi'],
  mn: ['Нүүр', 'Илрүүлэх', 'Үүсгэх', 'Моментус', 'Бодол', 'Профайл', 'Тохиргоо', 'Премиум авах', 'Чатууд', 'Хайх', 'Дагах', 'Зурвас', 'Илгээх', 'Хадгалах', 'Цуцлах', 'Гарах', 'Хэл', 'Хэлээ сонгох', 'Хэл хайх…', 'Харанхуй горим', 'Орчуулаагүй хэсэг англиар харагдана.', 'Алдаа гарлаа'],
  'zh-Hans': ['首页', '发现', '创建', '瞬间', '想法', '个人资料', '设置', '开通高级版', '聊天', '搜索', '关注', '消息', '发送', '保存', '取消', '退出登录', '语言', '选择你的语言', '搜索语言…', '深色模式', '未翻译的部分将显示英文。', '出错了'],
  'zh-Hant': ['首頁', '探索', '建立', '瞬間', '想法', '個人資料', '設定', '開通高級版', '聊天', '搜尋', '追蹤', '訊息', '傳送', '儲存', '取消', '登出', '語言', '選擇你的語言', '搜尋語言…', '深色模式', '未翻譯的部分將顯示英文。', '發生錯誤'],
  ja: ['ホーム', '見つける', '作成', 'モーメンツ', '思考', 'プロフィール', '設定', 'プレミアム', 'チャット', '検索', 'フォロー', 'メッセージ', '送信', '保存', 'キャンセル', 'ログアウト', '言語', '言語を選択', '言語を検索…', 'ダークモード', '未翻訳の部分は英語で表示されます。', 'エラーが発生しました'],
  ko: ['홈', '탐색', '만들기', '순간', '생각', '프로필', '설정', '프리미엄', '채팅', '검색', '팔로우', '메시지', '보내기', '저장', '취소', '로그아웃', '언어', '언어를 선택하세요', '언어 검색…', '다크 모드', '번역되지 않은 부분은 영어로 표시됩니다.', '문제가 발생했습니다'],
  vi: ['Trang chủ', 'Khám phá', 'Tạo', 'Khoảnh khắc', 'Suy nghĩ', 'Hồ sơ', 'Cài đặt', 'Nâng cấp Premium', 'Trò chuyện', 'Tìm kiếm', 'Theo dõi', 'Tin nhắn', 'Gửi', 'Lưu', 'Hủy', 'Đăng xuất', 'Ngôn ngữ', 'Chọn ngôn ngữ', 'Tìm ngôn ngữ…', 'Chế độ tối', 'Phần chưa dịch sẽ hiển thị tiếng Anh.', 'Đã xảy ra lỗi'],
  th: ['หน้าแรก', 'สำรวจ', 'สร้าง', 'ช่วงเวลา', 'ความคิด', 'โปรไฟล์', 'การตั้งค่า', 'อัปเกรดพรีเมียม', 'แชท', 'ค้นหา', 'ติดตาม', 'ข้อความ', 'ส่ง', 'บันทึก', 'ยกเลิก', 'ออกจากระบบ', 'ภาษา', 'เลือกภาษาของคุณ', 'ค้นหาภาษา…', 'โหมดมืด', 'ส่วนที่ยังไม่แปลจะเป็นภาษาอังกฤษ', 'มีบางอย่างผิดพลาด'],
  my: ['ပင်မ', 'ရှာဖွေတို့လ်', 'ဖန်တီးမည်', 'အခိုက်အတန့်', 'စဉ်းစားချက်', 'ပရိုဖိုင်', 'ဆက်တင်များ', 'ပရီမီယမ်ရယူ', 'ချတ်များ', 'ရှာဖွေ', 'ဆက်နော်', 'စာတို', 'ပို့မည်', 'သိမ်းဆည်း', 'ဖျက်သိမ်း', 'ထွက်မည်', 'ဘာသာစကား', 'သင့်ဘာသာရွေး', 'ဘာသာရှာ…', 'အမှောင်မုဒ်', 'မတည်းဖြတ်ရသောအပိုင်းများ အင်္ဂလိပ်ဖြင့်ပါဝင်သည်', 'တစ်ခုခုမှားယွင်းသည်'],
  km: ['ទំព័រដើម', 'រកឃើញ', 'បង្កើត', 'ពេលវេលា', 'គំនិត', 'ប្រវត្តិរូប', 'ការកំណត់', 'ទទួលព្រីមីយ៉ូម', 'ជជែក', 'ស្វែងរក', 'តាមដាន', 'សារ', 'ផ្ញើ', 'រក្សាទុក', 'បោះបង់', 'ចេញ', 'ភាសា', 'ជ្រើសភាសារបស់អ្នក', 'ស្វែងរកភាសា…', 'ផ្ទាំងងងឹត', 'ផ្នែកដែលមិនបានបកប្រែនឹងបង្ហាញជាអង់គ្លេស។', 'មានបញ្ហាបានកើតឡើង'],
  lo: ['ໜ້າຫຼັກ', 'ຄົ້ນພົບ', 'ສ້າງ', 'ເວລາດີ', 'ຄວາມຄິດ', 'ໂປຣໄຟລ໌', 'ການຕັ້ງຄ່າ', 'ໄດ້ພຼີເມຍມ', 'ແຊັດ', 'ຄົ້ນຫາ', 'ຕິດຕາມ', 'ຂໍ້ຄວາມ', 'ສົ່ງ', 'ບັນທຶກ', 'ຍົກເລີກ', 'ອອກຈາກລະບົບ', 'ພາສາ', 'ເລືອກພາສາຂອງເຈົ້າ', 'ຄົ້ນຫາພາສາ…', 'ໂໝດມືດ', 'ພາກທີ່ບໍ່ແປຈະສະແດງເປັນອັງກິດ', 'ມີບາງຢ່າງຜິດພາດ'],
  id: ['Beranda', 'Temukan', 'Buat', 'Momen', 'Pemikiran', 'Profil', 'Pengaturan', 'Klaim Premium', 'Obrolan', 'Cari', 'Ikuti', 'Pesan', 'Kirim', 'Simpan', 'Batal', 'Keluar', 'Bahasa', 'Pilih bahasamu', 'Cari bahasa…', 'Mode gelap', 'Bagian yang belum diterjemahkan tampil dalam Inggris.', 'Terjadi kesalahan'],
  ms: ['Utama', 'Terokai', 'Cipta', 'Detik', 'Pemikiran', 'Profil', 'Tetapan', 'Dapat Premium', 'Sembang', 'Cari', 'Ikut', 'Mesej', 'Hantar', 'Simpan', 'Batal', 'Log keluar', 'Bahasa', 'Pilih bahasa anda', 'Cari bahasa…', 'Mod gelap', 'Bahagian belum diterjemah kekal dalam Inggeris.', 'Sesuatu salah berlaku'],
  tl: ['Home', 'Tuklasin', 'Gumawa', 'Sandali', 'Isipin', 'Profile', 'Mga Setting', 'Kumuha ng Premium', 'Mga Chat', 'Maghanap', 'Sundan', 'Mensahe', 'Ipadala', 'I-save', 'Kanselahin', 'Mag-sign out', 'Wika', 'Piliin ang wika mo', 'Maghanap ng wika…', 'Dark mode', 'Ang hindi pa isalin na bahagi ay nasa Ingles.', 'May naging mali'],
  sw: ['Nyumbani', 'Gundua', 'Unda', 'Matukio', 'Wazo', 'Wasifu', 'Mipangilio', 'Pata Premium', 'Mazungumzo', 'Tafuta', 'Fuatilia', 'Ujumbe', 'Tuma', 'Hifadhi', 'Ghairi', 'Toka', 'Lugha', 'Chagua lugha yako', 'Tafuta lugha…', 'Hali ya giza', 'Sehemu zisizotafsiriwa huendelea kwa Kiingereza.', 'Kuna kilichoharibika'],
  am: ['ሆም', 'መርምር', 'ፍጠር', 'ቅጽበታት', 'ሃሳቦች', 'መገለጫ', 'ቅንብሮች', 'ፕሪሚየም ተመዝገብ', 'ውይይቶች', 'ፈልግ', 'ተከተል', 'መልእክት', 'ላክ', 'አስቀምጥ', 'ሰርዝ', 'ውጣ', 'ቋንቋ', 'ቋንቋህን ምረጥ', 'ቋንቋዎችን ፈልግ', 'ጨለማ ሁነታ', 'ያልተተረጎመ ክፍሎች በእንግሊዝኛው ይቀጥላሉ.', 'ስህተት ተከስቷል'],
  ha: ['Gida', 'Bincika', 'Ƙirƙira', 'Lokuta', 'Ra\'ayi', 'Batura', 'Saitattu', 'Samu Premium', 'Tattaunawa', 'Nemi', 'Biyo baya', 'Saƙo', 'Aika', 'Ajiye', 'Soke', 'Fita', 'Harshe', 'Zaɓi harshenka', 'Nemi harsuna…', 'Yanayin duhu', 'Bangarorin da ba a fassara su ba Turanci ne.', 'Wani abu ya lalace'],
  yo: ['Ile', 'Àwárí', 'Ṣẹ̀dá', 'Ìṣẹ́jú àkókò', 'Èrò', 'Profaili', 'Ìtọ́sọnà', 'Gba Premium', 'Ìbánisọ̀rọ̀', 'Ṣàwárí', 'Tẹ̀le', 'Ifiṣẹ́', 'Fi rántí', 'Ìfipamọ́', 'Fagilé', 'Jáde', 'Èdè', 'Yan èdè rẹ', 'Ṣàwárí èdè…', 'Ípamọ́ dúdú', 'Àwọn apá tí a kò ṭún wọn ni yoo lóyìn lédè Gẹ̀ẹ́sì.', 'Èyí kan ṣàṣì'],
  ig: ['Ụlọ', 'Chọpụta', 'Mepụta', 'Oge', 'Echiche', 'Profaịlụ', 'Ntọala', 'Nweta Premium', 'Okwu', 'Chọọ', 'Soro', 'Ozi', 'Zipu', 'Chekwa', 'Kagbuo', 'Pụọ', 'Asụsụ', 'Họrọ asụsụ gị', 'Chọọ asụsụ…', 'Ụdị gbara ọchịchịrị', 'Ndị e dabereghị ntụgharị ga-aga n’asụsụ Bekee.', 'Ọ nwere nsogbu'],
  af: ['Tuis', 'Verken', 'Skep', 'Oomblikke', 'Gedagtes', 'Profiel', 'Instellings', 'Kry Premium', 'Geselsies', 'Soek', 'Volg', 'Boodskap', 'Stuur', 'Stoor', 'Kanselleer', 'Teken uit', 'Taal', 'Kies jou taal', 'Soek tale…', 'Donker modus', 'Onvertaalde dele bly in Engels.', 'Iets het misluk'],
  zu: ['Ikhaya', 'Thola', 'Yakha', 'Amaza', 'Imicabango', 'Iphrofayila', 'Izilungiselelo', 'Sithengele Premium', 'Izingxoxo', 'Sesha', 'Landela', 'Umyalezo', 'Thumela', 'Londoloza', 'Khansela', 'Phuma', 'Ulwimi', 'Khetha ulwimi lwakho', 'Sesha izilwimi…', 'Iliso elimnyama', 'Izindawo ezingakahunyazwa ngesiNgisi.', 'Kwenzeke okungalungile'],
};

// ---------------------------------------------------------------------------
// Extended dictionaries — full Settings/Profile/Chat coverage for the most
// used languages. Everything else gracefully falls back to English.
// ---------------------------------------------------------------------------
const EXT: Record<string, I18nDict> = {
  hi: {
    'settings.privacy': 'गोपनीयता और सुरक्षा', 'settings.notifications': 'सूचनाएँ', 'settings.appearance': 'दिखावट',
    'settings.account': 'खाता', 'settings.privateProfile': 'प्राइवेट प्रोफ़ाइल', 'settings.showEmail': 'ईमेल दिखाएँ',
    'settings.pushNotifications': 'पुश सूचनाएँ', 'settings.compactView': 'कॉम्पैक्ट दृश्य', 'action.viewProfile': 'प्रोफ़ाइल देखें',
    'settings.contactSupport': 'सहायता से संपर्क करें', 'settings.deleteAccount': 'खाता हटाएँ', 'chat.message': 'संदेश',
    'chat.noMessages': 'अभी कोई संदेश नहीं', 'feed.empty': 'यहाँ अभी कुछ नहीं है', 'common.loading': 'लोड हो रहा है…',
    'action.ok': 'ठीक है', 'badge.verified': 'सत्यापित', 'pricing.choosePlan': 'प्लान चुनें',
    'settings.personalizedAds': 'पर्सनलाइज़्ड विज्ञापन', 'settings.goAdFree': 'विज्ञापन-मुक्त रहें', 'action.seePlans': 'प्लान देखें',
    'common.signedOut': 'साइन आउट हो गया',
    'display.title': 'टेक्स्ट और डिस्प्ले', 'display.desc': 'टेक्स्ट आकार और जानबूझकर पिंच-ज़ूम',
    'display.fontSection': 'टेक्स्ट आकार', 'display.fontDesc': 'Equyvo में सब कुछ छोटा या बड़ा करें',
    'display.fontSmall': 'छोटा', 'display.fontNormal': 'सामान्य', 'display.fontLarge': 'बड़ा', 'display.fontReset': 'टेक्स्ट आकार रीसेट करें',
    'display.zoomSection': 'पिंच ज़ूम', 'display.zoomOn': 'लेआउट ज़ूम के लिए पिंच करें',
    'display.zoomOnDesc': 'ऐप लेआउट बड़ा करने के लिए दो उँगलियों से पिंच करें',
    'display.antimistouch': 'एंटी-मिसटच', 'display.antimistouchDesc': 'केवल दृढ़, जानबूझकर किए गए दो-उँगली पिंच से ज़ूम बदलेगा — तेज़ अनजाने स्पर्च नज़रअंदाज़ किए जाएँगे',
    'display.zoomLevel': 'ज़ूम स्तर', 'display.resetZoom': 'ज़ूम रीसेट करें',
    'display.zoomNote': 'ज़ूम केवल ऐप के लेआउट को बदलता है — आपका सिस्टम ज़ूम वैसे ही रहता है।',
  },
  bn: {
    'settings.privacy': 'গোপনীয়তা ও নিরাপত্তা', 'settings.notifications': 'নোটিফিকেশন', 'settings.appearance': 'চেহারা',
    'settings.account': 'অ্যাকাউন্ট', 'settings.privateProfile': 'প্রাইভেট প্রোফাইল', 'settings.showEmail': 'ইমেইল দেখান',
    'settings.pushNotifications': 'পুশ নোটিফিকেশন', 'settings.compactView': 'কমপ্যাক্ট ভিউ', 'action.viewProfile': 'প্রোফাইল দেখুন',
    'settings.contactSupport': 'সহায়তার সাথে যোগাযোগ', 'settings.deleteAccount': 'অ্যাকাউন্ট মুছুন', 'chat.message': 'মেসেজ',
    'chat.noMessages': 'এখনও কোনো মেসেজ নেই', 'feed.empty': 'এখানে এখনও কিছু নেই', 'common.loading': 'লোড হচ্ছে…',
    'action.ok': 'ঠিক আছে', 'badge.verified': 'যাচাইকৃত', 'pricing.choosePlan': 'প্ল্যান বেছে নিন',
    'settings.personalizedAds': 'ব্যক্তিগতকৃত বিজ্ঞাপন', 'settings.goAdFree': 'বিজ্ঞাপনমুক্ত থাকুন', 'action.seePlans': 'প্ল্যান দেখুন',
    'common.signedOut': 'সাইন আউট হয়েছে',
    'display.title': 'টেক্সট ও ডিসপ্লে', 'display.desc': 'টেক্সটের আকার এবং ইচ্ছাকৃত পিঞ্চ-জুম',
    'display.fontSection': 'টেক্সটের আকার', 'display.fontDesc': 'Equyvo-তে সবকিছু ছোট বা বড় করুন',
    'display.fontSmall': 'ছোট', 'display.fontNormal': 'স্বাভাবিক', 'display.fontLarge': 'বড়', 'display.fontReset': 'টেক্সটের আকার রিসেট করুন',
    'display.zoomSection': 'পিঞ্চ জুম', 'display.zoomOn': 'লেআউট জুমের জন্য পিঞ্চ করুন',
    'display.zoomOnDesc': 'অ্যাপ লেআউট বড় করতে দুই আঙুল দিয়ে পিঞ্চ করুন',
    'display.antimistouch': 'অ্যান্টি-মিসটাচ', 'display.antimistouchDesc': 'শুধু দৃঢ়, ইচ্ছাকৃত দুই-আঙুলের পিঞ্চ জুম বদলায় — অল্প আকস্মিক স্পর্চ উপেক্ষিত হয়',
    'display.zoomLevel': 'জুম স্তর', 'display.resetZoom': 'জুম রিসেট করুন',
    'display.zoomNote': 'জুম কেবল অ্যাপের লেআউট বদলায় — সিস্টেম জুম অপরিবর্তিত থাকে।',
  },
  ta: {
    'settings.privacy': 'தனியுரிமை & பாதுகாப்பு', 'settings.notifications': 'அறிவிப்புகள்', 'settings.appearance': 'தோற்றம்',
    'settings.account': 'கணக்கு', 'settings.privateProfile': 'தனிப்பட்ட சுயவிவரம்', 'settings.showEmail': 'மின்னஞ்சலைக் காட்டு',
    'settings.pushNotifications': 'புஷ் அறிவிப்புகள்', 'settings.compactView': 'சுருக்கமான பார்வை', 'action.viewProfile': 'சுயவிவரத்தைப் பார்',
    'settings.contactSupport': 'ஆதரவைத் தொடர்பு கொள்ள', 'settings.deleteAccount': 'கணக்கை நீக்கு', 'chat.message': 'செய்தி',
    'chat.noMessages': 'இன்னும் செய்திகள் இல்லை', 'feed.empty': 'இங்கே இன்னும் ஏதும் இல்லை', 'common.loading': 'ஏற்றுகிறது…',
    'action.ok': 'சரி', 'badge.verified': 'சரிபார்க்கப்பட்டது', 'pricing.choosePlan': 'திட்டத்தைத் தேர்ந்தெடு',
    'settings.personalizedAds': 'தனிப்பயன் விளம்பரங்கள்', 'settings.goAdFree': 'விளம்பரமில்லாதது', 'action.seePlans': 'திட்டங்களைப் பார்',
    'common.signedOut': 'வெளியேறினார்கள்',
    'display.title': 'உரை மற்றும் தோற்றம்', 'display.desc': 'உரை அளவு மற்றும் வேண்டுமென்றே பிஞ்ச்-பெரிதாக்குதல்',
    'display.fontSection': 'உரை அளவு', 'display.fontDesc': 'Equyvo முழுவதும் உரையை சிறியதாகவோ பெரியதாகவோ செய்யுங்கள்',
    'display.fontSmall': 'சிறியது', 'display.fontNormal': 'சாதாரணம்', 'display.fontLarge': 'பெரியது', 'display.fontReset': 'உரை அளவை மீட்டமை',
    'display.zoomSection': 'பிஞ்ச் பெரிதாக்கம்', 'display.zoomOn': 'இயக்கத்தை பெரிதாக்க பிஞ்ச் செய்யவும்',
    'display.zoomOnDesc': 'செயலி இயக்கத்தைப் பெரிதாக்க இரு விரல்களால் பிஞ்ச் செய்யவும்',
    'display.antimistouch': 'தவறான தொடர்பு தடுப்பு', 'display.antimistouchDesc': 'விரல்களால் உறுதியாக, வேண்டுமென்றே பிஞ்ச் செய்தால் மட்டுமே அளவு மாறும் — திடீர் தவறான தொடல்கள் புறக்கணிக்கப்படும்',
    'display.zoomLevel': 'பெரிதாக்க நிலை', 'display.resetZoom': 'பெரிதாக்கத்தை மீட்டமை',
    'display.zoomNote': 'பெரிதாக்கம் செயலி அமைப்பை மட்டும் மாற்றும் — கணினி பெரிதாக்கம் அப்படியே இருக்கும்.',
  },
  es: {
    'settings.privacy': 'Privacidad y seguridad', 'settings.notifications': 'Notificaciones', 'settings.appearance': 'Apariencia',
    'settings.account': 'Cuenta', 'settings.privateProfile': 'Perfil privado', 'settings.showEmail': 'Mostrar correo',
    'settings.pushNotifications': 'Notificaciones push', 'settings.compactView': 'Vista compacta', 'action.viewProfile': 'Ver perfil',
    'settings.contactSupport': 'Contactar soporte', 'settings.deleteAccount': 'Eliminar cuenta', 'chat.message': 'Mensaje',
    'chat.noMessages': 'Aún no hay mensajes', 'feed.empty': 'Nada por aquí todavía', 'common.loading': 'Cargando…',
    'action.ok': 'Aceptar', 'badge.verified': 'Verificado', 'pricing.choosePlan': 'Elegir plan',
    'settings.personalizedAds': 'Anuncios personalizados', 'settings.goAdFree': 'Sin anuncios', 'action.seePlans': 'Ver planes',
    'common.signedOut': 'Sesión cerrada',
    'display.title': 'Texto y pantalla', 'display.desc': 'Tamaño del texto y zoom intencional con dos dedos',
    'display.fontSection': 'Tamaño del texto', 'display.fontDesc': 'Hacer todo más pequeño o más grande en Equyvo',
    'display.fontSmall': 'Pequeño', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Grande', 'display.fontReset': 'Restablecer tamaño del texto',
    'display.zoomSection': 'Zoom por pellizco', 'display.zoomOn': 'Pellizcar para agrandar',
    'display.zoomOnDesc': 'Agrandar el diseño de la app con dos dedos',
    'display.antimistouch': 'Anti-toques accidentales', 'display.antimistouchDesc': 'Solo un pellizco firme y deliberado cambia el zoom — los toques rápidos se ignoran',
    'display.zoomLevel': 'Nivel de zoom', 'display.resetZoom': 'Restablecer zoom',
    'display.zoomNote': 'El zoom solo cambia el diseño de la app: el zoom del sistema no se toca.',
  },
  fr: {
    'settings.privacy': 'Confidentialité et sécurité', 'settings.notifications': 'Notifications', 'settings.appearance': 'Apparence',
    'settings.account': 'Compte', 'settings.privateProfile': 'Profil privé', 'settings.showEmail': 'Afficher l’e-mail',
    'settings.pushNotifications': 'Notifications push', 'settings.compactView': 'Vue compacte', 'action.viewProfile': 'Voir le profil',
    'settings.contactSupport': 'Contacter l’assistance', 'settings.deleteAccount': 'Supprimer le compte', 'chat.message': 'Message',
    'chat.noMessages': 'Aucun message pour l’instant', 'feed.empty': 'Rien pour le moment', 'common.loading': 'Chargement…',
    'action.ok': 'OK', 'badge.verified': 'Vérifié', 'pricing.choosePlan': 'Choisir une offre',
    'settings.personalizedAds': 'Publicités personnalisées', 'settings.goAdFree': 'Sans publicité', 'action.seePlans': 'Voir les offres',
    'common.signedOut': 'Déconnecté',
    'display.title': 'Texte et affichage', 'display.desc': 'Taille du texte et zoom intentionnel à deux doigts',
    'display.fontSection': 'Taille du texte', 'display.fontDesc': 'Tout rendre plus petit ou plus grand dans Equyvo',
    'display.fontSmall': 'Petit', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Grand', 'display.fontReset': 'Réinitialiser la taille du texte',
    'display.zoomSection': 'Zoom par pincement', 'display.zoomOn': 'Pincer pour agrandir',
    'display.zoomOnDesc': 'Agrandir la mise en page de l’app avec deux doigts',
    'display.antimistouch': 'Anti-contact accidentel', 'display.antimistouchDesc': 'Seul un pincement ferme et délibéré change le zoom — les touches rapides sont ignorées',
    'display.zoomLevel': 'Niveau de zoom', 'display.resetZoom': 'Réinitialiser le zoom',
    'display.zoomNote': 'Le zoom ne change que l’app — le zoom du système reste intact.',
  },
  de: {
    'settings.privacy': 'Datenschutz & Sicherheit', 'settings.notifications': 'Benachrichtigungen', 'settings.appearance': 'Darstellung',
    'settings.account': 'Konto', 'settings.privateProfile': 'Privates Profil', 'settings.showEmail': 'E-Mail anzeigen',
    'settings.pushNotifications': 'Push-Benachrichtigungen', 'settings.compactView': 'Kompakte Ansicht', 'action.viewProfile': 'Profil ansehen',
    'settings.contactSupport': 'Support kontaktieren', 'settings.deleteAccount': 'Konto löschen', 'chat.message': 'Nachricht',
    'chat.noMessages': 'Noch keine Nachrichten', 'feed.empty': 'Noch nichts hier', 'common.loading': 'Wird geladen…',
    'action.ok': 'OK', 'badge.verified': 'Verifiziert', 'pricing.choosePlan': 'Tarif wählen',
    'settings.personalizedAds': 'Personalisierte Werbung', 'settings.goAdFree': 'Werbefrei', 'action.seePlans': 'Tarife ansehen',
    'common.signedOut': 'Abgemeldet',
    'display.title': 'Text & Anzeige', 'display.desc': 'Textgröße und bewusster Zwei-Finger-Zoom',
    'display.fontSection': 'Textgröße', 'display.fontDesc': 'Alles in Equyvo kleiner oder größer machen',
    'display.fontSmall': 'Klein', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Groß', 'display.fontReset': 'Textgröße zurücksetzen',
    'display.zoomSection': 'Pinch-Zoom', 'display.zoomOn': 'Zum Vergrößern zusammenziehen',
    'display.zoomOnDesc': 'App-Layout mit zwei Fingern vergrößern',
    'display.antimistouch': 'Anti-Fehlberührung', 'display.antimistouchDesc': 'Nur ein fester, bewusster Zwei-Finger-Kneif verändert den Zoom — schnelle Berührungen werden ignoriert',
    'display.zoomLevel': 'Zoomstufe', 'display.resetZoom': 'Zoom zurücksetzen',
    'display.zoomNote': 'Zoom ändert nur das App-Layout — der Systemzoom bleibt unberührt.',
  },
  pt: {
    'settings.privacy': 'Privacidade e segurança', 'settings.notifications': 'Notificações', 'settings.appearance': 'Aparência',
    'settings.account': 'Conta', 'settings.privateProfile': 'Perfil privado', 'settings.showEmail': 'Mostrar e-mail',
    'settings.pushNotifications': 'Notificações push', 'settings.compactView': 'Visão compacta', 'action.viewProfile': 'Ver perfil',
    'settings.contactSupport': 'Falar com o suporte', 'settings.deleteAccount': 'Excluir conta', 'chat.message': 'Mensagem',
    'chat.noMessages': 'Nenhuma mensagem ainda', 'feed.empty': 'Nada por aqui ainda', 'common.loading': 'Carregando…',
    'action.ok': 'OK', 'badge.verified': 'Verificado', 'pricing.choosePlan': 'Escolher plano',
    'settings.personalizedAds': 'Anúncios personalizados', 'settings.goAdFree': 'Sem anúncios', 'action.seePlans': 'Ver planos',
    'common.signedOut': 'Sessão encerrada',
    'display.title': 'Texto e tela', 'display.desc': 'Tamanho do texto e zoom intencional com dois dedos',
    'display.fontSection': 'Tamanho do texto', 'display.fontDesc': 'Deixar tudo menor ou maior no Equyvo',
    'display.fontSmall': 'Pequeno', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Grande', 'display.fontReset': 'Redefinir tamanho do texto',
    'display.zoomSection': 'Zoom por pinça', 'display.zoomOn': 'Pinçar para ampliar',
    'display.zoomOnDesc': 'Ampliar o layout do app com dois dedos',
    'display.antimistouch': 'Anti-toque acidental', 'display.antimistouchDesc': 'Somente uma pinça firme e intencional muda o zoom — toques rápidos são ignorados',
    'display.zoomLevel': 'Nível de zoom', 'display.resetZoom': 'Redefinir zoom',
    'display.zoomNote': 'O zoom muda apenas o layout do app — o zoom do sistema fica intacto.',
  },
  ar: {
    'settings.privacy': 'الخصوصية والأمان', 'settings.notifications': 'الإشعارات', 'settings.appearance': 'المظهر',
    'settings.account': 'الحساب', 'settings.privateProfile': 'حساب خاص', 'settings.showEmail': 'إظهار البريد',
    'settings.pushNotifications': 'إشعارات فورية', 'settings.compactView': 'عرض مضغوط', 'action.viewProfile': 'عرض الملف الشخصي',
    'settings.contactSupport': 'تواصل مع الدعم', 'settings.deleteAccount': 'حذف الحساب', 'chat.message': 'رسالة',
    'chat.noMessages': 'لا توجد رسائل بعد', 'feed.empty': 'لا يوجد شيء هنا بعد', 'common.loading': 'جارٍ التحميل…',
    'action.ok': 'حسنًا', 'badge.verified': 'موثّق', 'pricing.choosePlan': 'اختر الخطة',
    'settings.personalizedAds': 'إعلانات مخصصة', 'settings.goAdFree': 'بلا إعلانات', 'action.seePlans': 'عرض الخطط',
    'common.signedOut': 'تم تسجيل الخروج',
    'display.title': 'النص والعرض', 'display.desc': 'حجم النص والتكبير المتعمّد بإصبعين',
    'display.fontSection': 'حجم النص', 'display.fontDesc': 'اجعل كل شيء أصغر أو أكبر في Equyvo',
    'display.fontSmall': 'صغير', 'display.fontNormal': 'عادي', 'display.fontLarge': 'كبير', 'display.fontReset': 'إعادة تعيين حجم النص',
    'display.zoomSection': 'التقريب بالقرص', 'display.zoomOn': 'قرص لتكبير التصميم',
    'display.zoomOnDesc': 'كبّر واجهة التطبيق بإصبعين',
    'display.antimistouch': 'ضد اللمس العرضي', 'display.antimistouchDesc': 'القرص الواثق والعمدي بإصبعين فقط يغيّر التكبير — اللمسات السريعة تُتجاهل',
    'display.zoomLevel': 'مستوى التكبير', 'display.resetZoom': 'إعادة تعيين التكبير',
    'display.zoomNote': 'التكبير يغيّر واجهة التطبيق فقط — تقريب النظام يبقى كما هو.',
  },
  ru: {
    'settings.privacy': 'Приватность и безопасность', 'settings.notifications': 'Уведомления', 'settings.appearance': 'Оформление',
    'settings.account': 'Аккаунт', 'settings.privateProfile': 'Закрытый профиль', 'settings.showEmail': 'Показывать почту',
    'settings.pushNotifications': 'Push-уведомления', 'settings.compactView': 'Компактный вид', 'action.viewProfile': 'Открыть профиль',
    'settings.contactSupport': 'Связаться с поддержкой', 'settings.deleteAccount': 'Удалить аккаунт', 'chat.message': 'Сообщение',
    'chat.noMessages': 'Сообщений пока нет', 'feed.empty': 'Здесь пока пусто', 'common.loading': 'Загрузка…',
    'action.ok': 'ОК', 'badge.verified': 'Подтверждено', 'pricing.choosePlan': 'Выбрать тариф',
    'settings.personalizedAds': 'Персональная реклама', 'settings.goAdFree': 'Без рекламы', 'action.seePlans': 'Показать тарифы',
    'common.signedOut': 'Вы вышли',
    'display.title': 'Текст и экран', 'display.desc': 'Размер текста и намеренный зум щипком',
    'display.fontSection': 'Размер текста', 'display.fontDesc': 'Сделать всё в Equyvo крупнее или меньше',
    'display.fontSmall': 'Мелкий', 'display.fontNormal': 'Обычный', 'display.fontLarge': 'Крупный', 'display.fontReset': 'Сбросить размер текста',
    'display.zoomSection': 'Зум щипком', 'display.zoomOn': 'Щипок для масштаба',
    'display.zoomOnDesc': 'Увеличивать макет приложения двумя пальцами',
    'display.antimistouch': 'Защита от случайных касаний', 'display.antimistouchDesc': 'Только твёрдый намеренный щипок двумя пальцами меняет масштаб — быстрые случайные касания игнорируются',
    'display.zoomLevel': 'Уровень масштаба', 'display.resetZoom': 'Сбросить масштаб',
    'display.zoomNote': 'Масштаб меняет только макет приложения — системный зум остаётся прежним.',
  },
  'zh-Hans': {
    'settings.privacy': '隐私与安全', 'settings.notifications': '通知', 'settings.appearance': '外观',
    'settings.account': '账号', 'settings.privateProfile': '私密资料', 'settings.showEmail': '显示邮箱',
    'settings.pushNotifications': '推送通知', 'settings.compactView': '紧凑视图', 'action.viewProfile': '查看资料',
    'settings.contactSupport': '联系客服', 'settings.deleteAccount': '删除账号', 'chat.message': '消息',
    'chat.noMessages': '暂无消息', 'feed.empty': '这里还很安静', 'common.loading': '加载中…',
    'action.ok': '好的', 'badge.verified': '已认证', 'pricing.choosePlan': '选择方案',
    'settings.personalizedAds': '个性化广告', 'settings.goAdFree': '去广告', 'action.seePlans': '查看方案',
    'common.signedOut': '已退出',
    'display.title': '文字与显示', 'display.desc': '文字大小与有意的双指缩放',
    'display.fontSection': '文字大小', 'display.fontDesc': '让 Equyvo 中的所有内容更大或更小',
    'display.fontSmall': '小', 'display.fontNormal': '标准', 'display.fontLarge': '大', 'display.fontReset': '重置文字大小',
    'display.zoomSection': '双指缩放', 'display.zoomOn': '双指缩放布局',
    'display.zoomOnDesc': '用两根手指捏合即可放大应用布局',
    'display.antimistouch': '防误触', 'display.antimistouchDesc': '只有明确、用力的双指捏合才会改变缩放 — 快速的意外触碰会被忽略',
    'display.zoomLevel': '缩放级别', 'display.resetZoom': '重置缩放',
    'display.zoomNote': '缩放只改变应用内布局 — 系统缩放不受影响。',
  },
  ja: {
    'settings.privacy': 'プライバシーと安全', 'settings.notifications': '通知', 'settings.appearance': '外観',
    'settings.account': 'アカウント', 'settings.privateProfile': '非公開プロフィール', 'settings.showEmail': 'メールを表示',
    'settings.pushNotifications': 'プッシュ通知', 'settings.compactView': 'コンパクト表示', 'action.viewProfile': 'プロフィールを見る',
    'settings.contactSupport': 'サポートに連絡', 'settings.deleteAccount': 'アカウント削除', 'chat.message': 'メッセージ',
    'chat.noMessages': 'まだメッセージはありません', 'feed.empty': 'まだ何もありません', 'common.loading': '読み込み中…',
    'action.ok': 'OK', 'badge.verified': '認証済み', 'pricing.choosePlan': 'プランを選ぶ',
    'settings.personalizedAds': 'パーソナライズ広告', 'settings.goAdFree': '広告なし', 'action.seePlans': 'プランを見る',
    'common.signedOut': 'ログアウトしました',
    'display.title': '文字と表示', 'display.desc': '文字サイズと意図的なピンチズーム',
    'display.fontSection': '文字サイズ', 'display.fontDesc': 'Equyvo の文字を小さく / 大きく調整',
    'display.fontSmall': '小', 'display.fontNormal': '標準', 'display.fontLarge': '大', 'display.fontReset': '文字サイズをリセット',
    'display.zoomSection': 'ピンチズーム', 'display.zoomOn': 'つまんで拡大',
    'display.zoomOnDesc': '二本の指でつまんでアプリのレイアウトを拡大します',
    'display.antimistouch': '誤タッチ防止', 'display.antimistouchDesc': '両指でしっかり意図的にピンチした場合だけズームが変わります — 一瞬の誤タッチは無視されます',
    'display.zoomLevel': 'ズームレベル', 'display.resetZoom': 'ズームをリセット',
    'display.zoomNote': 'ズームはアプリ内レイアウトのみを変更します — システムズームはそのままです。',
  },
  id: {
    'settings.privacy': 'Privasi & keamanan', 'settings.notifications': 'Notifikasi', 'settings.appearance': 'Tampilan',
    'settings.account': 'Akun', 'settings.privateProfile': 'Profil privat', 'settings.showEmail': 'Tampilkan email',
    'settings.pushNotifications': 'Notifikasi push', 'settings.compactView': 'Tampilan ringkas', 'action.viewProfile': 'Lihat profil',
    'settings.contactSupport': 'Hubungi dukungan', 'settings.deleteAccount': 'Hapus akun', 'chat.message': 'Pesan',
    'chat.noMessages': 'Belum ada pesan', 'feed.empty': 'Belum ada apa pun di sini', 'common.loading': 'Memuat…',
    'action.ok': 'OK', 'badge.verified': 'Terverifikasi', 'pricing.choosePlan': 'Pilih paket',
    'settings.personalizedAds': 'Iklan pribadinya', 'settings.goAdFree': 'Bebas iklan', 'action.seePlans': 'Lihat paket',
    'common.signedOut': 'Keluar',
    'display.title': 'Teks & Tampilan', 'display.desc': 'Ukuran teks dan zoom cubit yang disengaja',
    'display.fontSection': 'Ukuran teks', 'display.fontDesc': 'Buat semua di Equyvo lebih kecil atau lebih besar',
    'display.fontSmall': 'Kecil', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Besar', 'display.fontReset': 'Setel ulang ukuran teks',
    'display.zoomSection': 'Zoom cubit', 'display.zoomOn': 'Cubit untuk memperbesar',
    'display.zoomOnDesc': 'Perbesar tata letak aplikasi dengan dua jari',
    'display.antimistouch': 'Anti-sentuh salah', 'display.antimistouchDesc': 'Hanya cubitan dua jari yang mantap dan disengaja yang mengubah zoom — sentuhan cepat diabaikan',
    'display.zoomLevel': 'Tingkat zoom', 'display.resetZoom': 'Setel ulang zoom',
    'display.zoomNote': 'Zoom hanya mengubah tata letak dalam aplikasi — zoom sistem tidak terpengaruh.',
  },
  tr: {
    'settings.privacy': 'Gizlilik ve güvenlik', 'settings.notifications': 'Bildirimler', 'settings.appearance': 'Görünüm',
    'settings.account': 'Hesap', 'settings.privateProfile': 'Gizli profil', 'settings.showEmail': 'E-postayı göster',
    'settings.pushNotifications': 'Anlık bildirimler', 'settings.compactView': 'Sıkışık görünüm', 'action.viewProfile': 'Profili gör',
    'settings.contactSupport': 'Desteğe yaz', 'settings.deleteAccount': 'Hesabı sil', 'chat.message': 'Mesaj',
    'chat.noMessages': 'Henüz mesaj yok', 'feed.empty': 'Burada henüz bir şey yok', 'common.loading': 'Yükleniyor…',
    'action.ok': 'Tamam', 'badge.verified': 'Onaylı', 'pricing.choosePlan': 'Plan seç',
    'settings.personalizedAds': 'Kişiselleştirilmiş reklamlar', 'settings.goAdFree': 'Reklamsız', 'action.seePlans': 'Planları gör',
    'common.signedOut': 'Çıkış yapıldı',
    'display.title': 'Metin ve Görünüm', 'display.desc': 'Metin boyutu ve kasıtlı iki parmak yakınlaştırma',
    'display.fontSection': 'Metin boyutu', 'display.fontDesc': 'Equyvo’da her şeyi daha küçük veya daha büyük yap',
    'display.fontSmall': 'Küçük', 'display.fontNormal': 'Normal', 'display.fontLarge': 'Büyük', 'display.fontReset': 'Metin boyutunu sıfırla',
    'display.zoomSection': 'Pinç yakınlaştırma', 'display.zoomOn': 'Yakınlaştırmak için pinçle',
    'display.zoomOnDesc': 'İki parmakla pinçleyerek uygulama düzenini büyüt',
    'display.antimistouch': 'Yanlış dokunma koruması', 'display.antimistouchDesc': 'Sadece sağlam, kasıtlı iki parmak pinçi yakınlaştırmayı değiştirir — hızlı yanlış dokunuşlar yok sayılır',
    'display.zoomLevel': 'Yakınlaştırma düzeyi', 'display.resetZoom': 'Yakınlaştırmayı sıfırla',
    'display.zoomNote': 'Yakınlaştırma yalnızca uygulama düzenini değiştirir — sistem yakınlaştırması etkilenmez.',
  },
};

// ---------------------------------------------------------------------------

function buildDict(code: string): I18nDict {
  if (code === DEFAULT_LANGUAGE) return EN;
  const row = ROWS[code];
  if (!row) return EN;
  const dict: I18nDict = { ...EN };
  CORE_ORDER.forEach((key, i) => {
    const v = row[i];
    if (v && String(v).trim()) dict[key] = v;
  });
  const ext = EXT[code];
  if (ext) Object.assign(dict, ext);
  return dict;
}

function normalizeCode(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_LANGUAGE;
  if (LANGUAGES.some((l) => l.code === s)) return s;
  // Accept regional user-agent forms: "hi-IN" -> "hi", "zh-CN" -> "zh-Hans", "zh-TW/HK" -> "zh-Hant"
  const base = s.split('-')[0];
  if (s.toLowerCase().startsWith('zh-cn') || s.toLowerCase().startsWith('zh-sg')) return 'zh-Hans';
  if (s.toLowerCase().startsWith('zh-tw') || s.toLowerCase().startsWith('zh-hk')) return 'zh-Hant';
  if (LANGUAGES.some((l) => l.code === base)) return base;
  return DEFAULT_LANGUAGE;
}

export interface I18nContextValue {
  language: string;
  setLanguage: (code: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => { /* provider not mounted — no-op */ },
  t: (key, vars) => {
    let s = EN[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
    return s;
  },
});

function readStoredLanguage(): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored) return normalizeCode(stored);
  } catch { /* storage unavailable */ }
  try {
    return normalizeCode(navigator.language || DEFAULT_LANGUAGE);
  } catch { return DEFAULT_LANGUAGE; }
}

export const I18nProvider = ({ children }: { children: React.ReactNode }) => {
  const [language, setLanguageState] = useState<string>(readStoredLanguage);
  const dict = useMemo(() => buildDict(language), [language]);

  useEffect(() => {
    try {
      document.documentElement.lang = language;
      document.documentElement.dir = isRtl(language) ? 'rtl' : 'ltr';
    } catch { /* ignored */ }
  }, [language]);

  const setLanguage = useCallback((code: string) => {
    const next = normalizeCode(code);
    if (!LANGUAGES.some((l) => l.code === next)) return;
    setLanguageState(next);
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    let s = dict[key] || EN[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.split('{' + k + '}').join(String(v));
      }
    }
    return s;
  }, [dict]);

  return <I18nContext.Provider value={{ language, setLanguage, t }}>{children}</I18nContext.Provider>;
};

export const useI18n = () => useContext(I18nContext);
export { LANGUAGES, DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY } from './languages';
