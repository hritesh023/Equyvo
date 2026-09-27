# Equyvo - Enhanced Social Media Platform

A modern, cross-platform social media application built with React, TypeScript, and Capacitor. Optimized for Android, iOS, Web, and PC platforms with enhanced UI/UX and robust error handling.

## 🚀 Features

### Core Functionality
- **Stories**: Share ephemeral content with friends
- **Moments**: Short video content similar to Instagram Reels
- **Posts**: Traditional social media posts with images and text
- **Real-time Chat**: Messaging system with online status
- **Search**: AI-powered content and user discovery
- **Profile Management**: Customizable user profiles

### Enhanced Features
- **Offline Support**: Continue using the app with limited functionality when offline
- **Network Detection**: Automatic connection quality monitoring
- **Error Recovery**: Comprehensive error boundaries with recovery options
- **Loading States**: Beautiful, context-aware loading screens
- **Cross-Platform Optimization**: Native-like experience on all platforms

## 🛠️ Technology Stack

### Frontend
- **React 18** with TypeScript
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **Radix UI** for accessible components
- **Lucide React** for icons

### Backend & Services
- **Cloudflare Pages Functions** (`functions/api/[[path]].ts`) — entire API
- **Cloudflare KV + R2** — data + media warehouse
- **AWS Cognito** for authentication
- **Capacitor** for cross-platform deployment

### Development Tools
- **ESLint** for code quality
- **TypeScript** for type safety
- **PostCSS** for CSS processing

## 📱 Platform Support

### Web
- Progressive Web App (PWA) ready
- Responsive design for all screen sizes
- Optimized for desktop and mobile browsers

### Mobile (via Capacitor)
- **Android**: Native Android app with Material Design optimizations
- **iOS**: Native iOS app with Human Interface Guidelines compliance

### Desktop
- Cross-platform desktop support
- Keyboard shortcuts and mouse optimizations
- Window management features

## 🎨 UI/UX Enhancements

### Visual Design
- Modern, clean interface with dark/light themes
- Smooth animations and micro-animations
- Consistent design language across platforms
- Accessibility-first approach

### Performance
- Lazy loading for images and components
- Optimized bundle splitting
- Efficient state management
- Smooth 60fps animations

### User Experience
- Intuitive navigation patterns
- Contextual loading states
- Error recovery mechanisms
- Offline-first approach

## 🔧 Installation & Setup

### Prerequisites
- Node.js 18+
- npm
- Git

### Local Development
```bash
# Clone the repository
git clone https://github.com/hritesh023/equyvo.git
cd equyvo

# Install dependencies
npm install

# Start the app (needs the API too — see below)
npm run dev

# Terminal 2 — Cloudflare Pages Functions on :8788
npm run build
npm run dev:api
```

No `VITE_*` secrets — the frontend only ever sees its own Cognito JWT.
Server secrets live in Cloudflare Pages (`wrangler pages secret put`).
See `DEPLOYMENT.md` — Cloudflare Pages is the only deploy target.

## 📦 Build & Deployment

### Web Build
```bash
# Production build
npm run build

# Preview build
npm run preview

# Bundle analysis
npm run build:analyze
```

### Mobile Build
```bash
# Build for production first
npm run build

# Android
npx cap sync android
npx cap open android

# iOS
npx cap sync ios
npx cap open ios
```

## 🧪 Testing

### Type Checking
```bash
npm run type-check
```

### Linting
```bash
npm run lint
npm run lint:fix
```

### Build Testing
```bash
npm run build
```

## 📊 Performance Metrics

### Bundle Size
- **Total**: ~255KB (67KB gzipped)
- **Chunks**: Well-split for optimal loading

### Performance Features
- Code splitting by route and feature
- Lazy loading for heavy components
- Optimized images with blur placeholders
- Efficient caching strategies

## 🔒 Security Features

### Authentication
- Secure JWT-based authentication
- Session management
- Protected routes

### Data Protection
- Environment variable security
- Input validation
- XSS protection
- CSRF protection

## 🌐 Network Features

### Offline Support
- Cached content access
- Offline-first architecture
- Sync when reconnected

### Connection Monitoring
- Real-time connection status
- Adaptive content loading
- Performance optimization based on connection quality

## 🐛 Error Handling

### Error Boundaries
- Comprehensive error catching
- User-friendly error messages
- Recovery options
- Error reporting (in production)

### Network Errors
- Automatic retry mechanisms
- Graceful degradation
- User notifications

## 🎯 Platform-Specific Optimizations

### Android
- Material Design compliance
- Hardware acceleration
- Optimized touch feedback
- Battery-efficient animations

### iOS
- Human Interface Guidelines
- Smooth scrolling
- Native gesture support
- Optimized for different screen sizes

### Web
- Progressive enhancement
- SEO optimization
- Keyboard navigation
- Screen reader support

## 📈 Analytics & Monitoring

### Performance Monitoring
- Bundle size tracking
- Loading time metrics
- Error tracking
- User engagement analytics

### Development Tools
- Hot module replacement
- Source maps
- Development debugging
- Performance profiling

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For issues and questions:
- Check the [Issues](https://github.com/hritesh023/equyvo/issues) page
- Review the documentation
- Contact the development team

## 🗺️ Roadmap

### Upcoming Features
- [ ] Real-time notifications
- [ ] Advanced content filters
- [ ] Video calling
- [ ] Advanced analytics dashboard
- [ ] Content moderation tools

### Platform Enhancements
- [ ] Desktop app (Electron)
- [ ] Tablet-specific optimizations
- [ ] Apple Watch support
- [ ] Android Wear support

---

## 💳 Billing & Subscriptions

Equyvo uses the **central Acronous billing system** (Razorpay + KV entitlements). All plans are managed centrally — Equyvo never handles payment secrets.

### Plans
| Plan | Price | Storage | Ads | AI Tools |
|---|---|---|---|---|
| Free | ₹0 | 5 GB | Full | No |
| Plus | ₹49/mo | 50 GB | Light | No |
| Premium | ₹149/mo | 250 GB | None | Yes |
| Creator | ₹399/mo | 500 GB | None | Yes + monetization |
| Creator Pro | ₹799/mo | 1 TB | None | Yes + API + advanced |

### Flow
1. User clicks a plan on `/pricing` → `buyPlan(planId)` in `src/lib/billing.ts`
2. `POST /api/create-order {plan}` → proxied to central `api.acronous.com/v1/billing/order`
3. Razorpay Checkout opens (UPI/cards/netbanking)
4. `POST /api/verify-payment` → central verifies HMAC + binds order → grants KV entitlement
5. `localStorage` updated + `planChanged` event → ads/quotas update instantly

### Paywall
- Storage/upload limits return HTTP 402 `{type:'paywall', code:'QUOTA_*'}`
- `handlePaywall(status, body)` in `src/lib/api.ts` redirects to `/pricing` (throttled)
- Ad-free plans: `ads-config.ts` reads `getBillingStatus().subscriptions.equyvo.plan`

### Key files
- `src/lib/billing.ts` — checkout flow, friendly error messages
- `src/lib/api.ts` — `handlePaywall()`, `isPaywallBody()`
- `src/lib/ads-config.ts` — ad gating by plan
- `src/pages/PricingPage.tsx` — plan cards + buy flow
- `functions/api/[[path]].ts` — `/api/create-order`, `/api/verify-payment` proxy to central

---

Built with ❤️ using modern web technologies
