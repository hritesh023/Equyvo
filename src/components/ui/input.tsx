import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, spellCheck, autoCorrect, autoCapitalize, inputMode, autoComplete, ...props }, ref) => {
    const t = (type || 'text').toLowerCase();
    const isTextLike = !['password', 'email', 'tel', 'number', 'url', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'file', 'hidden', 'checkbox', 'radio', 'range', 'submit', 'button', 'reset', 'image'].includes(t);
    // Default to enabling the system keyboard's suggestion/autocorrect/spellcheck/
    // autofill affordances for text-like fields unless the caller explicitly opts out.
    const resolvedSpellCheck = spellCheck ?? (isTextLike ? true : undefined);
    const resolvedAutoCorrect = autoCorrect ?? (isTextLike ? 'on' : undefined);
    const resolvedAutoCapitalize = autoCapitalize ?? (isTextLike ? 'sentences' : undefined);
    const resolvedAutoComplete = autoComplete ?? (isTextLike ? 'on' : undefined);
    return (
      <input
        type={type}
        spellCheck={resolvedSpellCheck}
        autoCorrect={resolvedAutoCorrect}
        autoCapitalize={resolvedAutoCapitalize}
        inputMode={inputMode}
        autoComplete={resolvedAutoComplete}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
