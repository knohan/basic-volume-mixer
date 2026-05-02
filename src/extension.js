import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// -------------------------------------
//         BASIC VOLUME MIXER
// -------------------------------------
const StreamRow = GObject.registerClass(
class StreamRow extends St.BoxLayout {
    _init(streams, mixerControl, iconsDirPath) {
        super._init({
            style_class: 'active-app-item',
            style: 'padding: 1px 0px; margin: 0px; spacing: 0px;', 
            vertical: false,
            x_expand: true,
            y_expand: false,
            reactive: true
        });

        this._streams = streams;
        this._mixerControl = mixerControl;
        this._iconsDirPath = iconsDirPath;
        let mainStream = this._streams[0];

        // 1. ICON BUTTON
        this._iconButton = new St.Button({
            style_class: 'message-media-control',
            style: 'padding: 0px; border-radius: 6px;',
            width: 24, 
            height: 38,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: true,
        });

        // 2. SMART ICON SYSTEM
        let gicon = this._getCorrectIcon(mainStream);
        this._appIcon = new St.Icon({
            gicon: gicon, 
            icon_size: 20,
            fallback_icon_name: 'application-x-executable' 
        });

        this._iconButton.set_child(this._appIcon);
        this.add_child(this._iconButton);

        // 3. VOLUME SLIDER
        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.style = 'margin-right: 8px; margin-left: 16px; padding: 0px;'; 
        
        this._updateSliderValue();

        // 4. INTERACTIONS
        this._iconButton.connect('clicked', () => {
            let isMuted = !mainStream.is_muted;
            this._streams.forEach(s => s.change_is_muted(isMuted));
        });
        
        this._slider.connect('notify::value', () => {
            let maxVol = this._mixerControl.get_vol_max_norm();
            let newVol = this._slider.value * maxVol;
            this._streams.forEach(s => { s.volume = newVol; s.push_volume(); });
        });

        this._streamSignals = [];
        this._streams.forEach(s => {
            let volId = s.connect('notify::volume', () => this._updateSliderValue());
            let muteId = s.connect('notify::is-muted', () => this._updateMuteVisual());
            this._streamSignals.push({ s, volId, muteId });
        });

        this.add_child(this._slider);
        this._updateMuteVisual();
    }

    _updateMuteVisual() {
        this._appIcon.opacity = this._streams[0].is_muted ? 100 : 255;
    }

    _getCorrectIcon(stream) {
        let appId = stream.get_application_id() || "";
        let appName = stream.get_name() || "";
        let sysIconName = stream.get_icon_name() || "";
        let desc = stream.get_description() || "";

        let searchNames = new Set();

        // Name Extraction
        let addName = (str) => {
            if (!str) return;
            let s = str.toString();
            let lower = s.toLowerCase();
            
            searchNames.add(s);
            searchNames.add(lower);
            
            if (s.includes('.')) {
                let parts = s.split('.');
                let lastPart = parts[parts.length - 1];
                searchNames.add(lastPart);
                searchNames.add(lastPart.toLowerCase());
            }
            searchNames.add(lower.replace(/ /g, '-'));
            
            let cleaned = lower.replace(/[^a-z0-9]/g, ' ').trim();
            cleaned.split(/\s+/).forEach(word => {
                if (word.length > 2) searchNames.add(word);
            });
        };

        addName(appId);
        addName(appName);
        addName(sysIconName);
        addName(desc);

        // 1. Local Folder - Highest Priority
        if (this._iconsDirPath) {
            for (let name of searchNames) {
                if (!name || name.length < 2) continue;
                for (let ext of ['.svg', '.png']) {
                    let iconPath = `${this._iconsDirPath}/${name}${ext}`;
                    let file = Gio.File.new_for_path(iconPath);
                    if (file.query_exists(null)) return Gio.FileIcon.new(file);
                }
            }
        }

        // 2. System Icon
        if (sysIconName && sysIconName !== 'audio-x-generic') {
            return Gio.ThemedIcon.new_with_default_fallbacks(sysIconName);
        }

        // 3. GNOME AppSystem
        let appSystem = Shell.AppSystem.get_default();
        if (appId) {
            let desktopId = appId.includes('.desktop') ? appId : appId + '.desktop';
            let app = appSystem.lookup_app(desktopId) || appSystem.lookup_app(appId);
            if (app) return app.get_icon();
        }

        // 4. Fallback
        return Gio.ThemedIcon.new_from_names([appId || "application-x-executable"]);
    }

    _updateSliderValue() {
        if (!this._streams[0]) return;
        let maxVol = this._mixerControl.get_vol_max_norm();
        this._slider.value = this._streams[0].volume / maxVol;
    }

    destroy() {
        this._streamSignals.forEach(item => {
            item.s.disconnect(item.volId);
            item.s.disconnect(item.muteId);
        });
        super.destroy();
    }
});

export default class VolumeMixerExtension extends Extension {
    enable() {
        this._mixerControl = new Gvc.MixerControl({ name: 'App Volume Mixer' });
        this._signals = [];
        this._iconsPath = this.dir.get_child('icons').get_path();

        this._floatingCard = new St.BoxLayout({
            vertical: true,
            style_class: 'card',
            style: 'margin-top: 4px; margin-bottom: 0px; padding: 0px; border: none; background-color: transparent;',
            x_expand: true,
            y_expand: false
        });

        let qsMenu = Main.panel.statusArea.quickSettings.menu.box;
        qsMenu.add_child(this._floatingCard);
        this._floatingCard.hide();

        this._signals.push(this._mixerControl.connect('state-changed', (c, state) => {
            if (state === Gvc.MixerControlState.READY) this._updateMenu();
        }));
        this._signals.push(this._mixerControl.connect('stream-added', () => this._updateMenu()));
        this._signals.push(this._mixerControl.connect('stream-removed', () => this._updateMenu()));

        this._mixerControl.open();
    }

    _updateMenu() {
        if (!this._floatingCard) return;
        
        // Native Clutter C-function to destroy children
        this._floatingCard.destroy_all_children();

        let streams = this._mixerControl.get_sink_inputs().filter(s => !s.is_event_stream);
        if (streams.length === 0) {
            this._floatingCard.hide();
            return;
        }

        this._floatingCard.show();
        let grouped = {};
        streams.forEach(s => {
            let key = s.get_application_id() || s.get_name() || 'unknown';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(s);
        });

        Object.values(grouped).forEach(sArray => {
            try {
                let row = new StreamRow(sArray, this._mixerControl, this._iconsPath);
                this._floatingCard.add_child(row);
            } catch (e) {
                // Silently ignore errors to prevent logging
            }
        });
    }

    disable() {
        if (this._mixerControl) {
            this._signals.forEach(id => this._mixerControl.disconnect(id));
            this._mixerControl.close();
            this._mixerControl = null;
        }
        if (this._floatingCard) {
            this._floatingCard.destroy();
            this._floatingCard = null;
        }
    }
}
