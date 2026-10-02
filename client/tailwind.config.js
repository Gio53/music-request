/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        text: "var(--text)",
        muted: "var(--muted)",
        line: "var(--border)",
        primary: "var(--primary)",
        "primary-hover": "var(--primary-hover)",
        "on-primary": "var(--on-primary)",
        accent: "var(--accent)",
        "on-accent": "var(--on-accent)",
      },
    },
  },
  plugins: [],
};
