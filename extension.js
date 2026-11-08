// Post-it: icono en la barra + nota con lista de tareas.
//  - Enter fija la línea y abre otra debajo.
//  - Tick a la izquierda: 1er clic tacha, 2º clic borra la línea.
//  - La cabecera (zona de arriba) sirve para arrastrar la nota; el pin la ancla por encima de las ventanas.
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

export default class PostItExtension extends Extension {
    enable() {
        this._pinned = false;
        this._closing = false;
        this._path = GLib.build_filenamev([GLib.get_user_data_dir(), 'postit-note', 'notes.json']);
        this._saved = this._load();

        // Icono de la barra: notita realista en miniatura (franja pegajosa + dos rayitas de texto)
        const icon = new St.BoxLayout({style_class: 'postit-icon', vertical: true, y_align: Clutter.ActorAlign.CENTER});
        icon.add_child(new St.Widget({style_class: 'postit-icon-strip'}));
        icon.add_child(new St.Widget({style_class: 'postit-icon-line'}));
        icon.add_child(new St.Widget({style_class: 'postit-icon-line postit-icon-line-short'}));
        this._button = new PanelMenu.Button(0.0, 'Post-it', true);
        this._button.add_child(icon);
        this._button.connect('button-press-event', () => {
            this._note.visible = !this._note.visible;
            this._queueSave();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._button);

        // La nota: cabecera (arrastrar + pin) / lista con scroll / pie con esquina doblada
        this._note = new St.BoxLayout({style_class: 'postit', vertical: true, reactive: true});
        const header = new St.BoxLayout({style_class: 'postit-header'});
        const grip = new St.Widget({reactive: true, x_expand: true, y_expand: true});   // zona de arrastre (el pin queda aparte)
        this._pinIcon = new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'postit-pin-icon'});
        const pin = new St.Button({style_class: 'postit-pin', child: this._pinIcon, reactive: true, can_focus: false});
        pin.connect('clicked', () => { this._setPinned(!this._pinned); this._queueSave(); });
        header.add_child(grip);
        header.add_child(pin);
        this._connectDrag(grip);

        this._lines = new St.BoxLayout({style_class: 'postit-lines', vertical: true});
        this._scroll = new St.ScrollView({
            style_class: 'postit-scroll', y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.set_child(this._lines);

        const footer = new St.Widget({style_class: 'postit-footer'});

        this._note.add_child(header);
        this._note.add_child(this._scroll);
        this._note.add_child(footer);

        // Restaurar líneas guardadas y dejar una vacía al final para escribir
        this._loading = true;
        for (const l of this._saved.lines ?? [])
            if (typeof l?.text === 'string' && l.text.trim()) this._addRow(false, l.text, l.done === true);
        this._addRow(false);
        this._loading = false;

        this._setPinned(this._saved.pinned === true);
        this._note.visible = this._saved.visible !== false;
        // El monitor puede no existir todavía al arrancar la sesión: esperamos a que esté listo.
        if (Main.layoutManager._startingUp)
            this._startupId = Main.layoutManager.connect('startup-complete', () => this._place());
        else
            this._place();
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

    _saveNow() {
        if (this._saveId) { GLib.source_remove(this._saveId); this._saveId = 0; }
        if (!this._note || !this._placed) return;
        const lines = this._lines.get_children()
            .map(r => ({text: r._entry.text, done: r._state === 'done'}))
            .filter(l => l.text.trim());
        const data = {visible: this._note.visible, pinned: this._pinned, x: this._note.x, y: this._note.y, lines};
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
            // replace_contents escribe en un temporal y renombra: atómico, no deja el archivo a medias
            Gio.File.new_for_path(this._path).replace_contents(
                new TextEncoder().encode(JSON.stringify(data, null, 2)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`postit: no se pudo guardar: ${e.message}`);
        }
    }

    // Una fila = [tick] [campo de texto]. Estados: 'new' (línea de escribir) → 'open' (fijada) → 'done' (tachada).
    _addRow(focus = true, text = '', done = false) {
        const row = new St.BoxLayout({style_class: 'postit-row'});
        // El tick ocupa sitio siempre (opacidad 0 mientras es "new") para que el texto no salte al fijar la línea.
        const tick = new St.Button({
            style_class: 'postit-tick', can_focus: false, opacity: 0, reactive: false, y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'postit-tick-icon'}),
        });
        const entry = new St.Entry({style_class: 'postit-line postit-line-new', can_focus: true, x_expand: true});
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

        entry.clutter_text.connect('text-changed', () => this._queueSave());
        row.connect('destroy', () => this._queueSave());

        entry.clutter_text.connect('activate', () => {
            if (!entry.text.trim()) {                      // vacía: la línea de escribir no hace nada; una ya fijada se borra
                if (row._state !== 'new') row.destroy();
                return;
            }
            if (row._state === 'new') {
                open();
                this._addRow();                            // nueva línea debajo, con foco
                this._queueSave();
            } else {
                row.get_next_sibling()?._entry.grab_key_focus();
            }
        });

        // Teclado: ↑/↓ cambian de línea, Backspace en una línea vacía la borra y sube, Esc suelta el foco
        entry.clutter_text.connect('key-press-event', (_a, ev) => {
            const prev = row.get_previous_sibling(), next = row.get_next_sibling();
            switch (ev.get_key_symbol()) {
            case Clutter.KEY_Up:
                prev?._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                next?._entry.grab_key_focus();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Escape:
                global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_BackSpace:
                if (entry.text !== '' || !prev) return Clutter.EVENT_PROPAGATE;
                prev._entry.grab_key_focus();
                if (row._state !== 'new') row.destroy();   // la línea de escribir no se borra, solo se sale de ella
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        tick.connect('clicked', () => {
            if (row._state === 'open') strike();           // 1er clic: tachar
            else if (row._state === 'done') row.destroy(); // 2º clic: borrar
            this._queueSave();
        });

        if (text) {                                        // fila restaurada del disco
            entry.text = text;
            open();
            if (done) strike();
        }

        row.add_child(tick);
        row.add_child(entry);
        this._lines.add_child(row);
        if (focus) {
            entry.grab_key_focus();
            // Tras el layout, scroll hasta abajo: las filas nuevas siempre entran por el final
            this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idle = 0;
                const adj = this._scroll?.vadjustment;
                if (adj) adj.value = adj.upper - adj.page_size;
                return GLib.SOURCE_REMOVE;
            });
        }
        return row;
    }

    // Arrastrar la nota agarrando la cabecera. global.stage.grab captura el ratón aunque salga de la nota.
    // Sin box-shadow en la nota: la sombra dejaba rastro de líneas al moverla.
    _connectDrag(header) {
        header.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._dragOff = [x - this._note.x, y - this._note.y];
            this._grab = global.stage.grab(header);
            return Clutter.EVENT_STOP;
        });
        header.connect('motion-event', (_a, event) => {
            if (!this._grab) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const clamp = (v, max) => Math.max(0, Math.min(v, max));   // sin salirse de la pantalla
            this._note.set_position(
                clamp(x - this._dragOff[0], global.stage.width - this._note.width),
                clamp(y - this._dragOff[1], global.stage.height - this._note.height));
            return Clutter.EVENT_STOP;
        });
        header.connect('button-release-event', () => {
            this._grab?.dismiss();
            this._grab = null;
            this._queueSave();
            return Clutter.EVENT_STOP;
        });
    }

    // Posición guardada (si cabe en pantalla) o esquina superior derecha por defecto
    _place() {
        const m = Main.layoutManager.primaryMonitor;
        let x = m.x + m.width - NOTE_SIZE - 20, y = m.y + 60;
        if (Number.isFinite(this._saved.x) && Number.isFinite(this._saved.y)) {
            x = Math.max(0, Math.min(this._saved.x, global.stage.width - NOTE_SIZE));
            y = Math.max(0, Math.min(this._saved.y, global.stage.height - NOTE_SIZE));
        }
        this._note.set_position(x, y);
        this._placed = true;
    }

    _setPinned(pinned) {
        this._pinned = pinned;
        this._pinIcon.style_class = pinned ? 'postit-pin-icon postit-pin-on' : 'postit-pin-icon';
        if (this._chrome) { Main.layoutManager.removeChrome(this._note); this._chrome = false; }
        else this._note.get_parent()?.remove_child(this._note);
        this._chrome = pinned;
        if (pinned)
            Main.layoutManager.addTopChrome(this._note);              // por encima de ventanas
        else
            Main.layoutManager._backgroundGroup.add_child(this._note); // debajo de ventanas
    }

    disable() {
        this._saveNow();          // guardado inmediato: bloqueo de pantalla, desactivar, cerrar sesión
        this._closing = true;     // a partir de aquí, destruir filas ya no programa más guardados
        if (this._startupId) Main.layoutManager.disconnect(this._startupId);
        if (this._idle) GLib.source_remove(this._idle);
        this._grab?.dismiss();
        this._startupId = this._idle = 0;
        this._grab = null;
        if (this._chrome) Main.layoutManager.removeChrome(this._note);
        else this._note?.get_parent()?.remove_child(this._note);
        this._chrome = false;
        this._note?.destroy();
        this._button?.destroy();
        this._note = this._button = this._lines = this._scroll = this._pinIcon = this._saved = null;
        this._placed = false;
    }
}
