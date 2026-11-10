/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * One palette with the municipality's other systems (CFMS/CBO and DMS):
         *   deep #20364c sidebar · slate blue #284e64 · ink #243b50 headings
         *   steel blue #3e6a80 primary actions (brand-600) · teal #558b8c accent (gold-500)
         * The legacy class name `gold` now holds the teal accent, as DMS does.
         */
        navy: { 50: '#eef4f6', 100: '#d9e6eb', 200: '#b8cfd8', 300: '#8eb0be', 400: '#6590a3', 500: '#457489', 600: '#355f74', 700: '#284e64', 800: '#243b50', 900: '#20364c', 950: '#162636' },
        brand: { 50: '#eef5f8', 100: '#d8e8ef', 200: '#b4d1de', 300: '#89b3c6', 400: '#6d98ac', 500: '#4f8098', 600: '#3e6a80', 700: '#335869', 800: '#2b4a59', 900: '#243d49' },
        gold: { 50: '#eef6f5', 100: '#d6eae8', 200: '#b9dbdb', 300: '#8fc2c1', 400: '#6aa6a6', 500: '#558b8c', 600: '#457273', 700: '#3a5f60', 800: '#304e4f', 900: '#283f40' },
        // DMS neutrals: hairline borders, sunken fills, ink text.
        ink: '#0c0a09',
        muted: '#6b6b6b',
        line: { DEFAULT: '#ececec', 2: '#dcdcdc' },
        sunken: '#f5f5f5',
        side: '#fcfcfc',
        sand: '#edd0a9',
        clay: '#cf8c6e',
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Headings use Inter too (DMS/CBO); `font-serif` is kept as an alias.
        serif: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Codes and numbers: Inter with tabular figures and a plain zero, as CBO.
        mono: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: { xl2: '14px', md2: '10px' },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '1rem' }] },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,.04), 0 2px 8px -2px rgba(15,23,42,.04)',
        raised: '0 4px 12px -2px rgb(16 24 40 / 0.08), 0 2px 6px -2px rgb(16 24 40 / 0.05)',
      },
    },
  },
  plugins: [],
};
