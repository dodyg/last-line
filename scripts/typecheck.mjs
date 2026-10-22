// tsrs 0.18 has native packages for Linux x64/arm64 and macOS arm64.
// Use the official Rust WASM compiler elsewhere, including Windows.
const useNative = Boolean(process.env.TSRS_BINARY)
  || (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))
  || (process.platform === 'darwin' && process.arch === 'arm64');
const compiler = useNative ? 'tsrs' : '@tsrs/wasm';
const packageUrl = import.meta.resolve(`${compiler}/package.json`);
const entry = new URL(useNative ? './bin/tsrs' : './bin/tsrs-wasm.js', packageUrl);

await import(entry.href);
