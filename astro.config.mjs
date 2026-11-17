import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.localliance.org',
  integrations: [sitemap({ filter: (page) => !page.includes('/panel') })],
  vite: {
    plugins: [tailwindcss()],
  },
});
