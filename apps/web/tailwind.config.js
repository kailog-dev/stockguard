/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        panel2: 'rgb(var(--c-panel2) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        txt: 'rgb(var(--c-txt) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        up: 'rgb(var(--c-up) / <alpha-value>)',
        down: 'rgb(var(--c-down) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        onfill: '#14181F',
      },
      textColor: {
        accent: 'rgb(var(--c-accent-t) / <alpha-value>)',
        up: 'rgb(var(--c-up-t) / <alpha-value>)',
        down: 'rgb(var(--c-down-t) / <alpha-value>)',
        warn: 'rgb(var(--c-warn-t) / <alpha-value>)',
      },
      fontFamily: {
        num: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
