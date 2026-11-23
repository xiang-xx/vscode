/**
 * Output-speed meter behind the "current model" chip in the chat/Worker detail
 * page.
 *
 * The number exists so models can be compared, which rules out trusting what a
 * provider reports: Cursor's ACP stream carries no usage fields at all and the
 * OpenAI-compatible path only exposes a single total. Every brain is therefore
 * measured the same way — an estimate of the streamed assistant text over a
 * sliding window of time actually spent streaming.
 *
 * What it deliberately ignores: waiting on a tool, waiting on the user, a
 * connection retry or a thinking pause. Those can dwarf the generation time,
 * so dividing the whole turn by wall time would report a number that says more
 * about how long a tool ran than about how fast the model writes. Idle time is
 * cut out both by an explicit `pause()` (the panel calls it when a tool starts)
 * and by a silence backstop for waits that arrive without an event.
 *
 * The chip shows the *peak* windowed rate rather than a turn average: a peak is
 * what the model can do when it is actually generating, and it does not drift
 * downwards just because the turn was long.
 */

/** Silence longer than this starts a new streaming segment: whatever happened
 *  in between (a tool the panel never announced, a stalled socket) is not
 *  generation time. */
const SEGMENT_GAP_MS = 2000;

/** Window on the streaming clock. Wide enough to swallow per-chunk jitter,
 *  narrow enough that one slow patch does not drag the peak down. */
const WINDOW_MS = 1000;

/** A segment shorter than this is too short to measure, so nothing is shown. */
const MIN_WINDOW_MS = 400;

/** Below this much streamed text the reading is noise, not a measurement. */
const MIN_TOKENS = 4;

/** Latin text averages ~3.6 characters per token; CJK is ~1 character per token. */
const LATIN_CHARS_PER_TOKEN = 3.6;

export interface OutputSpeedSample {
	/** Peak windowed rate for the turn, in estimated tokens per second. */
	tokensPerSec: number;
	/** Estimated output tokens in the whole turn so far. */
	tokens: number;
	/** Streaming time attributed to those tokens, idle waits excluded. */
	streamMs: number;
}

/** Cheap token estimate for a slice of assistant text (CJK-weighted). */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		// 0x2e80 and above covers CJK ideographs, kana, hangul and fullwidth forms.
		if (text.charCodeAt(i) >= 0x2e80) {
			cjk++;
		} else {
			other++;
		}
	}
	return cjk + other / LATIN_CHARS_PER_TOKEN;
}

interface OutputChunk {
	/** Position on the streaming clock, in ms. */
	at: number;
	tokens: number;
}

/**
 * Accumulates one turn's streamed output and streaming time. Feed it every
 * assistant text the provider emits; it de-duplicates the cumulative text
 * itself, so callers can pass whatever arrived.
 */
export class OutputSpeedMeter {
	private lastText = '';
	private lastAt = 0;
	/** Streaming clock: sum of chunk-to-chunk intervals, idle waits excluded. */
	private clock = 0;
	/** Clock value at which the current streaming segment began. */
	private segmentBase = 0;
	private tokens = 0;
	private peak = 0;
	private chunks: OutputChunk[] = [];

	reset(): void {
		this.lastText = '';
		this.lastAt = 0;
		this.clock = 0;
		this.segmentBase = 0;
		this.tokens = 0;
		this.peak = 0;
		this.chunks = [];
	}

	/**
	 * Ends the current streaming segment without losing what was measured: the
	 * wall time until the next chunk is not counted. Call this where the turn
	 * blocks on something else — a tool run, a user answer, a retry backoff.
	 */
	pause(): void {
		this.lastAt = 0;
	}

	/** `text` is the reply accumulated so far, exactly as emitted upstream. */
	note(text: string, now = Date.now()): void {
		if (!text || text === this.lastText) {
			return;
		}
		// Cumulative text is the norm. Anything else is a restarted paragraph —
		// a fresh assistant segment after a tool call — so count it whole.
		const added = text.startsWith(this.lastText) ? text.slice(this.lastText.length) : text;
		this.lastText = text;
		if (!added) {
			return;
		}
		const gained = estimateTokens(added);
		this.tokens += gained;

		const gap = this.lastAt ? now - this.lastAt : Number.POSITIVE_INFINITY;
		if (gap > SEGMENT_GAP_MS) {
			// New segment — a fresh reply after a tool, or after a wait nobody
			// announced. Push the clock past the previous window so the two are
			// never averaged together, and start counting from here.
			if (this.clock > 0) {
				this.clock += WINDOW_MS;
			}
			this.segmentBase = this.clock;
		} else {
			this.clock += gap;
		}
		this.lastAt = now;

		this.chunks.push({ at: this.clock, tokens: gained });
		this.trimChunks();

		const rate = this.windowRate();
		if (rate !== undefined && rate > this.peak) {
			this.peak = rate;
		}
	}

	/** Current reading (peak so far), or undefined while there is nothing measured. */
	sample(): OutputSpeedSample | undefined {
		if (this.peak <= 0 || this.tokens < MIN_TOKENS) {
			return undefined;
		}
		return {
			tokensPerSec: this.peak,
			tokens: Math.round(this.tokens),
			streamMs: Math.round(this.clock),
		};
	}

	/**
	 * Rate over the last window of streaming time. The window is the full
	 * WINDOW_MS once the segment is that long; a shorter segment is measured
	 * over its own length instead — but only past MIN_WINDOW_MS, so a burst of
	 * two chunks is never mistaken for a fast model.
	 */
	private windowRate(): number | undefined {
		const segmentMs = this.clock - this.segmentBase;
		if (segmentMs < MIN_WINDOW_MS) {
			return undefined;
		}
		// A chunk arriving at t carries the tokens written since the previous
		// chunk, so a window (from, clock] sums to exactly clock - from of
		// generation. A segment shorter than a window is measured over its own
		// length; its opening chunk carries text written before the segment began,
		// so it falls on the opening edge and is left out.
		const from = segmentMs <= WINDOW_MS ? this.segmentBase : this.clock - WINDOW_MS;
		let tokens = 0;
		for (let i = this.chunks.length - 1; i >= 0; i--) {
			const chunk = this.chunks[i];
			if (chunk.at <= from) {
				break;
			}
			tokens += chunk.tokens;
		}
		if (tokens < MIN_TOKENS) {
			return undefined;
		}
		return tokens / ((this.clock - from) / 1000);
	}

	/** Drops chunks that can no longer fall inside the window. */
	private trimChunks(): void {
		const floor = this.clock - WINDOW_MS * 2;
		let drop = 0;
		while (drop < this.chunks.length && this.chunks[drop].at <= floor) {
			drop++;
		}
		if (drop > 0) {
			this.chunks.splice(0, drop);
		}
	}
}
