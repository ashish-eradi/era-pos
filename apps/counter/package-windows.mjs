import console from 'node:console';
import process from 'node:process';

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, Platform, build } from 'electron-builder';

const [version, mode, ...extra] = process.argv.slice(2);
const rehearsal = mode === '--rehearsal';
if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || (mode && !rehearsal) || extra.length) {
  throw new Error('Run npm run package:counter -- <major.minor.patch> [--rehearsal]');
}

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source,'../..');
const require = createRequire(import.meta.url);
const installedElectron = dirname(require.resolve('electron/package.json'));
const electron = JSON.parse(await readFile(join(installedElectron,'package.json'),'utf8'));
const contracts = join(root,'packages/contracts');
const cache = join(root,'.npm-cache');
await mkdir(cache,{ recursive: true });
process.env.ELECTRON_BUILDER_CACHE ??= join(cache,'electron-builder');
const stage = await mkdtemp(join(cache,'counter-package-'));
await cp(join(source,'dist'),join(stage,'dist'),{ recursive: true });
await cp(join(source,'migrations'),join(stage,'migrations'),{ recursive: true });
await writeFile(join(stage,'package.json'),JSON.stringify({
  name: 'era-counter',
  productName: rehearsal ? 'ERA POS Counter Rehearsal' : 'ERA POS Counter',
  description: 'ERA POS Windows register',
  author: 'ERA',
  main: 'dist/main/index.js',
  version,
}));

if (rehearsal) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  delete process.env.CSC_LINK;
  delete process.env.WIN_CSC_LINK;
}

const output = join(cache,'releases',rehearsal ? 'rehearsal' : 'signed',version);
const name = `ERA-POS-Counter-${version}${rehearsal ? '-rehearsal' : ''}-setup.exe`;
await build({
  projectDir: stage,
  targets: Platform.WINDOWS.createTarget('nsis',Arch.x64),
  publish: 'never',
  config: {
    appId: rehearsal ? 'com.eradi.pos.counter.rehearsal' : 'com.eradi.pos.counter',
    electronVersion: electron.version,
    electronDist: join(installedElectron,'dist'),
    directories: { output },
    files: ['dist/**/*','migrations/**/*','package.json'],
    extraResources: [
      { from: contracts, to: 'node_modules/@era/contracts', filter: ['package.json','dist/**/*.js'] },
    ],
    npmRebuild: false,
    forceCodeSigning: !rehearsal,
    nsis: {
      artifactName: name,
      include: join(source,'installer.nsh'),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      createStartMenuShortcut: !rehearsal,
      createDesktopShortcut: !rehearsal,
    },
  },
});

const installer = join(output,name);
if (!rehearsal) {
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:ERA_INSTALLER_TO_VERIFY',
    '$app = Get-AuthenticodeSignature -LiteralPath $env:ERA_APP_TO_VERIFY',
    'if ($signature.Status -ne "Valid" -or $app.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ne $app.SignerCertificate.Thumbprint) { throw "Setup and application require the same valid Authenticode signer" }',
  ].join('\n');
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    env: { ...process.env, ERA_INSTALLER_TO_VERIFY: installer, ERA_APP_TO_VERIFY: join(output,'win-unpacked','ERA POS Counter.exe') }, stdio: 'inherit',
  });
}
console.log(installer);
