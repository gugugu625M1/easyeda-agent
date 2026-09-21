/// <reference types="@jlceda/pro-api-types" />
/**
 * Module-load smoke test for the cold-start timeline (issue #221).
 *
 * The experiment this feeds asks one binary question of the FROZEN artifact the
 * user imports: when EasyEDA evaluates the connector bundle, does
 * `ENTRY_MODULE_EVALUATED` land in the log? A marker that fails to record would
 * be read as "the bundle was never evaluated" and would send the whole
 * investigation down the wrong branch — so the recording mechanism is verified
 * here against a mocked sandbox, before any human runs the cold start.
 *
 * This test is deliberately about the ENTRY MODULE, not a helper: it `require`s
 * `./index` and asserts what the module body did, mirroring what the host does
 * when it evaluates the bundle.
 *
 * Harness notes (learned the hard way here):
 *   - Node's `require` cache evaluates a module ONCE per process, so the whole
 *     module-load contract is asserted in a single test. Re-`require`ing after
 *     `delete require.cache[...]` starts a second always-on watchdog whose timer
 *     outlives the test; that was a real hang, not a hypothetical one.
 *   - `sys_Storage.getExtensionUserConfig` reports auto-connect OFF so
 *     `transport.start()` records its marker without starting the reconnect loop.
 *     A live watchdog would keep the process alive and let a later test observe
 *     `eda` reset underneath it.
 *   - Markers are asserted by presence and relative order, never by absolute
 *     `seq`: the sequence counter is process-global by design.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readLifecycleTimeline } from './lifecycle-timeline';

test('module evaluation records its own timeline before anything else runs', async t => {
	const globals = globalThis as any;
	const previousEda = globals.eda;
	const previousWorker = globals.Worker;
	const sink: string[] = [];
	globals.eda = {
		sys_Log: { add: (line: string) => { sink.push(line); } },
		sys_Environment: { getEditorCurrentVersion: () => '3.2.149.88089769' },
		sys_Storage: {
			getExtensionUserConfig: (key: string) => (key === 'autoConnectEnabled' ? false : undefined),
			setExtensionUserConfig: async () => undefined,
		},
		sys_Message: { showToastMessage: () => undefined },
		sys_I18n: { text: (k: string) => k },
		sys_WebSocket: { register: () => undefined, close: () => undefined, send: () => undefined },
		dmt_SelectControl: { getCurrentDocumentInfo: () => ({ documentType: 'schematic' }) },
		dmt_Project: { getCurrentProjectInfo: () => ({ uuid: 'p'.repeat(32) }) },
	};
	// The transport's watchdog builds a Web Worker holding a `setInterval`. In the
	// editor that is exactly what keeps reconnects alive while backgrounded; in a
	// test process it keeps the event loop alive forever and hangs `npm test`. Stub
	// the constructor so the watchdog is exercised but nothing ticks.
	class InertWorker {
		onmessage: ((event: unknown) => void) | null = null;
		terminate(): void { /* no-op */ }
	}
	globals.Worker = InertWorker as unknown as typeof Worker;

	t.after(() => {
		// Tear the transport down before the sandbox disappears, so no timer survives
		// with a stale `eda`.
		try {
			const entry = require('./index') as { stopConnection?: () => void };
			entry.stopConnection?.();
		}
		catch { /* entry failed to load — nothing to stop */ }
		globals.eda = previousEda;
		globals.Worker = previousWorker;
		delete globals.__easyedaAgentLifecycleTimelineV1;
	});

	// The sandbox is installed BEFORE the module body runs — exactly the ordering the
	// host uses when it builds the sandbox and then evaluates the bundle.
	const entry = require('./index') as { activate: (status?: string) => void };

	const evaluated = sink.findIndex(l => l.includes('ENTRY_MODULE_EVALUATED'));
	assert.ok(
		evaluated >= 0,
		`ENTRY_MODULE_EVALUATED must be logged during module evaluation, got: ${sink.join(' | ') || '(nothing)'}`,
	);
	assert.match(sink[evaluated], /^\[easyeda-agent:lifecycle\] ENTRY_MODULE_EVALUATED/);

	// Recorded exactly once per evaluation: a duplicate would make the field log
	// claim two evaluations where the host performed one.
	assert.equal(sink.filter(l => l.includes('ENTRY_MODULE_EVALUATED')).length, 1);

	// The probe must accompany it: a module-scope bootstrap (#230) depends on what
	// the sandbox injected at that instant, so both are recorded together.
	const probe = sink.findIndex(l => l.includes('SANDBOX_GLOBALS_PROBE'));
	assert.ok(probe > evaluated, 'SANDBOX_GLOBALS_PROBE must follow ENTRY_MODULE_EVALUATED');
	assert.match(sink[probe], /eda=true/);

	// Module evaluation must NOT be mistaken for activation: on the #221 cold start
	// the host evaluates the bundle WITHOUT ever calling activate() (field timeline:
	// two evaluations, zero ACTIVATE_CALLED). Recording ACTIVATE_CALLED here would
	// destroy the very distinction the timeline exists to make.
	assert.equal(
		sink.some(l => l.includes('ACTIVATE_CALLED')),
		false,
		'ACTIVATE_CALLED must not be recorded by module evaluation alone',
	);

	// ...but the transport MUST now start from module scope, because a skipped
	// activate() otherwise strands the connector entirely — that IS the #221 failure.
	const startedAtModuleLoad = sink.findIndex(l => l.includes('TRANSPORT_START'));
	assert.ok(
		startedAtModuleLoad >= 0,
		`the transport must start during module evaluation, got: ${sink.join(' | ') || '(nothing)'}`,
	);
	assert.ok(startedAtModuleLoad > evaluated, 'TRANSPORT_START must follow ENTRY_MODULE_EVALUATED');
	assert.match(sink[startedAtModuleLoad], /source=module-load/);
	assert.equal(typeof entry.activate, 'function');

	// Now the host dispatches activation, as it does on a healthy start.
	const before = sink.length;
	entry.activate('onStartupFinished');
	const added = sink.slice(before);
	const activated = added.findIndex(l => l.includes('ACTIVATE_CALLED'));
	assert.ok(
		activated >= 0 && added[activated].includes('status=onStartupFinished'),
		`activate() must be recorded, got: ${added.join(' | ')}`,
	);
	// The second start must be attributed to the activation path, not to module load,
	// so the field log distinguishes the two entry points.
	const started = added.findIndex(l => l.includes('TRANSPORT_START'));
	assert.ok(started > activated, 'TRANSPORT_START must follow ACTIVATE_CALLED');
	assert.match(added[started], /source=activate/);
	// Calling activate() a second time must not re-register the same socket: the host
	// evaluates the bundle more than once per cold start, and an unconditional kick
	// would tear down a live connection (#196).
	assert.equal(
		added.filter(l => l.includes('TRANSPORT_START')).length,
		1,
		'one activate() call must produce exactly one TRANSPORT_START',
	);
	// The field timeline must carry the editor build, so the evidence is attributable
	// to one EasyEDA version.
	assert.ok(added.some(l => l.includes('3.2.149.88089769')), 'activate() must record the editor version');

	// The buffer is readable independently of how many log lines were emitted.
	assert.match(readLifecycleTimeline(), /ENTRY_MODULE_EVALUATED/);
});
