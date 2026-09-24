/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 50: '#eef3fa', 100: '#d5e0f0', 200: '#a9bfdf', 300: '#7496c6', 400: '#476fa9', 500: '#2b5189', 600: '#1d3d6d', 700: '#132f57', 800: '#0b2545', 900: '#071a33' },
        gold: { 50: '#fbf7e8', 100: '#f5ecc4', 300: '#e2c96a', 500: '#c9a227', 600: '#a8841b', 700: '#7f6414' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
