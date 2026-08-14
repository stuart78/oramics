/**
 * Minimal AudioWorkletGlobalScope declarations. The DOM lib does not describe
 * the worklet scope, and pulling a whole types package for four symbols is not
 * worth the dependency.
 */
declare const sampleRate: number;
declare const currentTime: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
