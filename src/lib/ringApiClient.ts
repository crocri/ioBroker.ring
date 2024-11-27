import { Location, ProfileResponse, RingApi, RingCamera, RingDevice, RingIntercom } from "ring-client-api";
import pathToFfmpeg from "ffmpeg-static";

import { RingAdapter } from "../main";
import { OwnRingCamera } from "./ownRingCamera";
import { COMMON_NEW_TOKEN, COMMON_OLD_TOKEN } from "./constants";
import { OwnRingLocation } from "./ownRingLocation";
import { OwnRingDevice } from "./ownRingDevice";
import { OwnRingIntercom } from "./ownRingIntercom";
import { ExtendedResponse } from "ring-client-api/lib/rest-client";

export class RingApiClient {
  public refreshing: boolean = false;
  private cameras: { [id: string]: OwnRingCamera } = {};
  private intercoms: { [id: string]: OwnRingIntercom } = {};
  private _refreshInterval: NodeJS.Timeout | null = null;
  private _retryTimeout: NodeJS.Timeout | null = null;

  public get locations(): { [id: string]: OwnRingLocation } {
    return this._locations;
  }

  private _locations: { [id: string]: OwnRingLocation } = {};

  public validateRefreshToken(): boolean {
    const token: string = this.adapter.config.refreshtoken;
    if (!token || token === "") {
      this.adapter.log.error(`Refresh Token missing.`);
      return false;
    }
    if (token.length < 10) {
      this.adapter.log.error(`Refresh Token is oddly short.`);
      return false;
    }

    return true;
  }

  public async getApi(): Promise<RingApi> {
    if (this._api) {
      return this._api;
    }
    if (!this.adapter.config.refreshtoken) {
      throw (`Refresh Token needed.`);
    }
    this._api = new RingApi({
      controlCenterDisplayName: "iobroker.ring",
      refreshToken: await this.adapter.getRefreshToken(),
      systemId: `${this.adapter.host}.ring_v${this.adapter.version}_${Math.random() * Math.pow(10, 6)}`,
      cameraStatusPollingSeconds: 120,
      locationModePollingSeconds: 120,
      // overwrite "ffmpeg for homebridge" with many missing libraries, use actual ffmpeg-static!
      ffmpegPath: pathToFfmpeg ? pathToFfmpeg : undefined,
      // debug: true
    });
    this._api.onRefreshTokenUpdated.subscribe((data: {
      oldRefreshToken?: string | undefined;
      newRefreshToken: string;
    }): void => {
      this.adapter.log.info(
        `Received new Refresh Token. Will use the new one until the token in config gets changed`
      );
      this.adapter.upsertState(
        "next_refresh_token",
        COMMON_NEW_TOKEN,
        data.newRefreshToken,
      );
      this.adapter.upsertState(
        "old_user_refresh_token",
        COMMON_OLD_TOKEN,
        this.adapter.config.refreshtoken,
      );
    });
    const profile: (ProfileResponse & ExtendedResponse) | void = await this._api.getProfile()
      .catch((reason: any): void => this.handleApiError(reason));
    if (profile === undefined) {
      this.warn("Couldn't Retrieve profile, please make sure your api-token is fresh and correct");
    }
    return this._api;
  }

  private readonly adapter: RingAdapter;
  private _api: RingApi | undefined;

  public constructor(adapter: RingAdapter) {
    this.adapter = adapter;
  }

  public async init(): Promise<void> {
    await this.refreshAll(true);
  }

  public async refreshAll(initial: boolean = false): Promise<void> {
    /**
     *  TH 2022-05-30: It seems like Ring Api drops its socket connection from time to time,
     *  so we should reconnect ourselves
     */
    this.debug(`Refresh Ring Connection`);
    this.refreshing = true;
    this._api?.disconnect();
    this._api = undefined;
    if (!await this.retrieveLocations()) {
      if (initial) {
        this.adapter.terminate(`Failed to retrieve any locations for your ring Account.`);
      }
      if (this._retryTimeout !== null) {
        clearTimeout(this._retryTimeout);
        this._retryTimeout = null;
      }
      this.warn(`Couldn't load data from Ring Server on reconnect, will retry in 5 Minutes...`);
      this._retryTimeout = setTimeout(this.refreshAll.bind(this), 5 * 60 * 1000);
    } else {
      if (this._retryTimeout !== null) {
        clearTimeout(this._retryTimeout);
        this._retryTimeout = null;
      }
    }
    if (Object.keys(this._locations).length === 0 && initial) {
      this.adapter.terminate(`We couldn't find any locations in your Ring Account`);
    }
    for (const key in this._locations) {
      const l: OwnRingLocation = this._locations[key];
      this.debug(`Process Location ${l.name}`);
      const devices: RingDevice[] = await l.getDevices();
      this.debug(`Received ${devices.length} Devices in Location ${l.name}`);
      this.debug(`Location has ${l.loc.cameras.length} Cameras`);
      for (const c of l.loc.cameras) {
        this.updateCamera(c, l);
      }
      this.debug(`Location has ${l.loc.intercoms.length} Intercoms`);
      for (const i of l.loc.intercoms) {
        this.updateIntercom(i, l);
      }
    }
    this.refreshing = false;
    this.debug(`Refresh complete`);
  }


  public processUserInput(targetId: string, channelID: string, stateID: string, state: ioBroker.State): void {
    const targetDevice: OwnRingCamera = this.cameras[targetId] ?? this.intercoms[targetId];
    const targetLocation: OwnRingLocation = this._locations[targetId];
    if (!targetDevice && !targetLocation) {
      this.adapter.log.error(`Received State Change on Subscribed State, for unknown Device/Location "${targetId}"`);
      return;
    } else if (targetDevice) {
      targetDevice.processUserInput(channelID, stateID, state);
    } else if (targetLocation) {
      targetLocation.processUserInput(channelID, stateID, state);
    }
  }

  public unload(): void {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    if (this._retryTimeout !== null) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }
  }

  private async retrieveLocations(): Promise<boolean> {
    this.debug(`Retrieve Locations`);
    return new Promise<boolean>(async (res: (value: (PromiseLike<boolean> | boolean)) => void): Promise<void> => {
      (await this.getApi()).getLocations()
        .catch((reason: any): void => {
          this.handleApiError(reason);
          res(false);
        })
        .then((locs: Location[] | void): void => {
          if (typeof locs != "object" || (locs?.length ?? 0) == 0) {
            this.debug("getLocations was successful, but received no array");
            res(false);
            return;
          }
          this.debug(`Received ${locs?.length} Locations`);
          this._locations = {};
          for (const loc of locs as Location[]) {
            const newLoc: OwnRingLocation = new OwnRingLocation(loc, this.adapter, this);
            this._locations[newLoc.fullId] = newLoc;
          }
          res(true);
        });
    });
  }

  private handleApiError(reason: any): void {
    this.adapter.log.error(`Api Call failed`);
    this.adapter.log.debug(`Failure reason:\n${reason}`);
    this.adapter.log.debug(`Call Stack: \n${(new Error()).stack}`);
  }

  private debug(message: string): void {
    this.adapter.log.debug(message);
  }

  private warn(message: string): void {
    this.adapter.log.warn(message);
  }

  private updateCamera(camera: RingCamera, location: OwnRingLocation): void {
    const fullID: string = OwnRingCamera.getFullId(camera, this.adapter);
    let ownRingCamera: OwnRingCamera = this.cameras[fullID];
    if (ownRingCamera === undefined) {
      ownRingCamera = new OwnRingCamera(camera, location, this.adapter, this);
      this.cameras[fullID] = ownRingCamera;
    } else {
      ownRingCamera.updateByDevice(camera);
    }
  }

  private updateIntercom(intercom: RingIntercom, location: OwnRingLocation): void {
    const fullID: string = OwnRingDevice.getFullId(intercom, this.adapter);
    let ownRingIntercom: OwnRingIntercom = this.intercoms[fullID];
    if (ownRingIntercom === undefined) {
      ownRingIntercom = new OwnRingIntercom(intercom, location, this.adapter, this);
      this.intercoms[fullID] = ownRingIntercom;
    } else {
      ownRingIntercom.updateByDevice(intercom);
    }
  }

  public getLocation(locId: string): OwnRingLocation {
    return this.locations[locId];
  }
}
