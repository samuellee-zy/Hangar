// Creates a self-signed code-signing certificate, "Hangar Local", in your login keychain.
//
// Run once: npm run cert:local
//
// Optional. `npm run install:local` signs ad-hoc without it, and ad-hoc is enough for macOS to
// deliver notifications. What it doesn't give you is a *stable* identity: an ad-hoc signature is a
// hash of the bundle, so every build is a different app as far as privacy permissions go, and
// macOS asks again for camera and microphone after each install. A certificate is the same identity
// every build, so a grant survives rebuilds. See docs/packaging.md, "Signing".
//
// This is not a Developer ID. It lets this Mac recognise its own builds and nothing more: another
// Mac will still refuse the app, and nothing here can be notarised.
//
// What it changes on your Mac, all in your login keychain and all removable in Keychain Access:
//   - adds a certificate and private key named "Hangar Local"
//   - marks that certificate trusted for code signing only (macOS asks for your password)
// The first build afterwards may ask whether codesign can use the key; choose "Always Allow".

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = 'Hangar Local';
const KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
// The system's LibreSSL, not whatever `openssl` is first on PATH. Homebrew's OpenSSL 3 writes
// PKCS#12 with AES and PBKDF2, which `security import` rejects with an unhelpful "MAC verification
// failed"; LibreSSL's defaults are the ones the keychain reads.
const OPENSSL = '/usr/bin/openssl';

if (process.platform !== 'darwin') {
  console.error('This creates a macOS keychain certificate, and this is not macOS.');
  process.exit(1);
}

function run(command, args, { input } = {}) {
  const result = spawnSync(command, args, { stdio: ['pipe', 'inherit', 'inherit'], input });
  if (result.status !== 0) {
    console.error(`\n✗ ${command} ${args[0]} failed (${result.status ?? result.signal ?? result.error})`);
    process.exit(1);
  }
}

const hasIdentity = () =>
  spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    .stdout.includes(`"${NAME}"`);

if (hasIdentity()) {
  console.log(`✓ "${NAME}" is already a valid code-signing identity. Nothing to do.`);
  process.exit(0);
}

// Key material only ever touches this directory, and it is removed whatever happens.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cert-'));
try {
  const config = path.join(work, 'openssl.cnf');
  const key = path.join(work, 'key.pem');
  const cert = path.join(work, 'cert.pem');
  const bundle = path.join(work, 'identity.p12');
  // Only protects the file for the seconds between writing and importing it.
  const passphrase = crypto.randomBytes(24).toString('hex');

  // codeSigning as the only extended key usage, critical, so the certificate is good for signing
  // code and refused for anything else — TLS, email, another CA.
  fs.writeFileSync(
    config,
    [
      '[ req ]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[ dn ]',
      `CN = ${NAME}`,
      '[ ext ]',
      'basicConstraints = critical,CA:false',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = critical,codeSigning',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n')
  );

  console.log(`▸ Generating "${NAME}" (RSA 2048, valid 10 years)`);
  run(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-config', config, '-keyout', key, '-out', cert]);
  run(OPENSSL, ['pkcs12', '-export', '-name', NAME, '-inkey', key, '-in', cert,
    '-out', bundle, '-passout', `pass:${passphrase}`]);

  console.log('▸ Importing it into your login keychain');
  // -T: codesign may use the key without asking every time.
  run('security', ['import', bundle, '-k', KEYCHAIN, '-P', passphrase, '-T', '/usr/bin/codesign']);

  console.log('▸ Trusting it for code signing (macOS will ask for your password)');
  // Per-user trust, code signing only. Without it the identity exists but is not *valid*, and
  // `find-identity -v` — which electron-builder relies on — does not list it.
  run('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', KEYCHAIN, cert]);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (!hasIdentity()) {
  console.error(`\n✗ "${NAME}" was imported but is not listed as a valid code-signing identity.`);
  console.error('  Open Keychain Access, find it under "My Certificates", and check its trust settings.');
  process.exit(1);
}
console.log(`\n✓ "${NAME}" is ready. \`npm run install:local\` will sign with it from now on.`);
