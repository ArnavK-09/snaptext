// selection.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Custom area selector for GNOME Shell 45-50.
// Cursor handling uses Clutter actor cursor types, the same route GNOME Shell's
// own screenshot UI uses. It does not draw or fake a cursor actor.
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

            // GNOME 43+ returns a Clutter.Grab from pushModal.
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

            this._setDefaultCursor();
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

            this._setCursorType(Clutter.CursorType.CROSSHAIR);
        }

        _setDefaultCursor() {
            this._setCursorType(Clutter.CursorType.INHERIT);
        }

        _setCursorType(cursorType) {
            if (!this.set_cursor_type) {
                return;
            }

            try {
                this.set_cursor_type(cursorType);
            } catch (error) {
                console.error(`[SnapText] Failed to set selection cursor: ${error}`);
            }
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