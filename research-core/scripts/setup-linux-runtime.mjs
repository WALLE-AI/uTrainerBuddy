import { run, wsl } from './common.mjs';
// Development-only private root. Never install packages into the Docker Desktop system root.
await run('wsl.exe',wsl.args('/bin/sh','-c',
  'mkdir -p /tmp/trainerbuddy-research-runtime && apk --root /tmp/trainerbuddy-research-runtime --initdb --no-scripts --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories add --no-cache git bash openssh-server openssh-client'
));
console.log('Linux test runtime installed in /tmp/trainerbuddy-research-runtime');
