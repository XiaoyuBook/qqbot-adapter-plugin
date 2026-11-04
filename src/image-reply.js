import { randomUUID } from 'node:crypto';
import { mediaUrl, uploadMarkdownImage } from './media.js';
import { AdapterError, logFailure } from './errors.js';

const retryDelay = 30000;
const uncertainDelay = 300000;
const maxAttempts = 3;
const maxImages = 100;
const referencePrefix = 'qqbot-media://image/v1/';

function boundedString(value, limit, empty = false) {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= limit && !/[\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
function validId(value) { return boundedString(value, 256) && value !== '.' && value !== '..'; }
function checkReference(value) {
  const token = typeof value === 'string' && value.startsWith(referencePrefix) ? value.slice(referencePrefix.length) : '';
  if (!token || token.length > 8192 || /[^A-Za-z0-9._~+/=-]/.test(token)) throw new AdapterError('API_RESPONSE');
}

export class ImageReplies {
  #tail = Promise.resolve();
  #pending = new Map();
  #closed = false;

  constructor(api, { logger, timers = globalThis } = {}) {
    this.api = api;
    this.logger = logger;
    this.timers = timers;
  }

  #serial(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #check() { if (this.#closed) throw new AdapterError('OFFLINE'); }

  #suspend(state) {
    if (state.timer !== null) this.timers.clearTimeout(state.timer);
    state.timer = null;
    state.generation++; // Also invalidates timer work that already entered the serial queue.
  }

  #forget(state) {
    if (!state) return;
    this.#suspend(state);
    if (this.#pending.get(state.id) === state) this.#pending.delete(state.id);
  }

  #schedule(state, delay) {
    if (this.#closed || this.#pending.get(state.id) !== state) return;
    this.#suspend(state);
    state.delay = delay;
    const generation = state.generation;
    state.timer = this.timers.setTimeout(() => {
      state.timer = null;
      void this.#serial(() => {
        if (state.generation === generation) return this.#remove(state);
      }).catch(error => this.#log(error));
    }, delay);
    state.timer?.unref?.();
  }

  #log(error) {
    try { logFailure(this.logger, 'image_cleanup', error); } catch {}
  }

  async #remove(state) {
    if (this.#closed || this.#pending.get(state.id) !== state) return;
    state.attempts++;
    try {
      await this.api.request('DELETE', `/v2/media-images/${encodeURIComponent(state.id)}/delete`);
      this.#forget(state);
    } catch (error) {
      if (error instanceof AdapterError && error.platformCode === 40035008) {
        this.#forget(state);
        return;
      }
      this.#log(error);
      if (state.attempts < maxAttempts) this.#schedule(state, retryDelay);
      else this.#forget(state);
    }
  }

  async #inventory() {
    const ids = new Set(), cursors = new Set();
    let cursor = '', total, pages = 0;
    do {
      this.#check();
      if (++pages > maxImages || cursors.has(cursor)) throw new AdapterError('API_RESPONSE');
      cursors.add(cursor);
      const page = await this.api.request('GET', `/v2/media-images${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`);
      if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.images) || page.images.length > maxImages) throw new AdapterError('API_RESPONSE');
      if (page.total !== undefined) {
        const value = typeof page.total === 'string' && /^(0|[1-9]\d{0,2})$/.test(page.total) ? Number(page.total) : page.total;
        if (!Number.isInteger(value) || value < 0 || value > maxImages || (total !== undefined && total !== value)) throw new AdapterError('API_RESPONSE');
        total = value;
      }
      for (const image of page.images) {
        if (!image || !validId(image.image_id) || ids.has(image.image_id)) throw new AdapterError('API_RESPONSE');
        ids.add(image.image_id);
      }
      if (ids.size > maxImages || (total !== undefined && ids.size > total)) throw new AdapterError('API_RESPONSE');
      cursor = page.next_cursor === undefined ? '' : page.next_cursor;
      if (!boundedString(cursor, 2048, true) || (cursor && cursors.has(cursor))) throw new AdapterError('API_RESPONSE');
    } while (cursor);
    if (total !== undefined && ids.size !== total) throw new AdapterError('API_RESPONSE');
    return ids;
  }

  #upload(prepared, { beforeComplete, check = () => {} } = {}) {
    this.#check();
    // Closing during one request must stop the remaining upload stages.
    return uploadMarkdownImage({
      request: (...args) => { this.#check(); check(); return this.api.request(...args); },
      uploadPart: (...args) => { this.#check(); check(); return this.api.uploadPart(...args); }
    }, prepared, beforeComplete);
  }

  async send(prepared, callback) {
    this.#check();
    if (prepared.url) return callback(mediaUrl(prepared.url));
    return this.#serial(async () => {
      this.#check();
      let existing, inventoryError;
      // Upload preparation and COS transfer do not create a gallery item. Run
      // them alongside the inventory read, then gate complete on its success.
      // Capture rejection immediately so a slow upload cannot leave it unhandled.
      const inventory = this.#inventory().then(ids => { existing = ids; }, error => { inventoryError = error; });
      const check = () => { if (inventoryError) throw inventoryError; };
      const image = await this.#upload({ ...prepared, fileName: `reply-${randomUUID()}.${prepared.extension}` }, {
        check, beforeComplete: async () => { await inventory; check(); }
      });
      this.#check();
      if (!validId(image.image_id)) throw new AdapterError('API_RESPONSE');
      let state = this.#pending.get(image.image_id);
      const reused = Boolean(state);
      if (state) this.#suspend(state);
      else if (!existing.has(image.image_id)) {
        state = { id: image.image_id, attempts: 0, timer: null, generation: 0 };
        this.#pending.set(state.id, state);
      }
      try { checkReference(image.url); }
      catch (error) {
        if (state) {
          if (reused) this.#schedule(state, state.delay);
          else await this.#remove(state);
        }
        throw error;
      }
      let result;
      try { this.#check(); result = await callback(image.url); }
      catch (error) { if (state) this.#schedule(state, uncertainDelay); throw error; }
      if (state) {
        // An earlier uncertain delivery can still reference a reused temporary asset.
        if (reused) this.#schedule(state, state.delay);
        else await this.#remove(state);
      }
      return result;
    });
  }

  persistent(prepared) {
    return this.#serial(async () => {
      this.#check();
      const image = await this.#upload(prepared);
      this.#check();
      if (!validId(image.image_id)) throw new AdapterError('API_RESPONSE');
      this.#forget(this.#pending.get(image.image_id));
      checkReference(image.url);
      return image;
    });
  }

  close() {
    this.#closed = true;
    for (const state of this.#pending.values()) this.#forget(state);
  }
}
