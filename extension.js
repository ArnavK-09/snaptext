// extension.js
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import Soup from "gi://Soup";

import { OcrProcessor } from "./ocr.js";
import { getMissingAppsErrorDialog } from "./dependencies.js";
import { SelectionUI } from "./selection.js";

const HISTORY_LIMIT = 15;
const HISTORY_LABEL_LIMIT = 40;

export default class SnapTextExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._activeProcesses = new Set();
    this._errorDialog = null;
    this._notifSource = null;
    this._cancellable = new Gio.Cancellable();
    this._extractTimeoutId = null;
    this._selectionTimeoutId = null;
    this._selectionUI = null;
    this._historySection = null;
    this._soupSession = new Soup.Session();

    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._trayGIcon = Gio.FileIcon.new(this.dir.get_child("trayicon.svg"));
    this._busyGIcon = Gio.FileIcon.new(this.dir.get_child("spinner.svg"));
    this._indicatorIcon = new St.Icon({
      gicon: this._trayGIcon,
      style_class: "system-status-icon",
      style: "padding: 0 2px; margin: 0;",
    });
    this._indicatorIcon.set_pivot_point(0.5, 0.5);
    this._busyId = 0;
    this._busyActive = false;
    this._ocrStage = _("Waiting…");
    this._indicator.add_child(this._indicatorIcon);

    this._indicator.visible = this._settings.get_boolean("show-tray-icon");

    this._indicator.connectObject(
      "captured-event",
      (_actor, event) => {
        let type = event.type();

        if (
          type !== Clutter.EventType.BUTTON_PRESS &&
          type !== Clutter.EventType.BUTTON_RELEASE
        ) {
          return Clutter.EVENT_PROPAGATE;
        }

        let button = event.get_button();

        if (button === 1 || button === 3) {
          if (type === Clutter.EventType.BUTTON_RELEASE) {
            if (button === 1) {
              if (this._indicator.menu.isOpen) {
                this._indicator.menu.close();
              }
              if (this._busyActive) {
                this._cancelExtraction();
              } else {
                this._triggerExtraction();
              }
            } else if (button === 3) {
              if (this._busyActive) {
                this._buildProgressMenu();
                this._indicator.menu.open();
              } else {
                this._buildMenu();
                this._indicator.menu.toggle();
              }
            }
          }

          return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
      },
      this,
    );

    this._buildMenu();

    this._settings.connectObject(
      "changed",
      this._onSettingsChanged.bind(this),
      this,
    );

    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._bindShortcut();
  }

  _triggerExtraction() {
    if (this._extractTimeoutId) {
      GLib.source_remove(this._extractTimeoutId);
      this._extractTimeoutId = null;
    }

    this._extractTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      150,
      () => {
        this._extractTimeoutId = null;
        this._extractTextAsync().catch((error) => {
          if (!this._isCancelled()) {
            this._notifyError(`Text extraction failed: ${error}`);
          }
        });
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _logDebug(msg, isError = false) {
    if (this._settings && this._settings.get_boolean("enable-debug")) {
      if (isError) {
        console.error(`[SnapText Debug] ${msg}`);
      } else {
        console.log(`[SnapText Debug] ${msg}`);
      }
    }
  }

  _notifyError(msg) {
    this._logDebug(`Error: ${msg}`, true);
    this._showNotification(_("Snap Text Error"), msg);
  }

  _setBusy(busy) {
    if (!this._indicatorIcon || !this._indicator) {
      return;
    }

    this._busyActive = busy;

    if (busy) {
      this._indicator.visible = true;
      this._indicatorIcon.gicon = this._busyGIcon;
      this._setOcrProgress(_("Starting…"));
      if (!this._busyId) {
        this._busyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          this._indicatorIcon.rotation_angle_z =
            (this._indicatorIcon.rotation_angle_z + 30) % 360;
          return GLib.SOURCE_CONTINUE;
        });
      }
    } else {
      if (this._busyId) {
        GLib.source_remove(this._busyId);
        this._busyId = 0;
      }
      this._indicatorIcon.rotation_angle_z = 0;
      this._indicatorIcon.gicon = this._trayGIcon;
      this._indicator.visible = this._settings.get_boolean("show-tray-icon");
    }
  }

  _setOcrProgress(stage) {
    this._ocrStage = stage;
    if (this._progressLabel) {
      this._progressLabel.text = stage;
    }
  }

  _cancelExtraction() {
    if (this._extractTimeoutId) {
      GLib.source_remove(this._extractTimeoutId);
      this._extractTimeoutId = null;
    }
    if (this._cancellable) {
      this._cancellable.cancel();
    }
    this._stopActiveProcesses();
    this._setBusy(false);
  }

  _buildProgressMenu() {
    this._indicator.menu.removeAll();

    let statusItem = new PopupMenu.PopupBaseMenuItem({
      reactive: false,
      can_focus: false,
    });
    this._progressLabel = new St.Label({
      text: this._ocrStage || _("Processing…"),
      style_class: "popup-menu-item-label",
    });
    statusItem.add_child(this._progressLabel);
    this._indicator.menu.addMenuItem(statusItem);

    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    let cancelItem = new PopupMenu.PopupMenuItem(_("Cancel in-progress OCR"));
    cancelItem.connectObject(
      "activate",
      () => {
        this._indicator.menu.close();
        this._cancelExtraction();
      },
      this,
    );
    this._indicator.menu.addMenuItem(cancelItem);
  }

  _onSettingsChanged(_settings, key) {
    if (key === "shortcut-trigger" || key === "enable-shortcut") {
      this._bindShortcut();
      return;
    }

    if (key === "show-tray-icon") {
      this._indicator.visible = this._settings.get_boolean("show-tray-icon");
      return;
    }

    if (key === "history-list") {
      this._populateHistory();
      return;
    }

    if (key === "keep-history") {
      if (this._indicator && this._indicator.menu.isOpen) {
        this._indicator.menu.close();
      }
      this._buildMenu();
      return;
    }

  }

  _populateHistory() {
    if (!this._historySection || !this._settings) {
      return;
    }

    this._historySection.removeAll();
    let history = this._settings.get_strv("history-list");

    if (history.length === 0) {
      this._historySection.addMenuItem(
        new PopupMenu.PopupMenuItem(_("No history yet"), {
          reactive: false,
        }),
      );
    } else {
      for (let text of history) {
        this._historySection.addMenuItem(this._historyMenuItem(text));
      }
    }
  }

  _buildMenu() {
    if (!this._indicator || !this._settings) {
      return;
    }

    this._indicator.menu.removeAll();

    let keepHistory = this._settings.get_boolean("keep-history");

    if (keepHistory) {
      this._historySection = new PopupMenu.PopupMenuSection();
      this._indicator.menu.addMenuItem(this._historySection);
      this._populateHistory();
      this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    } else {
      this._historySection = null;
    }

    let actionsRow = new PopupMenu.PopupBaseMenuItem({
      reactive: false,
      can_focus: false,
    });

    let buttonBox = new St.BoxLayout({
      style: "spacing: 12px; padding: 4px;",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
    });

    if (keepHistory) {
      let clearBtn = new St.Button({
        style_class: "button",
        child: new St.Icon({
          icon_name: "user-trash-symbolic",
          icon_size: 16,
        }),
        can_focus: true,
        reactive: true,
        x_expand: true,
      });

      clearBtn.connectObject(
        "clicked",
        () => {
          this._settings.set_strv("history-list", []);
        },
        this,
      );

      buttonBox.add_child(clearBtn);
    }

    let settingsBtn = new St.Button({
      style_class: "button",
      child: new St.Icon({
        icon_name: "preferences-system-symbolic",
        icon_size: 16,
      }),
      can_focus: true,
      reactive: true,
      x_expand: true,
    });

    settingsBtn.connectObject(
      "clicked",
      () => {
        this._indicator.menu.close();
        this.openPreferences().catch((error) => {
          this._logDebug(`Could not open preferences: ${error}`, true);
        });
      },
      this,
    );

    buttonBox.add_child(settingsBtn);

    actionsRow.add_child(buttonBox);
    this._indicator.menu.addMenuItem(actionsRow);
  }

  _historyMenuItem(text) {
    let label = text.replace(/\s+/g, " ").trim();
    if (label.length > HISTORY_LABEL_LIMIT) {
      label = `${label.substring(0, HISTORY_LABEL_LIMIT - 3)}...`;
    }

    let item = new PopupMenu.PopupMenuItem(label);
    item.connectObject(
      "activate",
      () => {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        if (this._settings?.get_boolean("show-notification")) {
          this._showNotification(_("Text copied"), text);
        }
      },
      this,
    );

    return item;
  }

  _bindShortcut() {
    Main.wm.removeKeybinding("shortcut-trigger");

    Main.wm.addKeybinding(
      "shortcut-trigger",
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => {
        if (!this._settings.get_boolean("enable-shortcut")) return;
        this._logDebug("Main shortcut triggered.");
        this._triggerExtraction();
      },
    );
  }

  _showMissingDependencies(dialog) {
    if (this._errorDialog) {
      this._errorDialog.disconnectObject(this);
      this._errorDialog.destroy();
      this._errorDialog = null;
    }

    this._errorDialog = dialog;
    this._errorDialog.connectObject(
      "destroy",
      () => {
        this._errorDialog = null;
      },
      this,
    );

    this._errorDialog.open();
  }

  _notificationIcon() {
    return Gio.FileIcon.new(this.dir.get_child("trayicon.svg"));
  }

  _getNotificationSource() {
    if (!this._notifSource) {
      this._notifSource = new MessageTray.Source({
        title: "SnapText",
        icon: this._notificationIcon(),
      });

      this._notifSource.connectObject(
        "destroy",
        () => {
          this._notifSource = null;
        },
        this,
      );

      Main.messageTray.add(this._notifSource);
    }
    return this._notifSource;
  }

  _showNotification(title, body) {
    let titleText = String(title ?? "").trim();
    let bodyText = String(body ?? "").trim();

    if (!titleText && !bodyText) {
      return;
    }

    let source = this._getNotificationSource();
    let notification = new MessageTray.Notification({
      source,
      title: titleText,
      body: bodyText,
      urgency: MessageTray.Urgency.NORMAL,
    });

    source.addNotification(notification);
  }

  _isCancelled(cancellable = this._cancellable) {
    return !cancellable || cancellable.is_cancelled();
  }

  _stopActiveProcesses() {
    for (let process of this._activeProcesses) {
      process.force_exit();
    }
    this._activeProcesses.clear();
  }

  async _getSelectionArea() {
    return new Promise((resolve) => {
      this._selectionUI = new SelectionUI((x, y, w, h) => {
        if (this._selectionTimeoutId) {
          GLib.source_remove(this._selectionTimeoutId);
          this._selectionTimeoutId = null;
        }

        this._selectionTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          150,
          () => {
            this._selectionTimeoutId = null;
            resolve({ x, y, w, h });
            return GLib.SOURCE_REMOVE;
          },
        );
      });
      this._selectionUI.open();
    });
  }

  async _takeScreenshot(x, y, w, h, stream) {
    return new Promise((resolve) => {
      try {
        let shooter = new Shell.Screenshot();
        shooter.screenshot_area(x, y, w, h, stream, (obj, res) => {
          try {
            let successResult = obj.screenshot_area_finish(res);
            let success = Array.isArray(successResult)
              ? successResult[0]
              : successResult;
            resolve(!!success);
          } catch (e) {
            this._logDebug(`screenshot_area_finish failed: ${e}`);
            resolve(false);
          }
        });
      } catch (e) {
        this._logDebug(`Shell.Screenshot failed: ${e}`);
        resolve(false);
      }
    });
  }

  async _extractTextAsync() {
    // Abort any previously running extraction flow
    if (this._cancellable) {
      this._cancellable.cancel();
    }

    // Create a new cancellation token for this specific execution
    let currentCancellable = new Gio.Cancellable();
    this._cancellable = currentCancellable;

    this._stopActiveProcesses();

    let errorDialog = getMissingAppsErrorDialog();
    if (errorDialog) {
      this._showMissingDependencies(errorDialog);
      return;
    }

    let area = await this._getSelectionArea();

    let cleanupSelectionUI = () => {
      if (this._selectionUI) {
        this._selectionUI.close();
        this._selectionUI = null;
      }
    };

    if (area.x === null || this._isCancelled(currentCancellable)) {
      cleanupSelectionUI();
      return;
    }

    if (area.w === 0 && area.h === 0) {
      cleanupSelectionUI();
      return;
    }

    let imagePath = null;
    let stream = null;

    try {
      let file;
      let tempStream;
      [file, tempStream] = Gio.File.new_tmp("snaptext-XXXXXX.png");
      imagePath = file.get_path();
      tempStream.close(null);

      stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    } catch (error) {
      cleanupSelectionUI();
      if (!this._isCancelled(currentCancellable)) {
        this._notifyError(
          `Could not create temporary screenshot file: ${error}`,
        );
      }
      return;
    }

    try {
      this._setBusy(true);
      let gotScreenshot = await this._takeScreenshot(
        area.x,
        area.y,
        area.w,
        area.h,
        stream,
      );
      stream.close(null);

      cleanupSelectionUI();

      if (gotScreenshot && !this._isCancelled(currentCancellable)) {
        const ocrProcessor = new OcrProcessor(
          currentCancellable,
          this._activeProcesses,
          this._logDebug.bind(this),
          (stage) => this._setOcrProgress(stage),
        );
        let result = await ocrProcessor.processImage(imagePath);

        if (!this._isCancelled(currentCancellable) && result !== null) {
          let text = result.text || "";

          if (result.isQr && /^https?:\/\/[^\s]+$/i.test(text.trim())) {
            if (this._settings.get_boolean("qr-auto-open")) {
              try {
                Gio.AppInfo.launch_default_for_uri(text.trim(), null);
              } catch (e) {
                this._logDebug(`Could not launch URI: ${e}`, true);
              }
            }
          }

          if (!this._isCancelled(currentCancellable)) {
            this._handleExtractedText(text);
          }
        }
      } else if (!this._isCancelled(currentCancellable)) {
        this._notifyError(_("Could not capture screenshot."));
      }
    } catch (error) {
      cleanupSelectionUI();
      if (!this._isCancelled(currentCancellable)) {
        this._notifyError(`Text extraction failed: ${error}`);
      }
    } finally {
      this._setBusy(false);
      cleanupSelectionUI();
      if (imagePath && GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
        if (GLib.unlink(imagePath) !== 0) {
          this._logDebug(`Could not remove temporary screenshot file`, true);
        }
      }
    }
  }

  _handleExtractedText(text) {
    if (!text) {
      this._showNotification(_("Snap Text"), _("No text found."));
      return;
    }

    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);

    if (this._settings?.get_boolean("keep-history")) {
      let history = this._settings.get_strv("history-list");
      history = history.filter((item) => item !== text);
      history.unshift(text);
      history.length = Math.min(history.length, HISTORY_LIMIT);
      this._settings.set_strv("history-list", history);
    }

    if (this._settings?.get_boolean("show-notification")) {
      this._showNotification(_("Text extracted"), text);
    }
  }

  disable() {
    if (this._busyId) {
      GLib.source_remove(this._busyId);
      this._busyId = 0;
    }

    if (this._soupSession) {
      this._soupSession.abort();
      this._soupSession = null;
    }

    if (this._extractTimeoutId) {
      GLib.source_remove(this._extractTimeoutId);
      this._extractTimeoutId = null;
    }

    if (this._selectionTimeoutId) {
      GLib.source_remove(this._selectionTimeoutId);
      this._selectionTimeoutId = null;
    }

    if (this._selectionUI) {
      this._selectionUI._onSelected(null, null, null, null);
      this._selectionUI.close();
      this._selectionUI = null;
    }

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    Main.wm.removeKeybinding("shortcut-trigger");

    if (this._settings) {
      this._settings.disconnectObject(this);
    }

    this._stopActiveProcesses();

    if (this._errorDialog) {
      this._errorDialog.disconnectObject(this);
      this._errorDialog.destroy();
      this._errorDialog = null;
    }

    if (this._historySection) {
      this._historySection.destroy();
      this._historySection = null;
    }

    if (this._indicator) {
      this._indicator.disconnectObject(this);
      this._indicator.destroy();
      this._indicator = null;
    }

    if (this._notifSource) {
      this._notifSource.disconnectObject(this);
      this._notifSource.destroy();
      this._notifSource = null;
    }

    this._settings = null;
  }
}
