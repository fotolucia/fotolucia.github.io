import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const categorias = defineCollection({
  loader: glob({ pattern: "*.json", base: "./content/categorias" }),
  schema: z.object({
    titulo: z.string(),
    tituloEn: z.string().nullish(),
    descripcion: z.string().nullish(),
    descripcionEn: z.string().nullish(),
    oculta: z.boolean().nullish(),
    portada: z.string().nullish(),
    orden: z.number().nullish(),
    fotos: z
      .array(
        z.object({
          imagen: z.string(),
          titulo: z.string().nullish(),
          tituloEn: z.string().nullish(),
          pie: z.string().nullish(),
          oculta: z.boolean().nullish(),
          posicion: z.string().nullish(),
        })
      )
      .nullish()
      .transform((f) => f ?? []),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./content/blog" }),
  schema: z.object({
    titulo: z.string(),
    tituloEn: z.string().nullish(),
    fecha: z.coerce.date(),
    portada: z.string().nullish(),
    resumen: z.string().nullish(),
    resumenEn: z.string().nullish(),
    oculta: z.boolean().nullish(),
    orden: z.number().nullish(),
    cuerpoEn: z.string().nullish(),
  }),
});

export const collections = { categorias, blog };
