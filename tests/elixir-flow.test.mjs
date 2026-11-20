import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractElixir, elixirModuleResolver } from '../skills/floorplan/scripts/lib/elixir.mjs';
import { extractElixirFlow, linkElixirFlows } from '../skills/floorplan/scripts/lib/elixir-flow.mjs';

const live = [
  'defmodule DemoWeb.WidgetLive do',
  '  use DemoWeb, :live_view',
  '  def handle_event("save", params, socket) do',
  '    Demo.Widgets.widget_changeset(params)',
  '    {:noreply, socket}',
  '  end',
  '',
  '  def handle_info(%{event: "widget_changed"}, socket) do',
  '    Demo.Widgets.get_widget(socket.assigns.widget_id)',
  '    {:noreply, socket}',
  '  end',
  '',
  '  def render(assigns) do',
  '    ~H"""',
  '    <form phx-submit="save">',
  '      <input name="title"/>',
  '    </form>',
  '    <button phx-click="ignored" phx-target={@myself}>Component event</button>',
  '    <!-- <button phx-click="ignored">Comment</button> -->',
  '    <button data-demo=\'phx-click="ignored"\'>Other attribute</button>',
  '    """',
  '  end',
  '',
  '  def handle_event("ignored", _params, socket), do: {:noreply, socket}',
  'end',
].join('\n');

const domain = [
  'defmodule Demo.Widgets do',
  '  use Ash.Domain',
  '  resources do',
  '    resource Demo.Widgets.Widget do',
  '      define :load_widgets,',
  '        action: :list_widgets',
  '    end',
  '  end',
  '  def widget_changeset(params) do',
  '    Ash.Changeset.for_create(Demo.Widgets.Widget, :save_widget, params)',
  '  end',
  '  def get_widget(id), do: load_widgets(%{id: id})',
  'end',
].join('\n');

const resource = [
  'defmodule Demo.Widgets.Widget do',
  '  use Ash.Resource, data_layer: AshPostgres.DataLayer',
  '  actions do',
  '    create :save_widget do',
  '      accept [:title]',
  '    end',
  '    read :list_widgets do',
  '    end',
  '  end',
  '  policies do',
  '    policy action_type(:create) do',
  '      authorize_if Demo.Widgets.Checks.Owner',
  '    end',
  '    policy action(:list_widgets) do',
  '      authorize_if actor_present()',
  '    end',
  '  end',
  '  postgres do',
  '    table "widgets"',
  '  end',
  '  pub_sub do',
  '    name Demo.PubSub',
  '    publish :save_widget, ["widgets"],',
  '      event: "widget_changed"',
  '  end',
  'end',
].join('\n');

const check = 'defmodule Demo.Widgets.Checks.Owner do\n  use Ash.Policy.SimpleCheck\nend\n';
const migration = 'defmodule Demo.Repo.Migrations.Widgets do\n  use Ecto.Migration\n  def change do\n    create table(:widgets) do\n    end\n  end\nend\n';

function file(path, source, repo = '.') {
  const lang = path.endsWith('.heex') ? 'heex' : 'elixir';
  const { elixir } = lang === 'elixir' ? extractElixir(source) : {};
  const result = { path, repo, lang, elixir };
  result.elixirFlow = extractElixirFlow(source, result);
  return result;
}

function relations(files) {
  const resolveModule = elixirModuleResolver(files);
  return linkElixirFlows(files, (from, name) => resolveModule(from, name)?.file.path);
}

test('source evidence follows a LiveView form into Ash, policy, migration and PubSub callback', () => {
  const files = [
    file('lib/demo_web/live/widget_live.ex', live),
    file('lib/demo/widgets.ex', domain),
    file('lib/demo/widgets/widget.ex', resource),
    file('lib/demo/widgets/checks/owner.ex', check),
    file('priv/repo/migrations/001_widgets.exs', migration),
  ];
  const links = relations(files);
  const pairs = (kind) => links.filter((link) => link.kind === kind).map(({ from, to }) => [from.name, to.name]);
  const events = links.filter((link) => link.kind === 'liveview-event');
  assert.deepEqual(events, [{
    kind: 'liveview-event',
    from: { file: files[0].path, line: 15, name: 'save' },
    to: { file: files[0].path, line: 3, name: 'handle_event' },
    binding: 'phx-submit',
  }]);
  assert.deepEqual(pairs('elixir-call'), [['handle_event:save', 'widget_changeset'], ['handle_info', 'get_widget']]);
  assert.deepEqual(pairs('ash-action'), [['widget_changeset', 'save_widget'], ['get_widget', 'list_widgets']]);
  assert.deepEqual(pairs('ash-policy'), [['save_widget', 'action_type(create)'], ['list_widgets', 'action(list_widgets)']]);
  const custom = links.find((link) => link.kind === 'ash-policy-check');
  assert.deepEqual(custom.to, { file: files[3].path, line: 1, name: 'Demo.Widgets.Checks.Owner' });
  assert.equal(custom.checkType, 'authorize_if');
  assert.deepEqual(pairs('ash-publication'), [['save_widget', 'widget_changed']]);
  const pubsub = links.find((link) => link.kind === 'phoenix-pubsub');
  assert.deepEqual(pubsub.to, { file: files[0].path, line: 8, name: 'handle_info' });
  assert.equal(pubsub.match, 'event-name');
  assert.equal(pubsub.bus, 'Demo.PubSub');
  assert.deepEqual(pairs('ecto-migration'), [['widgets', 'widgets']]);
});

test('external LiveView templates only link named events to their matching sibling', () => {
  const owner = file('lib/demo_web/live/widget_live.ex', live);
  const template = file('lib/demo_web/live/widget_live.html.heex', [
    '<%!-- <button phx-click="ignored">Template comment</button> --%>',
    '<button',
    '  phx-click="save"',
    '  title={"dynamic"}',
    '>Save</button>',
    '<button phx-click="missing">Unknown event</button>',
  ].join('\n'));
  const unrelated = file('lib/demo_web/live/unrelated.html.heex', '<button phx-click="save">Other event</button>');
  const links = relations([owner, template, unrelated]).filter(({ kind }) => kind === 'liveview-event');
  assert.deepEqual(links.map(({ from, to }) => [from.file, from.line, to.file]), [
    [owner.path, 15, owner.path],
    [template.path, 3, owner.path],
  ]);
});

test('literal event guards can describe multiple events and a dynamic guard stays unresolved', () => {
  const owner = file('lib/demo_web/live/edit.ex', [
    'defmodule DemoWeb.Edit do',
    '  def handle_event(event, _params, socket) when event in ["start", "stop"] do',
    '    {:noreply, socket}',
    '  end',
    '  def handle_event(event, _params, socket) when event in @extra_events do',
    '    {:noreply, socket}',
    '  end',
    'end',
  ].join('\n'));
  const template = file('lib/demo_web/live/edit.html.heex', [
    'Isn’t that clear?',
    '<button phx-click="start">Start</button>',
    "Don't skip the next action.",
    '<button phx-click="stop">Stop</button>',
    '<button phx-click="some_extra">Extra</button>',
  ].join('\n'));
  assert.deepEqual(relations([owner, template]).map(({ from, to }) => [from.name, to.line]), [['start', 2], ['stop', 2]]);
});

test('unrelated repositories and ambiguous declarations do not get inferred PubSub or migration links', () => {
  const files = [
    file('lib/demo/widgets/widget.ex', resource),
    file('lib/demo/widgets/other_widget.ex', resource.replace('Demo.Widgets.Widget', 'Demo.Widgets.OtherWidget')),
    file('lib/demo_web/live/widget_live.ex', live),
    file('priv/repo/migrations/001_widgets.exs', migration),
    file('priv/repo/migrations/002_widgets.exs', migration),
    file('other/lib/demo_web/live/widget_live.ex', live, 'other'),
  ];
  const links = relations(files);
  assert.equal(links.filter(({ kind }) => ['phoenix-pubsub', 'ecto-migration'].includes(kind)).length, 0);
});
