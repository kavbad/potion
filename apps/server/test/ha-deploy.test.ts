// HA deploy artifacts — static inspection (M3 #27 HA, SPEC §12.8). Guards
// against drift in docker-compose.ha.yml + deploy/nginx.conf: two replicas
// built from the repo, shared postgres+redis (same images as the dev
// compose), /readyz healthchecks, nginx round-robining both replicas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

const composeHa = repoRoot('docker-compose.ha.yml');
const composeDev = repoRoot('docker-compose.yml');
const nginxConf = repoRoot('deploy/nginx.conf');
const dockerfile = repoRoot('Dockerfile');

describe('docker-compose.ha.yml (SPEC §12.8)', () => {
  it('declares two server replicas built from the repo Dockerfile', () => {
    expect(composeHa).toMatch(/^ {2}server-a:/m);
    expect(composeHa).toMatch(/^ {2}server-b:/m);
    expect(composeHa).toContain('dockerfile: Dockerfile');
    expect(composeHa.match(/<<: \*potion-server/g)).toHaveLength(2);
    expect(dockerfile).toContain('apps/server/dist/index.js');
  });

  it('wires DATABASE_URL / REDIS_URL / POTION_MASTER_KEY into the replicas', () => {
    expect(composeHa).toContain('DATABASE_URL: postgres://potion:potion@postgres:5432/potion');
    expect(composeHa).toContain('REDIS_URL: redis://redis:6379');
    expect(composeHa).toContain('POTION_MASTER_KEY');
  });

  it('reuses the existing compose postgres + redis images and healthchecks', () => {
    for (const image of ['pgvector/pgvector:pg16', 'redis:7']) {
      expect(composeDev).toContain(image); // shared with the dev compose file
      expect(composeHa).toContain(image);
    }
    expect(composeHa).toContain('pg_isready');
    expect(composeHa).toContain('redis-cli');
    expect(composeHa).toContain('condition: service_healthy');
  });

  it('healthchecks the replicas on /readyz (not /healthz)', () => {
    expect(composeHa).toContain('/readyz');
    expect(composeHa).not.toContain("fetch('http://localhost:3000/healthz')");
  });

  it('puts nginx in front as the published entry point', () => {
    expect(composeHa).toMatch(/^ {2}nginx:/m);
    expect(composeHa).toContain('nginx:1.27-alpine');
    expect(composeHa).toContain('./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro');
    expect(composeHa).toContain('"3000:80"');
  });
});

describe('deploy/nginx.conf (round-robin over both replicas)', () => {
  it('lists server-a AND server-b in the upstream (default = round-robin)', () => {
    expect(nginxConf).toMatch(/upstream potion_backend \{/);
    expect(nginxConf).toContain('server server-a:3000;');
    expect(nginxConf).toContain('server server-b:3000;');
    // no least_conn/ip_hash/weights → nginx's default round-robin applies
    expect(nginxConf).not.toMatch(/least_conn|ip_hash|weight=/);
  });

  it('proxies every path to the upstream', () => {
    expect(nginxConf).toContain('proxy_pass http://potion_backend;');
    expect(nginxConf).toMatch(/location \/ \{/);
  });
});
