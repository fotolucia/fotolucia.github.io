import credenciales from "./credenciales.json";
import { descifrar, type Credenciales, type Secreto } from "./cripto";
import { almacenGitHub, almacenLocal, textoABase64, type Almacen, type Cambio } from "./almacen";
import Sortable from "sortablejs";
import EasyMDE from "easymde";

type Foto = {
  imagen: string;
  titulo?: string | null;
  tituloEn?: string | null;
  pie?: string | null;
  oculta?: boolean | null;
};
type Categoria = {
  slug: string;
  datos: {
    titulo: string;
    tituloEn?: string | null;
    descripcion?: string | null;
    descripcionEn?: string | null;
    oculta?: boolean | null;
    portada?: string | null;
    orden?: number | null;
    fotos: Foto[];
  };
};
// Foto en edición: las nuevas llevan el archivo ya reducido, pendiente de guardar
type FotoEdicion = Foto & { nueva?: { base64: string; vista: string } };

type Entrada = {
  slug: string;
  datos: {
    titulo: string;
    tituloEn?: string | null;
    fecha: string; // ISO
    portada?: string | null;
    resumen?: string | null;
    resumenEn?: string | null;
    oculta?: boolean | null;
    orden?: number | null;
    cuerpo: string; // el texto, en Markdown
    cuerpoEn?: string | null;
  };
};

const DIR_CATEGORIAS = "content/categorias";
const DIR_BLOG = "content/blog";
const CLAVE_SESION = "panel-admin";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const LOCAL = import.meta.env.DEV;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;

let almacen: Almacen;
let secreto: Secreto;
let categorias: Categoria[] = [];
let editando: { original: Categoria; fotos: FotoEdicion[] } | null = null;
let entradas: Entrada[] = [];
let editandoEntrada: {
  original: Entrada;
  portada: string; // ruta final ("" = sin foto)
  portadaNueva?: { base64: string; vista: string }; // pendiente de subir
} | null = null;

// ---------- utilidades ----------

const slugify = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const escapar = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// "/uploads/x.jpg" → ruta dentro del repositorio
const rutaRepo = (imagen: string) => `public${imagen}`;

// Miniaturas: en la web publicada se leen de GitHub, porque las fotos recién subidas
// tardan un par de minutos en aparecer en la propia web
const urlImagen = (imagen: string) =>
  LOCAL || !secreto?.repo
    ? `${BASE}${imagen}`
    : `https://raw.githubusercontent.com/${secreto.repo}/${secreto.rama}/public${imagen}`;

function estado(texto: string, tipo: "" | "ok" | "mal" = "") {
  const e = $("#estado");
  e.textContent = texto;
  e.className = `estado ${tipo}`;
}

const MSG_PUBLICADO = LOCAL
  ? "✓ Guardado."
  : "✓ Guardado. La web se actualizará en 1–2 minutos (si no ves el cambio, recarga la página con Ctrl+F5).";

async function conEstado(texto: string, accion: () => Promise<void>) {
  document.querySelectorAll<HTMLButtonElement>("#panel button").forEach((b) => (b.dataset.bloq = String(b.disabled)));
  document.querySelectorAll<HTMLButtonElement>("#panel button").forEach((b) => (b.disabled = true));
  estado(texto);
  try {
    await accion();
    return true;
  } catch (e) {
    console.error(e);
    estado(`✗ No se ha podido completar: ${(e as Error).message}`, "mal");
    return false;
  } finally {
    document.querySelectorAll<HTMLButtonElement>("#panel button").forEach((b) => (b.disabled = b.dataset.bloq === "true"));
  }
}

// Reduce la foto en el navegador antes de subirla (máx. 2000 px, JPEG)
async function prepararImagen(archivo: File) {
  const bitmap = await createImageBitmap(archivo);
  const escala = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * escala);
  canvas.height = Math.round(bitmap.height * escala);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const vista = canvas.toDataURL("image/jpeg", 0.85);
  return { vista, base64: vista.split(",")[1] };
}

// Fotos insertadas dentro del texto de una entrada (con el botón de imagen del editor, o
// arrastrándolas): se guardan aquí hasta que se pulse «Guardar cambios», momento en el que la
// URL provisional (la vista previa) se cambia por la ruta final dentro del texto.
let imagenesPendientesTexto: { dataUrl: string; ruta: string; base64: string }[] = [];

async function subirImagenEditor(archivo: File, onExito: (url: string) => void, onError: (msg: string) => void) {
  try {
    const nueva = await prepararImagen(archivo);
    const nombre = `${slugify(archivo.name.replace(/\.[^.]+$/, "")) || "foto"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
    const ruta = `/uploads/blog/${nombre}`;
    imagenesPendientesTexto.push({ dataUrl: nueva.vista, ruta, base64: nueva.base64 });
    onExito(nueva.vista); // se ve al momento; se cambia por la ruta final al guardar
  } catch {
    onError("No se ha podido leer esa imagen.");
  }
}

// Cambia, en el texto ya escrito, las vistas previas provisionales por su ruta final, y añade
// a «cambios» solo las fotos que de verdad se han quedado en el texto (si se insertó una y
// luego se borró, no se llega a subir)
function resolverImagenesEditor(texto: string, cambios: Cambio[]): string {
  let resultado = texto;
  for (const img of imagenesPendientesTexto) {
    if (!resultado.includes(img.dataUrl)) continue;
    resultado = resultado.split(img.dataUrl).join(img.ruta);
    if (!cambios.some((c) => c.ruta === rutaRepo(img.ruta))) cambios.push({ ruta: rutaRepo(img.ruta), base64: img.base64 });
  }
  return resultado;
}

const jsonCategoria = (c: Categoria["datos"]) => textoABase64(JSON.stringify(c, null, 2) + "\n");

// Lectura y escritura de los archivos .md del blog: unas líneas de datos («frontmatter»,
// entre --- y ---) y debajo el texto en Markdown.
const valorYaml = (v: unknown) => JSON.stringify(String(v ?? "")); // entre comillas: evita líos con : o acentos

function serializarEntrada(d: Entrada["datos"]): string {
  const lineas = [`titulo: ${valorYaml(d.titulo)}`, `fecha: ${valorYaml(d.fecha)}`];
  if (d.tituloEn) lineas.push(`tituloEn: ${valorYaml(d.tituloEn)}`);
  if (d.portada) lineas.push(`portada: ${valorYaml(d.portada)}`);
  if (d.resumen) lineas.push(`resumen: ${valorYaml(d.resumen)}`);
  if (d.resumenEn) lineas.push(`resumenEn: ${valorYaml(d.resumenEn)}`);
  if (d.oculta) lineas.push(`oculta: true`);
  if (d.orden != null) lineas.push(`orden: ${d.orden}`);
  // El texto en inglés (si lo hay) también va en el frontmatter, en una sola línea con \n
  // escapados, porque el texto principal (debajo de los ---) solo puede haber uno.
  if (d.cuerpoEn) lineas.push(`cuerpoEn: ${valorYaml(d.cuerpoEn)}`);
  return `---\n${lineas.join("\n")}\n---\n\n${d.cuerpo.trim()}\n`;
}

function analizarEntrada(texto: string): Entrada["datos"] {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const datos: Record<string, string | number | boolean> = {};
  (m?.[1] ?? "").split(/\r?\n/).forEach((linea) => {
    const im = linea.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!im) return;
    const [, clave, bruto] = im;
    if (bruto === "true" || bruto === "false") datos[clave] = bruto === "true";
    else if (/^-?\d+$/.test(bruto)) datos[clave] = Number(bruto);
    else if (/^".*"$/.test(bruto)) {
      try {
        datos[clave] = JSON.parse(bruto);
      } catch {
        datos[clave] = bruto;
      }
    } else datos[clave] = bruto;
  });
  return {
    titulo: String(datos.titulo ?? ""),
    tituloEn: String(datos.tituloEn ?? ""),
    fecha: String(datos.fecha ?? new Date().toISOString()),
    portada: String(datos.portada ?? ""),
    resumen: String(datos.resumen ?? ""),
    resumenEn: String(datos.resumenEn ?? ""),
    orden: typeof datos.orden === "number" ? datos.orden : null,
    oculta: !!datos.oculta,
    cuerpo: (m?.[2] ?? "").trim(),
    cuerpoEn: String(datos.cuerpoEn ?? ""),
  };
}

// Iconos de plantilla: ojo abierto/cerrado (mostrar/ocultar foto) y puntos de arrastre
const ICONO_OJO = `
  <svg class="abierto" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
    <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
  </svg>
  <svg class="cerrado" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
    <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
    <path d="M4 4l16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
  </svg>`;

const ICONO_ASA = `<svg viewBox="0 0 24 24" width="14" height="20" aria-hidden="true">
  <circle cx="9" cy="6" r="1.6" fill="currentColor"></circle>
  <circle cx="15" cy="6" r="1.6" fill="currentColor"></circle>
  <circle cx="9" cy="12" r="1.6" fill="currentColor"></circle>
  <circle cx="15" cy="12" r="1.6" fill="currentColor"></circle>
  <circle cx="9" cy="18" r="1.6" fill="currentColor"></circle>
  <circle cx="15" cy="18" r="1.6" fill="currentColor"></circle>
</svg>`;

// Traducción automática (botón «Traducir con IA»). Usa MyMemory, un servicio gratuito y sin
// clave: el texto se envía a su servidor para traducirlo, así que solo se usa al pulsar el botón.
async function traducirTexto(texto: string, idioma: string): Promise<string> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}&langpair=es|${idioma}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("El traductor no responde.");
  const datos = await res.json();
  const traducido: string | undefined = datos?.responseData?.translatedText;
  if (!traducido || /MYMEMORY WARNING|INVALID/.test(traducido)) {
    throw new Error("No se ha podido traducir (puede que se haya agotado el límite gratuito de hoy).");
  }
  return traducido;
}

// Conecta cada botón «Traducir con IA» con su campo de origen (español) y destino
document.querySelectorAll<HTMLButtonElement>(".traducir-ia").forEach((boton) => {
  const origen = document.getElementById(boton.dataset.desde!) as HTMLInputElement | HTMLTextAreaElement;
  const destino = document.getElementById(boton.dataset.hacia!) as HTMLInputElement | HTMLTextAreaElement;
  const idioma = boton.dataset.idioma!;
  const tituloOriginal = boton.title;
  boton.addEventListener("click", async () => {
    const texto = origen.value.trim();
    if (!texto) return;
    boton.disabled = true;
    boton.classList.remove("error");
    boton.classList.add("cargando");
    try {
      destino.value = await traducirTexto(texto, idioma);
    } catch (e) {
      boton.classList.add("error");
      boton.title = (e as Error).message;
      setTimeout(() => {
        boton.classList.remove("error");
        boton.title = tituloOriginal;
      }, 4000);
    } finally {
      boton.classList.remove("cargando");
      boton.disabled = false;
    }
  });
});

// ---------- acceso ----------

async function entrar(s: Secreto) {
  secreto = s;
  almacen = LOCAL ? almacenLocal() : almacenGitHub(s);
  document.documentElement.dataset.sesion = "dentro"; // el candado de la cabecera se abre
  $("#login").hidden = true;
  $("#panel").hidden = false;
  $("#aviso-local").hidden = !LOCAL;
  if (!LOCAL && !s.token) {
    estado("✗ Falta configurar el token de GitHub (npm run configurar-admin). No se podrán guardar cambios.", "mal");
  }
  mostrarVista("categorias");
  await Promise.all([cargarCategorias(), cargarEntradas()]);
}

// La pantalla de acceso también respeta el idioma elegido con la bandera (antes de entrar)
const enIngles = () => document.documentElement.dataset.idioma === "en";

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const datos = new FormData(form);
  const boton = form.querySelector("button")!;
  boton.disabled = true;
  boton.textContent = enIngles() ? "Checking…" : "Comprobando…";
  $("#error-login").textContent = "";
  const s = await descifrar(credenciales as Credenciales, String(datos.get("usuario")), String(datos.get("clave")));
  boton.disabled = false;
  boton.textContent = enIngles() ? "Log in" : "Entrar";
  if (!s) {
    $("#error-login").textContent = enIngles() ? "Incorrect username or password." : "Usuario o contraseña incorrectos.";
    return;
  }
  try {
    sessionStorage.setItem(CLAVE_SESION, JSON.stringify(s));
  } catch {}
  form.reset();
  await entrar(s);
});

$("#cerrar-panel").addEventListener("click", () => {
  try {
    sessionStorage.removeItem(CLAVE_SESION);
  } catch {}
  location.href = `${BASE}/`;
});

// ---------- vistas ----------

function mostrarVista(nombre: string) {
  document.querySelectorAll<HTMLElement>(".vista").forEach((v) => (v.hidden = v.dataset.vista !== nombre));
  const pestana = nombre === "editar" ? "categorias" : nombre === "editar-entrada" ? "blog" : nombre;
  document
    .querySelectorAll<HTMLButtonElement>(".pestanas [data-vista]")
    .forEach((b) => b.classList.toggle("activa", b.dataset.vista === pestana));
}

document.querySelectorAll<HTMLButtonElement>(".pestanas [data-vista]").forEach((b) =>
  b.addEventListener("click", () => {
    editando = null;
    editandoEntrada = null;
    estado("");
    mostrarVista(b.dataset.vista!);
  })
);

// ---------- categorías ----------

// Las ocultas van siempre al final de la lista
const ordenarCategorias = (cats: Categoria[]) =>
  [...cats].sort(
    (a, b) => Number(!!a.datos.oculta) - Number(!!b.datos.oculta) || (a.datos.orden ?? 99) - (b.datos.orden ?? 99)
  );

async function cargarCategorias() {
  const lista = $("#lista-categorias");
  lista.innerHTML = `<li class="suave">Cargando…</li>`;
  try {
    const archivos = await almacen.listar(DIR_CATEGORIAS);
    categorias = ordenarCategorias(
      archivos
        .filter((a) => a.ruta.endsWith(".json"))
        .map((a) => {
          const datos = JSON.parse(a.contenido);
          datos.fotos ??= [];
          return { slug: a.ruta.split("/").pop()!.replace(/\.json$/, ""), datos };
        })
    );
    pintarCategorias();
  } catch (e) {
    lista.innerHTML = "";
    estado(`✗ No se han podido cargar las categorías: ${(e as Error).message}`, "mal");
  }
}

function pintarCategorias() {
  const lista = $("#lista-categorias");
  if (!categorias.length) {
    lista.innerHTML = `<li class="suave">Todavía no hay categorías.</li>`;
    return;
  }
  lista.innerHTML = categorias
    .map((c, i) => {
      const portada = c.datos.fotos.find((f) => !f.oculta)?.imagen || c.datos.fotos[0]?.imagen || c.datos.portada;
      const n = c.datos.fotos.length;
      const oculta = !!c.datos.oculta;
      const asa = oculta
        ? `<span class="asa-espacio" aria-hidden="true"></span>`
        : `<span class="asa-arrastrar" aria-hidden="true">${ICONO_ASA}</span>`;
      return `<li class="${oculta ? "fila-oculta" : ""}" data-slug="${c.slug}">
        ${asa}
        ${portada ? `<img class="${oculta ? "en-gris" : ""}" src="${escapar(urlImagen(portada))}" alt="" loading="lazy" />` : `<span class="sin-foto"></span>`}
        <div class="info">
          <span class="nombre">${escapar(c.datos.titulo)}${oculta ? ` <span class="etiqueta-oculta">Oculta</span>` : ""}</span>
          <span class="contador">${n} ${n === 1 ? "foto" : "fotos"}</span>
        </div>
        <div class="botones">
          <button type="button" class="boton" data-editar="${i}">Modificar</button>
          <button type="button" class="boton" data-ocultar="${i}">${oculta ? "Mostrar" : "Ocultar"}</button>
          <button type="button" class="boton peligro" data-eliminar="${i}">Eliminar</button>
        </div>
      </li>`;
    })
    .join("");
  lista.querySelectorAll<HTMLButtonElement>("[data-editar]").forEach((b) =>
    b.addEventListener("click", () => abrirEdicion(categorias[Number(b.dataset.editar)]))
  );
  lista.querySelectorAll<HTMLButtonElement>("[data-ocultar]").forEach((b) =>
    b.addEventListener("click", () => alternarOcultar(categorias[Number(b.dataset.ocultar)]))
  );
  lista.querySelectorAll<HTMLButtonElement>("[data-eliminar]").forEach((b) =>
    b.addEventListener("click", () => eliminarCategoria(categorias[Number(b.dataset.eliminar)]))
  );
}

// Arrastrar (los puntos, a la izquierda) para reordenar las categorías. Las ocultas no tienen
// asa, así que no se pueden arrastrar, y no se puede soltar ninguna después de ellas: siempre
// quedan al final.
Sortable.create($("#lista-categorias"), {
  animation: 150,
  forceFallback: true,
  handle: ".asa-arrastrar",
  ghostClass: "arrastrando",
  onMove: (evt) => !evt.related.classList.contains("fila-oculta"),
  onEnd: async () => {
    const filas = [...document.querySelectorAll<HTMLElement>("#lista-categorias li[data-slug]")];
    const cambios: Cambio[] = [];
    filas
      .filter((li) => !li.classList.contains("fila-oculta"))
      .forEach((li, i) => {
        const cat = categorias.find((c) => c.slug === li.dataset.slug);
        const nuevoOrden = i + 1;
        if (cat && cat.datos.orden !== nuevoOrden) {
          cat.datos.orden = nuevoOrden;
          cambios.push({ ruta: `${DIR_CATEGORIAS}/${cat.slug}.json`, base64: jsonCategoria(cat.datos) });
        }
      });
    if (!cambios.length) return;
    const ok = await conEstado("Guardando el nuevo orden…", () => almacen.guardar(cambios, "Reordenar categorías"));
    if (ok) {
      estado(MSG_PUBLICADO, "ok");
      // No se vuelve a pedir a GitHub: ya sabemos el orden que se acaba de guardar
      categorias = ordenarCategorias(categorias);
      pintarCategorias();
    }
  },
});

// Ocultar/mostrar: la categoría deja de aparecer en la web pública, sin borrar nada
async function alternarOcultar(c: Categoria) {
  const oculta = !c.datos.oculta;
  const datos: Categoria["datos"] = { ...c.datos, oculta };
  const ok = await conEstado(oculta ? "Ocultando…" : "Mostrando…", () =>
    almacen.guardar(
      [{ ruta: `${DIR_CATEGORIAS}/${c.slug}.json`, base64: jsonCategoria(datos) }],
      `${oculta ? "Ocultar" : "Mostrar"} categoría: ${c.datos.titulo}`
    )
  );
  if (ok) {
    estado(`${MSG_PUBLICADO} «${c.datos.titulo}» ${oculta ? "oculta" : "visible de nuevo"}.`, "ok");
    // No se vuelve a pedir a GitHub: justo después de guardar, a veces devuelve la versión
    // anterior durante uno o dos segundos. Como ya sabemos lo que se ha guardado, actualizamos
    // la lista con eso directamente.
    c.datos = datos;
    categorias = ordenarCategorias(categorias);
    pintarCategorias();
  }
}

// Añadir
const dialogoNombre = $<HTMLDialogElement>("#dialogo-nombre");
$("#nueva-categoria").addEventListener("click", () => {
  dialogoNombre.querySelector("form")!.reset();
  $("#error-nombre").textContent = "";
  dialogoNombre.showModal();
});

dialogoNombre.querySelector("form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = String(new FormData(e.currentTarget as HTMLFormElement).get("nombre")).trim();
  const slug = slugify(nombre);
  if (!slug) {
    $("#error-nombre").textContent = "Escribe un nombre.";
    return;
  }
  if (categorias.some((c) => c.slug === slug)) {
    $("#error-nombre").textContent = "Ya existe una categoría con ese nombre.";
    return;
  }
  dialogoNombre.close();
  const orden = Math.max(0, ...categorias.map((c) => c.datos.orden ?? 0)) + 1;
  const nueva: Categoria = { slug, datos: { titulo: nombre, descripcion: "", portada: "", orden, fotos: [] } };
  const ok = await conEstado("Creando categoría…", () =>
    almacen.guardar(
      [{ ruta: `${DIR_CATEGORIAS}/${slug}.json`, base64: jsonCategoria(nueva.datos) }],
      `Nueva categoría: ${nombre}`
    )
  );
  if (ok) {
    estado(`${MSG_PUBLICADO} Ahora puedes añadirle fotos.`, "ok");
    categorias = ordenarCategorias([...categorias, nueva]);
    pintarCategorias();
    abrirEdicion(nueva);
  }
});

// Eliminar
const dialogoConfirmar = $<HTMLDialogElement>("#dialogo-confirmar");
function confirmar(titulo: string, texto: string) {
  $("#confirmar-titulo").textContent = titulo;
  $("#confirmar-texto").textContent = texto;
  dialogoConfirmar.returnValue = "";
  dialogoConfirmar.showModal();
  return new Promise<boolean>((ok) => {
    dialogoConfirmar.addEventListener("close", () => ok(dialogoConfirmar.returnValue === "ok"), { once: true });
  });
}

async function eliminarCategoria(c: Categoria) {
  const n = c.datos.fotos.length;
  const seguro = await confirmar(
    `¿Estás segura de que quieres eliminar «${c.datos.titulo}»?`,
    n === 0
      ? "Se borrará la categoría. No se puede deshacer."
      : `Se borrarán la categoría y ${n === 1 ? "su foto" : `sus ${n} fotos`}. No se puede deshacer.`
  );
  if (!seguro) return;

  // Borra las fotos que no use ninguna otra categoría
  const usadas = new Set(
    categorias.filter((o) => o.slug !== c.slug).flatMap((o) => [o.datos.portada, ...o.datos.fotos.map((f) => f.imagen)])
  );
  const imagenes = [...new Set([c.datos.portada, ...c.datos.fotos.map((f) => f.imagen)])].filter(
    (i): i is string => !!i && i.startsWith("/uploads/") && !usadas.has(i)
  );
  const cambios: Cambio[] = [
    { ruta: `${DIR_CATEGORIAS}/${c.slug}.json`, base64: null },
    ...imagenes.map((i) => ({ ruta: rutaRepo(i), base64: null })),
  ];
  const ok = await conEstado("Eliminando…", () => almacen.guardar(cambios, `Eliminar categoría: ${c.datos.titulo}`));
  if (ok) {
    estado(`${MSG_PUBLICADO} «${c.datos.titulo}» eliminada.`, "ok");
    categorias = categorias.filter((o) => o.slug !== c.slug);
    pintarCategorias();
  }
}

// Modificar
function abrirEdicion(c: Categoria) {
  editando = { original: c, fotos: c.datos.fotos.map((f) => ({ ...f })) };
  $("#editar-titulo").textContent = c.datos.titulo;
  $<HTMLInputElement>("#editar-nombre").value = c.datos.titulo;
  $<HTMLInputElement>("#editar-nombre-en").value = c.datos.tituloEn ?? "";
  $<HTMLTextAreaElement>("#editar-descripcion").value = c.datos.descripcion ?? "";
  $<HTMLTextAreaElement>("#editar-descripcion-en").value = c.datos.descripcionEn ?? "";
  pintarFotos();
  mostrarVista("editar");
}

function pintarFotos() {
  if (!editando) return;
  const n = editando.fotos.length;
  $("#editar-contador").textContent = `(${n})`;
  const ul = $("#editar-fotos");
  // La portada real es la primera foto que no esté oculta
  const primeraVisible = editando.fotos.findIndex((f) => !f.oculta);
  ul.innerHTML = n
    ? editando.fotos
        .map((f, i) => {
          const oculta = !!f.oculta;
          const etiquetas = [i === primeraVisible ? "Portada" : "", f.nueva ? "Nueva" : ""].filter(Boolean);
          return `<li class="${oculta ? "foto-oculta" : ""}">
            <button type="button" class="miniatura" data-nombrar="${i}" title="Pulsa para ponerle nombre">
              <img src="${escapar(f.nueva?.vista ?? urlImagen(f.imagen))}" alt="${escapar(f.titulo ?? "")}" loading="lazy" />
            </button>
            <span class="etiquetas">${etiquetas.map((e) => `<span>${e}</span>`).join("")}</span>
            <button type="button" class="ojo" data-ojo="${i}" aria-label="${oculta ? "Mostrar foto" : "Ocultar foto"}" title="${oculta ? "Mostrar foto" : "Ocultar foto"}">
              ${ICONO_OJO}
            </button>
            <button type="button" class="quitar" data-quitar="${i}" aria-label="Quitar foto" title="Quitar foto">✕</button>
            <span class="nombre-foto ${f.titulo ? "" : "vacio"}">${escapar(f.titulo || "Sin nombre")}</span>
          </li>`;
        })
        .join("")
    : `<li class="suave" style="cursor:auto">Aún no hay fotos. Añade algunas desde tu ordenador.</li>`;
  ul.querySelectorAll<HTMLButtonElement>("[data-quitar]").forEach((b) =>
    b.addEventListener("click", async () => {
      const seguro = await confirmar("¿Quitar esta foto?", "Se quitará de la categoría al guardar los cambios.");
      if (!seguro) return;
      editando!.fotos.splice(Number(b.dataset.quitar), 1);
      pintarFotos();
    })
  );
  ul.querySelectorAll<HTMLButtonElement>("[data-ojo]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.ojo);
      editando!.fotos[i].oculta = !editando!.fotos[i].oculta;
      pintarFotos();
    })
  );
  ul.querySelectorAll<HTMLButtonElement>("[data-nombrar]").forEach((b) =>
    b.addEventListener("click", () => nombrarFoto(Number(b.dataset.nombrar)))
  );
}

// Arrastrar para cambiar el orden (funciona con ratón y con el dedo)
Sortable.create($("#editar-fotos"), {
  animation: 150,
  forceFallback: true,
  filter: ".quitar, .ojo",
  preventOnFilter: false,
  ghostClass: "arrastrando",
  chosenClass: "elegida",
  delay: 150,
  delayOnTouchOnly: true,
  onEnd: ({ oldIndex, newIndex }) => {
    if (!editando || oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
    const [foto] = editando.fotos.splice(oldIndex, 1);
    editando.fotos.splice(newIndex, 0, foto);
    pintarFotos();
  },
});

// Pulsar una foto: ponerle nombre (si se deja vacío, se queda sin nombre)
const dialogoFoto = $<HTMLDialogElement>("#dialogo-foto");
let fotoNombrando = -1;
function nombrarFoto(i: number) {
  if (!editando) return;
  const f = editando.fotos[i];
  fotoNombrando = i;
  $<HTMLImageElement>("#foto-vista").src = f.nueva?.vista ?? urlImagen(f.imagen);
  dialogoFoto.querySelector<HTMLInputElement>("input[name=titulo]")!.value = f.titulo ?? "";
  dialogoFoto.querySelector<HTMLInputElement>("input[name=tituloEn]")!.value = f.tituloEn ?? "";
  dialogoFoto.showModal();
  dialogoFoto.querySelector<HTMLInputElement>("input[name=titulo]")!.focus();
}
dialogoFoto.querySelector("form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  if (editando && editando.fotos[fotoNombrando]) {
    editando.fotos[fotoNombrando].titulo = dialogoFoto.querySelector<HTMLInputElement>("input[name=titulo]")!.value.trim();
    editando.fotos[fotoNombrando].tituloEn = dialogoFoto.querySelector<HTMLInputElement>("input[name=tituloEn]")!.value.trim();
    pintarFotos();
  }
  dialogoFoto.close();
});

$<HTMLInputElement>("#editar-subir").addEventListener("change", async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const archivos = [...(input.files ?? [])];
  input.value = "";
  if (!editando || !archivos.length) return;
  const carpeta = editando.original.slug;
  estado(`Preparando ${archivos.length} ${archivos.length === 1 ? "imagen" : "imágenes"}…`);
  let fallidas = 0;
  for (const archivo of archivos) {
    try {
      const nueva = await prepararImagen(archivo);
      const nombre = `${slugify(archivo.name.replace(/\.[^.]+$/, "")) || "foto"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
      editando.fotos.push({ imagen: `/uploads/${carpeta}/${nombre}`, titulo: "", pie: "", nueva });
    } catch {
      fallidas++;
    }
  }
  pintarFotos();
  estado(
    fallidas
      ? `${fallidas} imagen(es) no se han podido leer (¿formato HEIC del iPhone? Prueba con JPG).`
      : "Imágenes añadidas. Pulsa «Guardar cambios» para publicarlas.",
    fallidas ? "mal" : ""
  );
});

$("#volver-categorias").addEventListener("click", salirEdicion);
$("#editar-cancelar").addEventListener("click", salirEdicion);

// ¿Ha cambiado algo (nombre, descripción, fotos, orden o nombres de fotos) desde que se abrió?
function hayCambios() {
  if (!editando) return false;
  const limpiar = (fotos: FotoEdicion[]) =>
    JSON.stringify(fotos.map((f) => [f.imagen, f.titulo ?? "", f.tituloEn ?? "", !!f.oculta]));
  return (
    $<HTMLInputElement>("#editar-nombre").value.trim() !== editando.original.datos.titulo ||
    $<HTMLInputElement>("#editar-nombre-en").value.trim() !== (editando.original.datos.tituloEn ?? "") ||
    $<HTMLTextAreaElement>("#editar-descripcion").value.trim() !== (editando.original.datos.descripcion ?? "") ||
    $<HTMLTextAreaElement>("#editar-descripcion-en").value.trim() !== (editando.original.datos.descripcionEn ?? "") ||
    limpiar(editando.fotos) !== limpiar(editando.original.datos.fotos)
  );
}

function salirEdicion() {
  if (hayCambios() && !window.confirm("Hay cambios sin guardar. ¿Salir igualmente?")) return;
  editando = null;
  estado("");
  mostrarVista("categorias");
}

$("#editar-guardar").addEventListener("click", async () => {
  if (!editando) return;
  const { original, fotos } = editando;
  const titulo = $<HTMLInputElement>("#editar-nombre").value.trim();
  const tituloEn = $<HTMLInputElement>("#editar-nombre-en").value.trim();
  const descripcion = $<HTMLTextAreaElement>("#editar-descripcion").value.trim();
  const descripcionEn = $<HTMLTextAreaElement>("#editar-descripcion-en").value.trim();
  const slug = slugify(titulo);
  if (!slug) {
    estado("✗ El nombre no puede estar vacío.", "mal");
    return;
  }
  if (slug !== original.slug && categorias.some((c) => c.slug === slug)) {
    estado("✗ Ya existe otra categoría con ese nombre.", "mal");
    return;
  }

  const imagenesFinales = new Set(fotos.map((f) => f.imagen));
  const quitadas = original.datos.fotos
    .map((f) => f.imagen)
    .filter((i) => !imagenesFinales.has(i) && i.startsWith("/uploads/"));
  // La portada es la primera foto que no esté oculta
  const portada = fotos.find((f) => !f.oculta)?.imagen ?? fotos[0]?.imagen ?? "";

  const datos: Categoria["datos"] = {
    ...original.datos,
    titulo,
    tituloEn: tituloEn || "",
    descripcion: descripcion || "",
    descripcionEn: descripcionEn || "",
    portada,
    fotos: fotos.map(({ nueva, ...f }) => f),
  };
  const cambios: Cambio[] = [
    ...fotos.filter((f) => f.nueva).map((f) => ({ ruta: rutaRepo(f.imagen), base64: f.nueva!.base64 })),
    ...quitadas.map((i) => ({ ruta: rutaRepo(i), base64: null })),
    { ruta: `${DIR_CATEGORIAS}/${slug}.json`, base64: jsonCategoria(datos) },
    ...(slug !== original.slug ? [{ ruta: `${DIR_CATEGORIAS}/${original.slug}.json`, base64: null }] : []),
  ];

  const ok = await conEstado("Guardando…", () => almacen.guardar(cambios, `Modificar categoría: ${titulo}`));
  if (ok) {
    categorias = ordenarCategorias(categorias.map((c) => (c.slug === original.slug ? { slug, datos } : c)));
    editando = null;
    pintarCategorias();
    mostrarVista("categorias");
    estado(MSG_PUBLICADO, "ok");
  }
});

// ---------- blog ----------
// Funciona igual que las categorías (Modificar / Ocultar / Eliminar), pero cada entrada tiene
// una sola foto principal en vez de una galería, y el orden es siempre por fecha (no se puede
// arrastrar para reordenar).

// Las ocultas van siempre al final de la lista (igual que las categorías)
const ordenarEntradas = (es: Entrada[]) =>
  [...es].sort(
    (a, b) => Number(!!a.datos.oculta) - Number(!!b.datos.oculta) || (a.datos.orden ?? 99e9) - (b.datos.orden ?? 99e9)
  );

async function cargarEntradas() {
  const lista = $("#lista-blog");
  lista.innerHTML = `<li class="suave">Cargando…</li>`;
  try {
    const archivos = await almacen.listar(DIR_BLOG);
    const brutas = archivos
      .filter((a) => a.ruta.endsWith(".md"))
      .map((a) => ({ slug: a.ruta.split("/").pop()!.replace(/\.md$/, ""), datos: analizarEntrada(a.contenido) }));
    // Entradas de antes de tener esta opción: se les da un orden según su fecha (la más
    // reciente, primero), para que empiecen ordenadas tal y como ya se veían en la web
    const sinOrden = brutas.filter((e) => e.datos.orden == null);
    const base = Math.max(0, ...brutas.map((o) => o.datos.orden ?? 0));
    sinOrden
      .sort((a, b) => new Date(b.datos.fecha).getTime() - new Date(a.datos.fecha).getTime())
      .forEach((e, i) => (e.datos.orden = base + 1 + i));
    entradas = ordenarEntradas(brutas);
    pintarEntradas();
  } catch (e) {
    lista.innerHTML = "";
    estado(`✗ No se han podido cargar las entradas: ${(e as Error).message}`, "mal");
  }
}

function pintarEntradas() {
  const lista = $("#lista-blog");
  if (!entradas.length) {
    lista.innerHTML = `<li class="suave">Todavía no hay entradas.</li>`;
    return;
  }
  lista.innerHTML = entradas
    .map((e, i) => {
      const oculta = !!e.datos.oculta;
      const fecha = new Date(e.datos.fecha).toLocaleDateString("es-ES", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      const asa = oculta
        ? `<span class="asa-espacio" aria-hidden="true"></span>`
        : `<span class="asa-arrastrar" aria-hidden="true">${ICONO_ASA}</span>`;
      return `<li class="${oculta ? "fila-oculta" : ""}" data-slug="${e.slug}">
        ${asa}
        ${e.datos.portada ? `<img src="${escapar(urlImagen(e.datos.portada))}" alt="" loading="lazy" />` : `<span class="sin-foto"></span>`}
        <div class="info">
          <span class="nombre">${escapar(e.datos.titulo)}${oculta ? ` <span class="etiqueta-oculta">Oculta</span>` : ""}</span>
          <span class="contador">${fecha}</span>
        </div>
        <div class="botones">
          <button type="button" class="boton" data-editar-entrada="${i}">Modificar</button>
          <button type="button" class="boton" data-ocultar-entrada="${i}">${oculta ? "Mostrar" : "Ocultar"}</button>
          <button type="button" class="boton peligro" data-eliminar-entrada="${i}">Eliminar</button>
        </div>
      </li>`;
    })
    .join("");
  lista.querySelectorAll<HTMLButtonElement>("[data-editar-entrada]").forEach((b) =>
    b.addEventListener("click", () => abrirEdicionEntrada(entradas[Number(b.dataset.editarEntrada)]))
  );
  lista.querySelectorAll<HTMLButtonElement>("[data-ocultar-entrada]").forEach((b) =>
    b.addEventListener("click", () => alternarOcultarEntrada(entradas[Number(b.dataset.ocultarEntrada)]))
  );
  lista.querySelectorAll<HTMLButtonElement>("[data-eliminar-entrada]").forEach((b) =>
    b.addEventListener("click", () => eliminarEntrada(entradas[Number(b.dataset.eliminarEntrada)]))
  );
}

// Arrastrar (los puntos, a la izquierda) para reordenar las entradas, igual que las categorías
Sortable.create($("#lista-blog"), {
  animation: 150,
  forceFallback: true,
  handle: ".asa-arrastrar",
  ghostClass: "arrastrando",
  onMove: (evt) => !evt.related.classList.contains("fila-oculta"),
  onEnd: async () => {
    const filas = [...document.querySelectorAll<HTMLElement>("#lista-blog li[data-slug]")];
    const cambios: Cambio[] = [];
    filas
      .filter((li) => !li.classList.contains("fila-oculta"))
      .forEach((li, i) => {
        const e = entradas.find((o) => o.slug === li.dataset.slug);
        const nuevoOrden = i + 1;
        if (e && e.datos.orden !== nuevoOrden) {
          e.datos.orden = nuevoOrden;
          cambios.push({ ruta: `${DIR_BLOG}/${e.slug}.md`, base64: textoABase64(serializarEntrada(e.datos)) });
        }
      });
    if (!cambios.length) return;
    const ok = await conEstado("Guardando el nuevo orden…", () => almacen.guardar(cambios, "Reordenar entradas"));
    if (ok) {
      estado(MSG_PUBLICADO, "ok");
      entradas = ordenarEntradas(entradas);
      pintarEntradas();
    }
  },
});

// Ocultar/mostrar
async function alternarOcultarEntrada(e: Entrada) {
  const oculta = !e.datos.oculta;
  const datos: Entrada["datos"] = { ...e.datos, oculta };
  const ok = await conEstado(oculta ? "Ocultando…" : "Mostrando…", () =>
    almacen.guardar(
      [{ ruta: `${DIR_BLOG}/${e.slug}.md`, base64: textoABase64(serializarEntrada(datos)) }],
      `${oculta ? "Ocultar" : "Mostrar"} entrada: ${e.datos.titulo}`
    )
  );
  if (ok) {
    estado(`${MSG_PUBLICADO} «${e.datos.titulo}» ${oculta ? "oculta" : "visible de nuevo"}.`, "ok");
    e.datos = datos;
    entradas = ordenarEntradas(entradas);
    pintarEntradas();
  }
}

// Añadir
const dialogoEntrada = $<HTMLDialogElement>("#dialogo-entrada");
$("#nueva-entrada").addEventListener("click", () => {
  dialogoEntrada.querySelector("form")!.reset();
  $("#error-entrada").textContent = "";
  dialogoEntrada.showModal();
});

dialogoEntrada.querySelector("form")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const titulo = String(new FormData(e.currentTarget as HTMLFormElement).get("titulo")).trim();
  const slug = slugify(titulo);
  if (!slug) {
    $("#error-entrada").textContent = "Escribe un título.";
    return;
  }
  if (entradas.some((o) => o.slug === slug)) {
    $("#error-entrada").textContent = "Ya existe una entrada con ese título.";
    return;
  }
  dialogoEntrada.close();
  const orden = Math.max(0, ...entradas.map((e) => e.datos.orden ?? 0)) + 1;
  const nueva: Entrada = {
    slug,
    datos: { titulo, fecha: new Date().toISOString(), portada: "", resumen: "", orden, cuerpo: "" },
  };
  const ok = await conEstado("Creando entrada…", () =>
    almacen.guardar(
      [{ ruta: `${DIR_BLOG}/${slug}.md`, base64: textoABase64(serializarEntrada(nueva.datos)) }],
      `Nueva entrada: ${titulo}`
    )
  );
  if (ok) {
    estado(`${MSG_PUBLICADO} Ahora puedes escribirla.`, "ok");
    entradas = ordenarEntradas([...entradas, nueva]);
    pintarEntradas();
    abrirEdicionEntrada(nueva);
  }
});

// Eliminar
async function eliminarEntrada(e: Entrada) {
  const seguro = await confirmar(
    `¿Estás segura de que quieres eliminar «${e.datos.titulo}»?`,
    "Se borrará la entrada del blog. No se puede deshacer."
  );
  if (!seguro) return;
  const cambios: Cambio[] = [{ ruta: `${DIR_BLOG}/${e.slug}.md`, base64: null }];
  if (e.datos.portada && e.datos.portada.startsWith("/uploads/")) {
    const usada = entradas.some((o) => o.slug !== e.slug && o.datos.portada === e.datos.portada);
    if (!usada) cambios.push({ ruta: rutaRepo(e.datos.portada), base64: null });
  }
  const ok = await conEstado("Eliminando…", () => almacen.guardar(cambios, `Eliminar entrada: ${e.datos.titulo}`));
  if (ok) {
    estado(`${MSG_PUBLICADO} «${e.datos.titulo}» eliminada.`, "ok");
    entradas = entradas.filter((o) => o.slug !== e.slug);
    pintarEntradas();
  }
}

// El editor de texto (una sola vez; cada entrada solo cambia lo que contiene)
const TOOLBAR_ENTRADA = [
  "bold",
  "italic",
  "heading-2",
  "heading-3",
  "|",
  "quote",
  "unordered-list",
  "ordered-list",
  "|",
  "link",
  "image",
  "|",
  "preview",
  "guide",
] as const;

// uploadImage hace que el botón de imagen (y arrastrar o pegar una foto) suba el archivo de
// verdad, en vez de solo escribir un hueco de texto para pegar una URL
const entradaMde = new EasyMDE({
  element: $<HTMLTextAreaElement>("#entrada-cuerpo"),
  spellChecker: false,
  status: ["lines", "words"],
  placeholder: "Escribe aquí la entrada…",
  toolbar: [...TOOLBAR_ENTRADA],
  uploadImage: true,
  imageAccept: "image/png, image/jpeg, image/gif, image/webp",
  imageMaxSize: 20 * 1024 * 1024,
  imageUploadFunction: subirImagenEditor,
  imageTexts: {
    sbInit: "Arrastra una foto o pulsa el icono de imagen para insertarla",
    sbOnDragEnter: "Suelta la foto para subirla",
    sbOnDrop: "Subiendo foto…",
    sbProgress: "Subiendo #images_names#: #percent#%",
    sbOnUploaded: "Subida",
    sizeUnits: " B, KB, MB",
  },
  errorMessages: {
    noFileGiven: "No se ha elegido ningún archivo.",
    typeNotAllowed: "Ese tipo de archivo no está permitido.",
    fileTooLarge: "La foto pesa demasiado (máximo #maxSize#).",
    importError: "Algo ha fallado al subir la foto.",
  },
});

const entradaMdeEn = new EasyMDE({
  element: $<HTMLTextAreaElement>("#entrada-cuerpo-en"),
  spellChecker: false,
  status: ["lines", "words"],
  placeholder: "Déjalo en blanco para que, en inglés, se siga viendo el texto en español…",
  toolbar: [...TOOLBAR_ENTRADA],
  uploadImage: true,
  imageAccept: "image/png, image/jpeg, image/gif, image/webp",
  imageMaxSize: 20 * 1024 * 1024,
  imageUploadFunction: subirImagenEditor,
  imageTexts: {
    sbInit: "Arrastra una foto o pulsa el icono de imagen para insertarla",
    sbOnDragEnter: "Suelta la foto para subirla",
    sbOnDrop: "Subiendo foto…",
    sbProgress: "Subiendo #images_names#: #percent#%",
    sbOnUploaded: "Subida",
    sizeUnits: " B, KB, MB",
  },
  errorMessages: {
    noFileGiven: "No se ha elegido ningún archivo.",
    typeNotAllowed: "Ese tipo de archivo no está permitido.",
    fileTooLarge: "La foto pesa demasiado (máximo #maxSize#).",
    importError: "Algo ha fallado al subir la foto.",
  },
});

function pintarPortadaEntrada() {
  if (!editandoEntrada) return;
  const { portada, portadaNueva } = editandoEntrada;
  $("#entrada-portada-marco").innerHTML = portada
    ? `<img src="${escapar(portadaNueva?.vista ?? urlImagen(portada))}" alt="" />`
    : `<span class="suave">Sin foto</span>`;
  $<HTMLButtonElement>("#entrada-quitar-portada").hidden = !portada;
}

$<HTMLInputElement>("#entrada-subir-portada").addEventListener("change", async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const archivo = input.files?.[0];
  input.value = "";
  if (!editandoEntrada || !archivo) return;
  try {
    const nueva = await prepararImagen(archivo);
    const nombre = `${slugify(archivo.name.replace(/\.[^.]+$/, "")) || "portada"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`;
    editandoEntrada.portada = `/uploads/blog/${nombre}`;
    editandoEntrada.portadaNueva = nueva;
    pintarPortadaEntrada();
  } catch {
    estado("✗ No se ha podido leer esa imagen.", "mal");
  }
});

$("#entrada-quitar-portada").addEventListener("click", () => {
  if (!editandoEntrada) return;
  editandoEntrada.portada = "";
  editandoEntrada.portadaNueva = undefined;
  pintarPortadaEntrada();
});

// Modificar
function abrirEdicionEntrada(e: Entrada) {
  editandoEntrada = { original: e, portada: e.datos.portada ?? "" };
  imagenesPendientesTexto = [];
  $("#entrada-titulo-visor").textContent = e.datos.titulo;
  $<HTMLInputElement>("#entrada-titulo").value = e.datos.titulo;
  $<HTMLInputElement>("#entrada-titulo-en").value = e.datos.tituloEn ?? "";
  $<HTMLInputElement>("#entrada-fecha").value = e.datos.fecha.slice(0, 10);
  $<HTMLInputElement>("#entrada-resumen").value = e.datos.resumen ?? "";
  $<HTMLInputElement>("#entrada-resumen-en").value = e.datos.resumenEn ?? "";
  pintarPortadaEntrada();
  entradaMde.value(e.datos.cuerpo);
  entradaMdeEn.value(e.datos.cuerpoEn ?? "");
  mostrarVista("editar-entrada");
  // El editor se dibuja mal si estaba oculto al crearse
  entradaMde.codemirror.refresh();
  entradaMdeEn.codemirror.refresh();
}

$("#volver-blog").addEventListener("click", salirEdicionEntrada);
$("#entrada-cancelar").addEventListener("click", salirEdicionEntrada);

function hayCambiosEntrada() {
  if (!editandoEntrada) return false;
  return (
    $<HTMLInputElement>("#entrada-titulo").value.trim() !== editandoEntrada.original.datos.titulo ||
    $<HTMLInputElement>("#entrada-titulo-en").value.trim() !== (editandoEntrada.original.datos.tituloEn ?? "") ||
    $<HTMLInputElement>("#entrada-fecha").value !== editandoEntrada.original.datos.fecha.slice(0, 10) ||
    $<HTMLInputElement>("#entrada-resumen").value.trim() !== (editandoEntrada.original.datos.resumen ?? "") ||
    $<HTMLInputElement>("#entrada-resumen-en").value.trim() !== (editandoEntrada.original.datos.resumenEn ?? "") ||
    editandoEntrada.portada !== (editandoEntrada.original.datos.portada ?? "") ||
    entradaMde.value().trim() !== editandoEntrada.original.datos.cuerpo.trim() ||
    entradaMdeEn.value().trim() !== (editandoEntrada.original.datos.cuerpoEn ?? "").trim()
  );
}

function salirEdicionEntrada() {
  if (hayCambiosEntrada() && !window.confirm("Hay cambios sin guardar. ¿Salir igualmente?")) return;
  editandoEntrada = null;
  estado("");
  mostrarVista("blog");
}

$("#entrada-guardar").addEventListener("click", async () => {
  if (!editandoEntrada) return;
  const { original } = editandoEntrada;
  const titulo = $<HTMLInputElement>("#entrada-titulo").value.trim();
  const tituloEn = $<HTMLInputElement>("#entrada-titulo-en").value.trim();
  const fechaInput = $<HTMLInputElement>("#entrada-fecha").value;
  const resumen = $<HTMLInputElement>("#entrada-resumen").value.trim();
  const resumenEn = $<HTMLInputElement>("#entrada-resumen-en").value.trim();
  const cuerpo = entradaMde.value().trim();
  const cuerpoEn = entradaMdeEn.value().trim();
  const slug = slugify(titulo);
  if (!slug) {
    estado("✗ El título no puede estar vacío.", "mal");
    return;
  }
  if (!fechaInput) {
    estado("✗ Pon una fecha.", "mal");
    return;
  }
  if (slug !== original.slug && entradas.some((e) => e.slug === slug)) {
    estado("✗ Ya existe otra entrada con ese título.", "mal");
    return;
  }

  const datos: Entrada["datos"] = {
    ...original.datos,
    titulo,
    tituloEn: tituloEn || "",
    fecha: `${fechaInput}T10:00:00.000Z`,
    resumen: resumen || "",
    resumenEn: resumenEn || "",
    portada: editandoEntrada.portada || "",
    cuerpo,
    cuerpoEn: cuerpoEn || "",
  };
  const cambios: Cambio[] = [];
  if (editandoEntrada.portadaNueva) {
    cambios.push({ ruta: rutaRepo(editandoEntrada.portada), base64: editandoEntrada.portadaNueva.base64 });
  }
  const portadaAnterior = original.datos.portada;
  if (portadaAnterior && portadaAnterior !== editandoEntrada.portada && portadaAnterior.startsWith("/uploads/")) {
    const usada = entradas.some((e) => e.slug !== original.slug && e.datos.portada === portadaAnterior);
    if (!usada) cambios.push({ ruta: rutaRepo(portadaAnterior), base64: null });
  }
  // Las fotos puestas dentro del texto con el editor: se cambia su vista previa por la ruta final
  datos.cuerpo = resolverImagenesEditor(datos.cuerpo, cambios);
  if (datos.cuerpoEn) datos.cuerpoEn = resolverImagenesEditor(datos.cuerpoEn, cambios);
  cambios.push({ ruta: `${DIR_BLOG}/${slug}.md`, base64: textoABase64(serializarEntrada(datos)) });
  if (slug !== original.slug) cambios.push({ ruta: `${DIR_BLOG}/${original.slug}.md`, base64: null });

  const ok = await conEstado("Guardando…", () => almacen.guardar(cambios, `Modificar entrada: ${titulo}`));
  if (ok) {
    entradas = ordenarEntradas(entradas.map((e) => (e.slug === original.slug ? { slug, datos } : e)));
    editandoEntrada = null;
    pintarEntradas();
    mostrarVista("blog");
    estado(MSG_PUBLICADO, "ok");
  }
});

// Botones «Cancelar» de los diálogos
document.querySelectorAll<HTMLButtonElement>("[data-cerrar]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog")!.close())
);

// En `npm run dev`, guardar archivos hace que la página se recargue sola y se perdería lo que
// se está haciendo en el panel. Aquí se ignoran esas recargas (solo en local).
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", (aviso: { path?: string }) => {
    aviso.path = "/__panel-sin-recarga.html";
  });
}

// ---------- inicio: si ya había sesión abierta en esta pestaña, entra directamente ----------
try {
  const guardado = sessionStorage.getItem(CLAVE_SESION);
  if (guardado) entrar(JSON.parse(guardado));
} catch {}
