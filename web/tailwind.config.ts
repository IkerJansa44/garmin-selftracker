import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ceramic: "var(--ceramic-bg)",
        panel: "var(--panel-surface)",
        subsurface: "var(--subsurface)",
        ink: "var(--ink-text)",
        muted: "var(--muted-text)",
        hairline: "var(--hairline)",
        accent: "var(--accent)",
        success: "var(--success)",
        warning: "var(--warning)",
        error: "var(--error)",
      },
      fontFamily: {
        sans: ["-apple-system", "SF Pro Text", "Inter", "system-ui", "sans-serif"],
        mono: ["SF Mono", "ui-monospace", "Menlo", "monospace"],
      },
      boxShadow: {
        panel: "0 24px 60px rgba(18,18,18,0.08), 0 2px 8px rgba(18,18,18,0.05)",
        soft: "0 12px 30px rgba(18,18,18,0.06)",
        inset: "inset 0 1px 0 rgba(255,255,255,0.8)",
      },
      borderRadius: {
        panel: "28px",
        capsule: "9999px",
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        pulseSoft: {
          "0%": { transform: "scale(0.95)", opacity: "0" },
          "70%": { opacity: "0.4" },
          "100%": { transform: "scale(1.15)", opacity: "0" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 360ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
