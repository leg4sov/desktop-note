// Post-it: icono en la barra + nota con lista de tareas.
//  - Enter fija la línea y abre otra debajo.
//  - Tick a la izquierda: 1er clic tacha, 2º clic borra la línea.
//  - La nota está siempre por encima de las ventanas (se oculta sola sobre una ventana a pantalla completa).
//  - La cabecera (zona de arriba) sirve para arrastrarla.
//  - Doble clic en cualquier hueco de la nota pone el cursor en la línea de escribir.
//  - Todo se guarda solo en ~/.local/share/postit-note/notes.json y se restaura al activar la extensión.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const NOTE_SIZE = 210;
const SAVE_DELAY_MS = 500;   // debounce: mientras sigues escribiendo no se toca el disco
const DOUBLE_CLICK_PX = 8;   // margen de movimiento entre los dos clics de un doble clic

const clamp = (v, max) => Math.max(0, Math.min(v, max));

export default class PostItExtension extends Extension {
    enable() {
        this._closing = false;
        this._writing = false;
        this._dirty = false;
        this._lastPress = null;
        this._path = GLib.build_filenamev([GLib.get_user_data_dir(), 'postit-note', 'notes.json']);
        this._saved = this._load();

        // Icono de la barra: notita en miniatura (franja pegajosa + dos rayitas de texto)
        const icon = new St.BoxLayout({style_class: 'postit-icon', vertical: true, y_align: Clutter.ActorAlign.CENTER});
        icon.add_child(new St.Widget({style_class: 'postit-icon-strip'}));
        icon.add_child(new St.Widget({style_class: 'postit-icon-line'}));
        icon.add_child(new St.Widget({style_class: 'postit-icon-line postit-icon-line-short'}));
        this._button = new PanelMenu.Button(0.0, 'Post-it', true);
        this._button.add_child(icon);
        this._button.connect('button-press-event', () => {
            this._toggle();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._button);

        // Dos capas: _box es el "chrome" que GNOME oculta sobre ventanas a pantalla completa (trackFullscreen
        // escribe su .visible); _note es lo que oculta el usuario. Así ninguna de las dos pisa a la otra.
        this._box = new Clutter.Actor();
        this._note = new St.BoxLayout({style_class: 'postit', vertical: true, reactive: true});
        this._box.add_child(this._note);

        const header = new St.Widget({style_class: 'postit-header', reactive: true});   // cabecera = zona de arrastre
        this._connectDrag(header);
        this._note.connect('button-press-event', (_a, event) => this._onNotePress(event));

        this._lines = new St.BoxLayout({style_class: 'postit-lines', vertical: true});
        this._scroll = new St.ScrollView({
            style_class: 'postit-scroll', y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.set_child(this._lines);

        this._note.add_child(header);
        this._note.add_child(this._scroll);
        this._note.add_child(new St.Widget({style_class: 'postit-footer'}));

        // Restaurar líneas guardadas y dejar una vacía al final para escribir
        this._loading = true;
        const lines = Array.isArray(this._saved.lines) ? this._saved.lines : [];
        for (const l of lines) {
            const text = typeof l?.text === 'string' ? l.text.replace(/[\r\n]+/g, ' ').trim() : '';
            if (text) this._addRow(false, text, l.done === true);
        }
        this._addRow(false);
        this._loading = false;

        Main.layoutManager.addTopChrome(this._box, {trackFullscreen: true});
        this._note.visible = this._saved.visible !== false;
        // Si cambia la configuración de pantallas (p. ej. desenchufas un monitor) la nota vuelve a caber.
        // Solo tras la primera colocación: al arrancar llega antes que startup-complete y la dejaría en 0,0.
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this._placed) this._place(this._box.x, this._box.y);
        }, this);
        // El monitor puede no existir todavía al arrancar la sesión: esperamos a que esté listo.
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._place(this._saved?.x, this._saved?.y), this);
        else
            this._place(this._saved.x, this._saved.y);
    }

    _toggle() {
        const show = !this._note.visible, focus = global.stage.get_key_focus();
        // Al ocultarla con el cursor dentro, se suelta el foco: si no, lo que tecleas iría a la nota invisible.
        if (!show && focus && this._note.contains(focus))
            global.stage.set_key_focus(null);
        this._note.visible = show;
        this._queueSave();
    }

    // Doble clic en un hueco (no en una fila ni en la barra de scroll): cursor a la línea de escribir.
    // Nunca se corta el evento: devolver EVENT_STOP aquí cancelaba el gesto de clic del tick en GNOME 50.
    _onNotePress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        for (let a = global.stage.get_event_actor(event); a && a !== this._note; a = a.get_parent())
            if (a._entry || a instanceof St.ScrollBar) return Clutter.EVENT_PROPAGATE;

        const t = event.get_time(), [x, y] = event.get_coords(), p = this._lastPress;
        const double = p && t - p.t <= Clutter.Settings.get_default().double_click_time &&
            Math.abs(x - p.x) <= DOUBLE_CLICK_PX && Math.abs(y - p.y) <= DOUBLE_CLICK_PX;
        this._lastPress = double ? null : {t, x, y};
        if (double) this._lines.get_last_child()?._entry.grab_key_focus();
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- Persistencia ----
    _load() {
        const file = Gio.File.new_for_path(this._path);
        try {
            const [, bytes] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                // Archivo corrupto: se aparta como .bak para no perderlo ni sobrescribirlo a ciegas
                console.error(`postit: no se pudo leer ${this._path}: ${e.message}`);
                try { file.move(Gio.File.new_for_path(`${this._path}.bak`), Gio.FileCopyFlags.OVERWRITE, null, null); } catch (_e) { /* ya no existe */ }
            }
            return {};
        }
    }

    _queueSave() {
        if (this._closing || this._loading || !this._placed) return;
        if (this._saveId) GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Normalmente asíncrono: la shell no se congela esperando al disco (replace hace fsync).
    // En disable() es síncrono porque la sesión puede estar cerrándose y no hay "después".
    _saveNow(sync = false) {
        if (this._saveId) { GLib.source_remove(this._saveId); this._saveId = 0; }
        if (!this._placed) return;
        const lines = this._lines.get_children()
            .map(r => ({text: r._entry.text.trim(), done: r._state === 'done'}))
            .filter(l => l.text);
        const data = {visible: this._note.visible, x: this._box.x, y: this._box.y, lines};
        const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
        const file = Gio.File.new_for_path(this._path);
        const flags = Gio.FileCreateFlags.REPLACE_DESTINATION;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
            if (sync) {
                this._cancellable?.cancel();          // un guardado asíncrono a medias no debe pisar a este
                this._cancellable = null;
                file.replace_contents(bytes, null, false, flags, null);
                return;
            }
        } catch (e) {
            console.error(`postit: no se pudo guardar: ${e.message}`);
            return;
        }
        // Una sola escritura a la vez; si llegan cambios mientras tanto, se guarda otra vez al terminar.
        if (this._writing) { this._dirty = true; return; }
        this._writing = true;
        const c = this._cancellable = new Gio.Cancellable();
        file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false, flags, c, (f, res) => {
            try {
                f.replace_contents_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) console.error(`postit: no se pudo guardar: ${e.message}`);
            }
            if (c !== this._cancellable) return;      // respuesta de una sesión anterior (disable/enable)
            this._writing = false;
            if (this._dirty) { this._dirty = false; this._saveNow(); }
        });
    }

    // Una fila = [tick] [campo de texto]. Estados: 'new' (línea de escribir) → 'open' (fijada) → 'done' (tachada).
    _addRow(focus = true, text = '', done = false) {
        const row = new St.BoxLayout({style_class: 'postit-row'});
        // El tick ocupa sitio siempre (opacidad 0 mientras es "new") para que el texto no salte al fijar la línea.
        const tick = new St.Button({
            style_class: 'postit-tick', can_focus: false, opacity: 0, reactive: false, y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'postit-tick-icon'}),
        });
        const entry = new St.Entry({style_class: 'postit-line postit-line-new', can_focus: true, x_expand: true, text});
        row._entry = entry;
        row._state = 'new';

        const open = () => {
            row._state = 'open';
            entry.remove_style_class_name('postit-line-new');
            tick.opacity = 255;
            tick.reactive = true;
        };
        const strike = () => {
            row._state = 'done';
            entry.add_style_class_name('postit-line-done');
            entry.clutter_text.editable = false;
            tick.add_style_class_name('postit-tick-done');
        };
        // Borrar la fila dejando el cursor en otra (si no, el foco se pierde con la fila destruida)
        const remove = target => {
            target?._entry.grab_key_focus();
            row.destroy();
        };

        entry.clutter_text.connect('text-changed', () => this._queueSave());
        entry.clutter_text.connect('key-focus-in', () => this._scrollTo(row));   // con ↑/↓ la línea nunca queda fuera de vista
        row.connect('destroy', () => {
            if (this._scrollTarget === row) this._scrollTarget = null;
            this._queueSave();
        });

        entry.clutter_text.connect('activate', () => {
            const next = row.get_next_sibling();
            if (!entry.text.trim()) {                      // vacía: la línea de escribir no hace nada; una ya fijada se borra
                if (row._state !== 'new') remove(next);
                return;
            }
            if (row._state === 'new') {
                open();
                this._addRow();                            // nueva línea debajo, con foco
                this._queueSave();
            } else {
                next?._entry.grab_key_focus();
            }
        });

        // Teclado: ↑/↓ cambian de línea, Backspace en una línea vacía la borra y sube, Esc suelta el foco
        entry.clutter_text.connect('key-press-event', (_a, ev) => {
            const prev = row.get_previous_sibling();
            switch (ev.get_key_symbol()) {
            case Clutter.KEY_Up:
                prev?._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                row.get_next_sibling()?._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Escape:
                global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_BackSpace:
                if (entry.text !== '' || !prev) return Clutter.EVENT_PROPAGATE;
                if (row._state === 'new') prev._entry.grab_key_focus();   // la línea de escribir no se borra, solo se sale de ella
                else remove(prev);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        tick.connect('clicked', () => {
            if (row._state === 'open') strike();           // 1er clic: tachar
            else if (row._state === 'done') row.destroy(); // 2º clic: borrar
            this._queueSave();
        });

        if (text) {                                        // fila restaurada del disco (el texto ya va en el constructor)
            open();
            if (done) strike();
        }

        row.add_child(tick);
        row.add_child(entry);
        this._lines.add_child(row);
        if (focus) entry.grab_key_focus();
        return row;
    }

    // Desplaza la lista lo justo para que se vea la fila. Va en un idle porque una fila recién creada
    // aún no tiene posición; si se piden varias seguidas, solo cuenta la última.
    _scrollTo(row) {
        this._scrollTarget = row;
        this._scrollId ||= GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._scrollId = 0;
            const r = this._scrollTarget, adj = this._scroll?.vadjustment;
            this._scrollTarget = null;
            if (r && adj) {
                if (r.y < adj.value) adj.value = r.y;
                else if (r.y + r.height > adj.value + adj.page_size) adj.value = r.y + r.height - adj.page_size;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Arrastrar la nota agarrando la cabecera. global.stage.grab captura el ratón aunque salga de la nota.
    // Sin box-shadow en la nota: la sombra dejaba rastro de líneas al moverla.
    _connectDrag(header) {
        header.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._grab) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._dragOff = [x - this._box.x, y - this._box.y];
            this._grab = global.stage.grab(header);
            return Clutter.EVENT_STOP;
        });
        header.connect('motion-event', (_a, event) => {
            if (!this._grab) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._box.set_position(
                clamp(x - this._dragOff[0], global.stage.width - this._note.width),
                clamp(y - this._dragOff[1], global.stage.height - this._note.height));
            return Clutter.EVENT_STOP;
        });
        header.connect('button-release-event', () => {
            if (!this._grab) return Clutter.EVENT_PROPAGATE;
            this._grab.dismiss();
            this._grab = null;
            this._queueSave();
            return Clutter.EVENT_STOP;
        });
    }

    // Posición pedida si su centro cae en algún monitor (ajustada para que la nota quepa entera en él);
    // si no, o si no hay posición guardada, esquina superior derecha del monitor principal.
    // Se valida contra los monitores y no contra el tamaño total de la pantalla: con varios monitores
    // de distinto tamaño hay zonas "muertas" donde la nota quedaría invisible.
    _place(x, y) {
        const lm = Main.layoutManager;
        let m = lm.primaryMonitor;
        if (!m) return;
        const cx = x + NOTE_SIZE / 2, cy = y + NOTE_SIZE / 2;   // NaN si no hay posición: ningún monitor la contiene
        const on = lm.monitors.find(o => cx >= o.x && cx < o.x + o.width && cy >= o.y && cy < o.y + o.height);
        if (on) {
            m = on;
        } else {
            x = m.x + m.width - NOTE_SIZE - 20;
            y = m.y + 60;
        }
        this._box.set_position(
            Math.max(m.x, Math.min(x, m.x + m.width - NOTE_SIZE)),
            Math.max(m.y, Math.min(y, m.y + m.height - NOTE_SIZE)));
        this._placed = true;
    }

    disable() {
        this._saveNow(true);      // guardado inmediato: bloqueo de pantalla, desactivar, cerrar sesión
        this._closing = true;     // a partir de aquí, destruir filas ya no programa más guardados
        Main.layoutManager.disconnectObject(this);
        if (this._scrollId) GLib.source_remove(this._scrollId);
        this._grab?.dismiss();
        this._scrollId = 0;
        this._grab = this._scrollTarget = null;
        const focus = global.stage.get_key_focus();
        if (focus && this._box?.contains(focus)) global.stage.set_key_focus(null);   // no destruir un campo con el cursor dentro
        if (this._box) Main.layoutManager.removeChrome(this._box);
        this._box?.destroy();
        this._button?.destroy();
        this._box = this._note = this._button = this._lines = this._scroll = this._saved = null;
        this._placed = false;
    }
}
