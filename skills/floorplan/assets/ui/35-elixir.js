/* Phoenix route declarations and source-linked Elixir relationships. */
(() => {
  const SC = window.Floorplan;
  const { h, hk } = SC;
  const related = new Map();
  for (const rel of SC.graph.elixirFlows || []) {
    for (const file of new Set([rel.from.file, rel.to.file])) {
      if (!related.has(file)) related.set(file, []);
      related.get(file).push(rel);
    }
  }
  const labels = {
    'liveview-event': 'LiveView event',
    'elixir-call': 'Elixir call',
    'ash-action': 'Ash action',
    'ash-policy': 'Ash policy',
    'ash-policy-check': 'Ash policy check',
    'ash-publication': 'Ash publication',
    'phoenix-pubsub': 'PubSub event-name match',
    'ecto-migration': 'Ecto table-name match',
  };
  function location(file, line) {
    const url = SC.editorUrl(file, line);
    const label = h(file + ':' + line);
    return url ? `<a href="${hk(url)}">${label}</a>` : label;
  }
  function routeDetails(route) {
    const r = route?.phoenix;
    if (!r) return null;
    const fields = [r.module, r.action ? `Action ${r.action}` : '', r.session ? `LiveView session ${r.session}` : '',
      r.pipelines?.length ? `Pipelines ${r.pipelines.join(', ')}` : '', r.conditional ? 'Declared inside a conditional block' : '',
      !r.resolved ? 'Handler module could not be resolved' : ''].filter(Boolean);
    return {
      top: true,
      html: `<div class="sec"><h3>Phoenix declaration</h3><div class="rp">${location(r.file, r.line)}</div>
        <ul>${fields.map((field) => `<li>${h(field)}</li>`).join('')}</ul></div>`,
    };
  }
  SC.addPanelSection('item', (id) => {
    if (typeof id !== 'string') return null;
    if (id.startsWith('r:')) return routeDetails(SC.routes[Number(id.slice(2))]);
    const links = id.startsWith('f:') ? related.get(id.slice(2)) : null;
    if (!links?.length) return null;
    return {
      html: `<div class="sec"><h3>Elixir relationships <span class="c">${links.length}</span></h3><div class="list">
        ${links.map(({ kind, from, to }) => `<div class="row"><span class="rt">
          <div class="rn">${h(labels[kind] || kind)}</div>
          <div class="rd">${h(from.name)} → ${h(to.name)}</div>
          <div class="rp">${location(from.file, from.line)}</div>
          <div class="rp">${location(to.file, to.line)}</div>
        </span></div>`).join('')}
      </div></div>`,
    };
  });
})();
