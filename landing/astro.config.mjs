import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

const description =
  "Domjet is a lightweight headless browser for AI agents. It runs inside Node.js, renders real pages, and ships without a Chromium download.";

export default defineConfig({
  site: "https://domjet.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Domjet",
      description,
      favicon: "/favicon.svg",
      customCss: ["./src/styles/starlight.css"],
      head: [
        { tag: "meta", attrs: { property: "og:site_name", content: "Domjet" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://domjet.dev/social-card.png",
          },
        },
        { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "link", attrs: { rel: "sitemap", href: "/sitemap-index.xml" } },
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "text/plain",
            href: "/llms.txt",
            title: "Domjet documentation for language models",
          },
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Back to Domjet", link: "/" },
            { label: "Overview", slug: "docs" },
            { label: "Get started", slug: "docs/getting-started" },
            { label: "Compatibility", slug: "docs/compatibility" },
          ],
        },
        {
          label: "Concepts",
          items: [{ label: "Architecture", slug: "docs/architecture" }],
        },
      ],
    }),
    sitemap(),
  ],
});
