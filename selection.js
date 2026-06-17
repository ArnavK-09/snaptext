import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

// To solve https://github.com/cwittenberg/snaptext/issues/1 we need to add a Custom area selector for GNOME Shell 45-50.
// Did not realize but lots of things have changed across gnome-shell for gnome-screenshot in past releases. This solution does Cursor
// handling and dynamically switches between Clutter.CursorType (GNOME 47+) and Meta.Cursor (GNOME 45-46) to support all versions transparently.
export const SelectionUI = GObject.registerClass(
    class SelectionUI extends St.Widget {
        _init(onSelected) {
            super._init({
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            this.add_constraint(new Clutter.BindConstraint({
                source: Main.layoutManager.uiGroup,
                coordinate: Clutter.BindCoordinate.ALL,
            }));

            this._onSelected = onSelected;
            this._startX = 0;
            this._startY = 0;
            this._isDragging = false;
            this._isClosed = false;
            this._selectionEmitted = false;
            this._grab = null;

            this._bg = new St.Widget({
                reactive: false,
                can_focus: false,
                style: 'background-color: rgba(0,0,0,0.3);',
            });
            this._bg.add_constraint(new Clutter.BindConstraint({
                source: this,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            this.add_child(this._bg);

            //inline eyecandy, Orange is Yaru-orange (to mimic the legacy gnome-screenshot look n feel, pretty :))
            this._selectionBox = new St.Widget({
                reactive: false,
                can_focus: false,
                style: 'border: 2px solid #E95420; background-color: rgba(233, 84, 32, 0.2);',
            });
            this._selectionBox.hide();
            this.add_child(this._selectionBox);

            this.connectObject(
                'notify::mapped', this._onMappedChanged.bind(this),
                this
            );
        }

        open() {
            Main.layoutManager.uiGroup.add_child(this);
            this.show();

            this._setCrosshairCursor();

            // Seems GNOME 43+ returns a Clutter.Grab from pushModal.
            // Keep the exact object so popModal() removes the correct modal grab.
            this._grab = Main.pushModal(this);

            this.grab_key_focus();
            this._setCrosshairCursor();
        }

        close() {
            if (this._isClosed) {
                return;
            }

            this._isClosed = true;
            this._setDefaultCursor();

            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            } else {
                Main.popModal(this);
            }

            this.disconnectObject(this);
            this.destroy();
        }

        _onMappedChanged() {
            if (this.mapped) {
                this._setCrosshairCursor();
            }
        }

        _setCrosshairCursor() {
            if (this._isClosed) {
                return;
            }

            this._applyCursor('CROSSHAIR');
        }

        _setDefaultCursor() {
            // Attempt to use INHERIT first, fallback to DEFAULT
            if (!this._applyCursor('INHERIT')) {
                this._applyCursor('DEFAULT');
            }
        }

        _applyCursor(cursorName) {
            // GNOME 47-50+ (Clutter.CursorType on St.Widget)
            if (typeof this.set_cursor_type === 'function' && Clutter.CursorType?.[cursorName] !== undefined) {
                this.set_cursor_type(Clutter.CursorType[cursorName]);
                return true;
            }

            // GNOME 45-46 (Meta.Cursor via global.display)
            if (global.display && typeof global.display.set_cursor === 'function' && Meta.Cursor?.[cursorName] !== undefined) {
                global.display.set_cursor(Meta.Cursor[cursorName]);
                return true;
            }

            return false;
        }

        _emitSelection(x, y, w, h) {
            if (this._selectionEmitted) {
                return;
            }

            this._selectionEmitted = true;
            this._onSelected(x, y, w, h);
        }

        vfunc_button_press_event(event) {
            this._setCrosshairCursor();

            let button = event.get_button();
            if (button !== Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_STOP;
            }

            let [x, y] = event.get_coords();
            this._startX = x;
            this._startY = y;
            this._isDragging = true;

            this._selectionBox.set_position(x, y);
            this._selectionBox.set_size(0, 0);
            this._selectionBox.show();

            return Clutter.EVENT_STOP;
        }

        vfunc_motion_event(event) {
            this._setCrosshairCursor();

            if (!this._isDragging) {
                return Clutter.EVENT_STOP;
            }

            let [x, y] = event.get_coords();
            let rectX = Math.min(x, this._startX);
            let rectY = Math.min(y, this._startY);
            let rectW = Math.abs(x - this._startX);
            let rectH = Math.abs(y - this._startY);

            this._selectionBox.set_position(rectX, rectY);
            this._selectionBox.set_size(rectW, rectH);

            return Clutter.EVENT_STOP;
        }

        vfunc_button_release_event(event) {
            this._setCrosshairCursor();

            let button = event.get_button();
            if (button !== Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_STOP;
            }

            if (!this._isDragging) {
                return Clutter.EVENT_STOP;
            }

            this._isDragging = false;

            let [x, y] = event.get_coords();
            let rectX = Math.min(x, this._startX);
            let rectY = Math.min(y, this._startY);
            let rectW = Math.abs(x - this._startX);
            let rectH = Math.abs(y - this._startY);

            this.close();

            if (rectW > 5 && rectH > 5) {
                this._emitSelection(Math.round(rectX), Math.round(rectY), Math.round(rectW), Math.round(rectH));
            } else {
                this._emitSelection(null, null, null, null);
            }

            return Clutter.EVENT_STOP;
        }

        vfunc_key_press_event(event) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                this._emitSelection(null, null, null, null);
                return Clutter.EVENT_STOP;
            }

            this._setCrosshairCursor();
            return Clutter.EVENT_STOP;
        }

        vfunc_leave_event(event) {
            if (!this._isClosed) {
                this._setCrosshairCursor();
            }

            if (super.vfunc_leave_event) {
                return super.vfunc_leave_event(event);
            }

            return Clutter.EVENT_STOP;
        }
    }
);