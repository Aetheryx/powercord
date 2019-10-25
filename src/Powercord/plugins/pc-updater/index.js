const { ReactDOM, React, getModule, getModuleByDisplayName } = require('powercord/webpack');
const { open: openModal, close: closeModal } = require('powercord/modal');
const { Confirm } = require('powercord/components/modal');
const { Toast } = require('powercord/components');
const { createElement } = require('powercord/util');
const { Plugin } = require('powercord/entities');

const { resolve, join } = require('path');
const { promisify } = require('util');
const cp = require('child_process');
const exec = promisify(cp.exec);

const Settings = require('./components/Settings.jsx');

const changelog = require('../../../../changelogs.json');

module.exports = class Updater extends Plugin {
  constructor () {
    super();

    this.checking = false;
    this.cwd = { cwd: join(__dirname, ...Array(4).fill('..')) };
  }

  async startPlugin () {
    this.settings.set('paused', false);
    this.settings.set('updating', false);
    this.settings.set('awaiting_reload', false);
    this.loadCSS(resolve(__dirname, 'style.scss'));
    this.registerSettings('pc-updater', 'Updater', Settings);

    let minutes = Number(this.settings.get('interval', 15));
    if (minutes < 1) {
      this.settings.set('interval', 1);
      minutes = 1;
    }

    this._interval = setInterval(this.checkForUpdates.bind(this), minutes * 60 * 1000);
    this.checkForUpdates();

    const lastChangelog = this.settings.get('last_changelog', '');
    if (changelog.id !== lastChangelog) {
      this.openChangeLogs();
    }
  }

  pluginWillUnload () {
    clearInterval(this._interval);
  }

  async checkForUpdates () {
    if (
      this.settings.set('disabled', false) ||
      this.settings.set('paused', false) ||
      this.settings.set('checking', false) ||
      this.settings.set('updating', false)
    ) {
      return;
    }

    this.settings.set('checking', true);
    this.settings.set('checking_progress', [ 0, 0 ]);
    const disabled = this.settings.get('entities_disabled', []).map(e => e.id);
    const skipped = this.settings.get('entities_skipped', []);
    const plugins = [ ...powercord.pluginManager.plugins.values() ].filter(p => !p.isInternal);
    const themes = [ ...powercord.styleManager.themes.values() ].filter(t => t.isTheme);

    const entities = plugins.concat(themes).filter(e => !disabled.includes(e.updateIdentifier) && e.isUpdatable());
    if (!disabled.includes('powercord')) {
      entities.push(powercord);
    }

    // Not the prettiest way to limit concurrency but it works
    const groupedEntities = [];
    for (let i = 0; i < entities.length; i += 2) {
      groupedEntities.push([ entities[i], entities[i + 1] ]);
    }

    let done = 0;
    const updates = [];
    this.settings.set('checking_progress', [ 0, entities.length ]);
    for (const group of groupedEntities) {
      await Promise.all(group.filter(p => p).map(async entity => {
        const shouldUpdate = await entity.checkForUpdates();
        if (shouldUpdate) {
          const commits = await entity.getUpdateCommits();
          if (skipped[entity.updateIdentifier] === commits[0].id) {
            return;
          }
          updates.push({
            id: entity.updateIdentifier,
            name: entity.constructor.name,
            icon: entity.__proto__.__proto__.constructor.name.replace('Updatable', 'Powercord'),
            repo: await entity.getGitRepo(),
            commits
          });
        }
        done++;
        this.settings.set('checking_progress', [ done, entities.length ]);
      }));
    }
    this.settings.set('updates', updates);
    this.settings.set('last_check', Date.now());

    this.settings.set('checking', false);
    if (updates.length > 0) {
      if (this.settings.get('automatic', false)) {
        this.doUpdate();
      } else {
        this.notify('Updates are available', {
          text: 'Update now',
          type: 'blue',
          onClick: (close) => {
            this.doUpdate();
            close();
          }
        }, {
          text: 'Open Updater',
          onClick: async (close) => {
            const settingsModule = await getModule([ 'open', 'saveAccountChanges' ]);
            settingsModule.open('pc-updater');
            close();
          }
        });
      }
    }
  }

  async doUpdate (force = false) {
    this.settings.set('failed', false);
    this.settings.set('updating', true);
    const updates = this.settings.get('updates', []);
    const failed = [];
    for (const update of [ ...updates ]) {
      let entity = powercord;
      if (update.id.startsWith('plugin')) {
        entity = powercord.pluginManager.get(update.id.replace('plugins_', ''));
      } else if (update.id.startsWith('theme')) {
        entity = powercord.styleManager.get(update.id.replace('themes_', ''));
      }

      const success = await entity.update(force);
      updates.shift();
      this.settings.get('updates', updates);
      if (!success) {
        failed.push(update);
      }
    }

    this.settings.set('updating', false);
    if (failed.length > 0) {
      this.settings.set('failed', true);
      this.settings.set('updates', failed);
      if (!document.querySelector('.powercord-updater')) {
        this.notify('Some updates failed to install', {
          text: 'Force Update',
          onClick: (close) => this.askForce(close)
        }, {
          text: 'Ignore',
          onClick: (close) => close()
        }, {
          text: 'Open Updater',
          onClick: async (close) => {
            const settingsModule = await getModule([ 'open', 'saveAccountChanges' ]);
            settingsModule.open('pc-updater');
            close();
          }
        });
      }
    }
  }

  // MODALS
  notify (text, button1, button2, button3, button4) {
    if (document.getElementById('powercord-updater')) {
      return;
    }

    const container = createElement('div', { id: 'powercord-updater' });
    document.body.appendChild(container);
    ReactDOM.render(
      React.createElement(Toast, {
        style: {
          bottom: '25px',
          right: '25px',
          width: '320px'
        },
        header: text,
        buttons: [ button1, button2, button3, button4 ]
      }),
      container
    );
  }

  askForce (callback) {
    openModal(() =>
      React.createElement(Confirm, {
        red: true,
        header: 'Force update?',
        confirmText: 'Force update',
        cancelText: 'Cancel',
        onConfirm: () => {
          if (callback) {
            // eslint-disable-next-line callback-return
            callback();
          }
          this.doUpdate(true);
        },
        onCancel: closeModal
      }, React.createElement('div', { className: 'powercord-text' },
        'Are you sure you want to force update? Any local edit will be overwritten!'))
    );
  }

  // UTILS
  skipUpdate (id, commit) {
    this.settings.set('entities_skipped', {
      ...this.settings.get('entities_skipped', {}),
      [id]: commit
    });
    this._removeUpdate(id);
  }

  disableUpdates (entity) {
    this.settings.set('entities_disabled', [
      ...this.settings.get('entities_disabled', []),
      {
        id: entity.id,
        name: entity.name,
        icon: entity.icon
      }
    ]);
    this._removeUpdate(entity.id);
  }

  enableUpdates (id) {
    this.settings.set('entities_disabled', this.settings.get('entities_disabled', []).filter(d => d.id !== id));
  }

  _removeUpdate (id) {
    this.settings.set('updates', this.settings.get('updates', []).filter(u => u.id !== id));
  }

  async getGitInfos () {
    const branch = await exec('git branch', this.cwd)
      .then(({ stdout }) =>
        stdout
          .toString()
          .split('\n')
          .find(l => l.startsWith('*'))
          .slice(2)
          .trim()
      );

    const revision = await exec(`git rev-parse ${branch}`, this.cwd)
      .then(r => r.stdout.toString().trim());

    const upstream = await exec('git remote get-url origin', this.cwd)
      .then(r => r.stdout.toString().match(/github\.com[:/]([\w-_]+\/[\w-_]+)/)[1]);

    return {
      upstream,
      branch,
      revision
    };
  }

  // Change Log
  async openChangeLogs () {
    const ChangeLog = await this._getChangeLogsComponent();
    openModal(() => React.createElement(ChangeLog));
  }

  async _getChangeLogsComponent () {
    if (!this._ChangeLog) {
      const _this = this;
      const changeLogModule = await getModule([ 'changeLog' ]);
      const DiscordChangeLog = await getModuleByDisplayName('ChangeLog');

      class ChangeLog extends DiscordChangeLog {
        render () {
          const originalGetter = Object.getOwnPropertyDescriptor(changeLogModule.__proto__, 'changeLog').get;
          Object.defineProperty(changeLogModule, 'changeLog', {
            get: () => _this.formatChangeLog(changelog),
            configurable: true
          });
          const res = super.render();
          setImmediate(() => {
            Object.defineProperty(changeLogModule, 'changeLog', {
              get: originalGetter,
              configurable: true
            });
          });
          return res;
        }

        renderHeader () {
          const header = super.renderHeader();
          header.props.children[0].props.children = 'Powercord - What\'s New';
          return header;
        }

        renderVideo () {
          return null;
        }

        renderFooter () {
          const footer = super.renderFooter();
          footer.props.children = 'OwO whats this';
          return footer;
        }

        componentWillUnmount () {
          super.componentWillUnmount();
          _this.settings.set('last_changelog', changelog.id);
        }
      }

      this._ChangeLog = ChangeLog;
    }
    return this._ChangeLog;
  }

  formatChangeLog (json) {
    let body = '';
    const colorToClass = {
      GREEN: 'added',
      ORANGE: 'progress',
      RED: 'fixed',
      BLURPLE: 'improved'
    };
    json.contents.forEach(item => {
      if (item.type === 'HEADER') {
        body += `${item.text.toUpperCase()} {${colorToClass[item.color]}${item.noMargin ? ' marginTop' : ''}}\n======================\n\n`;
      } else {
        if (item.text) {
          body += item.text;
          body += '\n\n';
        }
        if (item.list) {
          body += ` * ${item.list.join('\n\n * ')}`;
          body += '\n\n';
        }
      }
    });
    return {
      date: json.date,
      locale: 'en-us',
      revision: 1,
      body
    };
  }
};
