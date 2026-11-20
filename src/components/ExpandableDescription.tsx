import React, { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Renders inline #hashtags as real buttons. Clicking one opens the Discover
 * page filtered to that tag (`/app/discover?tag=<tag>`) so every piece of
 * content carrying the same hashtag can be browsed in one place.
 *
 * onClick stops propagation so a hashtag inside a clickable feed card never
 * also opens the fullscreen viewer.
 */
export function HashtagText({ text }: { text?: string }) {
  const value = String(text ?? '');
  if (!value) return null;
  const parts = value.split(/(#[\w]+)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (/^#[\w]+$/.test(part)) {
          const tag = part.slice(1).toLowerCase();
          return (
            <Link
              key={index}
              to={`/app/discover?tag=${encodeURIComponent(tag)}`}
              onClick={(e) => e.stopPropagation()}
              className="text-primary hover:underline hover:text-primary/80 transition-colors"
              title={`Browse all content tagged #${tag}`}
            >
              {part}
            </Link>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

interface ExpandableDescriptionProps {
  text?: string | null;
  className?: string;
  /** Extra classes for the text itself (text size, colour, spacing). */
  textClassName?: string;
}

/**
 * A one-line description with a trailing "..." button. The button only appears
 * when the text actually overflows one line; tapping it reveals the full text
 * (and offers a "less" control to collapse it again). Hashtags inside the text
 * are always clickable.
 */
const ExpandableDescription: React.FC<ExpandableDescriptionProps> = ({
  text,
  className = '',
  textClassName = '',
}) => {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const value = String(text ?? '');

  // Collapse again whenever the underlying content changes.
  useLayoutEffect(() => {
    setExpanded(false);
  }, [value]);

  useLayoutEffect(() => {
    if (expanded || !value) {
      setOverflowing(false);
      return;
    }
    const el = measureRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, expanded]);

  if (!value) return null;

  return (
    <div className={`flex items-start min-w-0 ${className}`}>
      <span
        ref={measureRef}
        className={`min-w-0 flex-1 ${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} ${textClassName}`}
      >
        <HashtagText text={value} />
      </span>
      {(overflowing || expanded) && (
        <button
          type="button"
          aria-label={expanded ? 'Show less' : 'Read full description'}
          title={expanded ? 'Show less' : 'Read full description'}
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="ml-1 shrink-0 rounded px-1 font-semibold text-white/80 hover:bg-white/15 hover:text-white transition-colors"
        >
          {expanded ? 'less' : '...'}
        </button>
      )}
    </div>
  );
};

export default ExpandableDescription;
