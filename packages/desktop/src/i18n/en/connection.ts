/** Whether the app writes a conversation itself: Disconnect, Connect and read-only states (`connection.*`). */
export const connection = {
	"connection.disconnect": "Disconnect from app",
	"connection.connect": "Connect",
	"connection.connecting": "Connecting…",
	"connection.retry": "Check again",
	"connection.checking": "Checking…",
	"connection.badgeDisconnected": "Not connected here",
	"connection.badgeElsewhere": "In use in a terminal",
	"connection.markDisconnected": "not connected to the app",
	"connection.markElsewhere": "in use in a terminal",
	"connection.disconnectedTitle": "Not connected to the app",
	"connection.disconnectedBody":
		"The terminal can continue this conversation now. Its history stays here, read-only. Connect to continue here; your draft is kept.",
	"connection.elsewhereTitle": "In use in a terminal",
	"connection.elsewhereBody":
		"Another gjc process, usually a terminal, has this conversation open, so the app shows it read-only. Close it there, then check again.",
	"connection.stillElsewhere":
		"Another gjc process still has this conversation open. Close it there, then check again.",
	"connection.confirmTitle": "Disconnect while it is working?",
	"connection.confirmRunning": "Disconnecting stops the current turn, as Stop does.",
	"connection.confirmQueuedOne": "1 queued message goes back to the message box.",
	"connection.confirmQueued": "{count} queued messages go back to the message box.",
	"connection.confirmKept": "The conversation and its history are kept. The terminal can continue it afterwards.",
	"connection.confirmAction": "Stop and disconnect",
	"connection.showcaseNav": "Conversation connection",
	"connection.showcaseHeading": "Conversation connection · Disconnect, Connect and read-only states",
	"connection.showcaseNote":
		"Design example · Fixture states of the composer replacement, header badge, sidebar mark and the Disconnect confirmation. Buttons do nothing here.",
	"connection.showcaseDisconnected": "Not connected · composer replaced by Connect",
	"connection.showcaseConnecting": "Connect pending",
	"connection.showcaseElsewhere": "In use in a terminal · check again",
	"connection.showcaseChecking": "Check pending",
	"connection.showcaseBadges": "Header badges",
	"connection.showcaseRows": "Sidebar rows",
	"connection.showcaseConfirm": "Disconnect confirmation · running turn and queued messages",
	"connection.showcaseConfirmQueued": "Disconnect confirmation · queued messages only",
	"connection.showcaseNarrow": "Narrow width · Korean title",
} as const;
