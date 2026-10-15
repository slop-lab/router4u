import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const name = `router4u-container-test-${process.pid}`;
const volume = `${name}-data`;
const transcripts = `${name}-transcripts`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { docker('exec', name, 'node', '/app/src/container-health.js'); return; } catch { await delay(150); }
  }
  throw new Error('Bundled container did not become ready');
}
const key = () => docker('exec', name, 'router4u', 'admin-key', 'show');
const killRole = role => docker('exec', name, 'node', '-e', `const fs=require('fs'); for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(${role === 'backend' ? "args[0]==='/usr/local/bin/cli-proxy-api'" : "args.includes('/app/src/cli.js') && args.includes('serve')"})process.kill(Number(pid),'SIGKILL');}catch{}}`);
try {
  docker('volume', 'create', volume);
  docker('volume', 'create', transcripts);
  docker('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '-p', '127.0.0.1::9470', '-v', `${volume}:/var/lib/router4u`, '-v', `${transcripts}:/var/lib/router4u-transcripts`, 'router4u:local');
  await ready();
  const initialKey = key();
  assert.ok(initialKey.length >= 40);
  assert.equal(docker('logs', name).includes(initialKey), false);
  const inspection = JSON.parse(docker('inspect', name))[0];
  assert.equal(inspection.NetworkSettings.Ports['9470/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(inspection.NetworkSettings.Ports['8317/tcp'], undefined);
  const state = JSON.parse(docker('exec', name, 'node', '-e', "const fs=require('fs');const path='/var/lib/router4u/';console.log(JSON.stringify({config:JSON.parse(fs.readFileSync(path+'router4u.json')),backend:JSON.parse(fs.readFileSync(path+'cliproxyapi.yaml')),mode:fs.statSync(path+'secrets.json').mode&511,env:fs.existsSync(path+'.env')}));"));
  assert.equal(state.config.transcript_dir, '/var/lib/router4u-transcripts');
  assert.equal(inspection.Mounts.find(m => m.Destination === '/var/lib/router4u-transcripts').Name, transcripts);
  assert.notEqual(transcripts, volume);
  assert.equal(state.config.routes[0].enabled, false);
  assert.deepEqual(state.config.routes[0].models, []);
  assert.equal(state.backend.server.host, '127.0.0.1');
  assert.equal(state.backend.management['allow-remote'], false);
  assert.equal(state.mode, 0o600);
  assert.equal(state.env, false);
  const health = JSON.parse(docker('exec', name, 'router4u', 'health'));
  assert.ok(health);
  docker('exec', name, 'node', '-e', "require('fs').writeFileSync('/tmp/policy.json',JSON.stringify({routes:['personal']}))");
  docker('exec', name, 'router4u', 'project', 'put', 'persistent-project', '--file', '/tmp/policy.json');
  docker('exec', name, 'router4u', 'project', 'key', 'persistent-project');
  docker('exec', name, 'node', '-e', "const fs=require('fs');if(!fs.existsSync('/var/lib/router4u-transcripts/audit.jsonl')||fs.existsSync('/var/lib/router4u/data/transcripts')||fs.existsSync('/var/lib/router4u/data/logs'))process.exit(1);");
  docker('stop', '-t', '30', name);
  assert.equal(JSON.parse(docker('inspect', name))[0].State.ExitCode, 0);
  docker('start', name);
  await ready();
  assert.equal(key(), initialKey);
  docker('exec', name, 'router4u', 'effective-policy', 'persistent-project');
  // A second credential owner must never start against the same state volume.
  assert.throws(() => docker('run', '--rm', '-v', `${volume}:/var/lib/router4u`, '-v', `${transcripts}:/var/lib/router4u-transcripts`, 'router4u:local'));
  assert.throws(() => docker('exec', name, 'router4u', 'admin-key', 'rotate'));
  for (const role of ['backend', 'gateway']) {
    killRole(role);
    assert.notEqual(docker('wait', name), '0');
    docker('start', name);
    await ready();
    assert.equal(key(), initialKey);
  }
  docker('rm', '-f', name);
  docker('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '-p', '127.0.0.1::9470', '-v', `${volume}:/var/lib/router4u`, '-v', `${transcripts}:/var/lib/router4u-transcripts`, 'router4u:local');
  await ready();
  assert.equal(key(), initialKey);
  docker('exec', name, 'router4u', 'effective-policy', 'persistent-project');
  docker('stop', '-t', '30', name);
  const rotated = docker('run', '--rm', '-v', `${volume}:/var/lib/router4u`, '-v', `${transcripts}:/var/lib/router4u-transcripts`, 'router4u:local', 'admin-key', 'rotate');
  assert.equal(rotated.includes(initialKey), false);
  docker('start', name);
  await ready();
  assert.notEqual(key(), initialKey);
  docker('exec', name, 'router4u', 'effective-policy', 'persistent-project');
  console.log('Bundled container contracts passed: initialization, private persistent keys, loopback-only backend, host bind, passive health, ledger persistence, single-owner lock, graceful stop, process failures, container replacement, and stopped-service administrator-key rotation. No live provider was used.');
} finally {
  try { docker('rm', '-f', name); } catch { /* Already removed. */ }
  docker('volume', 'rm', volume);
  docker('volume', 'rm', transcripts);
}
