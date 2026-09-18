// @ts-nocheck
const MAX_HOST_TIMER_MS = 2_147_483_647;
export const MAX_PENDING_TASKS = 10_000;

function taskTimeoutError(timeoutMs) {
  const error = new Error(`Domjet page task timed out or was terminated after ${timeoutMs}ms`);
  error.code = "ERR_OBSCURA_TASK_TIMEOUT";
  return error;
}

function requireDelay(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError("Portable task delay must be a number");
  }
  if (value <= 0) return 0;
  // Preserve the full deadline and re-arm the one Node wake in bounded chunks.
  // Node clamps a direct timeout above 2^31-1ms and would fire it early.
  if (!Number.isFinite(value)) return Infinity;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function requireTaskId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Portable task id must be a positive safe integer");
  }
  return value;
}

/**
 * Node owns only opaque task ids, deadlines, and wake handles. Page callbacks
 * and posted-task Promise resolvers stay in the vm context's private registry.
 */
export class PortableTaskHost {
  #closed = false;
  #dispatcher = null;
  #enqueue;
  #entries = new Map();
  #heap = [];
  #epoch = 1;
  #nextId = 1;
  #nextSequence = 1;
  #timeoutMs;
  #wakeHandle = null;
  #wakeKind = null;
  #stats = {
    scheduled: 0,
    delivered: 0,
    running: 0,
    canceled: 0,
    dropped: 0,
    timeouts: 0,
  };

  constructor({ enqueue, timeoutMs }) {
    if (typeof enqueue !== "function") {
      throw new TypeError("Portable task host requires a serialized enqueue callback");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("Portable task timeout must be a positive safe integer");
    }
    this.#enqueue = enqueue;
    this.#timeoutMs = timeoutMs;
  }

  attach(dispatcher) {
    if (this.#closed) throw new Error("Portable task host is closed");
    if (typeof dispatcher?.dispatch !== "function") {
      throw new TypeError("Portable task host requires a page-realm dispatcher");
    }
    if (this.#dispatcher) throw new Error("Portable task host already has a dispatcher");
    this.#dispatcher = dispatcher;
  }

  operation(command, argument) {
    if (this.#closed) throw new Error("Portable task host is closed");
    switch (command) {
      case "schedule-timer":
        return this.#schedule("timer", requireDelay(argument));
      case "schedule-posted-task":
        return this.#schedule("posted", 0);
      case "cancel-task":
        return this.cancel(requireTaskId(argument));
      default:
        throw new TypeError(`Unsupported portable task command: ${command}`);
    }
  }

  cancel(id) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#removeEntry(entry);
    this.#stats.canceled += 1;
    this.#armWake();
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch += 1;
    this.#dispatcher = null;
    this.#clearWake();
    for (const _entry of this.#entries.values()) {
      this.#stats.dropped += 1;
    }
    this.#entries.clear();
    this.#heap.length = 0;
  }

  status() {
    return Object.freeze({
      available: !this.#closed,
      pending: this.#entries.size,
      scheduled: this.#stats.scheduled,
      delivered: this.#stats.delivered,
      running: this.#stats.running,
      canceled: this.#stats.canceled,
      dropped: this.#stats.dropped,
      timeouts: this.#stats.timeouts,
      timeoutMs: this.#timeoutMs,
    });
  }

  #allocateId() {
    if (this.#nextId > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Portable task id space is exhausted");
    }
    return this.#nextId++;
  }

  #schedule(kind, delay) {
    if (this.#entries.size >= MAX_PENDING_TASKS) {
      throw new RangeError(`Portable task queue exceeds the ${MAX_PENDING_TASKS}-task limit`);
    }
    const id = this.#allocateId();
    if (this.#nextSequence > Number.MAX_SAFE_INTEGER) {
      if (this.#entries.size !== 0) {
        throw new RangeError("Portable task sequence space is exhausted");
      }
      this.#nextSequence = 1;
    }
    const entry = {
      id,
      deadline: delay === Infinity ? Infinity : performance.now() + delay,
      epoch: this.#epoch,
      heapIndex: this.#heap.length,
      kind,
      sequence: this.#nextSequence++,
    };
    this.#entries.set(id, entry);
    this.#heap.push(entry);
    this.#siftUp(entry.heapIndex);
    this.#stats.scheduled += 1;
    this.#armWake();
    return id;
  }

  #nextEntry() {
    const entry = this.#heap[0];
    return entry ? { id: entry.id, entry } : null;
  }

  #precedes(left, right) {
    return left.deadline < right.deadline ||
      (left.deadline === right.deadline && left.sequence < right.sequence);
  }

  #swap(leftIndex, rightIndex) {
    const left = this.#heap[leftIndex];
    const right = this.#heap[rightIndex];
    this.#heap[leftIndex] = right;
    this.#heap[rightIndex] = left;
    right.heapIndex = leftIndex;
    left.heapIndex = rightIndex;
  }

  #siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.#precedes(this.#heap[index], this.#heap[parent])) break;
      this.#swap(index, parent);
      index = parent;
    }
  }

  #siftDown(index) {
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#heap.length) return;
      const right = left + 1;
      let first = left;
      if (right < this.#heap.length && this.#precedes(this.#heap[right], this.#heap[left])) {
        first = right;
      }
      if (!this.#precedes(this.#heap[first], this.#heap[index])) return;
      this.#swap(index, first);
      index = first;
    }
  }

  #removeEntry(entry) {
    const index = entry.heapIndex;
    const last = this.#heap.pop();
    this.#entries.delete(entry.id);
    entry.heapIndex = -1;
    if (last === entry) return;
    this.#heap[index] = last;
    last.heapIndex = index;
    const parent = index > 0 ? Math.floor((index - 1) / 2) : -1;
    if (parent >= 0 && this.#precedes(last, this.#heap[parent])) this.#siftUp(index);
    else this.#siftDown(index);
  }

  #clearWake() {
    if (this.#wakeHandle !== null) {
      if (this.#wakeKind === "immediate") clearImmediate(this.#wakeHandle);
      else clearTimeout(this.#wakeHandle);
    }
    this.#wakeHandle = null;
    this.#wakeKind = null;
  }

  #armWake() {
    this.#clearWake();
    if (this.#closed) return;
    const next = this.#nextEntry();
    if (next === null || next.entry.deadline === Infinity) return;
    const remaining = next.entry.deadline - performance.now();
    const wake = () => {
      this.#wakeHandle = null;
      this.#wakeKind = null;
      // A Node wake carries no page function. It only enters the serialized
      // Worker queue, where a fixed vm.Script dispatches one opaque id.
      try {
        Promise.resolve(this.#enqueue(() => this.#deliverOne())).catch(() => {
          // The Worker queue owns fatal transport errors; do not create an
          // unhandled rejection from a detached timer wake.
        });
      } catch {
        const current = this.#nextEntry();
        if (current) {
          this.#removeEntry(current.entry);
          this.#stats.dropped += 1;
        }
      }
    };
    if (remaining <= 0) {
      this.#wakeKind = "immediate";
      this.#wakeHandle = setImmediate(wake);
    } else {
      this.#wakeKind = "timeout";
      this.#wakeHandle = setTimeout(wake, Math.min(remaining, MAX_HOST_TIMER_MS));
      this.#wakeHandle.unref?.();
    }
    // An unref'ed immediate may wait for unrelated I/O before Node polls it.
    // Keep ready work referenced so idle pages deliver posted tasks without
    // needing a client RPC. close() still cancels the single owned wake.
  }

  async #deliverOne() {
    const next = this.#nextEntry();
    if (next === null || next.entry.deadline === Infinity) return;
    if (next.entry.deadline > performance.now()) {
      // The previous wake was an intermediate chunk for a long deadline.
      this.#armWake();
      return;
    }

    const { id, entry } = next;
    if (
      this.#closed ||
      entry.epoch !== this.#epoch ||
      !this.#dispatcher
    ) {
      this.#removeEntry(entry);
      this.#stats.dropped += 1;
      this.#armWake();
      return;
    }

    this.#removeEntry(entry);
    this.#stats.running += 1;
    try {
      this.#dispatcher.dispatch(id, this.#timeoutMs);
      this.#stats.delivered += 1;
    } catch (error) {
      if (error?.code === "ERR_OBSCURA_TASK_TIMEOUT") this.#stats.timeouts += 1;
      else this.#stats.dropped += 1;
      // Task failures must not reject the Worker's serialized operation
      // chain. Browser callbacks report their own exceptions in bootstrap.js.
    } finally {
      this.#stats.running -= 1;
      this.#armWake();
    }
  }
}

export function translateTaskDispatchError(error, timeoutMs) {
  if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return taskTimeoutError(timeoutMs);
  }
  // Node has changed the exact timeout error code/message across releases.
  if (typeof error?.message === "string" && /timed out|terminated/i.test(error.message)) {
    return taskTimeoutError(timeoutMs);
  }
  return error;
}
