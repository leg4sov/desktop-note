# Post-it — Extensión de GNOME Shell

Estado del proyecto y decisiones de diseño. Entorno objetivo: **GNOME Shell 50, Wayland, Fedora 44**.

## 1. Requisitos (cerrados)

| Tema | Decisión |
|---|---|
| Nº de notas | Una sola |
| Icono en la barra | Notita amarilla en miniatura. Clic = mostrar / ocultar la nota |
| Capa | Siempre **por encima** de las ventanas (sin modo "debajo": no tenía sentido práctico). Se oculta sola sobre una ventana a pantalla completa |
| Posición | Esquina superior derecha por defecto, **arrastrable** desde la cabecera |
| Tamaño | Fijo 210×210 px, scroll vertical si hay muchas líneas |
| Escritura | Una línea por tarea. **Enter** fija la línea y abre otra debajo. **Doble clic** en un hueco de la nota (menos la cabecera) pone el cursor en la línea de escribir |
| Tachar | Tick ✓ a la izquierda: 1er clic tacha, 2º clic borra la línea |
| Teclado | ↑/↓ cambian de línea, Backspace en línea vacía la borra, Esc suelta el foco |
| Estilo | Papel amarillo plano con degradado, franja adhesiva arriba, borde fino, sin sombra |
| Guardado | **Automático** en disco; al reiniciar todo sigue igual |
| Activación | Desde la app *Extensiones* como cualquier otra |

## 2. Arquitectura

```
desktop-note/
├── metadata.json     # uuid postit@leg4sov, shell-version ["50"]
├── extension.js      # toda la lógica
├── stylesheet.css    # aspecto
├── PLAN.md
└── README.md
```

Se desarrolla aquí y se enlaza con un symlink:

```bash
ln -s ~/Documents/Projects/desktop-note ~/.local/share/gnome-shell/extensions/postit@leg4sov
```

### Piezas de `extension.js`

| Pieza | API de GNOME |
|---|---|
| Clase `PostItExtension` (`enable()` crea todo, `disable()` lo destruye) | `Extension` (ESM) |
| Icono de la barra | `PanelMenu.Button` + `Main.panel.addToStatusArea` |
| Nota: cabecera (zona de arrastre) / lista / pie | `St.BoxLayout`, `St.ScrollView` |
| Fila = tick + campo de texto, con estados `new` → `open` → `done` | `St.Button`, `St.Entry` |
| Arrastre | `global.stage.grab` + eventos de ratón (sin `Clutter.DragAction`) |
| Capas | `_box` (Clutter.Actor) con `addTopChrome(…, {trackFullscreen: true})`; dentro, la nota. GNOME controla la visibilidad de `_box` y el usuario la de la nota |
| Doble clic | `button-press-event` en la nota + `event.get_time()` y `Clutter.Settings.double_click_time` (Clutter 18 ya no tiene `get_click_count`) |
| Guardado | `replace_contents_bytes_async` (normal) / `replace_contents` (en `disable()`) |

### Persistencia

`~/.local/share/postit-note/notes.json`, fuera de la carpeta de la extensión para que reinstalarla no borre nada.

```json
{ "visible": true, "x": 1400, "y": 60,
  "lines": [ { "text": "Entregar práctica", "done": false } ] }
```

- Cada cambio (tecla, tachar, borrar, mover, mostrar/ocultar) programa un guardado a los **500 ms** (debounce).
- Escritura **atómica** (temporal + renombrado) y **asíncrona**: una sola a la vez; si llegan cambios mientras escribe, se guarda otra vez al acabar.
- Guardado inmediato y **síncrono** en `disable()` (cancela el asíncrono en curso para que no lo pise).
- JSON corrupto: se aparta como `notes.json.bak` y se arranca vacío.
- La posición se valida contra los **monitores** (no contra el tamaño total del escritorio): si el centro de la nota no cae en ninguno, vuelve a la esquina por defecto; si cae, se ajusta para quedar entera en ese monitor. Se recoloca también con `monitors-changed`.

## 3. Decisiones y problemas resueltos

| Tema | Qué pasó | Solución |
|---|---|---|
| Monitor nulo en `enable()` | `primaryMonitor` no existe aún al arrancar la sesión | Posicionar en `startup-complete` |
| `ensureActorVisibleInScrollView` | Ya no existe en GNOME 50 | Scroll manual con `vadjustment` |
| Rastro de líneas al arrastrar | Probable: la `box-shadow` grande se sale del área repintada | Sin sombra, borde fino de 1 px |
| Esquina doblada | El CSS de St no puede recortar una esquina en diagonal | Descartada; la nota es plana |
| Tachar dejó de funcionar | Un `button-press-event` en la nota que devolvía `EVENT_STOP` cancelaba el gesto de clic del tick (GNOME 50 usa `Clutter.ClickGesture` en `St.Button`) | El manejador de la nota siempre devuelve `EVENT_PROPAGATE` e ignora clics dentro de una fila |
| Nota en 0,0 al arrancar | `monitors-changed` llega antes que `startup-complete` y recolocaba la nota en su posición inicial (0,0), que luego se guardaba | Se ignora hasta la primera colocación |
| Teclear en la nota oculta | Al ocultarla con el cursor dentro, el foco seguía en el campo invisible | Se suelta el foco al ocultar y en `disable()` |
| Borrar una línea perdía el foco | Destruir la fila con foco lo dejaba en ningún sitio | Antes de destruirla se pasa el foco a la vecina |
| Archivo con `lines` no-array | `for…of` sobre un objeto rompía `enable()` | `Array.isArray` + texto saneado (sin saltos de línea) |
| Línea fuera de vista con ↑/↓ | El scroll solo bajaba al final al crear filas | `_scrollTo(fila)` al recibir el foco |

## 4. Cómo probar sin cerrar sesión

En Wayland no se puede reiniciar la shell. Se usa una shell anidada (paquete `mutter-devkit`), con configuración aislada para que solo cargue esta extensión:

```bash
export GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=/ruta/a/cfg   # con enabled-extensions=['postit@leg4sov']
dbus-run-session gnome-shell --devkit --wayland
```

Para probar la interacción sin manos hay un arnés (fuera del repo) que crea un ratón y un teclado virtuales con `seat.create_virtual_device()` y comprueba: tachar, borrar, clic simple vs doble, escribir + Enter, ↑, ocultar con foco, guardado, arrastre, disable/enable y la colocación.

Prueba final real: cerrar sesión y volver a entrar.

## 5. Pendiente

- [ ] Probar la persistencia en una sesión real (logout/login).
- [ ] Comprobar en real que se oculta sobre una ventana a pantalla completa (no probado en la shell anidada).
- [ ] Insertar una línea entre otras (hoy Enter en una línea del medio solo pasa el foco).
- [ ] Publicar en extensions.gnome.org (requiere `gnome-extensions pack`, licencia y revisión).

## 6. Fuera de alcance (a propósito)

Varias notas, colores alternativos, redimensionar, fuente manuscrita, ventana de preferencias, sincronización en la nube.
