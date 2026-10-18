import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { Connection } from './contracts';

/** Separate from config/export/sync. Fail closed when the OS cannot protect credentials. */
export class ConnectorVault {
  constructor(private readonly directory: string) {}
  private file() { return path.join(this.directory, 'connector-credentials.enc'); }
  private available(): void {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Unlock your system keychain to connect accounts.');
    }
  }
  load(): Connection[] {
    if (!fs.existsSync(this.file())) return [];
    this.available();
    const value: unknown = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file())));
    if (!Array.isArray(value) || !value.every((c) => c && typeof c.id === 'string' && typeof c.serviceId === 'string'
      && ['slack', 'gmail'].includes(c.kind) && typeof c.accessToken === 'string' && typeof c.refreshToken === 'string'
      && typeof c.clientId === 'string' && typeof c.identity === 'string' && typeof c.expiresAt === 'number')) {
      throw new Error('Connected account credentials could not be read.');
    }
    return value as Connection[];
  }
  save(connections: Connection[]): void {
    this.available();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file()}.tmp`;
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(connections)), { mode: 0o600 });
    fs.renameSync(temporary, this.file());
  }
}
