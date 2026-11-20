import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { scanDeployment } from '../skills/floorplan/scripts/lib/deployment.mjs';
import { cleanup, makeProject, readGraph, run } from './helpers.mjs';

const scan = (sources) => scanDeployment(Object.keys(sources).map((path) => ({ path, repo: '.' })), (path) => sources[path]);
const edge = (from, to, kind, file, line) => ({ from, to, kind, evidence: { file, line } });

test('deployment: Compose links Caddy, a release image, migrations, and PostgreSQL with evidence', () => {
  const compose = 'compose.release.yml';
  const caddy = 'deploy/Caddyfile.local';
  const docker = 'Dockerfile';
  const server = 'rel/overlays/bin/server';
  const migrate = 'rel/overlays/bin/migrate';
  const ecto = 'lib/sample/release.ex';
  const result = scan({
    [compose]: [
      'services:',
      '  db:',
      '    image: docker.io/library/postgres:16',
      '  app:',
      '    environment:',
      '      PHX_HOST: localhost',
      '      SECRET_KEY_BASE: invented-value-must-stay-out-of-map',
      '    build: .',
      '    depends_on:',
      '      db: { condition: service_healthy }',
      '  proxy:',
      '    image: caddy:2',
      '    volumes:',
      '      - ./deploy/Caddyfile.local:/etc/caddy/Caddyfile:ro',
      '    depends_on: [app]',
      '  migrate:',
      '    command: ["/app/bin/migrate"]',
      '    depends_on: [db]',
    ].join('\n'),
    [caddy]: ':8080 {\n  reverse_proxy /internal/* http://app:4000\n}\n',
    [docker]: 'FROM elixir AS build\nRUN mix release\nFROM debian\nCMD ["/app/bin/server"]\n',
    [server]: '#!/bin/sh\nPHX_SERVER=true exec ./sample start\n',
    [migrate]: '#!/bin/sh\nexec ./sample eval "Sample.Release.migrate()"\n',
    [ecto]: 'defmodule Sample.Release do\n  def migrate do\n    Ecto.Migrator.run(repo, :up, all: true)\n  end\nend\n',
  });
  const id = (name) => `${compose}#service:${name}`;
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get(id('db')).kind, 'postgres');
  assert.equal(byId.get(id('app')).kind, 'phoenix-service');
  assert.equal(byId.get(id('proxy')).kind, 'caddy');
  assert.equal(byId.get(id('migrate')).kind, 'migration-service');
  assert.deepEqual(byId.get(id('app')).evidence, [{ file: compose, line: 4 }]);
  assert.deepEqual(byId.get(ecto).evidence, [{ file: ecto, line: 3 }]);
  assert.deepEqual(result.edges, [
    edge(server, migrate, 'includes_migration', migrate, 2),
    edge(migrate, ecto, 'invokes', migrate, 2),
    edge(docker, server, 'starts', docker, 4),
    edge(id('app'), id('db'), 'depends_on', compose, 9),
    edge(id('app'), docker, 'builds', compose, 8),
    edge(id('proxy'), id('app'), 'depends_on', compose, 15),
    edge(id('proxy'), caddy, 'mounts', compose, 13),
    edge(caddy, id('app'), 'reverse_proxy', caddy, 2),
    edge(id('migrate'), id('db'), 'depends_on', compose, 18),
    edge(id('migrate'), migrate, 'runs', compose, 17),
  ]);
  assert.doesNotMatch(JSON.stringify(result), /invented-value/);
});

test('deployment: keeps Compose declarations separate and marks a release image inferred from its fixture', () => {
  const release = 'compose.release.yaml';
  const vps = 'compose.vps.yml';
  const caddy = 'deploy/Caddyfile.vps';
  const result = scan({
    [release]: 'services:\n  app:\n    image: ${SAMPLE_RELEASE_IMAGE:?request a local image}\n    environment: [PHX_HOST=localhost]\n    depends_on: [db]\n  db:\n    image: postgres:16\n',
    [vps]: 'services:\n  proxy:\n    volumes:\n      - type: bind\n        source: deploy/Caddyfile.vps\n        target: /etc/caddy/Caddyfile\n  app:\n    environment: { PHX_HOST: example.invalid }\n',
    [caddy]: 'example.invalid {\n  # reverse_proxy db:5432\n  reverse_proxy app:4000 db:5432 {\n  }\n}\n',
    Dockerfile: 'FROM elixir\nRUN mix release\nCMD bin/server\n',
  });
  assert.deepEqual(result.edges, [
    edge(`${release}#service:app`, `${release}#service:db`, 'depends_on', release, 5),
    edge(`${release}#service:app`, 'Dockerfile', 'release_image_candidate', release, 3),
    edge(`${vps}#service:proxy`, caddy, 'mounts', vps, 3),
    edge(caddy, `${vps}#service:app`, 'reverse_proxy', caddy, 3),
  ]);
  assert.doesNotMatch(JSON.stringify(result), /php|example\.invalid|request a local image/);
});

test('deployment: skips dynamic, unrelated, and out-of-root source paths and never calls a reader for them', () => {
  const result = scanDeployment([
    { path: 'app/compose.yml', repo: 'app' },
    { path: 'other/Caddyfile', repo: 'other' },
    { path: 'app/compose.too-large.yml', repo: 'app', tooLarge: true },
    { path: 'app/.env', repo: 'app' },
  ], (path) => {
    if (path === 'other/Caddyfile') return 'reverse_proxy app:4000';
    assert.equal(path, 'app/compose.yml');
    return 'services:\n  app:\n    depends_on: [absent]\n    command: [echo, /app/bin/migrate]\n    volumes: ["../other/Caddyfile:/etc/caddy/Caddyfile", "${PATH}:/etc/caddy/Caddyfile"]\n';
  });
  assert.equal(result.nodes.find((node) => node.name === 'app').kind, 'service');
  assert.deepEqual(result.edges, []);
});

test('deployment view shows relationships, filters source evidence, and escapes scanned labels', () => {
  const source = readFileSync(new URL('../skills/floorplan/assets/ui/deployment.js', import.meta.url), 'utf8');
  const result = scan({ 'compose.yml': 'services:\n  app:\n    depends_on: [db]\n  db:\n    image: postgres:16\n' });
  result.nodes[0].name = '<img src=x>';
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const input = { value: '', focus: () => {}, addEventListener: (event, callback) => { input[event] = callback; } };
  const results = { innerHTML: '' };
  let openDeployment;
  runInNewContext(source, {
    window: { Floorplan: {
      graph: { deployment: result },
      h: escape,
      hk: escape,
      editorUrl: (file, line) => `vscode://file/project/${file}:${line}`,
      addHeaderButton: ({ onClick }) => { openDeployment = onClick; },
      modal: () => ({ el: { querySelector: (selector) => selector.includes('filter') ? input : results, addEventListener: () => {} } }),
    } },
    document: { createElement: () => ({}), head: { appendChild: () => {} } },
  });
  openDeployment();
  assert.match(results.innerHTML, /&lt;img src=x&gt;.*depends on.*db/);
  assert.match(results.innerHTML, /href="vscode:\/\/file\/project\/compose\.yml:3"/);
  assert.doesNotMatch(results.innerHTML, /<img/);
  input.value = 'compose.yml database-missing';
  input.input();
  assert.match(results.innerHTML, /No deployment components or relationships match/);
});

test('scan and build carry deployment source evidence into the generated map', (t) => {
  const root = makeProject({
    'compose.release.yml': 'services:\n  proxy:\n    image: caddy:2\n    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]\n  app:\n    environment: [PHX_HOST=localhost]\n',
    Caddyfile: ':8080 {\n  reverse_proxy app:4000\n}\n',
    'lib/sample.ex': 'defmodule Sample do\nend\n',
  }, { arch: {
    project: { name: 'Deployment sample', summary: 'A sample release.' },
    nodes: [{ id: 'app', label: 'Application', kind: 'service', summary: 'A small application.', paths: ['lib/**'] }],
  } });
  t.after(() => cleanup(root));
  const summary = JSON.parse(run('scan.mjs', root, '--unattended', '--json'));
  assert.equal(summary.counts.deploymentComponents, 3);
  assert.equal(summary.counts.deploymentConnections, 2);
  run('build.mjs', root, '--agent', 'none', '--unattended');
  const graph = readGraph(root);
  assert.deepEqual(graph.deployment.edges, [
    edge('compose.release.yml#service:proxy', 'Caddyfile', 'mounts', 'compose.release.yml', 4),
    edge('Caddyfile', 'compose.release.yml#service:app', 'reverse_proxy', 'Caddyfile', 2),
  ]);
  const html = readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.match(html, /ui\/deployment\.js/);
  assert.match(html, /"reverse_proxy","evidence":\{"file":"Caddyfile","line":2\}/);
});
