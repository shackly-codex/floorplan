// Static deployment topology. Only declarations and local, scanned source paths enter the graph.
import path from 'node:path';
import { parseYaml } from './serverless.mjs';

const COMPOSE_FILE = /^(?:docker-compose|compose)(?:[.-][\w.-]+)?\.ya?ml$/i;
const CADDY_FILE = /^caddyfile(?:[.-][\w.-]+)?$/i;
const DOCKER_FILE = /^(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const RELEASE_SCRIPT = /(?:^|\/)rel\/overlays\/bin\/(server|migrate)$/;
const RELEASE_MODULE = /(?:^|\/)lib\/(?:[^/]+\/)*release\.ex$/;
const SERVICE_NAME = /^[\w.-]+$/;
const POSTGRES_IMAGE = /(?:^|\/)postgres(?:ql)?(?:[:@]|$)/i;
const CADDY_IMAGE = /(?:^|\/)caddy(?:[:@]|$)/i;

const linesOf = (src) => src.split(/\r?\n/);
const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);
const asRecord = (v) => isRecord(v) ? { ...v } : {};
const asList = (v) => Array.isArray(v) ? v : [];
const isMatch = (v, regex) => typeof v === 'string' && regex.test(v);
const sourceAt = (file, line) => ({ file, line });

/** Source line of a simple YAML key, with a containing declaration as the fallback for flow maps. */
function keyLine(lines, name, start = 0, end = lines.length) {
  for (let i = start; i < end; i++) {
    const match = /^ *(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+)) *:(?:\s|$)/.exec(lines[i]);
    if (match && (match[1] || match[2] || match[3]) === name) return i + 1;
  }
  return start || 1;
}

function serviceBlocks(lines, names) {
  const marker = lines.findIndex((line) => /^services *:/.test(line));
  const result = new Map();
  if (marker < 0) return result;
  let indent = null;
  let previous = null;
  for (let i = marker + 1; i < lines.length; i++) {
    const match = /^( *)(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+)) *:(?:\s|$)/.exec(lines[i]);
    if (!match) continue;
    const width = match[1].length;
    if (!width) {
      if (previous) previous.end = i;
      break;
    }
    if (indent === null) indent = width;
    if (width !== indent) continue;
    if (previous) previous.end = i;
    const name = match[2] || match[3] || match[4];
    previous = { line: i + 1, end: lines.length };
    if (names.has(name)) result.set(name, previous);
  }
  return result;
}

function bindSource(mount) {
  if (typeof mount === 'string') {
    const [source, target] = mount.split(':');
    return target && CADDY_FILE.test(path.posix.basename(target)) && source.startsWith('.') ? source : null;
  }
  const { type, source, target } = asRecord(mount);
  return type === 'bind' && typeof source === 'string' && typeof target === 'string'
    && CADDY_FILE.test(path.posix.basename(target)) ? source : null;
}

function localPath(base, file) {
  if (typeof file !== 'string' || !file || path.posix.isAbsolute(file) || /[\0$\\]/.test(file)) return null;
  const candidate = path.posix.normalize(path.posix.join(base, file));
  return candidate === '..' || candidate.startsWith('../') ? null : candidate;
}

function scriptCommand(value) {
  const command = Array.isArray(value) ? value[0] : value;
  return typeof command === 'string'
    ? /^\s*(?:exec\s+)?["']?(?:[\w./-]*\/)?bin\/(server|migrate)(?=$|[\s"'])/.exec(command)?.[1]
    : undefined;
}

function dockerServerLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*FROM\s+/i.test(lines[i])) break;
    const command = /^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/i.exec(lines[i]);
    if (!command) continue;
    let value = command[1].trim();
    if (value.startsWith('[')) {
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (scriptCommand(value) === 'server') return i + 1;
  }
  return 0;
}

function caddyTargets(src) {
  return linesOf(src).flatMap((line, index) => {
    const directive = /^\s*reverse_proxy\s+([^#{]+?)(?:\s*[#{]|$)/.exec(line);
    if (!directive) return [];
    return directive[1].trim().split(/\s+/).flatMap((token) => {
      const target = /^(?:https?:\/\/)?([\w.-]+)(?::\d+)?$/.exec(token.replace(/^"(.*)"$/, '$1'));
      return target ? [{ name: target[1], line: index + 1 }] : [];
    });
  });
}

function phoenixEnvironment(env) {
  const names = Array.isArray(env) ? env.filter((entry) => typeof entry === 'string').map((entry) => entry.split('=', 1)[0]) : Object.keys(asRecord(env));
  return names.some((name) => /^(PHX_HOST|PHX_SERVER|SECRET_KEY_BASE_FILE)$/.test(name));
}

function releaseUses(lines, mode) {
  const expression = mode === 'server'
    ? /(?:^|\s)exec\s+(?:\.\/)?([\w-]+)\s+start(?:\s|$)/
    : /(?:^|\s)exec\s+(?:\.\/)?([\w-]+)\s+eval\s+['"]?([A-Z][\w.]*)\.migrate\b/;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('#')) continue;
    const match = expression.exec(lines[i]);
    if (match) return { line: i + 1, binary: match[1], module: match[2] };
  }
  return null;
}

/**
 * Reads named services in conventional Compose files, service dependencies, local Caddyfile binds,
 * literal Caddy upstreams, and standard Mix release commands and overlays. Each Compose file is a
 * separate declaration. Overlay order, imports, and runtime values are unknown.
 */
export function scanDeployment(files, readSource) {
  const nodes = new Map();
  const edges = new Map();
  const sources = new Map();
  const releaseModules = new Map();
  const addNode = (id, name, kind, file, line) => {
    nodes.set(id, { id, name, kind, evidence: [sourceAt(file, line)] });
    return id;
  };
  const connect = (from, to, kind, file, line) => {
    if (nodes.has(from) && nodes.has(to)) {
      const id = JSON.stringify([from, to, kind, file, line]);
      edges.set(id, { from, to, kind, evidence: sourceAt(file, line) });
    }
  };
  for (const file of files) {
    const p = file.path;
    const base = path.posix.basename(p);
    if (file.tooLarge || ![COMPOSE_FILE, CADDY_FILE, DOCKER_FILE].some((rx) => rx.test(base))
      && !RELEASE_SCRIPT.test(p) && !RELEASE_MODULE.test(p)) continue;
    const src = readSource(p)?.replace(/^\uFEFF/, '');
    if (src) sources.set(p, { src, lines: linesOf(src), repo: file.repo });
  }

  const scripts = new Map();
  const images = new Map();
  for (const [file, { src, lines, repo }] of sources) {
    const base = path.posix.basename(file);
    const mode = RELEASE_SCRIPT.exec(file)?.[1];
    if (CADDY_FILE.test(base)) addNode(file, base, 'caddyfile', file, 1);
    if (mode) {
      const use = releaseUses(lines, mode);
      if (!use) continue;
      scripts.set(file, { ...use, repo });
      addNode(file, mode === 'server' ? 'Phoenix release' : 'Release migrations', mode === 'server' ? 'phoenix-release' : 'migration', file, use.line);
    }
    if (RELEASE_MODULE.test(file)) {
      const declaration = /^\s*defmodule\s+([A-Z][\w.]*)\s+do\b/m.exec(src);
      const line = lines.findIndex((text) => /^\s*Ecto\.Migrator\.run\s*\(/.test(text)) + 1;
      if (!declaration || !line) continue;
      addNode(file, 'Ecto migrations', 'ecto-migrations', file, line);
      const key = JSON.stringify([repo, declaration[1]]);
      const sameName = releaseModules.get(key) || [];
      sameName.push(file);
      releaseModules.set(key, sameName);
    }
    if (DOCKER_FILE.test(base) && lines.some((line) => /^\s*RUN\b.*\bmix\s+release\b/i.test(line))) {
      const commandLine = dockerServerLine(lines);
      if (!commandLine) continue;
      addNode(file, base, 'release-image', file, commandLine);
      images.set(file, commandLine);
    }
  }

  for (const [file, script] of scripts) {
    if (!script.module) continue;
    const server = path.posix.join(path.posix.dirname(file), 'server');
    if (scripts.get(server)?.binary === script.binary) connect(server, file, 'includes_migration', file, script.line);
    const moduleFiles = releaseModules.get(JSON.stringify([script.repo, script.module])) || [];
    if (moduleFiles.length === 1) connect(file, moduleFiles[0], 'invokes', file, script.line);
  }
  for (const [file, line] of images) {
    const server = path.posix.join(path.posix.dirname(file), 'rel/overlays/bin/server');
    connect(file, server, 'starts', file, line);
  }

  for (const [file, { src, lines, repo }] of sources) {
    if (!COMPOSE_FILE.test(path.posix.basename(file))) continue;
    const parsed = asRecord(parseYaml(src));
    const services = new Map(Object.entries(asRecord(parsed.services))
      .filter(([name, value]) => SERVICE_NAME.test(name) && isRecord(value))
      .map(([name, value]) => [name, asRecord(value)]));
    if (!services.size) continue;
    const blocks = serviceBlocks(lines, services);
    const base = path.posix.dirname(file);
    const serviceId = (name) => `${file}#service:${name}`;
    const caddyMounts = new Map();
    for (const [name, service] of services) {
      const mode = scriptCommand(service.command) || scriptCommand(service.entrypoint);
      const mounts = asList(service.volumes).map((mount) => localPath(base, bindSource(mount))).filter((target) =>
        target && CADDY_FILE.test(path.posix.basename(target)) && sources.has(target) && sources.get(target).repo === repo,
      );
      caddyMounts.set(name, mounts);
      let kind = 'service';
      if (isMatch(service.image, POSTGRES_IMAGE)) kind = 'postgres';
      else if (isMatch(service.image, CADDY_IMAGE) || mounts.length) kind = 'caddy';
      else if (mode === 'migrate') kind = 'migration-service';
      else if (mode === 'server' || phoenixEnvironment(service.environment)) kind = 'phoenix-service';
      addNode(serviceId(name), name, kind, file, blocks.get(name)?.line || keyLine(lines, 'services'));
    }
    for (const [name, service] of services) {
      const id = serviceId(name);
      const block = blocks.get(name);
      const fieldLine = (key) => block ? keyLine(lines, key, block.line, block.end) : keyLine(lines, 'services');
      const depends = Array.isArray(service.depends_on) ? service.depends_on : Object.keys(asRecord(service.depends_on));
      for (const dependency of depends) {
        if (services.has(dependency)) connect(id, serviceId(dependency), 'depends_on', file, fieldLine('depends_on'));
      }
      for (const target of caddyMounts.get(name)) {
        connect(id, target, 'mounts', file, fieldLine('volumes'));
        for (const proxy of caddyTargets(sources.get(target).src)) {
          if (services.has(proxy.name)) connect(target, serviceId(proxy.name), 'reverse_proxy', target, proxy.line);
        }
      }
      const build = asRecord(service.build);
      const context = typeof service.build === 'string' ? service.build : build.context || '.';
      const buildDir = localPath(base, context);
      const docker = buildDir && localPath(buildDir, build.dockerfile || 'Dockerfile');
      if (service.build && !build.target && docker && sources.get(docker)?.repo === repo) connect(id, docker, 'builds', file, fieldLine('build'));
      const mode = scriptCommand(service.command) || scriptCommand(service.entrypoint);
      if (mode) {
        const script = path.posix.join(buildDir || base, 'rel/overlays/bin', mode);
        if (scripts.get(script)?.repo === repo) connect(id, script, 'runs', file, fieldLine(scriptCommand(service.command) ? 'command' : 'entrypoint'));
      } else if (!service.build && nodes.get(id).kind === 'phoenix-service' && isMatch(service.image, /^\$\{[\w]*RELEASE_IMAGE[:}]/)) {
        const candidate = path.posix.join(base, 'Dockerfile');
        if (images.has(candidate) && sources.get(candidate)?.repo === repo) connect(id, candidate, 'release_image_candidate', file, fieldLine('image'));
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
