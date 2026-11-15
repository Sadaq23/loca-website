================================================================
 LOCA WEBSITE REBUILD PACK  -  2026 EDITION
================================================================

WHAT THIS IS
------------
A complete rebuild of your website, delivered as 6 phase scripts
(0 to 5) plus an image pack. The phases follow the same style you
have been using, but everything here was TESTED: the full site
compiles with a real Astro build before being shipped to you.

WHAT YOU GET
------------
  phase-0-assets-check.sh    verifies images are in place
  phase-1-foundation.sh      config, design system, Layout, SEO
  phase-2-homepage.sh        new photography-led homepage
  phase-3-about-programs.sh  About page + programs + content files
  phase-4-core-pages.sh      Where We Work, Accountability, Contact,
                             News, Resources, Privacy, Terms, 404
  phase-5-launch-check.sh    personalization checks + production build
  images/                    13 ready-to-use web images
  documents/                 LOCA-Organisational-Profile.pdf

HOW TO RUN (from your project root, i.e. the folder with src/)
--------------------------------------------------------------
  1. Copy the contents of the images/ folder into public/images/
     (create the folder if it does not exist).
     Copy documents/LOCA-Organisational-Profile.pdf into
     public/documents/ if you want it on the Resources page.

  2. Run the phases IN ORDER:
       bash phase-0-assets-check.sh
       bash phase-1-foundation.sh
       bash phase-2-homepage.sh
       bash phase-3-about-programs.sh
       bash phase-4-core-pages.sh
       bash phase-5-launch-check.sh     <- this one also builds

  3. Preview with:  npm run dev   (open http://localhost:4321)

WHAT CHANGED VS YOUR OLD SITE
-----------------------------
 - Multi-page architecture: Home, About, What We Do (+4 program
   pages), Where We Work, Accountability, News (+article pages),
   Resources, Contact, Privacy, Terms, 404.
 - All profile content restored: 9 values, 6 how-we-work items,
   8 cross-cutting commitments, 8 localization commitments,
   governance structure, who-we-serve, compliance framework.
 - The old "Funded by UN OCHA / FCDO / USAID..." logo strip was
   REPLACED. Displaying funders you do not have agreements with
   is a credibility risk. Add real partner logos when they exist.
 - The false "Verified FY2025 data" caption was REMOVED. The
   stats remain but you must verify them before launch
   (phase 5 will remind you).
 - Fake dated news headlines were replaced with clearly-marked
   SAMPLE posts that double as writing templates.
 - Dark mode removed; one clean green design system, brand gold
   accent, photography-led, works in light mode only.
 - No animation libraries: all motion is CSS + tiny vanilla JS
   (scroll reveals, staggered, counters, hero settle-in) and it
   respects prefers-reduced-motion. Total custom JS is ~2 KB.

WHAT MAKES IT STAND OUT IN 2026
-------------------------------
 - Accessibility: skip link, aria labels, keyboard-reachable
   dropdown/accordions, labeled form fields, focus states.
 - SEO: per-page titles/descriptions, Open Graph + social card
   (og-image.jpg), JSON-LD NGO schema, sitemap, robots.txt.
 - Trust design: a dedicated Accountability page with real
   feedback channels, PSEA statement, compliance accordions.
 - Performance: lazy-loaded images, no heavy frameworks, static
   output, instant navigation.

THINGS YOU MUST DO BEFORE LAUNCH (phase 5 reminds you)
------------------------------------------------------
 1. Contact form: get a free access key at https://web3forms.com
    and replace YOUR_ACCESS_KEY_HERE in src/pages/contact.astro
    (it appears once in the form script).
 2. Homepage stats: confirm 150k+ / 45 / 12 / 100% against real
    monitoring data, or edit them in src/pages/index.astro.
 3. Replace the 3 SAMPLE news posts in src/content/news/ with
    real stories (the samples explain how to write good ones).
 4. Replace placeholder photos with your own field photos (with
    consent) or licensed stock. The pack images come from public
    web sources and are for DESIGN PREVIEW only.
 5. Review Privacy Policy and Terms of Use pages.
 6. The org profile PDF has an 'IRCA' typo and an empty
    organogram section - fix in Word and re-export before
    publishing it on the Resources page.

IMAGE PACK CONTENTS (copy into public/images/)
----------------------------------------------
  hero-home.jpg              homepage hero (market scene)
  about-community.jpg        about teaser (smiling woman)
  thematic-humanitarian.jpg  program card 1 (relief supplies)
  thematic-climate.jpg       program card 2 (farmer irrigating)
  thematic-essential.jpg     program card 3 (water pump)
  thematic-governance.jpg    program card 4 (community meeting)
  map-somalia.png            Somalia map, recolored to brand green
  news-1.jpg                 sample news: emergency response
  news-2.jpg                 sample news: WASH
  news-3.jpg                 sample news: skills training
  logo.jpeg                  your logo (from your WhatsApp file)
  favicon.png                circular badge cropped from your logo
  og-image.jpg               social sharing card 1200x630

NOTES
-----
 - Requires Astro 5 + Tailwind CSS 4 (your project already uses
   Tailwind 4 syntax). Node 18+ recommended.
 - If you previously had src/content/config.ts, phase 1 removes
   it (Astro 5 uses src/content.config.ts instead).
 - The old /api/contact route is no longer needed; Web3Forms
   handles the form without any server code.
================================================================
