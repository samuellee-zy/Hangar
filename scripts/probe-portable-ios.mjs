// Uses an isolated temporary simulator. Tests language/runtime compatibility, not mobile product readiness.
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ios-contract-'));
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer' };
const run = (...args) => execFileSync('xcrun', args, { env, encoding: 'utf8', timeout: 180_000 }).trim();
let device;
try {
  await build({ configFile: false, logLevel: 'error', build: { target: 'es2022', minify: false, outDir: path.join(directory, 'js'),
    lib: { entry: path.resolve('spikes/mobile-contract/probe.ts'), formats: ['iife'], name: 'HangarProbe', fileName: () => 'probe.js' } } });
  const runtime = JSON.parse(run('simctl', 'list', 'runtimes', '--json')).runtimes.find((r) => r.isAvailable && r.name === 'iOS 26.5');
  if (!runtime) throw new Error('Install the iOS 26.5 simulator runtime before running this probe.');
  const sdk = run('--sdk', 'iphonesimulator', '--show-sdk-path');
  const binary = path.join(directory, 'probe');
  run('--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios26.5-simulator`,
    '-module-cache-path', path.join(directory, 'modules'), 'spikes/mobile-contract/main.swift', '-o', binary);
  device = run('simctl', 'create', 'Hangar connector probe', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', runtime.identifier);
  console.log('Booting an isolated iOS simulator for the portable broker probe…');
  run('simctl', 'boot', device);
  run('simctl', 'bootstatus', device, '-b');
  console.log(run('simctl', 'spawn', device, binary, path.join(directory, 'js', 'probe.js')));
} finally {
  if (device) {
    try { run('simctl', 'shutdown', device); } finally { run('simctl', 'delete', device); }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
