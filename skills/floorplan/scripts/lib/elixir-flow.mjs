// Static, source-linked facts for Phoenix LiveView and Ash. Runtime choices and
// message delivery cannot be established by matching these declarations.

import { tokenizeElixir } from './elixir.mjs';

const MODULE = /^(?:Elixir\.)?[A-Z]\w*(?:\.[A-Z]\w*)*$/;
const NAME = /^[\w.:-]+$/;
const ACTION_TYPES = new Set(['action', 'create', 'read', 'update', 'destroy']);
const POLICY_CHECKS = new Set(['authorize_if', 'authorize_unless', 'forbid_if', 'forbid_unless']);
const ASH_CALL = /^Ash\.(?:Changeset|Query)\.for_(create|read|update|destroy|action)$|^AshPhoenix\.Form\.for_(create|read|update|destroy|action)$/;
const EVENTS = /^phx-(?:click|change|submit|keydown|keyup|focus|blur|window-(?:keydown|keyup|focus|blur)|capture-click|click-away)$/;
const PHOENIX_CALLBACKS = new Set(['handle_event', 'handle_info', 'mount']);
// Group qualified names for the DSL recognizers.
function flowTokens(src) {
  const original = tokenizeElixir(src);
  const tokens = [];
  for (let i = 0; i < original.length; i++) {
    const { type, value, line } = original[i];
    let text = value;
    if (type === 'word') {
      while (original[i + 1]?.value === '.' && original[i + 2]?.type === 'word') {
        text += '.' + original[i + 2].value;
        i += 2;
      }
    }
    tokens.push({
      text, line, first: tokens.at(-1)?.line !== line,
      value: type === 'string' && NAME.test(text.slice(1, -1)) ? text.slice(1, -1) : null,
      atom: type === 'atom' ? text.slice(1) : undefined,
      template: type === 'literal' && text.startsWith('~H"""') && text.endsWith('"""'),
    });
  }
  return tokens;
}

function isDo(tokens, i) {
  return tokens[i]?.text === 'do' && tokens[i + 1]?.text !== ':';
}

function endOfBlock(tokens, start) {
  let depth = 1;
  for (let i = start + 1; i < tokens.length; i++) {
    if (isDo(tokens, i) || tokens[i].text === 'fn') depth++;
    if (tokens[i].text === 'end' && tokens[i + 1]?.text !== ':' && --depth === 0) return i;
  }
  return tokens.length;
}

// A clause head ends at its top-level do or do:, after parameters and guards.
function clauseBody(tokens, start) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.first && ['def', 'defp', 'defmodule', 'end'].includes(token.text)) return [start, start];
    if ('([{'.includes(token.text)) depth++;
    if (')]}'.includes(token.text)) depth--;
    if (depth !== 0 || token.text !== 'do') continue;
    if (isDo(tokens, i)) return [i + 1, endOfBlock(tokens, i)];
    return [i + 2, declarationEnd(tokens, i + 2)];
  }
  return [start, start];
}

function sections(tokens, name) {
  return tokens.flatMap((t, i) => t.first && t.text === name && isDo(tokens, i + 1)
    ? [tokens.slice(i + 2, endOfBlock(tokens, i + 1))] : []);
}

function argumentsAt(tokens, i) {
  return tokens[i]?.text === '(' ? i + 1 : i;
}

function option(tokens, key) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const { text } = tokens[i];
    if (depth === 0 && text === key && tokens[i + 1]?.text === ':') return tokens[i + 2];
    if ('([{'.includes(text)) depth++;
    if (')]}'.includes(text) && --depth < 0) break;
  }
}

function declarationEnd(tokens, start) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (depth === 0 && (token.text === ';' || (i > start && token.first && tokens[i - 1].text !== ','))) return i;
    if ('([{'.includes(token.text)) depth++;
    if (')]}'.includes(token.text) && --depth < 0) return i;
  }
  return tokens.length;
}

function usesModule(tokens, module) {
  return tokens.some((t, i) => t.first && t.text === 'use' && tokens[argumentsAt(tokens, i + 1)]?.text === module);
}

// Skip template comments, and consume complete attribute values before looking
// for another attribute. Explicit targets may be component events.
function templateEvents(src, startLine) {
  const events = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const source = src.replace(/<!--[\s\S]*?-->|<%!--[\s\S]*?--%>|<%[\s\S]*?%>/g, blank);
  const tags = /<(?:[A-Za-z][\w.:-]*|\.[a-zA-Z][\w.-]*|:[a-zA-Z][\w.-]*)\b/g;
  const markup = /\s+|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\w:-]+|[^\s]/y;
  let previous = 0;
  let line = startLine;
  for (let match; (match = tags.exec(source));) {
    let depth = 0, value = false, attribute, target = false;
    const tagEvents = [];
    line += source.slice(previous, tags.lastIndex).split('\n').length - 1;
    markup.lastIndex = tags.lastIndex;
    for (let attr; (attr = markup.exec(source));) {
      const token = attr[0];
      if (token === '{') depth++;
      if (token === '}' && depth > 0) depth--;
      if (depth > 0 || token === '}') value = false;
      else if (token === '>') {
        if (!target) events.push(...tagEvents);
        previous = tags.lastIndex = markup.lastIndex;
        break;
      } else if (!/^\s/.test(token)) {
        if (value) {
          const name = token.slice(1, -1);
          if (attribute && EVENTS.test(attribute.name) && ['"', "'"].includes(token[0]) && NAME.test(name)) {
            tagEvents.push({ name, line: attribute.line, binding: attribute.name });
          }
          value = false;
        } else if (token === '=') value = true;
        else {
          attribute = { name: token, line };
          if (token === 'phx-target') target = true;
        }
      }
      line += token.split('\n').length - 1;
    }
    if (previous !== tags.lastIndex) break;
  }
  return events;
}

function parseResource(tokens) {
  if (!usesModule(tokens, 'Ash.Resource')) return null;
  const actions = sections(tokens, 'actions').flatMap((block) => block.flatMap((t, i) => {
    const name = block[argumentsAt(block, i + 1)]?.atom;
    return t.first && ACTION_TYPES.has(t.text) && name ? [{ name, line: t.line, type: t.text }] : [];
  }));
  const policies = sections(tokens, 'policies').flatMap((block) => block.flatMap((t, i) => {
    if (!t.first || t.text !== 'policy') return [];
    const at = argumentsAt(block, i + 1);
    const condition = block[at]?.text;
    const argument = block[argumentsAt(block, at + 1)]?.atom;
    if (!(condition === 'always' || (['action_type', 'action'].includes(condition) && argument))) return [];
    let open = at + 1;
    while (block[open]?.line === t.line && !isDo(block, open)) open++;
    if (!isDo(block, open) || block[open].line !== t.line) return [];
    const checks = block.slice(open + 1, endOfBlock(block, open)).flatMap((check, j, scope) => {
      const module = scope[argumentsAt(scope, j + 1)]?.text;
      return check.first && POLICY_CHECKS.has(check.text) && MODULE.test(module)
        ? [{ name: module, line: check.line, type: check.text }] : [];
    });
    return [{ name: condition + (argument ? '(' + argument + ')' : '()'), line: t.line, condition, argument, checks }];
  }));
  const publications = sections(tokens, 'pub_sub').flatMap((block) => {
    const bus = block.find((t, i) => t.first && t.text === 'name' && MODULE.test(block[i + 1]?.text));
    const busName = bus ? block[block.indexOf(bus) + 1]?.text : undefined;
    return block.flatMap((t, i) => {
      const at = argumentsAt(block, i + 1);
      const action = block[at]?.atom;
      if (!t.first || t.text !== 'publish' || !action) return [];
      // Continuation options stay with this declaration, never with a following publish.
      const explicit = option(block.slice(at, declarationEnd(block, i + 1)), 'event');
      const event = explicit ? explicit.value : action;
      if (!event) return [];
      return [{ name: event, line: t.line, action, bus: busName }];
    });
  });
  const tables = sections(tokens, 'postgres').flatMap((block) => block.flatMap((t, i) => {
    const name = block[argumentsAt(block, i + 1)]?.value;
    return t.first && t.text === 'table' && name ? [{ name, line: t.line }] : [];
  }));
  return { actions, policies, publications, tables };
}

function domainInterfaces(tokens) {
  const declarations = new Map();
  if (!usesModule(tokens, 'Ash.Domain')) return declarations;
  for (const block of sections(tokens, 'resources')) for (let i = 0; i < block.length; i++) {
    const token = block[i];
    if (!token.first || token.text !== 'resource') continue;
    const at = argumentsAt(block, i + 1);
    const module = block[at]?.text;
    const start = at + (block[at + 1]?.text === ')' ? 2 : 1);
    if (!MODULE.test(module) || !isDo(block, start)) continue;
    const body = block.slice(start + 1, endOfBlock(block, start));
    for (let j = 0; j < body.length; j++) {
      if (!body[j].first || body[j].text !== 'define') continue;
      const args = argumentsAt(body, j + 1);
      const name = body[args]?.atom;
      const action = option(body.slice(args, declarationEnd(body, j + 1)), 'action')?.atom;
      if (name && action) declarations.set(name, declarations.has(name) ? null : { module, name: action });
    }
  }
  return declarations;
}

function handlerEvents(head) {
  const literal = head[0]?.value;
  if (literal) return [literal];
  const arg = head[0]?.text;
  if (!/^[a-z_]\w*$/.test(arg || '')) return [];
  const guardAt = head.findIndex((token) => token.text === 'when');
  if (guardAt === -1) return [];
  const guard = head.slice(guardAt + 1, -1);
  if (guard[0]?.text !== arg || guard[1]?.text !== 'in' || guard[2]?.text !== '[' || guard.at(-1)?.text !== ']') return [];
  const names = [];
  for (let i = 3; i < guard.length - 1; i += 2) {
    if (!guard[i].value || ![',', ']'].includes(guard[i + 1]?.text)) return [];
    names.push(guard[i].value);
  }
  return names;
}

function parseFunctions(tokens, interfaces) {
  return tokens.flatMap((t, i) => {
    const name = tokens[i + 1]?.text;
    if (!t.first || !['def', 'defp'].includes(t.text) || !NAME.test(name)) return [];
    const arg = argumentsAt(tokens, i + 2);
    const [start, end] = clauseBody(tokens, i + 2);
    const head = tokens.slice(arg, start);
    const events = name === 'handle_event' ? handlerEvents(head) : [];
    const message = name === 'handle_info' && head[0]?.text === '%' && head[1]?.text === '{' ? option(head.slice(2), 'event')?.value : undefined;
    const actions = [];
    const calls = [];
    for (let j = start; j < end; j++) {
      const { text, line } = tokens[j];
      const first = argumentsAt(tokens, j + 1);
      const module = tokens[first]?.text;
      const action = tokens[first + 2]?.atom;
      const domainAction = tokens[j + 1]?.text === '(' ? interfaces.get(text) : null;
      if (ASH_CALL.test(text) && MODULE.test(module) && tokens[first + 1]?.text === ',' && action) {
        actions.push({ module, name: action, line });
      } else if (domainAction) {
        actions.push({ ...domainAction, line });
      } else if (PHOENIX_CALLBACKS.has(name) && tokens[j + 1]?.text === '(') {
        const dot = text.lastIndexOf('.');
        const targetModule = text.slice(0, dot);
        if (dot > 0 && MODULE.test(targetModule)) calls.push({ module: targetModule, name: text.slice(dot + 1), line });
      }
    }
    return [{ line: t.line, name, events, message, actions, calls }];
  });
}

export function extractElixirFlow(src, file) {
  if (file.lang === 'heex' || file.path.endsWith('.heex')) {
    const events = templateEvents(src, 1);
    return events.length ? { events } : null;
  }
  if (file.lang !== 'elixir') return null;
  const tokens = flowTokens(src);
  const events = tokens.flatMap((t) => t.template ? templateEvents(t.text.slice(5, -3), t.line) : []);
  const functions = parseFunctions(tokens, domainInterfaces(tokens));
  const resource = parseResource(tokens);
  const migrations = usesModule(tokens, 'Ecto.Migration')
    ? tokens.flatMap((t, i) => {
      const table = argumentsAt(tokens, i + 1);
      const definition = tokens[argumentsAt(tokens, table + 1)];
      const name = definition?.atom || definition?.value;
      return t.first && t.text === 'create' && tokens[table]?.text === 'table' && name ? [{ name, line: t.line }] : [];
    }) : [];
  return events.length || functions.length || resource || migrations.length ? { events, functions, resource, migrations } : null;
}

export function linkElixirFlows(files, resolveModule) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const withFlow = files.filter((f) => f.elixirFlow);
  const byModule = (file, module) => byPath.get(resolveModule(file, module.replace(/^Elixir\./, '')));
  const result = [];
  const point = (file, fact) => ({ file: file.path, line: fact.line, name: fact.name });
  const add = (kind, fromFile, from, toFile, to, metadata) => result.push({
    kind, from: point(fromFile, from), to: point(toFile, to), ...metadata,
  });
  const indexFact = (index, file, fact, key = 'name') => {
    const byName = index.get(file.repo) || new Map();
    index.set(file.repo, byName);
    const existing = byName.get(fact[key]) || [];
    existing.push({ file, fact });
    byName.set(fact[key], existing);
  };
  const messages = new Map();
  const migrations = new Map();
  const publicationNames = new Map();
  for (const file of withFlow) {
    for (const fn of file.elixirFlow.functions || []) if (fn.message) indexFact(messages, file, fn, 'message');
    for (const mig of file.elixirFlow.migrations || []) indexFact(migrations, file, mig);
    for (const pub of file.elixirFlow.resource?.publications || []) indexFact(publicationNames, file, pub);
  }
  for (const file of withFlow) {
    const { events, functions, resource } = file.elixirFlow;
    const owner = file.path.endsWith('.html.heex') ? byPath.get(file.path.replace(/\.html\.heex$/, '.ex')) : file;
    for (const event of events || []) for (const fn of owner?.elixirFlow?.functions || []) {
      if (fn.events.includes(event.name)) add('liveview-event', file, event, owner, fn, { binding: event.binding });
    }
    for (const fn of functions || []) {
      const source = { ...fn, name: fn.events.length === 1 ? fn.name + ':' + fn.events[0] : fn.name };
      for (const call of fn.actions) {
        const target = byModule(file, call.module);
        const action = target?.elixirFlow?.resource?.actions.find((a) => a.name === call.name);
        if (action) add('ash-action', file, { ...source, line: call.line }, target, action, { actionType: action.type });
      }
      for (const call of fn.calls) {
        const target = byModule(file, call.module);
        const destination = target?.elixirFlow?.functions?.find((candidate) => candidate.name === call.name);
        if (destination) add('elixir-call', file, { ...source, line: call.line }, target, destination);
      }
    }
    if (!resource) continue;
    for (const action of resource.actions) for (const policy of resource.policies) {
      if (policy.condition === 'always' || (policy.condition === 'action_type' && policy.argument === action.type)
        || (policy.condition === 'action' && policy.argument === action.name)) add('ash-policy', file, action, file, policy);
    }
    for (const policy of resource.policies) for (const check of policy.checks) {
      const target = byModule(file, check.name);
      const mod = target?.elixir?.modules?.find((candidate) => candidate.name === check.name);
      if (mod) add('ash-policy-check', file, { ...policy, line: check.line }, target, mod, { checkType: check.type });
    }
    for (const pub of resource.publications) {
      const action = resource.actions.find((a) => a.name === pub.action);
      if (action) add('ash-publication', file, action, file, pub, { ...(pub.bus ? { bus: pub.bus } : {}) });
      if (publicationNames.get(file.repo)?.get(pub.name)?.length !== 1) continue;
      for (const handler of messages.get(file.repo)?.get(pub.name) || []) {
        add('phoenix-pubsub', file, pub, handler.file, handler.fact, { match: 'event-name', ...(pub.bus ? { bus: pub.bus } : {}) });
      }
    }
    for (const table of resource.tables) {
      const candidates = migrations.get(file.repo)?.get(table.name);
      if (candidates?.length === 1) add('ecto-migration', file, table, candidates[0].file, candidates[0].fact, { match: 'table-name' });
    }
  }
  return result;
}
