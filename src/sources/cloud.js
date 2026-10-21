// Enlighten cloud live stream: the same feed the web "Live Status" panel uses.
// Optional (ENLIGHTEN_CLOUD=1). Flow, as used by the Enlighten web app:
//   GET /pv/aws_sigv4/livestream.json?serial_num=<gw>  -> AWS IoT custom-authorizer creds + topic,
//   connect MQTT over wss://<aws_iot_endpoint>/mqtt with the creds packed into the username,
//   subscribe to live_stream_topic, decode each payload as protobuf DataMsg (~1 msg/sec).
// The stream stops after live_stream_duration (900 s), so we renew before it lapses.
import path from 'node:path';
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import protobuf from 'protobufjs';
import { config } from '../config.js';
import { getSession, enlightenHeaders, getGatewaySerial, hasCloudCreds } from '../auth.js';
import { fromCloud } from '../normalize.js';
import { log } from '../log.js';

let DataMsg;
async function loadProto() {
  if (DataMsg) return DataMsg;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.join(config.protoDir, path.basename(target));
  await root.load('DataMsg.proto', { keepCase: false });
  DataMsg = root.lookupType('DataMsg');
  return DataMsg;
}

export class CloudSource extends EventEmitter {
  constructor() {
    super();
    this.name = 'cloud';
    this.client = null;
    this.renewTimer = null;
    this.running = false;
    this.status = { state: 'idle', lastOk: 0, error: null, renewedAt: 0 };
  }

  enabled() { return config.enlighten.cloud && hasCloudCreds() && Boolean(config.enlighten.siteId); }

  async start() {
    if (this.running || !this.enabled()) {
      if (!this.enabled()) this.status.state = 'disabled';
      return;
    }
    this.running = true;
    this.status.state = 'starting';
    await this.connect().catch((e) => this.fail(e));
  }

  stop() {
    this.running = false;
    clearTimeout(this.renewTimer);
    if (this.client) this.client.end(true);
    this.client = null;
    this.status.state = 'standby';
  }

  fail(e) {
    log.warn('cloud', e.message);
    this.status.error = e.message;
    this.status.state = 'error';
    if (this.running) {
      clearTimeout(this.renewTimer);
      this.renewTimer = setTimeout(() => this.connect().catch((err) => this.fail(err)), 15_000);
    }
  }

  async fetchCreds(retry = true) {
    const session = await getSession({ force: !retry });
    const serial = await getGatewaySerial();
    const url = `${config.enlighten.base}/pv/aws_sigv4/livestream.json?serial_num=${encodeURIComponent(serial)}`;
    const res = await fetch(url, { headers: enlightenHeaders(session) });
    const json = await res.json().catch(() => ({}));
    if (!json.aws_iot_endpoint) {
      if (retry) return this.fetchCreds(false); // session may have expired; re-login once
      throw new Error(`livestream.json: ${json.message || res.status}`);
    }
    // Enlighten logs each live-status open; mirror it so the stream is treated like the web app's.
    fetch(`${config.enlighten.base}/app-api/${config.enlighten.siteId}/log_live_status`, {
      method: 'POST', headers: { ...enlightenHeaders(session), 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {});
    return json;
  }

  async connect() {
    if (!this.running) return;
    const Msg = await loadProto();
    const c = await this.fetchCreds();
    const username = '?' + [
      ['x-amz-customauthorizer-name', c.aws_authorizer],
      [c.aws_token_key, c.aws_token_value],
      ['site-id', config.enlighten.siteId],
      ['x-amz-customauthorizer-signature', encodeURIComponent(c.aws_digest)],
      ['evse-count', 0],
      ['env', 'prod'],
    ].map(([k, v]) => `${k}=${v}`).join('&');

    if (this.client) this.client.end(true);
    const client = mqtt.connect(`wss://${c.aws_iot_endpoint}/mqtt`, {
      clientId: `em-paho-mqtt-${process.hrtime.bigint()}`,
      username,
      protocolVersion: 4,
      reconnectPeriod: 0, // we manage reconnects (creds must be re-fetched)
      connectTimeout: 15_000,
      keepalive: 60,
    });
    this.client = client;

    client.on('connect', () => {
      log.info('cloud', `connected, subscribing ${c.live_stream_topic}`);
      client.subscribe(c.live_stream_topic);
      this.status.renewedAt = Date.now();
    });
    client.on('message', (_topic, payload) => {
      try {
        const obj = Msg.toObject(Msg.decode(payload), {
          enums: String, longs: Number, defaults: true, arrays: true,
        });
        this.status.lastOk = Date.now();
        this.status.state = 'ok';
        this.status.error = null;
        this.emit('sample', fromCloud(obj));
      } catch (e) {
        this.status.error = `decode: ${e.message}`;
      }
    });
    client.on('error', (e) => this.fail(e));
    client.on('close', () => {
      if (this.client === client && this.running) this.fail(new Error('mqtt closed'));
    });

    // Renew 60 s before the server-side window (default 900 s) ends.
    const windowMs = (c.live_stream_duration || 900) * 1000;
    clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => this.connect().catch((e) => this.fail(e)), windowMs - 60_000);
  }
}
