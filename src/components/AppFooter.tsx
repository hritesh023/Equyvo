import React from 'react';
import { Link } from 'react-router-dom';
import AppLogo from './AppLogo';

/**
 * Full-bleed responsive app footer.
 *
 * - Always spans the full width of its container (max-fill): w-full with
 *   left/right display-cutout insets, so curved edges, notches and external
 *   displays never leave gaps or clip content.
 * - Flexible grid: 1 column on small phones → 2 on large phones / foldables →
 *   4 on tablet/desktop → constrained inner max-width on ultrawide so lines
 *   stay readable while the background still fills edge to edge.
 * - Rendered only on md+ (mobile uses the bottom nav as its footer).
 */
const AppFooter: React.FC = () => {
  const year = new Date().getFullYear();

  const columns: Array<{ title: string; links: Array<{ label: string; to: string }> }> = [
    {
      title: 'Explore',
      links: [
        { label: 'Home', to: '/app/home' },
        { label: 'Discover', to: '/app/discover' },
        { label: 'Moments', to: '/app/moments' },
        { label: 'Thoughts', to: '/app/thoughts' },
      ],
    },
    {
      title: 'Create',
      links: [
        { label: 'New post', to: '/app/create' },
        { label: 'Search', to: '/app/search' },
        { label: 'Your profile', to: '/app/profile' },
      ],
    },
    {
      title: 'Account',
      links: [
        { label: 'Pricing', to: '/app/pricing' },
        { label: 'Settings', to: '/app/settings' },
      ],
    },
  ];

  return (
    <footer className="app-footer-fill hidden w-full border-t border-border/50 bg-background/95 backdrop-blur-xl md:block">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-8 sm:px-6 md:py-10 lg:px-8">
        <div className="grid w-full grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          {/* Brand */}
          <div className="min-w-0 space-y-3">
            <Link to="/" className="inline-flex min-w-0 items-center gap-2">
              <AppLogo className="h-7 w-7 shrink-0" />
              <span
                className="truncate bg-gradient-to-r from-pink-400 via-purple-500 to-cyan-400 bg-clip-text text-lg font-bold text-transparent"
                style={{ fontFamily: "'Pacifico', cursive" }}
              >
                Equyvo
              </span>
            </Link>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              Share moments, thoughts and stories with the people who matter.
            </p>
          </div>

          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title} className="min-w-0">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {col.title}
              </h3>
              <ul className="space-y-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      to={l.to}
                      className="inline-block max-w-full truncate text-sm text-foreground/80 transition-colors hover:text-primary"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-8 flex w-full flex-col gap-2 border-t border-border/40 pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="truncate">© {year} Equyvo. All rights reserved.</span>
          <span className="truncate">Made for every screen — phone, tablet, desktop &amp; external displays.</span>
        </div>
      </div>
    </footer>
  );
};

export default AppFooter;
