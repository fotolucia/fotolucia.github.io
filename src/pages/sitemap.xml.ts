import type { APIRoute } from "astro";
import { categoriasOrdenadas, entradasOrdenadas } from "../lib";
import { url } from "../site";

export const prerender = true;

// Un sitemap hecho a mano (sin librerías) con todas las páginas públicas: así Google las
// encuentra e indexa más rápido. Se excluyen /admin (no es contenido) y /fotografias (redirige).
export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL("http://localhost:4321/");
  const [categorias, entradas] = await Promise.all([categoriasOrdenadas(), entradasOrdenadas()]);

  const rutas = [
    "/",
    "/blog",
    "/contacto",
    "/privacidad",
    "/aviso-legal",
    ...categorias.map((c) => `/fotografias/${c.id}`),
    ...entradas.map((e) => `/blog/${e.id}`),
  ];

  const urls = rutas.map((r) => `  <url><loc>${new URL(url(r), base).href}</loc></url>`).join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml" } }
  );
};
