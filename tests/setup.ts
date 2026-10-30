import { Storage as BrowserStorage } from 'happy-dom';

// Node 26 exposes an unavailable native localStorage global. Use the same
// browser storage implementation as the DOM environment, without a disk file.
Object.defineProperty(globalThis, 'localStorage', { value: new BrowserStorage(), configurable: true, writable: true });
