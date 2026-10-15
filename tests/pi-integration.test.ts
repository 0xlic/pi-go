import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { test } from "node:test";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  initTheme, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext, type KeybindingsManager, type Theme,
} from "@earendil-works/pi-coding-agent";
import { MetadataStore } from "../src/metadata-store.ts";
import { executeAction } from "../src/session-gateway.ts";

// No model requests or user config: all services, resources and sessions live in a temporary fixture.
test("real Pi command dispatch and runtime replacement rebind cwd, read tool and project context", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-go-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a"), b = join(root, "b"), agentDir = join(root, "agent"), storage = join(root, "storage");
  await Promise.all([mkdir(a), mkdir(b), mkdir(agentDir)]);
  await writeFile(join(a, "marker.txt"), "PROJECT_A");
  await writeFile(join(b, "marker.txt"), "PROJECT_B");
  await writeFile(join(b, "AGENTS.md"), "PROJECT_B_INSTRUCTIONS");
  const store = new MetadataStore(join(root, "state.json"));
  let probes = 0;
  const errors: string[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "never" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [pi => {
          pi.registerCommand("probe", { handler: async () => { probes++; } });
          pi.registerCommand("target", { handler: async (_args, ctx) => executeAction(ctx, { kind: "create", cwd: b }, store) });
          pi.registerCommand("back", { handler: async (_args, ctx) => executeAction(ctx, { kind: "restore", path: original }, store) });
        }] },
    });
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["read", "bash"] }),
      services, diagnostics: services.diagnostics };
  };
  const initial = SessionManager.create(a, storage);
  initial.appendMessage({ role: "user", content: "original history", timestamp: Date.now() });
  const original = initial.getSessionFile()!;
  const runtime = await createAgentSessionRuntime(factory, { cwd: a, agentDir, sessionManager: initial });
  t.after(() => runtime.dispose());
  const bind = async () => runtime.session.bindExtensions({
    onError: error => errors.push(error.error),
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      switchSession: (path, options) => runtime.switchSession(path, options),
      newSession: options => runtime.newSession(options),
      fork: (id, options) => runtime.fork(id, options),
      navigateTree: async () => ({ cancelled: true }),
      reload: async () => {},
    },
  });
  runtime.setRebindSession(bind);
  await bind();
  await runtime.session.sendUserMessage("/probe", { expandPromptTemplates: true });
  assert.equal(probes, 1);
  assert.equal(runtime.session.messages.filter(m => m.role === "user").length, 1);
  const oldSession = runtime.session;
  await runtime.session.prompt("/target");
  assert.deepEqual(errors, []);
  assert.notEqual(runtime.session, oldSession);
  assert.equal(runtime.cwd, b);
  assert.equal(runtime.session.sessionManager.getCwd(), b);
  assert.equal(runtime.session.messages.filter(m => m.role === "user").length, 0);
  assert.match(runtime.session.systemPrompt, /PROJECT_B_INSTRUCTIONS/);
  const read = runtime.session.agent.state.tools.find(tool => tool.name === "read")!;
  const result = await read.execute("test", { path: "marker.txt" });
  assert.match(JSON.stringify(result.content), /PROJECT_B/);
  const state = await store.read();
  assert.equal(state.projects[b].registered, true);
  await runtime.session.prompt("/back");
  assert.deepEqual(errors, []);
  assert.equal(runtime.cwd, a);
  assert.match(JSON.stringify(runtime.session.messages), /original history/);
});

test("loads actual extension file: --g displays picker once and never sends a model prompt", async t => {
  initTheme("dark", false); // CLI initializes the shared theme before invoking interactive extensions.
  const root = await mkdtemp(join(tmpdir(), "pi-go-startup-sdk-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "project"); await mkdir(cwd);
  const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never" });
  const services = await createAgentSessionServices({ cwd, agentDir: root, settingsManager,
    extensionFlagValues: new Map([["g", true]]),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] },
  });
  const { session, extensionsResult } = await createAgentSessionFromServices({ services,
    sessionManager: SessionManager.create(cwd, join(root, "storage")), tools: [] });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  const tui = { requestRender: () => {}, terminal: { rows: 24 } } as TUI;
  const kb = { matches: () => false } as unknown as KeybindingsManager;
  const errors: string[] = [], screens: string[] = [];
  const components: (Component & { dispose?: () => void })[] = [];
  t.after(() => { for (const component of components) component.dispose?.(); });
  const ui = {
    notify: (text: string) => errors.push(text),
    custom: (factory: Parameters<ExtensionUIContext["custom"]>[0]) => new Promise<unknown>((resolve, reject) => {
      let component: Component & { dispose?: () => void };
      const done = (value: unknown) => { component?.dispose?.(); resolve(value); };
      Promise.resolve(factory(tui, theme, kb, done)).then(c => {
        component = c; components.push(c);
        if ("focused" in c) (c as Component & Focusable).focused = true;
        const screen = c.render(100).join("\n");
        if (screen.includes("所有项目")) { screens.push(screen); c.handleInput?.("\x1b"); }
      }, reject);
    }),
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error.error),
    commandContextActions: { waitForIdle: () => session.waitForIdle(), newSession: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }), reload: async () => {} },
  });
  const deadline = Date.now() + 3000;
  while (screens.length === 0 && errors.length === 0 && Date.now() < deadline) await sleep(10);
  assert.deepEqual(errors, []);
  assert.equal(screens.length, 1);
  assert.match(screens[0], /Enter 新建会话/);
  assert.doesNotMatch(screens[0], /＋ 新建会话/);
  assert.equal(session.messages.length, 0);
  await sleep(30);
  await session.prompt("/go");
  assert.equal(screens.length, 2); // Existing-session entry reuses the same UI.
  assert.equal(session.messages.length, 0);
});
