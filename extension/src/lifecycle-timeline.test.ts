/// <reference types="@jlceda/pro-api-types" />
/**
 * The lifecycle timeline exists to diagnose a cold start in which the connector
 * may not be running at all. Its own failure modes therefore matter: it must
 * record markers when it can, and must never throw when the sandbox is incomplete
 * (no `eda`, no log panel) — a diagnostic that breaks the thing it measures would
 * turn issue #221 into a self-inflicted bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	dumpLifecycleTimeline,
	markLifecycle,
	markLifecycleOnce,
	probeHost,
	probeSandboxGlobals,
	readLifecycleTimeline,
} from './lifecycle-timeline';

/** Install a fake `eda` whose log sink records everything. */
function installEda(t: { after: (f: () => void) => void }, opts: { logThrows?: boolean } = {}): string[] {
	const globals = globalThis as any;
	const previous = globals.eda;
	const lines: string[] = [];
	t.after(() => {
		globals.eda = previous;
		delete globals.__easyedaAgentLifecycleTimelineV1;
	});
	globals.eda = {
		sys_Log: {
			add: (line: string) => {
				if (opts.logThrows) throw new Error('log panel unavailable');
				lines.push(line);
			},
		},
		sys_Environment: { getEditorCurrentVersion: () => '3.2.149.88089769' },
		dmt_SelectControl: { getCurrentDocumentInfo: () => ({ documentType: 'schematic' }) },
		dmt_Project: { getCurrentProjectInfo: () => ({ uuid: 'p'.repeat(32) }) },
	};
	return lines;
}

test('markers reach the editor log in order with the fixed greppable prefix', async t => {
	const lines = installEda(t);
	markLifecycle('ENTRY_MODULE_EVALUATED');
	markLifecycle('CONNECT_ATTEMPT', 'ports=60832');
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^\[easyeda-agent:lifecycle\] ENTRY_MODULE_EVALUATED/);
	assert.match(lines[1], /CONNECT_ATTEMPT ports=60832/);
	// The prefix is what the maintainer greps for; it must never acquire a timestamp
	// or other decoration (the editor log already timestamps every line).
	assert.ok(lines.every(l => l.startsWith('[easyeda-agent:lifecycle] ')));
});

test('the timeline is ordered by a monotonic seq and every marker is greppable', async t => {
	const lines = installEda(t);
	markLifecycle('ENTRY_MODULE_EVALUATED');
	markLifecycle('ACTIVATE_CALLED');
	const timeline = readLifecycleTimeline();
	const rows = timeline.split('\n').filter(l => l.includes('ENTRY_MODULE_EVALUATED') || l.includes('ACTIVATE_CALLED'));
	assert.equal(rows.length, 2);
	assert.match(rows[0], /ENTRY_MODULE_EVALUATED/);
	assert.match(rows[1], /ACTIVATE_CALLED/);
	const seqs = rows.map(r => Number(/seq=(\d+)/.exec(r)![1]));
	assert.ok(seqs[1] > seqs[0], 'the second marker must have a higher seq');
	assert.equal(lines.length, 2);
});

test('markLifecycleOnce dedupes within one evaluation so re-evaluation stays countable', async t => {
	installEda(t);
	markLifecycleOnce('ENTRY_MODULE_EVALUATED');
	markLifecycleOnce('ENTRY_MODULE_EVALUATED');
	markLifecycleOnce('SANDBOX_GLOBALS_PROBE', probeSandboxGlobals());
	markLifecycleOnce('SANDBOX_GLOBALS_PROBE', probeSandboxGlobals());
	const timeline = readLifecycleTimeline();
	assert.equal(timeline.split('\n').filter(l => l.includes('ENTRY_MODULE_EVALUATED')).length, 1);
	assert.equal(timeline.split('\n').filter(l => l.includes('SANDBOX_GLOBALS_PROBE')).length, 1);
});

test('a missing or throwing log panel never throws on the cold-start path', async t => {
	const lines = installEda(t, { logThrows: true });
	assert.doesNotThrow(() => markLifecycle('ENTRY_MODULE_EVALUATED'));
	assert.doesNotThrow(() => markLifecycleOnce('SANDBOX_GLOBALS_PROBE', probeSandboxGlobals()));
	assert.doesNotThrow(() => dumpLifecycleTimeline());
	assert.equal(lines.length, 0);
	// The buffer still holds the timeline, so it survives a dead log panel.
	assert.match(readLifecycleTimeline(), /ENTRY_MODULE_EVALUATED/);
});

test('the probe reports which sandbox globals were usable at module-eval time', async t => {
	installEda(t);
	const probe = probeSandboxGlobals();
	assert.match(probe, /eda=true/);
	assert.match(probe, /storage=false/);
	assert.match(probe, /ws=false/);
});

test('probeHost reads version and context, and degrades instead of throwing', async t => {
	installEda(t);
	const host = probeHost();
	assert.equal(host.editorVersion, '3.2.149.88089769');
	assert.equal(host.documentType, 'schematic');
	assert.equal(host.projectUuid, 'p'.repeat(32));
});

test('dumpLifecycleTimeline re-emits the whole buffer through the log sink', async t => {
	const lines = installEda(t);
	markLifecycle('ENTRY_MODULE_EVALUATED');
	markLifecycle('ACTIVATE_CALLED', 'status=onStartupFinished');
	dumpLifecycleTimeline();
	// One line per marker, then the dump itself (which contains both markers).
	assert.ok(lines.some(l => /TIMELINE_DUMPED entries=2/.test(l)), `missing dump header in: ${lines.join(' | ')}`);
	const dumped = lines.find(l => l.includes('ENTRY_MODULE_EVALUATED') && l.includes('ACTIVATE_CALLED'));
	assert.ok(dumped, 'the dump must contain the previously recorded entries');
	assert.match(dumped!, /ACTIVATE_CALLED status=onStartupFinished/);
});
