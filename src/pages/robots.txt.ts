import type { APIRoute } from "astro";
import { url } from "../site";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL("http://localhost:4321/");
  const sitemap = new URL(url("/sitemap.xml"), base).href;
  return new Response(`User-agent: *\nDisallow: /admin\n\nSitemap: ${sitemap}\n`, {
    headers: { "Content-Type": "text/plain" },
  });
};
