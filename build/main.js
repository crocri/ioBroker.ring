"use strict";
/*
 * Created with @iobroker/create-adapter v1.34.1
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RingAdapter = void 0;
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
const ringApiClient_1 = require("./lib/ringApiClient");
const path_1 = __importDefault(require("path"));
const fs = __importStar(require("fs"));
// Load your modules here, e.g.:
// import * as fs from "fs";
class RingAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "ring",
        });
        this.isWindows = process.platform.startsWith("win");
        this.states = {};
        this.initializedMetaObjects = {};
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.apiClient = new ringApiClient_1.RingApiClient(this);
        if (!this.apiClient.validateRefreshToken()) {
            this.terminate(`Invalid Refresh Token, please follow steps provided within Readme to generate a new one`);
            return;
        }
        this.log.debug(`Configured Path: "${this.config.path}"`);
        if (!this.config.path) {
            const dataDir = (this.systemConfig) ? this.systemConfig.dataDir : "";
            this.log.silly(`DataDir: ${dataDir}`);
            if (this.systemConfig) {
                this.log.silly(`systemConfig: ${JSON.stringify(this.systemConfig)}`);
            }
            const snapshotDir = path_1.default.normalize(`${utils.controllerDir}/${dataDir}${this.namespace.replace(".", "_")}`);
            this.config.path = path_1.default.join(snapshotDir, "snapshot");
            this.log.debug(`New Config Path: "${this.config.path}"`);
        }
        if (!fs.existsSync(this.config.path)) {
            this.log.info(`Data dir isn't existing yet --> Creating Directory`);
            fs.mkdirSync(this.config.path, { recursive: true });
            if (!this.isWindows) {
                fs.chmodSync(this.config.path, 508);
            }
        }
        const objectDevices = this.getDevicesAsync();
        for (const objectDevice in objectDevices) {
            this.deleteDevice(objectDevice);
        }
        this.log.info(`Initializing Api Client`);
        await this.apiClient.init();
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            if (this.apiClient) {
                this.apiClient.unload();
            }
            callback();
        }
        catch (e) {
            callback();
        }
    }
    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    // 	if (obj) {
    // 		// The object was changed
    // 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    // 	} else {
    // 		// The object was deleted
    // 		this.log.info(`object ${id} deleted`);
    // 	}
    // }
    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        if (!state || !this.apiClient) {
            // The state was deleted
            this.log.silly(`state ${id} deleted`);
            return;
        }
        // The state was changed
        this.log.silly(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        const splits = id.split(".");
        const deviceID = splits[2];
        let stateID = splits[3];
        let channelID = "";
        if (splits.length === 5) {
            channelID = splits[3];
            stateID = splits[4];
        }
        this.apiClient.processUserInput(deviceID, channelID, stateID, state);
    }
    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  */
    // private onMessage(obj: ioBroker.Message): void {
    // 	if (typeof obj === "object" && obj.message) {
    // 		if (obj.command === "send") {
    // 			// e.g. send email or pushover or whatever
    // 			this.log.info("send command");
    // 			// Send response in callback if required
    // 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    // 		}
    // 	}
    // }
    upsertState(id, common, value, subscribe = false) {
        if (this.states[id] === value) {
            // Unchanged Value
            return;
        }
        // noinspection JSIgnoredPromiseFromCall
        this.upsertStateAsync(id, common, value, subscribe);
    }
    async upsertStateAsync(id, common, value, subscribe = false) {
        try {
            if (this.states[id] !== undefined) {
                this.states[id] = value;
                await this.setStateAsync(id, value, true);
                return;
            }
            const { device, channel, stateName } = this.getSplittedIds(id);
            await this.createStateAsync(device, channel, stateName, common);
            this.states[id] = value;
            await this.setStateAsync(id, value, true);
            if (subscribe) {
                await this.subscribeStatesAsync(id);
            }
        }
        catch (e) {
            this.log.warn(`Error Updating State ${id} to ${value}: ${e.message}`);
            this.log.debug(`Error Stack: ${e.stack}`);
        }
    }
    async upsertFile(id, common, value, timestamp) {
        try {
            const { device, channel, stateName } = this.getSplittedIds(id);
            if (id.indexOf("ring.") < 0) {
                id = `${this.namespace}.${id}`;
            }
            this.log.silly(`upsertFile ${id}`);
            if (this.states[id] === timestamp) {
                // Unchanged Value
                return;
            }
            if (this.states[id] !== undefined) {
                this.states[id] = timestamp;
                await this.setBinaryStateAsync(id, value);
                return;
            }
            this.log.silly(`upsertFile.First File create State first for ${id}.\n Device: ${device}; Channel: ${channel}; StateName: ${stateName}`);
            await this.createStateAsync(device, channel, stateName, common);
            await this.setBinaryStateAsync(id, value);
            this.states[id] = timestamp;
        }
        catch (e) {
            this.log.warn(`Error Updating File State ${id}: ${e.message}`);
            this.log.debug(`Error Stack: ${e.stack}`);
        }
    }
    getSplittedIds(id) {
        const splits = id.split(".");
        const device = splits[0];
        let channel = "";
        let stateName = splits[1];
        if (splits.length === 3) {
            channel = splits[1];
            stateName = splits[2];
        }
        return { device, channel, stateName };
    }
}
exports.RingAdapter = RingAdapter;
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new RingAdapter(options);
}
else {
    // otherwise start the instance directly
    (() => new RingAdapter())();
}
//# sourceMappingURL=main.js.map