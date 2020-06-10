/* global appSettings */
const Module = require('module');
const { join, dirname, resolve } = require('path');
const { existsSync, unlinkSync, writeFileSync } = require('fs');
const electron = require('electron');
const { BrowserWindow, app, session, ipcMain, globalShortcut } = electron;

const electronPath = require.resolve('electron');
const discordPath = join(dirname(require.main.filename), '..', 'app.asar');

console.log('Hello from Powercord!');

/**
 * Glasscord compatibility fix for legacy installs
 * This is a temporary fix and will be removed on July 1st, 2020.
 * Some cases might require just re-plugging Powercord, this isn't a perfect solution
 * @see https://github.com/powercord-org/powercord/issues/316
 */
const _pkgFile = join(dirname(require.main.filename), 'package.json');
const _pkg = require(_pkgFile);
if (!_pkg.name) {
  try {
    writeFileSync(_pkgFile, JSON.stringify({
      ..._pkg,
      name: 'discord'
    }));
  } catch (e) {
    // Most likely a perm issue. Let's fail silently on that one
  }
}

let settings;
try {
  settings = require(resolve(__dirname, '..', 'settings', 'pc-general.json'));
} catch (err) {
  settings = {};
}
const { transparentWindow, experimentalWebPlatform } = settings;

let originalPreload;

class PatchedBrowserWindow extends BrowserWindow {
  // noinspection JSAnnotator - Make JetBrains happy
  constructor (opts) {
    console.log(opts);
    if (opts.webContents) {
      // General purpose popouts used by Discord
    } else if (opts.webPreferences && opts.webPreferences.nodeIntegration) {
      // Splash Screen
      opts.webPreferences.preload = join(__dirname, 'preloadSplash.js');
    } else if (opts.webPreferences && opts.webPreferences.offscreen) {
      // Overlay
      originalPreload = opts.webPreferences.preload;
      opts.webPreferences.preload = join(__dirname, 'preload.js');
      opts.webPreferences.nodeIntegration = true;
    } else if (opts.webPreferences && opts.webPreferences.preload) {
      // Discord Client
      originalPreload = opts.webPreferences.preload;
      opts.webPreferences.preload = join(__dirname, 'preload.js');
      opts.webPreferences.nodeIntegration = true;

      if (transparentWindow) {
        opts.transparent = true;
        opts.frame = false;
        delete opts.backgroundColor;
      }

      if (experimentalWebPlatform) {
        opts.webPreferences.experimentalFeatures = true;
      }
    }

    opts.webPreferences.enableRemoteModule = true;
    return new BrowserWindow(opts);
  }
}


const electronExports = new Proxy(electron, {
  get (target, prop) {
    switch (prop) {
      case 'BrowserWindow': return PatchedBrowserWindow;
      default: return target[prop];
    }
  }
});

delete require.cache[electronPath].exports;
require.cache[electronPath].exports = electronExports;

app.once('ready', () => {
  // headers must die
  session.defaultSession.webRequest.onHeadersReceived(({ responseHeaders }, done) => {
    /*
     * To people worried about security: those protection headers removal do *not* cause security issues.
     *
     * In a vanilla Discord it would actually lower the security level of the app, but with Powercord installed
     * this is another story. Node integration is available within the render process, meaning scrips can do requests
     * using native http module (bypassing content-security-policy), and could use BrowserViews to mimic the behaviour
     * of an iframe (bypassing the x-frame-options header). So we decided, for convenience, to drop them entirely.
     */
    Object.keys(responseHeaders)
      .filter(k => (/^content-security-policy/i).test(k) || (/^x-frame-options/i).test(k))
      .map(k => (delete responseHeaders[k]));

    done({ responseHeaders });
  });

  // source maps must die
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    if (details.url.endsWith('.js.map')) {
      // source maps must die
      done({ cancel: true });
    } else if (details.url.startsWith('https://canary.discordapp.com/_powercord')) { // @todo: discord.com
      appSettings.set('_POWERCORD_ROUTE', details.url.replace('https://canary.discordapp.com', ''));
      appSettings.save();
      // It should get restored to _powercord url later
      done({ redirectURL: 'https://canary.discordapp.com/app' });
    } else {
      done({});
    }
  });
});


// #region IPC
ipcMain.on('pc-getPreload', (ev) => ev.returnValue = originalPreload);
ipcMain.on('pc-getWebPreferences', (ev) => ev.returnValue = ev.sender.getWebPreferences());
ipcMain.on('pc-getMaximized', (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win) {
    return;
  }
  ev.returnValue = win.isMaximized();
});
ipcMain.on('pc-handleMaximize', (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win) {
    return;
  }
  win.on('maximize', () => ev.reply('pc-windowMaximize'));
  win.on('unmaximize', () => ev.reply('pc-windowUnmaximize'));
});
ipcMain.handle('pc-openDevTools', (ev, isOverlay) => {
  if (isOverlay) {
    ev.sender.openDevTools({ mode: 'detach' });
    let devToolsWindow = new BrowserWindow({
      webContents: ev.sender.devToolsWebContents
    });
    devToolsWindow.on('ready-to-show', () => {
      devToolsWindow.show();
    });
    devToolsWindow.on('close', () => {
      ev.sender.closeDevTools();
      devToolsWindow = null;
    });
  } else {
    ev.sender.openDevTools();
  }
});
ipcMain.handle('pc-sendInputEvent', (ev, data) => {
  ev.sender.sendInputEvent(data);
});
ipcMain.handle('pc-clearDiscordCache', (ev) =>
  new Promise((rs) => ev.sender.session.clearCache(rs)));

let _splash;
ipcMain.on('pc-openSplashScreen', (ev, settings, url) => {
  if (_splash) {
    return;
  }
  _splash = new BrowserWindow(settings);
  _splash.loadURL(url);
  _splash.webContents.openDevTools({ mode: 'detach' });
  _splash.on('close', () => {
    ev.reply('pc-splashClosed');
    _splash = null;
  });
});
ipcMain.handle('pc-closeSplashScreen', () => {
  if (!_splash) {
    return;
  }
  _splash.close();
  _splash = null;
});
ipcMain.on('pc-sendToSplash', (_, channel, ...args) => {
  if (!_splash) {
    return;
  }
  _splash.webContents.send(channel, ...args);
});
ipcMain.on('pc-getAppPath', (ev) => ev.returnValue = app.getAppPath());
ipcMain.on('pc-getDevToolsOpened', (ev) => ev.returnValue = ev.sender.isDevToolsOpened());
ipcMain.on('pc-handleDevTools', (ev) => {
  const listener = () => {
    ev.reply('pc-devToolsOpened');
  };

  ev.sender.on('devtools-opened', listener);
  ipcMain.once('pc-stopHandleDevTools', (_ev) => {
    if (_ev.sender.id === ev.sender.id) {
      ev.sender.removeListener('devtools-opened', listener);
    }
  });
});
ipcMain.handle('pc-removeDevToolsExtension', (_, name) => {
  BrowserWindow.removeDevToolsExtension(name);
});
ipcMain.on('pc-addDevToolsExtension', (ev, path) => ev.returnValue = path && !!BrowserWindow.addDevToolsExtension(path));
ipcMain.on('pc-registerGlobalShortcut', (ev, accelerator) => ev.returnValue = accelerator && globalShortcut.register(accelerator, () => ev.reply('pc-globalShortcutInvoke', accelerator)));
ipcMain.handle('pc-unregisterGlobalShortcut', (_, accelerator) => globalShortcut.unregister(accelerator));
ipcMain.handle('pc-unregisterAllGlobalShortcuts', () => globalShortcut.unregisterAll());
// #endregion IPC

(async () => {
  if (process.argv[1] === '--squirrel-obsolete') {
    /**
     * @todo: Make this actually be working
     * After further testing it looks like this is only called
     * for versions that are way older (if new ver is 4, ver 2 will be
     * called but not ver 3).
     */
    const main = require('../injectors/main.js');
    const platform = require(`../injectors/${process.platform}.js`);
    await main.inject(platform);
  }
  const discordPackage = require(join(discordPath, 'package.json'));

  electron.app.setAppPath(discordPath);
  electron.app.name = discordPackage.name;

  /**
   * Fix DevTools extensions for wintards
   * Keep in mind that this rather treats the symptom
   * than fixing the root issue.
   */
  if (process.platform === 'win32') {
    setImmediate(() => { // WTF: the app name doesn't get set instantly?
      const devToolsExtensions = join(electron.app.getPath('userData'), 'DevTools Extensions');

      if (existsSync(devToolsExtensions)) {
        unlinkSync(devToolsExtensions);
      }
    });
  }

  console.log('Loading Discord');
  Module._load(
    join(discordPath, discordPackage.main),
    null,
    true
  );
})();
