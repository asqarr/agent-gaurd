import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const configuredSiteUrl = process.env.VITE_SITE_URL?.trim() || "https://agentguard.dev";
const siteUrl = configuredSiteUrl.replace(/\/+$/, "");

const entries = await readdir(dist);
for (const entry of entries.filter((file) => file.endsWith(".html"))) {
  const file = new URL(entry, dist);
  const html = await readFile(file, "utf8");
  await writeFile(file, html.replaceAll("__SITE_URL__", siteUrl), "utf8");
}

await writeFile(new URL("robots.txt", dist), `User-agent: *\nAllow: /\nDisallow: /app.html\nDisallow: /api/\nSitemap: ${siteUrl}/sitemap.xml\n`, "utf8");
await writeFile(new URL("sitemap.xml", dist), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n  <url><loc>${siteUrl}/agent-security-testing.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>\n  <url><loc>${siteUrl}/prompt-injection-testing.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>\n  <url><loc>${siteUrl}/privacy.html</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>\n  <url><loc>${siteUrl}/terms.html</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>\n</urlset>\n`, "utf8");
const sitemapPath = new URL("sitemap.xml", dist);
const sitemap = await readFile(sitemapPath, "utf8");
const attackLabEntry = `  <url><loc>${siteUrl}/attack-lab.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>\n`;
await writeFile(
  sitemapPath,
  sitemap.replace(
    `  <url><loc>${siteUrl}/agent-security-testing.html`,
    `${attackLabEntry}  <url><loc>${siteUrl}/agent-security-testing.html`,
  ),
  "utf8",
);

await mkdir(new URL(".well-known/", dist), { recursive: true });
await writeFile(new URL(".well-known/security.txt", dist), `Contact: ${siteUrl}/#contact\nPreferred-Languages: en\n`, "utf8");

console.log(`SEO assets generated for ${siteUrl}`);
