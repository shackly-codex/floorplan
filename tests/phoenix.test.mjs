// Phoenix routes and Elixir module dependencies, using source only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanup, lib, makeProject, readGraph, readJson, run } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const sourceLine = (source, text) => source.split('\n').findIndex((line) => line.trim() === text) + 1;

const router = `defmodule ExampleWeb.Router do
  use(
    Phoenix.Router
  )

  @moduledoc """
  get "/fake-doc", ExampleWeb.GhostController, :show
  """

  # live "/fake-comment", ExampleWeb.GhostLive, :show
  alias ExampleWeb.HealthController, as: Health

  scope "/app", ExampleWeb do
    pipe_through [:browser, :member]
    get "/before", PageController, :show

    scope(
      "/staff",
      Staff
    ) do
      pipe_through :staff
      live_session :workspace do
        live(
          "/projects/:id",
          ProjectLive,
          :show
        )
      end

      ash_authentication_live_session :account do
        live "/account", AccountLive, :edit
      end
    end

    get "/health", Health, :status, alias: false
  end

  scope "/plain", alias: false do
    get "/status", ExampleWeb.HealthController, :status
  end

  defp helper do
    get "/fake-function", ExampleWeb.GhostController, :show
  end
end

defmodule ExampleWeb.Utility do
  get "/fake-utility", ExampleWeb.GhostController, :show
end
`;

test('Phoenix extracts source lines, nested scope paths, ordered pipelines and LiveView sessions', () => {
  const parsed = extract(router, 'elixir', 'lib/example_web/router.ex');
  assert.deepEqual(parsed.routes.map((r) => [
    r.method, r.path, r.module, r.action, r.pipelines ?? [], r.liveSession ?? null,
  ]), [
    ['GET', '/app/before', 'ExampleWeb.PageController', 'show', ['browser', 'member'], null],
    ['GET', '/app/staff/projects/:id', 'ExampleWeb.Staff.ProjectLive', 'show', ['browser', 'member', 'staff'], 'workspace'],
    ['GET', '/app/staff/account', 'ExampleWeb.Staff.AccountLive', 'edit', ['browser', 'member', 'staff'], 'account'],
    ['GET', '/app/health', 'ExampleWeb.HealthController', 'status', ['browser', 'member'], null],
    ['GET', '/plain/status', 'ExampleWeb.HealthController', 'status', [], null],
  ]);
  const live = parsed.routes.find((r) => r.liveSession === 'workspace');
  assert.equal(live.line, sourceLine(router, 'live('));
  assert.equal(live.live, true);
  assert.deepEqual(parsed.elixir.modules.map((m) => m.name), ['ExampleWeb.Router', 'ExampleWeb.Utility']);
});

test('Phoenix keeps inherited paths and handles scoped aliases, custom verbs, and singleton routes', () => {
  const source = `defmodule ExampleWeb.Router do
  use Phoenix.Router

  @moduledoc """
  #{"""
  get "/fake-in-string", ExampleWeb.GhostController, :show
  """}
  """

  alias Plugins.EventsController, as: Events
  alias Example.Plugs.Headers, as: HeaderPlug

  scope "/api", ExampleWeb do
    scope host: "api.example" do
      pipe_through [:browser, HeaderPlug]
      match(:move, "/events/:id", Events, :move)
      match :*, "/all", Events, :catch_all, alias: false
      resources "/account", AccountController, singleton: true
    end
  end
end
`;
  const { routes } = extract(source, 'elixir', 'lib/example_web/router.ex');
  const routeKeys = routes.map((r) => [r.method, r.path, r.action].join(' ')).sort();
  assert.deepEqual(routeKeys, [
    'MOVE /api/events/:id move',
    'ANY /api/all catch_all',
    'GET /api/account show',
    'GET /api/account/new new',
    'GET /api/account/edit edit',
    'POST /api/account create',
    'PATCH /api/account update',
    'PUT /api/account update',
    'DELETE /api/account delete',
  ].sort());

  const move = routes.find((r) => r.method === 'MOVE');
  assert.equal(move.module, 'ExampleWeb.Plugins.EventsController');
  assert.equal(move.line, sourceLine(source, 'match(:move, "/events/:id", Events, :move)'));
  assert.equal(routes.find((r) => r.method === 'ANY').module, 'Plugins.EventsController');
  for (const route of routes) assert.deepEqual(route.pipelines, ['browser', 'Example.Plugs.Headers']);
});

test('Elixir extracts grouped and renamed aliases, dependency declarations and qualified calls', () => {
  const source = `defmodule Example.Checkout do
  alias Example.{Orders, Email}
  alias Example.Ledger, as: Billing
  require Example.Format
  import Example.Rules, only: [validate: 1]
  use Example.Schema

  def pay(id) do
    Orders.load(id)
    Billing.charge(id)
    Email.confirm(id)
  end
end
`;
  const parsed = extract(source, 'elixir', 'lib/example/checkout.ex');
  assert.deepEqual(parsed.imports.map(({ spec, names }) => [spec, names]), [
    ['Example.Orders', []],
    ['Example.Email', []],
    ['Example.Ledger', []],
    ['Example.Format', []],
    ['Example.Rules', []],
    ['Example.Schema', []],
    ['Example.Orders', ['load']],
    ['Example.Ledger', ['charge']],
    ['Example.Email', ['confirm']],
  ]);
  assert.deepEqual(parsed.symbols, [
    { name: 'Example.Checkout', kind: 'module', line: 1 },
    { name: 'pay', kind: 'function', line: sourceLine(source, 'def pay(id) do') },
  ]);
});

test('scan and build preserve Phoenix handler evidence, resolve modules within their repo, and map HEEx', (t) => {
  const pageSource = `defmodule SharedWeb.PageController do
  def show(conn, _params), do: conn
end
`;
  const liveSource = `defmodule FirstWeb.AccountLive do
  use Phoenix.LiveView

  def mount(_params, _session, socket), do: {:ok, socket}
end
`;
  const firstRouter = `defmodule FirstWeb.Router do
  use FirstWeb,
    :router
  alias SharedWeb.PageController

  get "/page", PageController, :show

  scope "/" do
    pipe_through [:browser, :authenticated]
    live_session :account do
      live "/account", FirstWeb.AccountLive, :edit
    end
  end
end
`;
  const secondRouter = `defmodule SecondWeb.Router do
  use Phoenix.Router
  get "/page", SharedWeb.PageController, :show
end
`;
  const thirdRouter = `defmodule ThirdWeb.Router do
  use Phoenix.Router
  get "/ambiguous", SharedWeb.PageController, :show
end
`;
  const first = {
    router: 'first/lib/first_web/router.ex',
    controller: 'first/lib/shared_web/page_controller.ex',
    live: 'first/lib/first_web/account_live.ex',
    template: 'first/lib/first_web/account_live.html.heex',
  };
  const second = {
    router: 'second/lib/second_web/router.ex',
    controller: 'second/lib/shared_web/page_controller.ex',
  };
  const third = { router: 'third/lib/third_web/router.ex' };
  const repos = ['first', 'second', 'third'];
  const root = makeProject({
    [first.router]: firstRouter,
    [first.controller]: pageSource,
    [first.live]: liveSource,
    [first.template]: '<p>Account</p>\n',
    [second.router]: secondRouter,
    [second.controller]: pageSource,
    [third.router]: thirdRouter,
  }, {
    repos,
    arch: {
      project: { name: 'Phoenix Workspace', summary: 'Synthetic applications.' },
      nodes: repos.map((id) => ({
        id,
        label: id,
        kind: 'service',
        summary: 'A Phoenix app.',
        paths: [id + '/**'],
      })),
    },
  });
  t.after(() => cleanup(root));

  run('scan.mjs', root, '--unattended');
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  const routes = scan.routes.filter((r) => r.framework === 'phoenix');
  const routeAt = (file, url) => routes.find((r) => r.defFile === file && r.path === url);
  const firstPage = routeAt(first.router, '/page');
  assert.deepEqual([
    firstPage.file, firstPage.line, firstPage.handler, firstPage.defLine,
  ], [
    first.controller, sourceLine(pageSource, 'def show(conn, _params), do: conn'),
    'show', sourceLine(firstRouter, 'get "/page", PageController, :show'),
  ]);
  assert.equal(routeAt(second.router, '/page').file, second.controller);
  const ambiguousPage = routeAt(third.router, '/ambiguous');
  assert.equal(ambiguousPage.file, third.router);
  assert.equal(ambiguousPage.handlerResolved, undefined);
  assert.equal(routes.length, 4);

  const live = routeAt(first.router, '/account');
  assert.deepEqual([live.file, live.handler, live.line, live.defLine], [
    first.live, 'mount', sourceLine(liveSource, 'def mount(_params, _session, socket), do: {:ok, socket}'),
    sourceLine(firstRouter, 'live "/account", FirstWeb.AccountLive, :edit'),
  ]);
  const edges = new Set(scan.edges.map((e) => [e.from, e.to]));
  assert.deepEqual(edges, new Set([
    [first.router, first.controller],
    [first.router, first.live],
    [second.router, second.controller],
  ]));
  const template = scan.files.find((file) => file.path === first.template);
  assert.deepEqual([template.category, template.lang], ['code', 'heex']);

  run('build.mjs', root, '--no-claude-md');
  const graph = readGraph(root);
  const graphLive = graph.routes.find((r) => r.p === '/account');
  assert.deepEqual([graphLive.f, graphLive.h, graphLive.l], [first.live, 'mount', live.line]);
  assert.deepEqual(graphLive.phoenix, {
    file: first.router,
    line: live.defLine,
    module: 'FirstWeb.AccountLive',
    action: 'edit',
    session: 'account',
    pipelines: ['browser', 'authenticated'],
    resolved: true,
  });
  assert.equal(graph.routes.find((r) => r.p === '/ambiguous').phoenix.resolved, false);
  assert.ok(graph.screens.some((screen) => (
    screen.url === '/account' && screen.file === first.live && screen.fw === 'phoenix-liveview'
  )));
});
