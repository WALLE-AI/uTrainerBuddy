import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { repoRoot, run, rustEnv } from './toolchain.mjs';

if (process.platform !== 'win32') throw new Error('Install Rust with your platform toolchain manager, then run cargo build.');
const installer = resolve(repoRoot, '.tools/tmp/rustup-init.exe');
const response = await fetch('https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe');
if (!response.ok) throw new Error(`Rustup download failed: ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(installer));
await run(installer, ['-y', '--no-modify-path', '--default-toolchain', 'stable', '--profile', 'minimal', '-c', 'rustfmt', '-c', 'clippy'], { env: rustEnv });
