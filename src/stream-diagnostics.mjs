const EVENTS = new Set(['message_start','content_block_start','text_delta','thinking_delta','signature_delta','input_json_delta','content_block_stop','message_delta','message_stop','error','ping']);
const ERROR_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[ERROR\] Connection error details: code=(StreamTruncated|StreamSuspended|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|ZlibError)(?=,|\s)/;
const ERROR_END = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[ERROR\] Connection error details: code=(StreamTruncated|StreamSuspended|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|ZlibError)$/;

export class StreamDiagnostics {
  #started = performance.now();
  #tail = '';
  #discarding = false;
  #firstError = null;
  #firstErrorAt = null;
  #lastEvent = null;
  #lastEventAt = null;
  #counts = {};

  stderr(chunk) {
    if (this.#firstError) return;
    const lines = (this.#tail + String(chunk)).split('\n');
    const tail = lines.pop();
    for(const line of lines){
      if(!this.#discarding) this.#classify(line,true);
      this.#discarding=false;
    }
    if(!this.#discarding) this.#classify(tail,false);
    this.#discarding ||= tail.length>256;
    this.#tail = this.#firstError || this.#discarding ? '' : tail;
  }

  #classify(line, ended) {
    if(this.#firstError) return;
    const match = ERROR_LINE.exec(line) ?? (ended ? ERROR_END.exec(line) : null);
    if (match) {
      this.#firstError = match[1];
      this.#firstErrorAt = Math.round(performance.now() - this.#started);
      this.#tail = '';
      return;
    }
  }

  end() {
    if(!this.#discarding) this.#classify(this.#tail,true);
    this.#tail='';
  }

  event(event) {
    if (event?.type !== 'stream_event') return;
    const kind = event.event?.delta?.type ?? event.event?.type;
    if (!EVENTS.has(kind)) return;
    this.#counts[kind] = Math.min((this.#counts[kind] ?? 0) + 1, Number.MAX_SAFE_INTEGER);
    this.#lastEvent = kind;
    this.#lastEventAt = Math.round(performance.now() - this.#started);
  }

  snapshot() {
    return { first_error: this.#firstError, first_error_elapsed_ms: this.#firstErrorAt,
      event_counts: { ...this.#counts }, last_event: this.#lastEvent, last_event_elapsed_ms: this.#lastEventAt };
  }
}
