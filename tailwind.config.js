// ตั้งค่า Tailwind ให้สแกนหน้าเว็บและไฟล์ JavaScript ของทุกบทบาท
module.exports = {
  content: ['./public/**/*.html', './public/js/**/*.js'],
  theme: {
    extend: {},
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        buffet: {
          // A single, high-contrast palette used by customer and staff screens.
          primary: '#c2410c',
          'primary-content': '#ffffff',
          secondary: '#172033',
          'secondary-content': '#ffffff',
          accent: '#f59e0b',
          'accent-content': '#172033',
          neutral: '#172033',
          'neutral-content': '#ffffff',
          'base-100': '#fffdf9',
          'base-200': '#fff7ed',
          'base-300': '#fed7aa',
          'base-content': '#1f2937',
          info: '#0369a1',
          success: '#15803d',
          warning: '#b45309',
          error: '#b91c1c',
        },
      },
      'light',
    ],
  },
};
