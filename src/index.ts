#!/usr/bin/env node

import yargs = require('yargs/yargs');
import * as cp from 'child_process';
import chokidar from 'chokidar';
import express from 'express';
import fg from 'fast-glob';
import * as fs from 'fs';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { hostname } from 'os';
import * as path from 'path';
import { Mapping, RawSourceMap, SourceMapGenerator } from 'source-map';
import { promisify } from 'util';
import { Logger } from './logger';
import chalk = require('chalk');
import rimraf = require('rimraf');
import boxen = require('boxen');
import acorn = require('acorn');

const mkdirAsync = promisify(fs.mkdir);
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const copyFileAsync = promisify(fs.copyFile);

const DEFAULT_TEMP_DIR_NAME = '.devserver';
const CORE_MODULE = 'iobroker.js-controller';
const IOBROKER_CLI = 'node_modules/iobroker.js-controller/iobroker.js';
const IOBROKER_COMMAND = `node ${IOBROKER_CLI}`;
const DEFAULT_ADMIN_PORT = 8081;
const HIDDEN_ADMIN_PORT = 18881;
const HIDDEN_BROWSER_SYNC_PORT = 18882;

interface ArgV {
  adminPort: number;
  forceInstall: boolean | undefined;
  jsController: string;
  wait?: boolean;
  _: (string | number)[];
}

type RunCommand = 'run' | 'watch' | 'debug';

class DevServer {
  private readonly log = new Logger();
  private readonly runCommands: Readonly<RunCommand[]> = ['run', 'watch', 'debug'];
  private readonly argv: ArgV;
  private readonly rootDir: string;
  private readonly adapterName: string;
  private readonly tempDir: string;

  constructor() {
    const argv = yargs(process.argv.slice(2))
      .usage('Usage: $0 <command> [options]')
      .command(
        ['install', 'i'],
        'Install devserver in the current directory. This should always be called in the directory where the package.json file of your adapter is located.',
      )
      .command(['update', 'ud'], 'Update devserver and its dependencies to the latest versions')
      .command(
        ['run', 'r', '*'],
        'Run ioBroker devserver, the adapter will not run, but you may test the Admin UI with hot-reload',
      )
      /*.command(
        ['watch', 'w'],
        'Run ioBroker devserver and start the adapter in "watch" mode. The adapter will automatically restart when its source code changes. You may attach a debugger to the running adapter.',
      )*/
      .command(
        ['debug', 'd'],
        'Run ioBroker devserver and start the adapter from ioBroker in "debug" mode. You may attach a debugger to the running adapter.',
      )
      .command(
        ['upload', 'ul'],
        'Upload the current version of your adapter to the devserver. This is only required if you changed something relevant in your io-package.json',
      )
      .options({
        adapter: {
          type: 'string',
          alias: 'a',
          description: 'Overwrite the adapter name\n(by default the name is taken from package.json)',
        },
        adminPort: {
          type: 'number',
          default: DEFAULT_ADMIN_PORT,
          alias: 'p',
          description: 'TCP port on which ioBroker.admin will be available',
        },
        temp: {
          type: 'string',
          alias: 't',
          default: DEFAULT_TEMP_DIR_NAME,
          description: 'Directory where the local devserver will be installed',
        },
        jsController: {
          type: 'string',
          alias: 'j',
          default: 'latest',
          description: 'Define which version of js-controller to be used.\n(Only relavant for "install".)',
        },
        wait: {
          type: 'boolean',
          alias: 'w',
          description: 'Used with "debug" to start the adapter only once the debugger is attached.',
        },
        forceInstall: { type: 'boolean', hidden: true },
        root: { type: 'string', alias: 'r', hidden: true, default: '.' },
      })
      .check((argv) => {
        if (argv._.length === 0) {
          argv._.push('run');
        }

        // expand short command names
        this.runCommands.forEach((cmd) => {
          if (argv._.includes(cmd[0])) {
            argv._.push(cmd);
          }
        });

        // ensure only one of the run commands is included
        this.runCommands.forEach((cmd) => {
          if (argv._.includes(cmd)) {
            this.runCommands.forEach((other) => {
              if (other !== cmd && argv._.includes(other)) {
                throw new Error(`Can't combine ${cmd} and ${other}. You may only use one at a time.`);
              }
            });
          }
        });
        return true;
      })
      .help().argv;

    //console.log('argv', argv);
    this.argv = argv;

    this.rootDir = path.resolve(argv.root);
    this.adapterName = argv.adapter || this.findAdapterName();
    this.tempDir = path.resolve(this.rootDir, argv.temp);
  }

  async run(): Promise<void> {
    const runCommand = this.runCommands.find((c) => this.argv._.includes(c));

    if (this.argv.forceInstall) {
      this.log.notice(`Deleting ${this.tempDir}`);
      await this.rimraf(this.tempDir);
    }

    const jsControllerDir = path.join(this.tempDir, 'node_modules', CORE_MODULE);

    if (!fs.existsSync(jsControllerDir)) {
      await this.install();
    } else if (this.argv._.includes('install')) {
      this.log.error(`Devserver is already installed in "${this.tempDir}".`);
      this.log.debug(`Use --force-install to reinstall from scratch.`);
    }

    if (this.argv._.includes('update') || this.argv._.includes('ud')) {
      await this.update();
    }

    const shouldUpload = this.argv._.includes('upload') || this.argv._.includes('ul');
    if (shouldUpload || runCommand === 'debug' || runCommand === 'watch') {
      await this.installLocalAdapter();
    }
    if (shouldUpload) {
      this.uploadAdapter(this.adapterName);
    }

    if (runCommand) {
      await this.runServer(runCommand);
    }
  }

  private findAdapterName(): string {
    const pkg = this.readPackageJson();
    const pkgName: string = pkg.name;
    const match = pkgName.match(/^iobroker\.(.+)$/);
    if (!match || !match[1]) {
      throw new Error(`Invalid package name in package.json: "${pkgName}"`);
    }
    const adapterName = match[1];
    this.log.debug(`Found adapter name: "${adapterName}"`);
    return adapterName;
  }

  private readJson(filename: string): any {
    const json = fs.readFileSync(filename, 'utf-8');
    return JSON.parse(json);
  }

  private readPackageJson(): any {
    return this.readJson(path.join(this.rootDir, 'package.json'));
  }

  async runServer(runCommand: RunCommand): Promise<void> {
    this.log.notice(`Running ${runCommand} inside ${this.tempDir}`);

    if (runCommand === 'debug') {
      await this.copySourcemaps();
    }

    const proc = this.spawn('node', ['node_modules/iobroker.js-controller/controller.js'], this.tempDir);
    proc.on('exit', (code) => {
      console.error(chalk.yellow(`ioBroker controller exited with code ${code}`));
      process.exit(-1);
    });

    process.on('SIGINT', () => {
      this.log.notice('devserver is exiting...');
      server.close();
      // do not kill this process when receiving SIGINT, but let all child processes exit first
    });

    // figure out if we need parcel (React)
    const pkg = this.readPackageJson();
    const scripts = pkg.scripts;
    if (scripts && scripts['watch:parcel']) {
      // use parcel
      await this.startParcel();
    }

    this.startBrowserSync();

    // browser-sync proxy
    const app = express();
    const adminPattern = `/adapter/${this.adapterName}/**`;
    const pathRewrite: Record<string, string> = {};
    pathRewrite[`^/adapter/${this.adapterName}/`] = '/';
    app.use(
      createProxyMiddleware([adminPattern, '/browser-sync/**'], {
        target: `http://localhost:${HIDDEN_BROWSER_SYNC_PORT}`,
        //ws: true, // can't have two web-socket connections proxying to different locations
        pathRewrite,
      }),
    );

    // admin proxy
    app.use(
      createProxyMiddleware([`!${adminPattern}`, '!/browser-sync/**'], {
        target: `http://localhost:${HIDDEN_ADMIN_PORT}`,
        ws: true,
      }),
    );

    // start express
    this.log.notice(`Starting web server on port ${this.argv.adminPort}`);
    const server = app.listen(this.argv.adminPort);
    await new Promise<void>((resolve, reject) => {
      server.on('listening', resolve);
      server.on('error', reject);
      server.on('close', reject);
    });

    console.log(
      boxen(chalk.green(`Admin is now reachable under http://localhost:${this.argv.adminPort}/`), {
        padding: 1,
        borderStyle: 'round',
      }),
    );

    if (runCommand === 'debug') {
      this.startAdapterDebug();
    } else if (runCommand === 'watch') {
      await this.startAdapterWatch();
    }
  }

  private async copySourcemaps(): Promise<void> {
    const outDir = path.join(this.tempDir, 'node_modules', `iobroker.${this.adapterName}`);
    this.log.notice(`Creating or patching sourcemaps in ${outDir}`);
    const sourcemaps = await this.findFiles('map', true);
    if (sourcemaps.length === 0) {
      this.log.debug(`Couldn't find any sourcemaps in ${this.rootDir},\nwill try to reverse map .js files`);

      // search all .js files that exist in the node module in the temp directory as well as in the root directory and
      // create sourcemap files for each of them
      const jsFiles = await this.findFiles('js', true);
      await Promise.all(
        jsFiles.map(async (js) => {
          const src = path.join(this.rootDir, js);
          const dest = path.join(outDir, js);
          await this.addSourcemap(src, dest, false);
        }),
      );
      return;
    }

    // copy all *.map files to the node module in the temp directory and
    // change their sourceRoot so they can be found in the development directory
    await Promise.all(
      sourcemaps.map(async (sourcemap) => {
        const src = path.join(this.rootDir, sourcemap);
        const dest = path.join(outDir, sourcemap);
        this.patchSourcemap(src, dest);
      }),
    );
  }

  /**
   * Create an identity sourcemap to point to a different source file.
   * @param src The path to the original JavaScript file.
   * @param dest The path to the JavaScript file which will get a sourcemap attached.
   * @param copyFromSrc Set to true to copy the JavaScript file from src to dest (not just modify dest).
   */
  private async addSourcemap(src: string, dest: string, copyFromSrc: boolean) {
    try {
      const mapFile = `${dest}.map`;
      const data = await this.createIdentitySourcemap(src.replace(/\\/g, '/'));
      await writeFileAsync(mapFile, JSON.stringify(data));

      // append the sourcemap reference comment to the bottom of the file
      const fileContent = await readFileAsync(copyFromSrc ? src : dest, { encoding: 'utf-8' });
      const filename = path.basename(mapFile);
      let updatedContent = fileContent.replace(/(\/\/\# sourceMappingURL=).+/, `$1${filename}`);
      if (updatedContent === fileContent) {
        // no existing source mapping URL was found in the file
        if (!fileContent.endsWith('\n')) {
          if (fileContent.match(/\r\n/)) {
            // windows eol
            updatedContent += '\r';
          }
          updatedContent += '\n';
        }
        updatedContent += `//# sourceMappingURL=${filename}`;
      }

      await writeFileAsync(dest, updatedContent);
      this.log.debug(`Created ${mapFile} from ${src}`);
    } catch (error) {
      this.log.warn(`Couldn't reverse map for ${src}: ${error}`);
    }
  }

  /**
   * Patch an existing sourcemap file.
   * @param src The path to the original sourcemap file to patch and copy.
   * @param dest The path to the sourcemap file that is created.
   */
  private async patchSourcemap(src: string, dest: string) {
    try {
      const data = this.readJson(src);
      if (data.version !== 3) {
        throw new Error(`Unsupported sourcemap version: ${data.version}`);
      }
      data.sourceRoot = path.dirname(src).replace(/\\/g, '/');
      await writeFileAsync(dest, JSON.stringify(data));
      this.log.debug(`Patched ${dest} from ${src}`);
    } catch (error) {
      this.log.warn(`Couldn't patch ${dest}: ${error}`);
    }
  }

  private getFilePatterns(extensions: string | string[], excludeAdmin: boolean) {
    const exts = typeof extensions === 'string' ? [extensions] : extensions;
    const patterns = exts.map((e) => `./**/*.${e}`);
    patterns.push('!./.*/**');
    patterns.push('!./node_modules/**');
    patterns.push('!./test/**');
    if (excludeAdmin) {
      patterns.push('!./admin/**');
    }
    return patterns;
  }

  private async findFiles(extension: string, excludeAdmin: boolean): Promise<string[]> {
    return await fg(this.getFilePatterns(extension, excludeAdmin), { cwd: this.rootDir });
  }

  private async createIdentitySourcemap(filename: string): Promise<RawSourceMap> {
    // thanks to https://github.com/gulp-sourcemaps/identity-map/blob/251b51598d02e5aedaea8f1a475dfc42103a2727/lib/generate.js [MIT]
    const generator = new SourceMapGenerator({ file: filename });
    const fileContent = await readFileAsync(filename, { encoding: 'utf-8' });
    var tokenizer = acorn.tokenizer(fileContent, {
      ecmaVersion: 'latest',
      allowHashBang: true,
      locations: true,
    });

    while (true) {
      const token = tokenizer.getToken();

      if (token.type.label === 'eof' || !token.loc) {
        break;
      }
      const mapping: Mapping = {
        original: token.loc.start,
        generated: token.loc.start,
        source: filename,
      };
      generator.addMapping(mapping);
    }

    return generator.toJSON();
  }

  private async startParcel(): Promise<void> {
    this.log.notice('Starting parcel');
    this.log.debug('Waiting for first successful parcel build...');
    await this.spawnAndAwaitOutput('npm', ['run', 'watch:parcel'], this.rootDir, 'Built in', { shell: true });
  }

  private startBrowserSync(): void {
    this.log.notice('Starting browser-sync');
    var bs = require('browser-sync').create();

    const adminPath = path.resolve(this.rootDir, 'admin/');
    const config = {
      server: { baseDir: adminPath, directory: true },
      port: HIDDEN_BROWSER_SYNC_PORT,
      open: false,
      ui: false,
      logLevel: 'silent',
      files: [path.join(adminPath, '**')],
      plugins: [
        {
          module: 'bs-html-injector',
          options: {
            files: [path.join(adminPath, '*.html')],
          },
        },
      ],
    };
    // console.log(config);
    bs.init(config);
  }

  private startAdapterDebug() {
    this.log.notice(`Starting ioBroker adapter debugger for ${this.adapterName}.0`);
    const args = [IOBROKER_CLI, 'debug', `${this.adapterName}.0`];
    if (this.argv.wait) {
      args.push('--wait');
    }
    const proc = this.spawn('node', args, this.tempDir);
    proc.on('exit', (code) => {
      console.error(chalk.yellow(`Adapter debugger exited with code ${code}`));
      process.exit(-1);
    });
  }

  private async startAdapterWatch(): Promise<void> {
    // figure out if we need to watch for TypeScript changes
    const pkg = this.readPackageJson();
    const scripts = pkg.scripts;
    if (scripts && scripts['watch:ts']) {
      // use TSC
      await this.startTscWatch();
    }

    // start sync
    const adapterRunDir = path.join(this.tempDir, 'node_modules', `iobroker.${this.adapterName}`);
    await this.startFileSync(adapterRunDir);

    this.startNodemon(adapterRunDir, pkg.main);
  }

  private async startTscWatch(): Promise<void> {
    this.log.notice('Starting tsc --watch');
    this.log.debug('Waiting for first successful tsc build...');
    await this.spawnAndAwaitOutput(
      'npm',
      ['run', 'watch:ts', '--', '--preserveWatchOutput'],
      this.rootDir,
      'Watching for',
      { shell: true },
    );
  }

  private startFileSync(destinationDir: string) {
    this.log.notice(`Starting file system sync from ${this.rootDir}`);
    const inSrc = (filename: string) => path.join(this.rootDir, filename);
    const inDest = (filename: string) => path.join(destinationDir, filename);
    return new Promise<void>((resolve, reject) => {
      const patterns = this.getFilePatterns(['js', 'map'], true);
      const ignoreFiles = [] as string[];
      const watcher = chokidar.watch(patterns, { cwd: this.rootDir });
      let ready = false;
      watcher.on('error', reject);
      watcher.on('ready', () => {
        ready = true;
        resolve();
      });
      /*watcher.on('all', (event, path) => {
        console.log(event, path);
      });*/
      const syncFile = async (filename: string) => {
        try {
          this.log.debug(`Synchronizing ${filename}`);
          const src = inSrc(filename);
          const dest = inDest(filename);
          if (filename.endsWith('.map')) {
            await this.patchSourcemap(src, dest);
          } else if (!fs.existsSync(inSrc(`${filename}.map`))) {
            // copy file and add sourcemap
            await this.addSourcemap(src, dest, true);
          } else {
            await copyFileAsync(src, dest);
          }
        } catch (error) {
          this.log.warn(`Couldn't sync ${filename}`);
        }
      };
      watcher.on('add', (filename: string) => {
        if (ready) {
          syncFile(filename);
        } else if (!filename.endsWith('map') && !fs.existsSync(inDest(filename))) {
          // ignore files during initial sync if they don't exist in the target directory
          ignoreFiles.push(filename);
        } else {
          this.log.debug(`Watching ${filename}`);
        }
      });
      watcher.on('change', (filename: string) => {
        if (!ignoreFiles.includes(filename)) {
          syncFile(filename);
        }
      });
      watcher.on('unlink', (filename: string) => {
        fs.unlinkSync(inDest(filename));
        const map = inDest(filename + '.map');
        if (fs.existsSync(map)) {
          fs.unlinkSync(map);
        }
      });
    });
  }

  private startNodemon(baseDir: string, scriptName: string) {
    const script = path.resolve(baseDir, scriptName);
    this.log.notice(`Starting nodemon for ${script}`);

    let isExiting = false;
    process.on('SIGINT', () => {
      isExiting = true;
    });

    var nodemon = require('nodemon');
    nodemon({
      script: script,
      stdin: false,
      verbose: true,
      // dump: true, // this will output the entire config and not do anything
      colours: false,
      watch: [baseDir],
      ignore: [path.join(baseDir, 'admin')],
      ignoreRoot: [],
      delay: 2000,
      execMap: { js: 'node --inspect' },
      args: ['--debug', '0'],
    });
    nodemon
      .on('start', () => {
        console.log(
          boxen(chalk.green(`Your adapter ioBroker.${this.adapterName} is starting.\nYou may now attach a debugger.`), {
            padding: 1,
            borderStyle: 'round',
          }),
        );
      })
      .on('log', (msg: { type: 'log' | 'info' | 'status' | 'detail' | 'fail' | 'error'; message: string }) => {
        if (isExiting) {
          return;
        }
        const message = `[nodemon] ${msg.message}`;
        switch (msg.type) {
          case 'info':
            this.log.info(message);
            break;
          case 'status':
            this.log.notice(message);
            break;
          case 'fail':
            this.log.error(message);
            break;
          case 'error':
            this.log.warn(message);
            break;
          default:
            this.log.debug(message);
            break;
        }
      })
      .on('quit', () => {
        this.log.error('nodemon has exited');
        process.exit(-2);
      });
  }

  async install(): Promise<void> {
    this.log.notice(`Installing to ${this.tempDir}`);
    if (!fs.existsSync(this.tempDir)) {
      await mkdirAsync(this.tempDir);
    }

    // create the data directory
    const dataDir = path.join(this.tempDir, 'iobroker-data');
    if (!fs.existsSync(dataDir)) {
      await mkdirAsync(dataDir);
    }

    // create the configuration
    const config = {
      system: {
        memoryLimitMB: 0,
        hostname: `dev-${this.adapterName}-${hostname()}`,
        instanceStartInterval: 2000,
        compact: false,
        allowShellCommands: false,
        memLimitWarn: 100,
        memLimitError: 50,
      },
      multihostService: {
        enabled: false,
      },
      network: {
        IPv4: true,
        IPv6: false,
        bindAddress: '127.0.0.1',
        useSystemNpm: true,
      },
      objects: {
        type: 'file',
        host: '127.0.0.1',
        port: 19901,
        noFileCache: false,
        maxQueue: 1000,
        connectTimeout: 2000,
        writeFileInterval: 5000,
        dataDir: '',
        options: {
          auth_pass: null,
          retry_max_delay: 5000,
          retry_max_count: 19,
          db: 0,
          family: 0,
        },
      },
      states: {
        type: 'file',
        host: '127.0.0.1',
        port: 19900,
        connectTimeout: 2000,
        writeFileInterval: 30000,
        dataDir: '',
        options: {
          auth_pass: null,
          retry_max_delay: 5000,
          retry_max_count: 19,
          db: 0,
          family: 0,
        },
      },
      log: {
        level: 'debug',
        maxDays: 7,
        noStdout: false,
        transport: {
          file1: {
            type: 'file',
            enabled: true,
            filename: 'log/iobroker',
            fileext: '.log',
            maxsize: null,
            maxFiles: null,
          },
        },
      },
      plugins: {},
      dataDir: '../../iobroker-data/',
    };
    await writeFileAsync(path.join(dataDir, 'iobroker.json'), JSON.stringify(config, null, 2));

    // create the package file
    const pkg = {
      name: `devserver.${this.adapterName}`,
      version: '1.0.0',
      private: true,
      dependencies: {
        'iobroker.js-controller': this.argv.jsController,
        'iobroker.admin': 'latest',
        'iobroker.info': 'latest',
      },
    };
    await writeFileAsync(path.join(this.tempDir, 'package.json'), JSON.stringify(pkg, null, 2));

    this.log.notice('Installing everything...');
    this.execSync('npm install --loglevel error --production', this.tempDir);

    this.uploadAndAddAdapter('admin');
    this.uploadAndAddAdapter('info');

    // reconfigure admin instance (only listen to local IP address)
    this.log.notice('Configure admin.0');
    this.execSync(`${IOBROKER_COMMAND} set admin.0 --port ${HIDDEN_ADMIN_PORT} --bind 127.0.0.1`, this.tempDir);

    // install local adapter
    await this.installLocalAdapter();
    this.uploadAndAddAdapter(this.adapterName);

    this.log.notice(`Stop ${this.adapterName}.0`);
    this.execSync(`${IOBROKER_COMMAND} stop ${this.adapterName} 0`, this.tempDir);
  }

  private uploadAndAddAdapter(name: string): void {
    // upload the already installed adapter
    this.uploadAdapter(name);

    // create an instance
    this.log.notice(`Add ${name}.0`);
    this.execSync(`${IOBROKER_COMMAND} add ${name} 0`, this.tempDir);
  }

  private uploadAdapter(name: string): void {
    this.log.notice(`Upload iobroker.${name}`);
    this.execSync(`${IOBROKER_COMMAND} upload ${name}`, this.tempDir);
  }

  private async installLocalAdapter(): Promise<void> {
    this.log.notice(`Install local iobroker.${this.adapterName}`);

    const command = 'npm pack';
    this.log.debug(`${this.rootDir}> ${command}`);
    const filename = cp.execSync(command, { cwd: this.rootDir, encoding: 'ascii' }).trim();
    this.log.info(`Packed to ${filename}`);

    const fullPath = path.join(this.rootDir, filename);
    this.execSync(`npm install --no-save "${fullPath}"`, this.tempDir);

    await this.rimraf(fullPath);
  }

  private async update(): Promise<void> {
    this.log.notice('Updating everything...');
    this.execSync('npm update --loglevel error', this.tempDir);
    await this.installLocalAdapter();
  }

  private execSync(command: string, cwd: string, options?: cp.ExecSyncOptionsWithBufferEncoding): Buffer {
    options = { cwd: cwd, stdio: 'inherit', ...options };
    this.log.debug(`${cwd}> ${command}`);
    return cp.execSync(command, options);
  }

  private spawn(command: string, args: ReadonlyArray<string>, cwd: string, options?: cp.SpawnOptions) {
    this.log.debug(`${cwd}> ${command} ${args.join(' ')}`);
    const proc = cp.spawn(command, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: cwd,
      ...options,
    });
    let alive = true;
    proc.on('exit', () => (alive = false));
    process.on('exit', () => alive && proc.kill());
    return proc;
  }

  private spawnAndAwaitOutput(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    awaitMsg: string,
    options?: cp.SpawnOptions,
  ): Promise<cp.ChildProcess> {
    return new Promise<cp.ChildProcess>((resolve, reject) => {
      const proc = this.spawn(command, args, cwd, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        console.log(str.trimEnd());
        if (str.includes(awaitMsg)) {
          resolve(proc);
        }
      });
      proc.stderr?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8').trimEnd();
        console.error(str);
        reject(str);
      });
      process.on('SIGINT', () => {
        proc.kill();
        reject('SIGINT');
      });
    });
  }

  private rimraf(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => rimraf(name, (err) => (err ? reject(err) : resolve())));
  }
}

(() =>
  new DevServer().run().catch((e) => {
    console.error(chalk.red(e));
    process.exit(-1);
  }))();
