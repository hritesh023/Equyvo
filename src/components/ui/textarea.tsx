import * as React from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, spellCheck, autoCorrect, autoCapitalize, autoComplete, ...props }, ref) => {
    // Textareas are always text-like: keep the system keyboard's suggestion
    // strip, autocorrect, spell-check and autofill enabled by default.
    const resolvedSpellCheck = spellCheck ?? true;
    const resolvedAutoCorrect = autoCorrect ?? 'on';
    const resolvedAutoCapitalize = autoCapitalize ?? 'sentences';
    const resolvedAutoComplete = autoComplete ?? 'on';
    return (
      <textarea
        spellCheck={resolvedSpellCheck}
        autoCorrect={resolvedAutoCorrect}
        autoCapitalize={resolvedAutoCapitalize}
        autoComplete={resolvedAutoComplete}
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
