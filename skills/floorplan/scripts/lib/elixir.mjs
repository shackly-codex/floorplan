// A source-only reader for Elixir declarations and literal Phoenix router macros.
const METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'connect', 'trace']);
const BLOCKS = new Set(['scope', 'pipeline', 'live_session', 'ash_authentication_live_session']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_!?]*/y;
const ALIAS = /^[A-Z][A-Za-z0-9_]*$/;

function literalAt(src, i) {
  const c = src[i];
  const sigil = c === '~' && /[A-Za-z]/.test(src[i + 1] || '') && /["'(/\[<{|]/.test(src[i + 2] || '');
  if (c !== '"' && c !== "'" && !sigil) return null;
  const at = i + (sigil ? 2 : 0);
  const mark = src[at];
  const triple = (mark === '"' || mark === "'") && src.startsWith(mark.repeat(3), at);
  const open = triple ? mark.repeat(3) : mark;
  const close = OPEN[open] || (open === '<' ? '>' : open);
  return { at, open, close, sigil, interpolate: !sigil || /[a-z]/.test(src[i + 1]), type: c === '"' && !triple ? 'string' : 'literal' };
}

function interpolationEnd(src, at, nesting) {
  let depth = 1;
  let i = at;
  while (i < src.length) {
    const c = src[i];
    const literal = literalAt(src, i);
    if (literal) { i = literalEnd(src, literal, nesting + 1); continue; }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '?' && src[i + 1] && !/[\w!?]/.test(src[i - 1] || '')) { i += src[i + 1] === '\\' ? 3 : 2; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

function literalEnd(src, { at, open, close, interpolate }, nesting = 0) {
  if (nesting > 32) return src.length;
  let depth = 1;
  let i = at + open.length;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (interpolate && src.startsWith('#{', i)) { i = interpolationEnd(src, i + 2, nesting); continue; }
    if (src.startsWith(close, i)) {
      i += close.length;
      if (--depth === 0) return i;
      continue;
    }
    if (open !== close && src.startsWith(open, i)) depth++;
    i++;
  }
  return src.length;
}

// Keep string and sigil bodies opaque so examples in documentation and HEEx cannot declare routes.
export function tokenizeElixir(src) {
  const tokens = [];
  let line = 1;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) { if (c === '\n') line++; i++; continue; }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    const start = i;
    let type = 'punctuation';
    const literal = literalAt(src, i);
    if (literal) {
      i = literalEnd(src, literal);
      if (literal.sigil) while (/[A-Za-z]/.test(src[i] || '')) i++;
      type = literal.type;
    } else {
      const atom = c === ':' && src[i - 1] !== ':' && !/[\w?!]/.test(src[i - 1] || '');
      IDENTIFIER.lastIndex = i + (atom ? 1 : 0);
      const ident = IDENTIFIER.exec(src);
      if (atom && src[i + 1] === '*') {
        i += 2;
        type = 'atom';
      } else if (ident) {
        i = IDENTIFIER.lastIndex;
        type = atom ? 'atom' : 'word';
      } else {
        // Elixir character literals can contain quote and comment delimiters.
        i += c === '?' && src[i + 1] ? (src[i + 1] === '\\' ? 3 : 2) : 1;
      }
    }
    const value = src.slice(start, i);
    tokens.push({ type, value, line });
    for (const char of value) if (char === '\n') line++;
  }
  return tokens;
}

export function readArguments(tokens, at) {
  const parenthesized = tokens[at]?.value === '(';
  let i = at + (parenthesized ? 1 : 0);
  let start = i;
  const groups = [];
  const stack = [];
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    const value = token.value;
    if (!stack.length) {
      if (parenthesized && value === ')') break;
      if (!parenthesized && (['do', 'end', ';'].includes(value) ||
          (token.line > tokens[i - 1]?.line && tokens[i - 1]?.value !== ',' && i !== start))) break;
      if (value === ',') { groups.push(tokens.slice(start, i)); start = i + 1; continue; }
    }
    if (Object.hasOwn(OPEN, value)) stack.push(OPEN[value]);
    else if (value === stack.at(-1)) stack.pop();
    else if (!stack.length && [')', ']', '}'].includes(value)) break;
  }
  if (start < i) groups.push(tokens.slice(start, i));
  const after = i + (parenthesized && tokens[i]?.value === ')' ? 1 : 0);
  const doIndex = tokens[after]?.value === 'do' && tokens[after + 1]?.value !== ':' ? after : -1;
  return { groups, doIndex };
}

function moduleAt(tokens, at = 0) {
  const start = at;
  if (!ALIAS.test(tokens[at]?.value || '')) return null;
  while (tokens[at + 1]?.value === '.' && ALIAS.test(tokens[at + 2]?.value || '')) at += 2;
  return { name: tokens.slice(start, at + 1).map((t) => t.value).join(''), end: at + 1 };
}

function moduleIn(tokens) {
  const mod = tokens && moduleAt(tokens);
  return mod && mod.end === tokens.length ? mod.name : null;
}

function expandAlias(name, aliases) {
  if (name.startsWith('Elixir.')) return name.slice(7);
  const head = name.split('.')[0];
  return aliases.has(head) ? aliases.get(head) + name.slice(head.length) : name;
}

function pathIn(tokens) {
  const token = tokens?.[0];
  if (tokens?.length !== 1 || token.type !== 'string' || !/^"\/[^"\\\n]*"$/.test(token.value) || token.value.includes('#{')) return null;
  return token.value.slice(1, -1);
}

const atomIn = (group) => group?.length === 1 && group[0].type === 'atom' ? group[0].value.slice(1) : null;
const keyword = (groups, name) => groups.find((g) => g[0]?.value === name && g[1]?.value === ':')?.slice(2);
const joinPath = (...parts) => '/' + parts.flatMap((p) => p.split('/').filter(Boolean)).join('/');
const keywordGroup = (group) => group?.[0]?.type === 'word' && group[1]?.value === ':';

function literalList(group) {
  if (group?.[0]?.value !== '[' || group.at(-1)?.value !== ']') return null;
  const paren = { value: '(' };
  return readArguments([paren, ...group.slice(1, -1), { value: ')' }], 0).groups;
}

function aliasTargets(groups) {
  const target = groups[0];
  const base = target && moduleAt(target);
  if (!base) return [];
  const as = moduleIn(keyword(groups, 'as'));
  if (base.end === target.length) return [{ name: base.name, as }];
  if (target[base.end]?.value !== '.' || target[base.end + 1]?.value !== '{' || target.at(-1)?.value !== '}') return [];
  const out = [];
  for (let i = base.end + 2; i < target.length - 1;) {
    const tail = moduleAt(target, i);
    if (!tail || ![',', '}'].includes(target[tail.end]?.value)) return [];
    out.push({ name: base.name + '.' + tail.name, as: null });
    i = tail.end + 1;
  }
  return out;
}

const RESOURCE_ACTIONS = [
  ['GET', '', 'index'], ['GET', '/new', 'new'], ['GET', '/:id/edit', 'edit'], ['GET', '/:id', 'show'],
  ['POST', '', 'create'], ['PATCH', '/:id', 'update'], ['PUT', '/:id', 'update'], ['DELETE', '/:id', 'delete'],
];

export function extractElixir(src) {
  const tokens = tokenizeElixir(src);
  const imports = [];
  const symbols = [];
  const routes = [];
  const modules = [];
  const frames = [{ kind: 'file', aliases: new Map(), prefix: '', namespace: '', pipelines: [] }];
  const opening = new Map();
  const addRef = (name, line, names = []) => imports.push({ spec: name, names, line });

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const { value, line } = token;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const frame = frames.at(-1);
    if (token.type !== 'word') continue;

    if (value === 'end' && prev?.value !== '.' && next?.value !== ':') {
      if (frames.length > 1) frames.pop();
      continue;
    }
    if (value === 'fn' || value === 'do') {
      if (prev?.value === '.' || next?.value === ':') continue;
      frames.push({ ...frame, kind: 'block', ...opening.get(i), aliases: new Map(frame.aliases) });
      continue;
    }
    const statement = !prev || prev.line < line || prev.value === ';' || prev.value === 'do';
    if (statement && value === 'defmodule') {
      const { groups, doIndex } = readArguments(tokens, i + 1);
      const declared = moduleIn(groups[0]);
      if (declared && doIndex !== -1) {
        const [head] = declared.split('.');
        const name = frame.module && !declared.startsWith('Elixir.') && !frame.aliases.has(head)
          ? frame.module.name + '.' + declared : expandAlias(declared, frame.aliases);
        const module = { name, line, functions: [] };
        modules.push(module);
        symbols.push({ name, kind: 'module', line });
        opening.set(doIndex, { kind: 'module', module, router: false, prefix: '', namespace: '', pipelines: [], session: undefined, conditional: false });
      }
    } else if (statement && frame.module && ['alias', 'import', 'require', 'use'].includes(value)) {
      const { groups } = readArguments(tokens, i + 1);
      for (const target of aliasTargets(groups)) {
        const name = expandAlias(target.name, frame.aliases);
        addRef(name, line);
        if (value === 'alias' || value === 'require') frame.aliases.set(target.as || name.split('.').at(-1), name);
        if (value === 'use' && frame.kind === 'module' && (name === 'Phoenix.Router' || atomIn(groups[1]) === 'router')) frame.router = true;
      }
    } else if (statement && frame.kind === 'module' && ['def', 'defp', 'defmacro', 'defmacrop', 'defdelegate'].includes(value) && /^[a-z_][\w!?]*$/.test(next?.value || '')) {
      const exported = !['defp', 'defmacrop'].includes(value);
      frame.module.functions.push({ name: next.value, line, exported });
      if (exported) symbols.push({ name: next.value, kind: 'function', line });
    } else if (statement && frame.router && ['module', 'scope', 'session', 'conditional'].includes(frame.kind)) {
      if (BLOCKS.has(value) || ['if', 'unless'].includes(value)) {
        const { groups, doIndex } = readArguments(tokens, i + 1);
        if (doIndex !== -1 && value === 'scope') {
          const options = literalList(groups[0]) || groups;
          const pathOption = keyword(options, 'path');
          const optionsOnly = options.every(keywordGroup);
          const prefix = pathIn(groups[0]) ?? (pathOption ? pathIn(pathOption) : optionsOnly ? '' : null);
          const namespace = keyword(options, 'alias') ?? (!optionsOnly && !keywordGroup(groups[1]) ? groups[1] : null);
          const segment = moduleIn(namespace);
          const resolved = segment && expandAlias(segment, frame.aliases);
          const noAlias = namespace?.length === 1 && namespace[0].value === 'false';
          const scoped = noAlias ? '' : [frame.namespace, resolved].filter(Boolean).join('.');
          // A dynamic prefix cannot produce a reliable route path.
          if (prefix != null && (!namespace || resolved || noAlias)) opening.set(doIndex, { kind: 'scope', prefix: joinPath(frame.prefix, prefix), namespace: scoped });
        } else if (doIndex !== -1 && value !== 'pipeline') {
          const conditional = ['if', 'unless'].includes(value);
          opening.set(doIndex, conditional ? { kind: 'conditional', conditional: true } : { kind: 'session', session: atomIn(groups[0]) });
        }
      } else if (value === 'pipe_through') {
        const { groups } = readArguments(tokens, i + 1);
        for (const group of literalList(groups[0]) || groups) {
          const mod = moduleIn(group);
          const name = mod ? expandAlias(mod, frame.aliases) : atomIn(group);
          if (name) frame.pipelines = [...frame.pipelines, name];
          if (mod) addRef(name, line);
        }
      } else if (value === 'live' || value === 'match' || value === 'resources' || METHODS.has(value)) {
        const { groups, doIndex } = readArguments(tokens, i + 1);
        const offset = value === 'match' ? 1 : 0;
        const path = pathIn(groups[offset]);
        const target = moduleIn(groups[offset + 1]);
        const verb = value === 'match' ? atomIn(groups[0]) : value;
        const action = atomIn(groups[offset + 2]);
        if (path != null && target && verb) {
          const resolved = expandAlias(target, frame.aliases);
          const unscoped = value !== 'live' && value !== 'resources' && keyword(groups, 'alias')?.[0]?.value === 'false';
          const module = [unscoped ? '' : frame.namespace, resolved].filter(Boolean).join('.');
          const addRoute = (method, routePath, routeAction) => routes.push({
            framework: 'phoenix', method, path: joinPath(frame.prefix, routePath), line, module,
            ...(routeAction ? { action: routeAction } : {}),
            ...(value === 'live' ? { live: true, ...(frame.session ? { liveSession: frame.session } : {}) } : {}),
            ...(frame.pipelines.length ? { pipelines: [...new Set(frame.pipelines)] } : {}),
            ...(frame.conditional ? { conditional: true } : {}),
          });
          if (value === 'resources') {
            const only = keyword(groups, 'only');
            const except = keyword(groups, 'except');
            const onlyActions = literalList(only);
            const exceptActions = literalList(except);
            const singleton = keyword(groups, 'singleton');
            if ((only && !onlyActions) || (except && !exceptActions) ||
                (singleton && !['true', 'false'].includes(singleton[0]?.value))) continue;
            const includes = onlyActions && new Set(onlyActions.map(atomIn));
            const excludes = new Set((exceptActions || []).map(atomIn));
            const single = singleton?.[0].value === 'true';
            const param = keyword(groups, 'param')?.[0]?.value?.match(/^"([a-zA-Z_][\w]*)"$/)?.[1] || 'id';
            for (const [method, suffix, name] of RESOURCE_ACTIONS) {
              if ((single && name === 'index') || (includes && !includes.has(name)) || excludes.has(name)) continue;
              addRoute(method, path + suffix.replace('/:id', single ? '' : '/:' + param), name);
            }
            // Nested resources implicitly generate a dynamic parent parameter. Read the outer resource only.
            if (doIndex !== -1) opening.set(doIndex, { kind: 'block' });
          } else {
            addRoute(value === 'live' ? 'GET' : verb === '*' ? 'ANY' : verb.toUpperCase(), path, action);
          }
          addRef(module, line, action ? [action] : []);
        }
      }
    }

    if (frame.module && ALIAS.test(value) && prev?.value !== '.') {
      const target = moduleAt(tokens, i);
      const member = tokens[target.end + 1]?.value;
      if (tokens[target.end]?.value === '.' && /^[a-z_][\w!?]*$/.test(member || '')) {
        addRef(expandAlias(target.name, frame.aliases), line, [member]);
      }
    }
  }
  return { imports, symbols, routes, mounts: [], calls: [], hosts: [], elixir: { modules } };
}

export function elixirModuleResolver(files) {
  const modules = new Map();
  for (const file of files) for (const module of file.elixir?.modules || []) {
    const entries = modules.get(module.name) || [];
    entries.push({ file, module });
    modules.set(module.name, entries);
  }
  return (file, name) => {
    const all = modules.get(name) || [];
    const local = all.filter((entry) => entry.file.repo === file.repo);
    const candidates = local.length ? local : all;
    return candidates.length === 1 ? candidates[0] : null;
  };
}
