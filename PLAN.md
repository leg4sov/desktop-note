# Post-it — Extensión de GNOME Shell

Estado del proyecto y decisiones de diseño. Entorno objetivo: **GNOME Shell 50, Wayland, Fedora 44**.

## 1. Requisitos (cerrados)

| Tema | Decisión |
|---|---|
| Nº de notas | Una sola |
| Icono en la barra | Notita amarilla en miniatura. Clic = mostrar / ocultar la nota |
| Sin anclar | La nota vive **debajo de las ventanas**, como widget del escritorio |
| Anclado (pin) | **Siempre por encima** de las ventanas |
| Posición | Esquina superior derecha por defecto, **arrastrable** desde la cabecera (también anclada) |
| Tamaño | Fijo 210×210 px, scroll vertical si hay muchas líneas |
| Escritura | Una línea por tarea. **Enter** fija la línea y abre otra debajo |
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
| Nota: cabecera (zona de arrastre + pin) / lista / pie | `St.BoxLayout`, `St.ScrollView` |
| Fila = tick + campo de texto, con estados `new` → `open` → `done` | `St.Button`, `St.Entry` |
| Arrastre | `global.stage.grab` + eventos de ratón (sin `Clutter.DragAction`) |
| Capas | `Main.layoutManager.addTopChrome` / `removeChrome` (anclada) y `_backgroundGroup` (sin anclar, API interna) |
| Guardado | `Gio.File.replace_contents` |

### Persistencia

`~/.local/share/postit-note/notes.json`, fuera de la carpeta de la extensión para que reinstalarla no borre nada.

```json
{ "visible": true, "pinned": false, "x": 1400, "y": 60,
  "lines": [ { "text": "Entregar práctica", "done": false } ] }
```

- Cada cambio (tecla, tachar, borrar, mover, anclar, mostrar/ocultar) programa un guardado a los **500 ms** (debounce).
- Escritura **atómica** (temporal + renombrado).
- Guardado inmediato en `disable()`.
- JSON corrupto: se aparta como `notes.json.bak` y se arranca vacío.
- La posición guardada se ajusta a la pantalla actual si cambió el monitor.

## 3. Decisiones y problemas resueltos

| Tema | Qué pasó | Solución |
|---|---|---|
| Monitor nulo en `enable()` | `primaryMonitor` no existe aún al arrancar la sesión | Posicionar en `startup-complete` |
| `ensureActorVisibleInScrollView` | Ya no existe en GNOME 50 | Scroll manual con `vadjustment` |
| Pin sin respuesta | La cabecera tomaba el `grab` del ratón y el pin nunca recibía el "soltar" | Zona de arrastre y pin como hijos separados de la cabecera |
| Re-anclar daba error | `addTopChrome` registra el actor; sacarlo a mano lo dejaba registrado | `removeChrome` al desanclar |
| Rastro de líneas al arrastrar | Probable: la `box-shadow` grande se sale del área repintada | Sin sombra, borde fino de 1 px |
| Esquina doblada | El CSS de St no puede recortar una esquina en diagonal | Descartada; la nota es plana |

## 4. Cómo probar sin cerrar sesión

En Wayland no se puede reiniciar la shell. Se usa una shell anidada (paquete `mutter-devkit`), con configuración aislada para que solo cargue esta extensión:

```bash
export GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=/ruta/a/cfg   # con enabled-extensions=['postit@leg4sov']
dbus-run-session gnome-shell --devkit --wayland
```

Prueba final real: cerrar sesión y volver a entrar.

## 5. Pendiente

- [ ] Probar la persistencia en una sesión real (logout/login).
- [ ] Insertar una línea entre otras (hoy Enter en una línea del medio solo pasa el foco).
- [ ] Publicar en extensions.gnome.org (requiere `gnome-extensions pack`, licencia y revisión).

## 6. Fuera de alcance (a propósito)

Varias notas, colores alternativos, redimensionar, fuente manuscrita, ventana de preferencias, sincronización en la nube.
