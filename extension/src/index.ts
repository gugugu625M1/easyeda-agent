/**
 * EasyEDA Agent Connector — extension entry point.
 *
 * Bridges the easyeda-agent Go daemon to the official `eda.*` API over a local
 * WebSocket. On startup it scans ports 60832-60841 (0xEDA0-0xEDA9), validates the daemon
 * handshake (service "easyeda-agent"), registers a windowId, sends context, and
 * keeps a heartbeat. Incoming `request` frames are dispatched to typed actions
 * (see ./actions) and answered with `response` frames.
 *
 * Exported functions are wired to menu items in `extension.json`.
 */

import * as extensionConfig from '../extension.json';
import {
	getConnectionStatus,
	reconnect as transportReconnect,
	start as transportStart,
	stop as transportStop,
} from './transport';
import {
	dumpLifecycleTimeline,
	markLifecycle,
	markLifecycleOnce,
	probeHost,
	probeSandboxGlobals,
} from './lifecycle-timeline';

const STORAGE_KEY_AUTO_CONNECT = 'autoConnectEnabled';

// ─── Cold-start evidence (issue #221) ─────────────────────────────────
// The single fact that decides whether a connector-side fix is even possible:
// did the host evaluate this bundle at all? Recorded unconditionally at module
// scope, before activation, so absence of this marker is itself the answer.
// See ./lifecycle-timeline for the full reasoning.
markLifecycleOnce('ENTRY_MODULE_EVALUATED');
markLifecycleOnce('SANDBOX_GLOBALS_PROBE', probeSandboxGlobals());

// ─── Module-scope bootstrap (issue #221) ──────────────────────────────
/**
 * Start the transport HERE, not only from `activate()`.
 *
 * EasyEDA can evaluate a user-extension bundle without ever dispatching its
 * activation event, which leaves `activate()` — and therefore the whole transport
 * — unrun. Measured on Windows EasyEDA Pro 3.2.149.88089769, connector 1.5.3-dev.3,
 * one cold start (2026-09-21):
 *
 *     10:50:16  ENTRY_MODULE_EVALUATED
 *     10:50:16  SANDBOX_GLOBALS_PROBE eda=true storage=true toast=true ws=true doc=false
 *     10:50:19  [project opened]
 *     10:50:44  ENTRY_MODULE_EVALUATED
 *     10:50:44  SANDBOX_GLOBALS_PROBE eda=true storage=true toast=true ws=true doc=false
 *
 * Two bundle evaluations, ZERO `ACTIVATE_CALLED`, zero `TRANSPORT_START`. The host
 * never called `activate()`, so no watchdog was ever built and the daemon saw no
 * connection attempt at all (it logged no TCP connect while the port stayed
 * healthy — the "daemon-side zero attempts" symptom of #221).
 *
 * `activate()` is still called on the healthy path, so `start()` is written to be
 * idempotent (see transport.start) and the two entry points cannot fight over the
 * socket.
 */
transportStart('module-load');

// ─── Lifecycle ────────────────────────────────────────────────────────

/**
 * Extension activation entry (supports onStartupFinished auto-start).
 *
 * @param status - activation reason (e.g. 'onStartupFinished')
 * @param arg - optional activation argument
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	const host = probeHost();
	markLifecycle('ACTIVATE_CALLED', `status=${status ?? 'none'} arg=${arg ?? ''} v=${host.editorVersion} doc=${host.documentType}`);
	transportStart('activate');
}

/**
 * Extension deactivation: tear down the connection without showing a toast.
 */
export function deactivate(): void {
	markLifecycle('DEACTIVATE_CALLED');
	transportStop(false);
}

/**
 * Write the cold-start timeline into the editor log (menu item).
 *
 * Exists so the timeline is recoverable on a cold start where nothing connected
 * and no action can travel over the (absent) daemon link.
 */
export function dumpLifecycle(): void {
	dumpLifecycleTimeline();
}

// ─── Menu actions ─────────────────────────────────────────────────────

/**
 * Manually reconnect (menu item).
 */
export function reconnect(): void {
	transportReconnect();
}

/**
 * Stop the connection and cancel retries (menu item).
 */
export function stopConnection(): void {
	transportStop();
}

/**
 * Toggle the auto-connect-on-startup preference (menu item).
 */
export async function toggleAutoConnect(): Promise<void> {
	const current = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	const currentlyEnabled = current !== false;
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT, !currentlyEnabled);
	const msgKey = currentlyEnabled ? 'Auto-Connect disabled' : 'Auto-Connect enabled';
	eda.sys_Message.showToastMessage(eda.sys_I18n.text(msgKey));
}

/**
 * Show the About dialog with the current connection status (menu item).
 */
export function about(): void {
	const status = getConnectionStatus();
	let statusLine: string;
	if (status.connected) {
		const portInfo = `Connected (port ${status.port})`;
		const windowInfo = status.windowId ? `\nWindow ID: ${status.windowId}` : '\nWindow ID: (not registered)';
		statusLine = `${portInfo}${windowInfo}`;
	}
	else if (status.connecting) {
		statusLine = 'Connecting...';
	}
	else {
		statusLine = 'Disconnected';
	}

	eda.sys_Dialog.showInformationMessage(
		`EasyEDA Agent Connector v${extensionConfig.version}\n${statusLine}`,
		'About',
	);
}
