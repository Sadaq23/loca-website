import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const thematic_areas = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/thematic_areas' }),
  schema: z.object({
    title: z.string(),
    shortTitle: z.string().optional(),
    description: z.string(),
    image: z.string().optional(),
    order: z.number(),
  }),
});

const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tag: z.string().optional(),
    excerpt: z.string(),
    image: z.string().optional(),
  }),
});

export const collections = { thematic_areas, news };
