// Web Audio falso para los tests de la presentación (Node no tiene Web Audio y NO se usa
// OfflineAudioContext). `FakeAudioParam` registra cada llamada y aplica las reglas de la
// especificación que importan aquí:
// - `cancelAndHoldAtTime(t)` quita los eventos posteriores a `t` y fija el valor que tenía en `t`
//   (aunque hubiera una rampa a medias);
// - las rampas parten del evento anterior;
// - `setValueCurveAtTime` lanza `NotSupportedError` en cuanto hay otro evento programado dentro de
//   su intervalo (aquí se registra y además falla siempre: la presentación no debe usarlo);
// - valores no finitos → TypeError; tiempos negativos o no finitos → RangeError.
import type {
  AudioContextLike,
  GainNodeLike,
  MediaElementLike,
} from '../../../../src/renderer/src/screens/presentation/audio-graph';

export interface ParamCall {
  method: string;
  args: number[];
}

interface ParamEvent {
  kind: 'set' | 'ramp';
  time: number;
  value: number;
}

export class FakeAudioParam {
  readonly calls: ParamCall[] = [];
  /** Errores que la especificación habría lanzado (TypeError, RangeError, NotSupportedError). */
  readonly errors: string[] = [];
  private events: ParamEvent[] = [];

  constructor(
    private readonly ctx: { currentTime: number },
    private readonly initial = 1,
  ) {}

  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }

  /** Valor programado en el instante `t` (rampas lineales entre eventos). */
  valueAt(t: number): number {
    let prevTime = 0;
    let prevValue = this.initial;
    for (const e of this.events) {
      if (e.time <= t) {
        prevTime = e.time;
        prevValue = e.value;
        continue;
      }
      if (e.kind === 'ramp') {
        const span = e.time - prevTime;
        return span <= 0 ? e.value : prevValue + ((e.value - prevValue) * (t - prevTime)) / span;
      }
      return prevValue;
    }
    return prevValue;
  }

  private check(method: string, value: number | null, time: number): void {
    if (value !== null && !Number.isFinite(value)) {
      this.errors.push(`TypeError:${method}`);
      throw new TypeError(`${method}: valor no finito`);
    }
    if (!Number.isFinite(time) || time < 0) {
      this.errors.push(`RangeError:${method}`);
      throw new RangeError(`${method}: tiempo inválido`);
    }
  }

  private insert(e: ParamEvent): void {
    let at = this.events.length;
    while (at > 0 && this.events[at - 1].time > e.time) at -= 1;
    this.events.splice(at, 0, e);
  }

  cancelAndHoldAtTime(cancelTime: number): this {
    this.calls.push({ method: 'cancelAndHoldAtTime', args: [cancelTime] });
    this.check('cancelAndHoldAtTime', null, cancelTime);
    const held = this.valueAt(cancelTime);
    this.events = this.events.filter((e) => e.time <= cancelTime);
    this.insert({ kind: 'set', time: cancelTime, value: held });
    return this;
  }

  setValueAtTime(value: number, startTime: number): this {
    this.calls.push({ method: 'setValueAtTime', args: [value, startTime] });
    this.check('setValueAtTime', value, startTime);
    this.insert({ kind: 'set', time: startTime, value });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, endTime] });
    this.check('linearRampToValueAtTime', value, endTime);
    this.insert({ kind: 'ramp', time: endTime, value });
    return this;
  }

  /** La presentación nunca debe llamarlo (§17.8). */
  setValueCurveAtTime(): never {
    this.calls.push({ method: 'setValueCurveAtTime', args: [] });
    this.errors.push('NotSupportedError:setValueCurveAtTime');
    throw new Error('NotSupportedError: setValueCurveAtTime está prohibido');
  }

  methodsCalled(): Set<string> {
    return new Set(this.calls.map((c) => c.method));
  }
}

export class FakeGain implements GainNodeLike {
  readonly gain: FakeAudioParam;
  readonly connections: unknown[] = [];

  constructor(ctx: { currentTime: number }) {
    this.gain = new FakeAudioParam(ctx, 1);
  }

  connect(destination: unknown): void {
    this.connections.push(destination);
  }
}

export class FakeMediaElement implements MediaElementLike {
  paused = true;
  playCalls = 0;
  pauseCalls = 0;

  play(): Promise<void> {
    this.paused = false;
    this.playCalls += 1;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
  }
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 1;
  readonly destination = { name: 'destination' };
  readonly gains: FakeGain[] = [];
  readonly sources: { element: unknown; node: { connect(d: unknown): void } }[] = [];
  closed = false;

  createGain(): FakeGain {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }

  createMediaElementSource(element: MediaElementLike): { connect(destination: unknown): void } {
    if (this.sources.some((s) => s.element === element)) {
      // La Web Audio real lanza InvalidStateError: un elemento solo se conecta una vez.
      throw new Error('InvalidStateError: el elemento ya está conectado');
    }
    const node = { connect: (): void => undefined };
    this.sources.push({ element, node });
    return node;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Avanza el reloj de audio (segundos). */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}
