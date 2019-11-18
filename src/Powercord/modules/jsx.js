/**
 * Powercord, a lightweight @discordapp client mod focused on simplicity and performance
 * Copyright (C) 2018-2019  aetheryx & Bowser65
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const sucrase = require('sucrase');
const { join } = require('path');
const { readFileSync, promises: { mkdir, writeFile } } = require('fs');
const { createHash } = require('crypto');

const cacheDir = join(__dirname, '../../../cache/jsx/');

const checksum = (str) => createHash('sha1').update(str).digest('hex');

module.exports = () => {
  mkdir(cacheDir, { recursive: true });

  require.extensions['.jsx'] = (_module, filename) => {
    const source = readFileSync(filename, 'utf8');
    const hash = checksum(`/* jsx-sucrase | ${filename} */${source}`);
    const transformPath = join(cacheDir, `${hash}.js`);

    let alreadyTransformed = false;
    let transform;
    try {
      transform = readFileSync(transformPath, 'utf8');
      alreadyTransformed = true;
    } catch (err) {
      transform = sucrase.transform(source, {
        transforms: [ 'jsx' ],
        filePath: filename
      }).code;
    }

    _module._compile(transform, filename);

    // Atomic writes when
    try {
      if (!alreadyTransformed) {
        writeFile(transformPath, transform);
      }
    } catch (err) {
      console.error('[JSX]', 'Failed to write to cache');
      console.error(err);
    }
  };
};
