/**
 * Cold-start lifecycle timeline for the connector (issue #221).
 *
 * ## Why this exists
 *
 * `easyeda-agent` issue #221: on EasyEDA Pro desktop 3.2.149 (Windows) the
 * Connector works only during the run in which it was imported. After a full
 * EasyEDA restart it never activates again — the daemon sees ZERO connection
 * attempts, no `EDA Agent` menu appears, and no error is logged anywhere.
 *
 * Two competing explanations were proposed upstream and both were abandoned
 * without field evidence:
 *
 *   - #219 (closed): bootstrap the transport from module scope. Rejected because
 *     the host's activation gate (`Ig()` returning early while user info is not
 *     loaded) sits BEFORE the bundle is evaluated — so a module-scope bootstrap
 *     could not cross it either.
 *   - #230 (open): keep one transport controller on the shared `eda` object so
 *     repeated bundle evaluations delegate instead of double-registering. Its
 *     author explicitly did NOT validate it on Windows 3.2.149, i.e. the exact
 *     environment where #221 reproduces.
 *
 * The maintainer's stated requirement is a **field timeline of module
 * evaluation / activation / registration** that identifies which entry point is
 * actually being skipped. This module produces exactly that.
 *
 * ## The decisive question it answers
 *
 * The host only runs extension code if it evaluates the bundle. Therefore:
 *
 *   - `ENTRY_MODULE_EVALUATED` present  → the bundle WAS evaluated; the missing
 *     `activate()` is the defect, and a module-scope bootstrap (#230) is a valid
 *     fix.
 *   - `ENTRY_MODULE_EVALUATED` absent   → the bundle was NEVER evaluated; no
 *     connector-side change can fix it, and the defect is host-side. #230 must be
 *     rejected rather than merged on speculation.
 *
 * Both outcomes are actionable, which is why the marker set is deliberately small
 * and every marker is unconditional.
 *
 * ## Where the markers go
 *
 * `console.*` is dead code inside the EasyEDA sandbox (every method is `()=>{}`),
 * so markers are written through `eda.sys_Log`, which the editor's 日志 panel
 * shows and `eda.sys_Log.sort()` reads back. The same buffer is also published on
 * `globalThis` and summarised by the `Dump lifecycle timeline` menu action, so the
 * timeline can be recovered even when the daemon never connects.
 */

/** Prefix is fixed and ASCII so it is unambiguous in the editor log and greppable. */
const MARKER_PREFIX = '[easyeda-agent:lifecycle]';
/** Key on the host's global object. Versioned so a future format cannot be read as this one. */
const BUFFER_KEY = '__easyedaAgentLifecycleTimelineV1';
/** Bounded: the timeline must never grow without limit in a long editor session. */
const MAX_ENTRIES = 500;

export type LifecycleMarker =
	| 'ENTRY_MODULE_EVALUATED'
	| 'SANDBOX_GLOBALS_PROBE'
	| 'ACTIVATE_CALLED'
	| 'ACTIVATE_ARG'
	| 'DEACTIVATE_CALLED'
	| 'TRANSPORT_START'
	| 'WATCHDOG_STARTED'
	| 'WATCHDOG_FALLBACK_INTERVAL'
	| 'CONNECT_ATTEMPT'
	| 'REGISTER_CALLED'
	| 'REGISTER_THREW'
	| 'HANDSHAKE_OK'
	| 'HANDSHAKE_BAD_SERVICE'
	| 'CONNECT_ATTEMPT_FAILED'
	| 'HEARTBEAT_ALIVE'
	| 'WAKE_EVENT'
	| 'MENU_RECONNECT'
	| 'MENU_STOP'
	| 'TIMELINE_DUMPED';

interface TimelineEntry {
	seq: number;
	marker: string;
	detail: string;
}

interface TimelineBuffer {
	entries: TimelineEntry[];
}

const entrySeqSeen = new Set<string>();
let seq = 0;

function buffer(): TimelineBuffer | null {
	try {
		const host = globalThis as unknown as Record<string, unknown>;
		const existing = host[BUFFER_KEY];
		if (existing && typeof existing === 'object' && Array.isArray((existing as TimelineBuffer).entries)) {
			return existing as TimelineBuffer;
		}
		const created: TimelineBuffer = { entries: [] };
		Object.defineProperty(host, BUFFER_KEY, {
			configurable: true,
			enumerable: false,
			value: created,
			writable: true,
		});
		return created;
	}
	catch {
		return null;
	}
}

/**
 * Record one lifecycle marker.
 *
 * Never throws: this runs on the cold-start path it is meant to diagnose, so a
 * diagnostic failure must not become the failure being diagnosed.
 *
 * @param marker - the lifecycle marker name
 * @param detail - optional free-form detail (counters, ports, error text)
 */
export function markLifecycle(marker: LifecycleMarker, detail = ''): void {
	seq += 1;
	const line = detail ? `${MARKER_PREFIX} ${marker} ${detail}` : `${MARKER_PREFIX} ${marker}`;
	try {
		const buf = buffer();
		if (buf) {
			buf.entries.push({ seq, marker, detail });
			if (buf.entries.length > MAX_ENTRIES) buf.entries.shift();
		}
	}
	catch { /* buffer unavailable — the log line below is the primary sink */ }
	try {
		eda.sys_Log.add(line);
	}
	catch { /* log panel unavailable — nothing else can carry this */ }
}

/**
 * Record a marker at most once per bundle evaluation.
 *
 * The host may evaluate the bundle more than once in one editor process (the
 * re-dispatch path behind #196 / #230). Repeating an identical marker would
 * inflate the timeline without adding information; per-evaluation dedupe keeps
 * "evaluated once" distinguishable from "evaluated N times" via the counters
 * that callers pass as `detail`.
 *
 * @param marker - the lifecycle marker name
 * @param detail - optional free-form detail
 */
export function markLifecycleOnce(marker: LifecycleMarker, detail = ''): void {
	if (entrySeqSeen.has(marker)) return;
	entrySeqSeen.add(marker);
	markLifecycle(marker, detail);
}

/**
 * Probe what the sandbox actually injected, at the moment the entry module ran.
 *
 * A module-scope bootstrap (the #230 approach) depends on `eda` being present and
 * `eda.sys_WebSocket` being usable while the bundle body executes. Recording this
 * turns "the bootstrap silently did nothing" into a named reason.
 *
 * @returns one short line describing which globals were usable
 */
export function probeSandboxGlobals(): string {
	const has = (path: string): boolean => {
		try {
			const parts = path.split('.');
			let cursor: unknown = eda as unknown;
			for (const part of parts) {
				if (cursor === null || cursor === undefined) return false;
				cursor = (cursor as Record<string, unknown>)[part];
			}
			return cursor !== undefined && cursor !== null;
		}
		catch {
			return false;
		}
	};
	const flags = [
		`eda=${has('sys_Log')}`,
		`storage=${has('sys_Storage')}`,
		`toast=${has('sys_Message')}`,
		`ws=${has('sys_WebSocket')}`,
		`doc=${has('sys_Document')}`,
	];
	return flags.join(' ');
}

interface HostProbe {
	editorVersion: string;
	documentType: string;
	projectUuid: string;
}

/**
 * Best-effort snapshot of the host state at marker time.
 *
 * Every field is optional on purpose: this runs before activation, and an
 * unavailable API is itself a finding rather than an error.
 *
 * @returns a probe record with whatever could be read
 */
export function probeHost(): HostProbe {
	const read = (fn: () => unknown): string => {
		try {
			const value = fn();
			return typeof value === 'string' && value ? value : '';
		}
		catch {
			return '';
		}
	};
	// These are the same accessors `buildContextFrame` uses; they are read-only.
	let docType = '';
	let projectUuid = '';
	try {
		const info = eda.dmt_SelectControl?.getCurrentDocumentInfo?.() as { documentType?: unknown } | undefined;
		if (typeof info?.documentType === 'string') docType = info.documentType;
	}
	catch { /* document context unavailable before a document opens */ }
	try {
		const project = eda.dmt_Project?.getCurrentProjectInfo?.() as { uuid?: unknown } | undefined;
		if (typeof project?.uuid === 'string') projectUuid = project.uuid;
	}
	catch { /* project context unavailable (start page) */ }
	return {
		editorVersion: read(() => eda.sys_Environment?.getEditorCurrentVersion?.()),
		documentType: docType,
		projectUuid,
	};
}

/**
 * Read the buffered timeline as newline-delimited text.
 *
 * @returns every entry, oldest first
 */
export function readLifecycleTimeline(): string {
	const buf = buffer();
	if (!buf) return `${MARKER_PREFIX} buffer unavailable`;
	if (buf.entries.length === 0) return `${MARKER_PREFIX} (empty)`;
	return buf.entries.map(e => `${MARKER_PREFIX} seq=${e.seq} ${e.marker}${e.detail ? ` ${e.detail}` : ''}`).join('\n');
}

/**
 * Re-emit the whole buffered timeline through `eda.sys_Log`.
 *
 * This makes the timeline readable from the editor's 日志 panel (and via
 * `eda.sys_Log.sort()`) even on a cold start where nothing connected, which is
 * the only situation #221 cares about. Safe to call repeatedly.
 */
export function dumpLifecycleTimeline(): void {
	markLifecycle('TIMELINE_DUMPED', `entries=${buffer()?.entries.length ?? 0}`);
	const text = readLifecycleTimeline();
	try {
		eda.sys_Log.add(text);
	}
	catch { /* nothing else can carry it */ }
}
