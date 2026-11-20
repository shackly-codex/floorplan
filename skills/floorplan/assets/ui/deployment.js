// Deployment declarations and links from the source scanner. Uses the existing viewer extension API.
(() => {
  const SC = window.Floorplan;
  const deployment = SC?.graph.deployment;
  if (!deployment?.nodes?.length) return;
  const { h, hk } = SC;
  const nodes = new Map(deployment.nodes.map((node) => [node.id, node]));
  const edges = deployment.edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  const names = new Map();
  for (const node of nodes.values()) names.set(node.name, (names.get(node.name) || 0) + 1);
  const kinds = new Map([
    ['service', 'Compose service'], ['phoenix-service', 'Phoenix service'], ['postgres', 'PostgreSQL'],
    ['caddy', 'Caddy service'], ['caddyfile', 'Caddyfile'], ['release-image', 'Release image'],
    ['phoenix-release', 'Phoenix release'], ['migration-service', 'Migration service'],
    ['migration', 'Migration command'], ['ecto-migrations', 'Ecto migrations'],
  ]);
  const relationships = new Map([
    ['depends_on', 'depends on'], ['mounts', 'mounts'], ['reverse_proxy', 'proxies to'],
    ['builds', 'builds'], ['starts', 'starts'], ['runs', 'runs'], ['includes_migration', 'includes'],
    ['invokes', 'invokes'], ['release_image_candidate', 'may use'],
  ]);

  const style = document.createElement('style');
  style.textContent = `
    .deployment-filter { display: grid; gap: 5px; font-size: 12.5px; color: var(--text-3); }
    .deployment-filter input { width: 100%; border: 1px solid rgba(var(--ink), .12); border-radius: var(--r-ctl); padding: 8px 10px; font: inherit; color: var(--text); background: rgba(var(--ink), .05); }
    .deployment-filter input:focus-visible, .deployment-source a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .deployment-results h3 { font-size: 13px; font-weight: 600; margin: 16px 0 4px; }
    .deployment-results ul { list-style: none; padding: 0; margin: 0; }
    .deployment-results li { padding: 8px 2px; border-bottom: 1px solid rgba(var(--ink), .08); overflow-wrap: anywhere; }
    .deployment-results li:last-child { border-bottom: 0; }
    .deployment-source, .deployment-caption { display: block; font-size: 11.5px; color: var(--text-3); }
    .deployment-source { margin-top: 3px; font-family: var(--mono); }
    .deployment-source a { color: inherit; }
    .deployment-label { font-weight: 550; color: var(--text); }
    .deployment-context { font-size: 11.5px; color: var(--text-3); }
  `;
  document.head.appendChild(style);

  function label(node) {
    const context = names.get(node.name) > 1 ? node.evidence?.[0]?.file : '';
    return `<span class="deployment-label">${h(node.name)}</span>${context ? ` <span class="deployment-context">(${h(context)})</span>` : ''}`;
  }

  function source(evidence) {
    if (!evidence?.file) return '';
    const { file, line } = evidence;
    const text = `${file}:${line}`;
    const url = SC.exported ? null : SC.editorUrl?.(file, line);
    return `<span class="deployment-source">${url ? `<a href="${hk(url)}" title="Open in editor">${h(text)}</a>` : h(text)}</span>`;
  }

  const nodeText = (node) => [node.name, kinds.get(node.kind) || node.kind, ...(node.evidence || []).map((item) => item.file)].join(' ');
  const section = (title, rows) => rows.length ? `<h3>${title}</h3><ul>${rows.join('')}</ul>` : '';

  function showDeployment() {
    const modal = SC.modal({
      title: 'Deployment',
      html: `<label class="deployment-filter">Filter by component or source file<input type="search" data-deployment-filter autocomplete="off" spellcheck="false"></label>
        <div class="deployment-results" data-deployment-results></div>`,
    });
    const filter = modal.el.querySelector('[data-deployment-filter]');
    const results = modal.el.querySelector('[data-deployment-results]');
    const render = () => {
      const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = (value) => terms.every((term) => value.toLowerCase().includes(term));
      const foundEdges = edges.flatMap((edge) => {
        const from = nodes.get(edge.from), to = nodes.get(edge.to);
        const relation = relationships.get(edge.kind) || edge.kind;
        if (!matches([nodeText(from), relation, nodeText(to), edge.evidence?.file].join(' '))) return [];
        return [`<li>${label(from)} ${h(relation)} ${label(to)}${source(edge.evidence)}</li>`];
      });
      const foundNodes = [...nodes.values()].filter((node) => matches(nodeText(node))).map((node) =>
        `<li>${label(node)}<span class="deployment-caption">${h(kinds.get(node.kind) || node.kind)}</span>${(node.evidence || []).map(source).join('')}</li>`,
      );
      results.innerHTML = section('Relationships', foundEdges) + section('Components', foundNodes)
        || '<p>No deployment components or relationships match.</p>';
    };
    filter.addEventListener('input', render);
    modal.el.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); modal.close(); button.focus(); }
    });
    render();
    filter.focus();
  }

  const button = SC.addHeaderButton({ id: 'btn-deployment', label: 'Deployment', icon: 'infra', title: 'Explore deployment components and source', onClick: showDeployment });
})();
