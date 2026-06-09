import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { WanderlogAuthError, WanderlogError } from "../errors.js";
/**
 * ShareDB JSONv0 client bound to a single trip key.
 * Exposes subscribe() for the initial snapshot, submit() for outgoing ops
 * (with version tracking and ack waiting), and a `remoteOp` event for ops
 * pushed by the server from other clients.
 */
export class ShareDBClient extends EventEmitter {
    config;
    tripKey;
    ws;
    sessionId;
    handshakeComplete = false;
    closedByUser = false;
    reconnectAttempts = 0;
    seqCounter = 0;
    snapshot;
    _version = 0;
    subscribed = false;
    subscribePending;
    pendingOps = new Map();
    connectPromise;
    heartbeatTimer;
    pongTimer;
    static HEARTBEAT_INTERVAL_MS = 30_000;
    static PONG_TIMEOUT_MS = 10_000;
    constructor(config, tripKey) {
        super();
        this.config = config;
        this.tripKey = tripKey;
    }
    get version() {
        return this._version;
    }
    get currentSnapshot() {
        return this.snapshot;
    }
    get isSubscribed() {
        return this.subscribed;
    }
    url() {
        return `${this.config.wsBaseUrl}/api/tripPlans/wsOverall/${encodeURIComponent(this.tripKey)}?clientSchemaVersion=2`;
    }
    async connect() {
        if (this.handshakeComplete)
            return;
        if (this.connectPromise)
            return this.connectPromise;
        this.connectPromise = this.doConnect();
        try {
            await this.connectPromise;
        }
        finally {
            this.connectPromise = undefined;
        }
    }
    doConnect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url(), {
                headers: {
                    Cookie: this.config.cookieHeader,
                    Origin: this.config.baseUrl,
                    "User-Agent": this.config.userAgent,
                },
            });
            this.ws = ws;
            this.handshakeComplete = false;
            const handshakeTimeout = setTimeout(() => {
                reject(new WanderlogError("ShareDB handshake timeout", "ws_timeout"));
                ws.close();
            }, 10_000);
            ws.on("open", () => {
                this.send({ a: "hs", id: null, protocol: 1, protocolMinor: 2 });
            });
            ws.on("message", (raw) => {
                const text = raw.toString();
                let msg;
                try {
                    msg = JSON.parse(text);
                }
                catch {
                    return;
                }
                if (!msg || typeof msg !== "object")
                    return;
                this.handleFrame(msg, handshakeTimeout, resolve);
            });
            ws.on("pong", () => {
                if (this.pongTimer) {
                    clearTimeout(this.pongTimer);
                    this.pongTimer = undefined;
                }
            });
            ws.on("close", (code) => {
                clearTimeout(handshakeTimeout);
                this.stopHeartbeat();
                const wasSubscribed = this.subscribed;
                this.handshakeComplete = false;
                this.subscribed = false;
                this.failAllPending(new WanderlogError("WebSocket closed", "ws_closed"));
                this.emit("closed", code);
                if (!this.closedByUser && code !== 1000) {
                    this.scheduleReconnect(wasSubscribed);
                }
            });
            ws.on("unexpected-response", (_req, res) => {
                clearTimeout(handshakeTimeout);
                if (res.statusCode === 401 || res.statusCode === 403) {
                    reject(new WanderlogAuthError());
                }
                else {
                    reject(new WanderlogError(`WebSocket upgrade failed: ${res.statusCode}`, "ws_upgrade_failed"));
                }
            });
            ws.on("error", (err) => {
                clearTimeout(handshakeTimeout);
                if (!this.handshakeComplete)
                    reject(err);
            });
        });
    }
    handleFrame(frame, handshakeTimeout, connectResolve) {
        // Server rejections arrive as bare {code, message} frames with no `a` and
        // no `seq` (observed: {code: 4001, message: "Too many requests"}). Without
        // this branch they fall through silently and the submit dies as an opaque
        // 10s timeout. No seq means we can't attribute it — fail everything.
        const bare = frame;
        if (bare.a === undefined && typeof bare.code === "number") {
            const code = bare.code === 4001 ? "rate_limited" : "ws_rejected";
            this.failAllPending(new WanderlogError(`Wanderlog rejected the request (${bare.code}): ${bare.message ?? "unknown"}`, code));
            return;
        }
        if (frame.error) {
            const err = frame.error;
            const errMsg = typeof err === "string" ? err : err.message ?? "unknown";
            // If the error frame carries a seq, it belongs to a specific submit.
            // Fail only that one pending op, so concurrent/queued submits are not
            // collateral damage.
            if (typeof frame.seq === "number" && this.pendingOps.has(frame.seq)) {
                const pending = this.pendingOps.get(frame.seq);
                this.pendingOps.delete(frame.seq);
                clearTimeout(pending.timer);
                pending.reject(new WanderlogError(errMsg, "ws_error"));
                return;
            }
            // No seq, or unknown seq — fall back to failing everything, since we
            // can't safely attribute the error.
            this.failAllPending(new WanderlogError(errMsg, "ws_error"));
            return;
        }
        if (frame.a === "init") {
            this.sessionId = frame.id;
            return;
        }
        if (frame.a === "hs" && !this.handshakeComplete) {
            this.handshakeComplete = true;
            clearTimeout(handshakeTimeout);
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            const hs = frame;
            if (!this.sessionId && hs.id)
                this.sessionId = hs.id;
            connectResolve();
            return;
        }
        if (frame.a === "s") {
            const pending = this.subscribePending;
            if (pending) {
                this.subscribePending = undefined;
                pending.resolve(frame);
            }
            return;
        }
        if (frame.a === "op") {
            this.handleOpFrame(frame);
        }
    }
    handleOpFrame(frame) {
        const isOurAck = frame.src === this.sessionId &&
            frame.seq !== undefined &&
            this.pendingOps.has(frame.seq);
        if (isOurAck) {
            const pending = this.pendingOps.get(frame.seq);
            this.pendingOps.delete(frame.seq);
            clearTimeout(pending.timer);
            this._version = frame.v + 1;
            pending.resolve();
            return;
        }
        if (frame.op && frame.op.length > 0) {
            this._version = frame.v + 1;
            this.emit("remoteOp", frame.op, this._version);
        }
    }
    failAllPending(err) {
        if (this.subscribePending) {
            this.subscribePending.reject(err);
            this.subscribePending = undefined;
        }
        for (const [seq, pending] of this.pendingOps) {
            clearTimeout(pending.timer);
            pending.reject(err);
            this.pendingOps.delete(seq);
        }
    }
    /**
     * WS-level keepalive. Idle connections through NATs and load balancers can
     * die without a close frame; the socket then looks OPEN forever while every
     * send goes nowhere and no remote ops arrive (stale reads + submit
     * timeouts). Ping every 30s; a missed pong means the connection is dead —
     * terminate() forces the close event, which drives the normal
     * reconnect/resubscribe path.
     */
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN)
                return;
            if (this.pongTimer)
                return; // previous ping still unanswered
            ws.ping();
            this.pongTimer = setTimeout(() => {
                this.pongTimer = undefined;
                ws.terminate();
            }, ShareDBClient.PONG_TIMEOUT_MS);
        }, ShareDBClient.HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = undefined;
        }
    }
    scheduleReconnect(resubscribe) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
        this.reconnectAttempts += 1;
        setTimeout(() => {
            if (this.closedByUser)
                return;
            this.doConnect()
                .then(() => {
                if (resubscribe) {
                    void this.subscribe().then(() => this.emit("reconnected"));
                }
                else {
                    this.emit("reconnected");
                }
            })
                .catch(() => this.scheduleReconnect(resubscribe));
        }, delay);
    }
    send(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new WanderlogError("WebSocket is not open — cannot send frame", "ws_not_open");
        }
        this.ws.send(JSON.stringify(obj));
    }
    async subscribe() {
        await this.connect();
        if (this.subscribed &&
            this.snapshot &&
            this.ws?.readyState === WebSocket.OPEN) {
            return this.snapshot;
        }
        this.subscribed = false;
        const ack = await new Promise((resolve, reject) => {
            this.subscribePending = { resolve, reject };
            this.send({ a: "s", c: "TripPlans", d: this.tripKey });
            setTimeout(() => {
                if (this.subscribePending) {
                    this.subscribePending = undefined;
                    reject(new WanderlogError("Subscribe timeout", "subscribe_timeout"));
                }
            }, 10_000);
        });
        if (!ack.data) {
            throw new WanderlogError("Subscribe ack missing snapshot", "subscribe_failed");
        }
        this.snapshot = ack.data.data;
        this._version = ack.data.v;
        this.subscribed = true;
        return this.snapshot;
    }
    /**
     * Submit a JSON0 op array to the server. Resolves when the server acks.
     * Throws if not subscribed, if the WebSocket is closed, or on ack timeout.
     *
     * On successful ack, the local version is bumped to `frame.v + 1`.
     */
    async submit(ops) {
        if (!this.subscribed) {
            throw new WanderlogError("Cannot submit op before subscribing to the trip", "not_subscribed");
        }
        if (ops.length === 0) {
            throw new WanderlogError("Cannot submit an empty op array", "empty_op");
        }
        this.seqCounter += 1;
        const seq = this.seqCounter;
        const frame = {
            a: "op",
            c: "TripPlans",
            d: this.tripKey,
            v: this._version,
            seq,
            x: {},
            op: ops,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingOps.has(seq)) {
                    this.pendingOps.delete(seq);
                    reject(new WanderlogError("Submit op timeout", "submit_timeout"));
                    // A missed ack almost always means the connection is dead (zombie
                    // socket). Terminate so the close event fires and the reconnect/
                    // resubscribe path restores a working connection for the next op,
                    // instead of every subsequent submit timing out the same way.
                    this.ws?.terminate();
                }
            }, 10_000);
            this.pendingOps.set(seq, { resolve, reject, timer });
            try {
                this.send(frame);
            }
            catch (err) {
                // Send failed (e.g. WS closed between the isSubscribed check and now).
                // Clean up the pending entry and propagate immediately rather than
                // waiting 10s for the timeout to fire.
                this.pendingOps.delete(seq);
                clearTimeout(timer);
                reject(err);
            }
        });
    }
    close() {
        this.closedByUser = true;
        this.subscribed = false;
        this.stopHeartbeat();
        this.failAllPending(new WanderlogError("Client closed", "ws_closed"));
        this.ws?.close();
    }
}
/**
 * Pool of ShareDBClient instances keyed by trip key. A single MCP server
 * session may subscribe to multiple trips concurrently; each gets its own
 * WebSocket (required, since the URL embeds the trip key).
 */
export class ShareDBPool {
    config;
    clients = new Map();
    constructor(config) {
        this.config = config;
    }
    get(tripKey) {
        let client = this.clients.get(tripKey);
        if (!client) {
            client = new ShareDBClient(this.config, tripKey);
            this.clients.set(tripKey, client);
        }
        return client;
    }
    has(tripKey) {
        return this.clients.has(tripKey);
    }
    closeAll() {
        for (const client of this.clients.values()) {
            client.close();
        }
        this.clients.clear();
    }
}
//# sourceMappingURL=sharedb.js.map