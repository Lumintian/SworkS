/** heic-decode（libheif 的 WASM 版）没有自带类型声明。 */
declare module 'heic-decode' {
  interface Decoded {
    width: number;
    height: number;
    /** RGBA，每像素 4 字节 */
    data: Uint8ClampedArray;
  }
  interface Lazy {
    width: number;
    height: number;
    decode(): Promise<Decoded>;
  }
  function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>;
  namespace decode {
    function all(input: { buffer: Uint8Array | ArrayBuffer }): Promise<Lazy[] & { dispose(): void }>;
  }
  export default decode;
}
