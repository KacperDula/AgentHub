// The few runtime globals core uses; present in browsers, Node 20+ and Electron. No DOM/Node lib on purpose.
declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID(): string;
};
declare function setTimeout(cb: () => void, ms: number): unknown;
interface AbortSignal {
  readonly aborted: boolean;
}
