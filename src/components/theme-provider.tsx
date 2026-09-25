import * as React from "react"

type Theme = "dark" | "light" | "system"

type ThemeProviderProps = {
  children: React.ReactNode
  attribute?: string
  defaultTheme?: Theme
  enableSystem?: boolean
  disableTransitionOnChange?: boolean
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
}

const ThemeProviderContext = React.createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<Theme>(
    () => {
      if (typeof window === 'undefined' || !window.localStorage) {
        return defaultTheme;
      }
      return (localStorage.getItem(storageKey) as Theme) || defaultTheme
    }
  )

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.document) {
      return;
    }
    
    const root = window.document.documentElement

    root.classList.remove("light", "dark")

    let effectiveTheme: string = theme
    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light"

      root.classList.add(systemTheme)
      effectiveTheme = systemTheme
    } else {
      root.classList.add(theme)
    }

    // Keep favicon / touch icon in sync: light logo in light mode,
    // dark logo in dark mode.
    try {
      const logoSrc =
        effectiveTheme === "light" ? "/Equyvo_logo_light_v2.png" : "/Equyvo_logo.png";
      const iconLink = window.document.querySelector<HTMLLinkElement>(
        'link[rel="icon"]',
      );
      if (iconLink) iconLink.href = logoSrc;
      const appleIconLink = window.document.querySelector<HTMLLinkElement>(
        'link[rel="apple-touch-icon"]',
      );
      if (appleIconLink) appleIconLink.href = logoSrc;
    } catch {
      // ignore (SSR / privacy modes)
    }
  }, [theme])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(storageKey, theme)
      }
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}